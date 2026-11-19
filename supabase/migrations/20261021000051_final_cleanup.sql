-- Release 1 final clean-up (.superpowers/sdd/drishti/release1-cleanups.md "From the final-fix-Y review"; final-fix-Y-review.md;
-- final-review-C.md M-29, M-30). Rulings FC-1..FC-8 in docs/drishti/DECISIONS.md.
--
--  1. Y-R1: security_set_mfa with no person is for the database owner only (postgres / supabase_admin in psql); the service key and the
--     web app must name an active super administrator of the organisation. The service key can no longer switch two-step sign-in off.
--  2. Y-R9: security_mfa_overview() also returns each organisation's slug (the production start-up refusal names them by slug).
--  3. Y-R3: mfa_code_lock_owner_clear(org, person, reason): break-glass for a code step locked for good when no other super administrator
--     can clear it. The database owner only (no API role may execute it; privilege_violations() says so), a reason of 10 to 500
--     characters, audited in auth_events and admin_audit_log with path 'database_owner'.
--  4. Y-R4: the web role writes the inventory tables (regions, clusters, locations, cameras, assets) by column grants only: never the
--     archive state, never the organisation, never the ids. A direct write by any API role (the web role, the service key) cannot
--     archive, restore, move an item to another organisation or put a live item under an archived parent (trigger
--     inventory_write_guard, DR040); the audited functions (owned by the database owner) are the only way. The service key loses
--     TRUNCATE on those tables.
--  5. Y-R11: access_check_password_reset takes the organisation's access lock first, like every other access or people change.
--  6. C M-29: recorder_save_login saves an NVR, its password and its clock offset in ONE transaction (recorder_save +
--     recorder_store_credential): a new NVR whose password cannot be saved leaves nothing behind; a new address or web port without the
--     password is refused (DR011). The saved-login version (nvr_login_version, final fix X) follows the new secret as before.
--  7. C M-30: one location import per organisation at a time (the device import's advisory lock), run against the inventory it was
--     checked with: inventory_import_stamp(org) is a hash of what the import plan reads; inventory_import_run(org, actor, plan, stamp)
--     takes the lock, refuses a changed inventory (DR051) and runs inventory_import_apply, which is the service key's only from now on.
--  8. Y-R10: privilege_violations() also flags whole-table writes of the web role on the inventory tables, column grants of the archive
--     state or the organisation, and the break-glass function given to anyone; the self-check below and NOTIFY pgrst (0049 had neither).
--
-- SECURITY DEFINER functions use SET search_path = '' with qualified names; explicit REVOKE / GRANT on every new or replaced function.
-- Rollback: supabase/rollback/20261021000051_final_cleanup_rollback.sql (dry run: -v drishti_dry_run=1).

BEGIN;

-- ── 1. Y-R1: no person = the database owner only ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.security_set_mfa(p_org uuid, p_actor uuid, p_enforced boolean, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_enforced IS NULL THEN RAISE EXCEPTION 'on or off?' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF p_actor IS NULL THEN
    -- Final clean-up (Y-R1): the service key is an API key; only the database owner (psql) may act without a person.
    IF public.service_caller_role() NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'only a super administrator may change the two-step sign-in requirement' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password
                    AND p.role = 'platform_owner') THEN
    RAISE EXCEPTION 'only a super administrator may change the two-step sign-in requirement' USING ERRCODE = '42501';
  END IF;
  IF NOT p_enforced AND (v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 500) THEN
    RAISE EXCEPTION 'switching two-step sign-in off needs a reason of 10 to 500 characters' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  INSERT INTO public.security_settings (org_id, mfa_enforced, mfa_off_reason, mfa_off_by)
  VALUES (p_org, p_enforced, CASE WHEN p_enforced THEN NULL ELSE v_reason END, CASE WHEN p_enforced THEN NULL ELSE p_actor END)
  ON CONFLICT (org_id) DO UPDATE SET mfa_enforced = EXCLUDED.mfa_enforced, mfa_off_reason = EXCLUDED.mfa_off_reason,
    mfa_off_by = EXCLUDED.mfa_off_by, updated_at = now();
  PERFORM pg_catalog.set_config('drishti.actor', '', true);
  RETURN pg_catalog.jsonb_build_object('org_id', p_org, 'enforced', p_enforced);
END
$$;

-- ── 2. Y-R9: the overview names the organisation by its slug ─────────────────────────────────────────────────────────────────────
DROP FUNCTION public.security_mfa_overview();
CREATE FUNCTION public.security_mfa_overview()
RETURNS TABLE (org_id uuid, slug text, enforced boolean, opted_out boolean, reason text, off_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.slug::text,
         coalesce(s.mfa_enforced, public.mfa_default_enforced()),
         NOT coalesce(s.mfa_enforced, public.mfa_default_enforced()) AND s.mfa_off_reason IS NOT NULL,
         s.mfa_off_reason, s.mfa_off_at
  FROM public.organizations o LEFT JOIN public.security_settings s ON s.org_id = o.id
  WHERE o.status IN ('trial', 'active')
  ORDER BY o.id
$$;

-- ── 3. Y-R3: break-glass for a code step locked for good (the database owner only) ───────────────────────────────────────────────
-- Not SECURITY DEFINER: it runs with the rights of the one who calls it, and no API role may call it. For the case the People page
-- cannot help: the only active super administrator's own code step is locked for good (mfa_code_lock_clear never clears one's own).
CREATE FUNCTION public.mfa_code_lock_owner_clear(p_org uuid, p_user uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  r public.mfa_code_failures%ROWTYPE;
BEGIN
  IF public.service_caller_role() NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'only the database owner clears a code step this way' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'a reason of 10 to 500 characters is needed (who, why, ticket)' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org) THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO r FROM public.mfa_code_failures f WHERE f.user_id = p_user FOR UPDATE;
  UPDATE public.mfa_code_failures SET failures = 0, lockouts = 0, locked_until = NULL, locked_for_good = false, lock_recorded = false, updated_at = now()
  WHERE user_id = p_user;
  INSERT INTO public.auth_events (org_id, user_id, actor_id, event, detail)
  VALUES (p_org, p_user, NULL, 'mfa_lock_cleared', pg_catalog.jsonb_build_object('reason', left(v_reason, 200), 'path', 'database_owner'));
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, NULL, 'mfa_code_lock_cleared', 'profile', p_user, pg_catalog.jsonb_build_object(
    'reason', v_reason, 'failures', coalesce(r.failures, 0), 'locked_for_good', coalesce(r.locked_for_good, false),
    'path', 'database_owner', 'db_user', session_user::text));
  RETURN true;
END
$$;

-- ── 4. Y-R4: the inventory tables by column grants, and a guard on direct writes ──────────────────────────────────────────────────
REVOKE INSERT, UPDATE ON public.regions, public.clusters, public.locations, public.cameras, public.assets FROM app_web;
GRANT INSERT (org_id, code, name) ON public.regions TO app_web;
GRANT UPDATE (code, name) ON public.regions TO app_web;
GRANT INSERT (org_id, region_id, code, name) ON public.clusters TO app_web;
GRANT UPDATE (region_id, code, name) ON public.clusters TO app_web;
GRANT INSERT (org_id, code, name, kind, city, address, zone, state, is_active, cluster_id, parent_location_id, uplink_asset_id) ON public.locations TO app_web;
GRANT UPDATE (code, name, kind, city, address, zone, state, is_active, cluster_id, parent_location_id, uplink_asset_id) ON public.locations TO app_web;
GRANT INSERT (org_id, location_id, recorder_id, channel, name, camera_ip, is_active) ON public.cameras TO app_web;
GRANT UPDATE (location_id, recorder_id, channel, name, camera_ip, is_active) ON public.cameras TO app_web;
GRANT INSERT (org_id, location_id, type, name, ip, tcp_port, enabled, notes, address_space_id, mac, serial, vendor, model, firmware, role, owner,
              criticality, lifecycle_state, warranty_until, management_mode, config_owner, credential_ref, assigned_profile_id,
              attached_recorder_id, capability_discovered_at, last_inventory_at) ON public.assets TO app_web;
GRANT UPDATE (location_id, type, name, ip, tcp_port, enabled, notes, address_space_id, mac, serial, vendor, model, firmware, role, owner,
              criticality, lifecycle_state, warranty_until, management_mode, config_owner, credential_ref, assigned_profile_id,
              attached_recorder_id, capability_discovered_at, last_inventory_at) ON public.assets TO app_web;
REVOKE TRUNCATE ON public.regions, public.clusters, public.locations, public.cameras, public.assets FROM service_role;

-- Not SECURITY DEFINER on purpose: current_user is whoever writes. The audited functions are owned by the database owner, so their
-- writes pass; a direct write by an API role (app_web, service_role, ...) is checked.
CREATE FUNCTION public.inventory_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_parent_archived boolean;
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'an inventory item never moves to another organisation' USING ERRCODE = '42501';
    END IF;
    IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
      RAISE EXCEPTION 'archiving and restoring go through inventory_archive and inventory_restore (admin.inventory)' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new inventory item is never archived' USING ERRCODE = '42501';
  END IF;
  IF NEW.archived_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'clusters' THEN
    IF NEW.region_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.region_id IS DISTINCT FROM OLD.region_id) THEN
      SELECT x.archived_at IS NOT NULL INTO v_parent_archived FROM public.regions x WHERE x.id = NEW.region_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'locations' THEN
    IF NEW.cluster_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.cluster_id IS DISTINCT FROM OLD.cluster_id) THEN
      SELECT x.archived_at IS NOT NULL INTO v_parent_archived FROM public.clusters x WHERE x.id = NEW.cluster_id;
    END IF;
  ELSIF TG_TABLE_NAME IN ('cameras', 'assets') THEN
    IF NEW.location_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
      SELECT x.archived_at IS NOT NULL INTO v_parent_archived FROM public.locations x WHERE x.id = NEW.location_id;
    END IF;
  END IF;
  IF coalesce(v_parent_archived, false) THEN
    RAISE EXCEPTION 'its parent is archived: restore the parent first' USING ERRCODE = 'DR040';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER regions_write_guard BEFORE INSERT OR UPDATE ON public.regions FOR EACH ROW EXECUTE FUNCTION public.inventory_write_guard();
CREATE TRIGGER clusters_write_guard BEFORE INSERT OR UPDATE ON public.clusters FOR EACH ROW EXECUTE FUNCTION public.inventory_write_guard();
CREATE TRIGGER locations_write_guard BEFORE INSERT OR UPDATE ON public.locations FOR EACH ROW EXECUTE FUNCTION public.inventory_write_guard();
CREATE TRIGGER cameras_write_guard BEFORE INSERT OR UPDATE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.inventory_write_guard();
CREATE TRIGGER assets_write_guard BEFORE INSERT OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.inventory_write_guard();

-- ── 5. Y-R11: the password-reset rule waits for the organisation's access lock ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.access_check_password_reset(p_org uuid, p_actor uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
  v_missing text;
BEGIN
  -- Final clean-up (Y-R11): one access or people change per organisation at a time; the actor's rights are read after the lock.
  PERFORM public.access_admin_lock(p_org);
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                    WHERE g.org_id = p_org AND g.capability = 'admin.users' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person may not change people (admin.users)' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'nobody resets their own password here' USING ERRCODE = '42501'; END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'platform_owner' THEN RETURN; END IF;
  IF v_target NOT IN ('user', 'operator', 'manager') THEN
    RAISE EXCEPTION 'the acting person may not manage this person' USING ERRCODE = '42501';
  END IF;
  SELECT g.capability INTO v_missing FROM public.access_grants g
  WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL AND (g.valid_until IS NULL OR g.valid_until > now())
    AND NOT EXISTS (
      SELECT 1 FROM public.access_grants a
      WHERE a.user_id = p_actor AND a.org_id = p_org AND a.capability = g.capability AND a.revoked_at IS NULL
        AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
        AND (a.valid_until IS NULL OR (g.valid_until IS NOT NULL AND a.valid_until >= g.valid_until))
        AND (a.scope_kind = 'organization'
             OR (a.scope_kind = g.scope_kind AND a.scope_id = g.scope_id)
             OR public.access_scope_covers(p_org, a.scope_kind, a.scope_id, g.scope_kind, g.scope_id)))
  ORDER BY g.capability LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'this person holds % where the acting person does not: only a super administrator may reset this password', v_missing USING ERRCODE = '42501';
  END IF;
END
$$;

-- ── 6. C M-29: an NVR, its password and its clock offset in one transaction ──────────────────────────────────────────────────────
-- p_recorder NULL: a new NVR (needs p_secret). p_secret NULL: keep the saved password, allowed only when the address and web port stay
-- (review I-4: a saved password is used only for the address it was saved for). Returns the recorder's id. Never returns the secret.
CREATE FUNCTION public.recorder_save_login(p_org uuid, p_location uuid, p_recorder uuid, p_host text, p_http_port integer, p_rtsp_port integer,
  p_username text, p_expected_channels integer, p_name text, p_actor uuid, p_secret text, p_clock_offset_sec integer) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_ip text;
  v_port integer;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF p_secret IS NOT NULL AND (btrim(p_secret) = '' OR length(p_secret) > 200) THEN
    RAISE EXCEPTION 'the NVR password must not be empty or longer than 200 characters' USING ERRCODE = '22023';
  END IF;
  IF p_recorder IS NULL THEN
    IF p_secret IS NULL THEN RAISE EXCEPTION 'a new NVR needs its password' USING ERRCODE = '22023'; END IF;
  ELSE
    SELECT a.ip, r.http_port INTO v_ip, v_port FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
    WHERE r.id = p_recorder AND r.org_id = p_org AND r.location_id = p_location FOR UPDATE OF r;
    IF NOT FOUND THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
    IF p_secret IS NULL AND (lower(btrim(coalesce(v_ip, ''))) <> lower(btrim(coalesce(p_host, ''))) OR v_port IS DISTINCT FROM p_http_port) THEN
      RAISE EXCEPTION 'the address or web port changed: the NVR password is needed again' USING ERRCODE = 'DR011';
    END IF;
  END IF;
  IF p_clock_offset_sec IS NOT NULL AND p_clock_offset_sec NOT BETWEEN -86400 AND 86400 THEN
    RAISE EXCEPTION 'the clock offset must be within a day' USING ERRCODE = '22023';
  END IF;
  v_id := public.recorder_save(p_org, p_location, p_recorder, p_host, p_http_port, p_rtsp_port, p_username, p_expected_channels, p_name, p_actor);
  IF p_secret IS NOT NULL THEN
    PERFORM public.recorder_store_credential(p_org, v_id, p_secret, p_actor);
  END IF;
  UPDATE public.recorders SET clock_offset_sec = p_clock_offset_sec, clock_offset_source = CASE WHEN p_clock_offset_sec IS NULL THEN NULL ELSE 'manual' END
  WHERE id = v_id AND org_id = p_org
    AND (clock_offset_sec, clock_offset_source) IS DISTINCT FROM (p_clock_offset_sec, CASE WHEN p_clock_offset_sec IS NULL THEN NULL ELSE 'manual' END);
  RETURN v_id;
END
$$;

-- ── 7. C M-30: one location import per organisation at a time, against the inventory it was checked with ─────────────────────────
-- A hash of what the import plan reads (lib/import/locations-import.ts loadImportSnapshot), so any change in between is seen.
CREATE FUNCTION public.inventory_import_stamp(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
    (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.concat_ws(',', l.id, l.code, l.name, l.kind, l.city, l.zone, l.state, l.address, l.cluster_id, l.archived_at, l.is_active), ';' ORDER BY l.id), ''))
     FROM public.locations l WHERE l.org_id = p_org),
    (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.concat_ws(',', r.id, r.location_id, r.http_port, r.rtsp_port, r.username, r.expected_channels,
                                                                               r.monitoring_enabled, r.secret_id, r.migrated_from_location_id, a.name, a.ip, a.archived_at), ';' ORDER BY r.id), ''))
     FROM public.recorders r JOIN public.assets a ON a.id = r.id WHERE r.org_id = p_org),
    (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.concat_ws(',', c.id, c.location_id, c.recorder_id, c.channel, c.name, c.archived_at), ';' ORDER BY c.id), ''))
     FROM public.cameras c WHERE c.org_id = p_org),
    (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.concat_ws(',', m.id, m.camera_id, m.recorder_id, m.channel, m.valid_to), ';' ORDER BY m.id), ''))
     FROM public.camera_channel_mappings m WHERE m.org_id = p_org),
    (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.concat_ws(',', x.id, x.code, x.archived_at), ';' ORDER BY x.id), ''))
     FROM public.regions x WHERE x.org_id = p_org),
    (SELECT pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.concat_ws(',', x.id, x.code, x.region_id, x.archived_at), ';' ORDER BY x.id), ''))
     FROM public.clusters x WHERE x.org_id = p_org)))
$$;

CREATE FUNCTION public.inventory_import_run(p_org uuid, p_actor uuid, p_plan jsonb, p_stamp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  -- The device import's lock (inventory_devices_import): one import of either kind per organisation at a time; a second one waits.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.import:' || p_org::text, 0));
  IF p_stamp IS NULL OR p_stamp IS DISTINCT FROM public.inventory_import_stamp(p_org) THEN
    RAISE EXCEPTION 'the inventory changed since the file was checked: check the file again' USING ERRCODE = 'DR051';
  END IF;
  RETURN public.inventory_import_apply(p_org, p_actor, p_plan);
END
$$;

-- ── 8. Y-R10: privilege_violations(), as in 20261021000050 plus the inventory column grants and the break-glass function ──────────
CREATE OR REPLACE FUNCTION public.privilege_violations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ), relacl AS (
    SELECT rel.relname, rel.relkind, a.grantee, a.privilege_type FROM rel CROSS JOIN LATERAL pg_catalog.aclexplode(rel.relacl) a
  ), colacl AS (
    SELECT c.relname, at.attname, a.grantee, a.privilege_type FROM pg_catalog.pg_attribute at JOIN pg_catalog.pg_class c ON c.oid = at.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a
    WHERE n.nspname = 'public' AND at.attacl IS NOT NULL
  ), fn AS (
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, p.proowner, p.proargnames, p.prosrc FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  ), fnacl AS (
    SELECT fn.proname, fn.proargnames, fn.prosrc, fn.proowner, a.grantee FROM fn CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(fn.proacl, pg_catalog.acldefault('f', fn.proowner))) a
    WHERE a.privilege_type = 'EXECUTE'
  ), r AS (
    SELECT rolname, oid FROM pg_catalog.pg_roles
  )
  SELECT pg_catalog.format('%s: authenticated has %s', x.relname, x.privilege_type) FROM relacl x
  WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated') AND x.privilege_type <> 'SELECT'
  UNION ALL
  SELECT pg_catalog.format('%s: anon has %s', x.relname, x.privilege_type) FROM relacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'anon')
  UNION ALL
  SELECT pg_catalog.format('%s: PUBLIC has %s', x.relname, x.privilege_type) FROM relacl x WHERE x.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('%s (column): %s has %s', x.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM r WHERE r.oid = x.grantee) END, x.privilege_type)
  FROM colacl x WHERE x.grantee IN (0, (SELECT oid FROM r WHERE rolname = 'anon'))
     OR (x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated') AND x.privilege_type <> 'SELECT')
  UNION ALL
  SELECT pg_catalog.format('sequence %s: %s has %s', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relkind = 'S' AND x.grantee IN (SELECT oid FROM r WHERE rolname IN ('authenticated', 'app_web', 'media_service', 'monitor_worker', 'video_gateway'))
  UNION ALL
  SELECT pg_catalog.format('%s: %s has %s (server-only table)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps', 'worker_leases', 'test_fixture_switch', 'nvr_login_state')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'worker_leases', 'test_fixture_switch', 'nvr_login_state') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = x.relname)
  UNION ALL
  SELECT pg_catalog.format('%s: app_web may %s (observations are written by the worker)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.relname IN ('check_state', 'outages', 'worker_state', 'monitor_gaps', 'media_sessions') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
  UNION ALL
  -- Final clean-up (Y-R4): the inventory tables too, for INSERT and UPDATE.
  SELECT pg_catalog.format('%s: app_web may %s every column (column grants only; the rest goes through the audited functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE ((x.relname IN ('recorders', 'profiles') AND x.privilege_type = 'UPDATE')
                       OR (x.relname IN ('regions', 'clusters', 'locations', 'cameras', 'assets') AND x.privilege_type IN ('INSERT', 'UPDATE')))
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
  UNION ALL
  SELECT pg_catalog.format('%s.%s: app_web may %s it (archive state, organisation and ids change only through the audited functions)', x.relname, x.attname, x.privilege_type)
  FROM colacl x WHERE x.relname IN ('regions', 'clusters', 'locations', 'cameras', 'assets') AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
    AND ((x.attname IN ('archived_at', 'archived_was_active', 'archived_was_enabled', 'id', 'is_recorder') AND x.privilege_type IN ('INSERT', 'UPDATE'))
         OR (x.attname = 'org_id' AND x.privilege_type = 'UPDATE'))
  UNION ALL
  SELECT pg_catalog.format('%s: monitor_worker may %s (the worker writes only through fenced functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') AND x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
  UNION ALL
  SELECT pg_catalog.format('%s (column): monitor_worker may %s (the worker writes only through fenced functions)', x.relname, x.privilege_type)
  FROM colacl x WHERE x.privilege_type IN ('INSERT', 'UPDATE') AND x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
  UNION ALL
  SELECT pg_catalog.format('%s: video_gateway has %s (it may only call its functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('%s (column): video_gateway has %s', x.relname, x.privilege_type) FROM colacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('function %s: PUBLIC may execute', x.proname) FROM fnacl x WHERE x.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('function %s: anon may execute', x.proname) FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'anon')
  UNION ALL
  SELECT pg_catalog.format('function %s: video_gateway may execute (only media_session_open, media_sessions_still_valid, media_session_close, media_session_login_check, media_session_login_refused, media_session_login_report)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
    AND x.proname NOT IN ('media_session_open', 'media_sessions_still_valid', 'media_session_close', 'media_session_login_check', 'media_session_login_refused', 'media_session_login_report')
  UNION ALL
  SELECT pg_catalog.format('function %s: media_service may execute (only the web app counts sign-ins and limits)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'media_service')
    AND x.proname IN ('rate_limit_hit', 'rate_limit_state', 'rate_limit_clear', 'sign_in_gate', 'sign_in_finish')
  UNION ALL
  SELECT pg_catalog.format('function %s: monitor_worker may execute it without a fencing token (every worker write takes p_fencing_token)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
    AND NOT ('p_fencing_token' = ANY (coalesce(x.proargnames, '{}'::text[])))
    AND x.proname NOT IN ('worker_acquire_lease', 'recorder_credential_read', 'media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune', 'nvr_login_gate', 'nvr_login_report')
  UNION ALL
  SELECT pg_catalog.format('function %s: monitor_worker may execute it, and it takes p_fencing_token but never calls the fence', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
    AND 'p_fencing_token' = ANY (coalesce(x.proargnames, '{}'::text[]))
    AND pg_catalog.strpos(coalesce(x.prosrc, ''), 'worker_fence') = 0
    AND x.proname NOT IN ('worker_renew_lease', 'worker_release_lease')
  UNION ALL
  SELECT pg_catalog.format('function %s: %s may execute it (internal; only the fenced functions call it)', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname IN ('worker_fence', 'worker_fence_global', 'worker_fence_org', 'worker_rows_guard') AND x.grantee <> x.proowner
  UNION ALL
  SELECT pg_catalog.format('function %s: %s may execute it (internal; only the login functions call it)', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname IN ('nvr_login_version', 'nvr_login_current', 'nvr_login_path_ok') AND x.grantee <> x.proowner
  UNION ALL
  -- Final clean-up (Y-R3): the break-glass is the database owner's alone.
  SELECT pg_catalog.format('function %s: %s may execute it (break-glass: the database owner only)', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname = 'mfa_code_lock_owner_clear' AND x.grantee <> x.proowner
  UNION ALL
  SELECT pg_catalog.format('function %s reads NVR logins: %s may execute it', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname IN ('recorder_credential_read', 'recorder_read_credential', 'recorder_secret_equals')
    AND x.grantee NOT IN (SELECT oid FROM r WHERE rolname IN ('service_role', 'media_service', 'monitor_worker', 'postgres'))
  UNION ALL
  SELECT pg_catalog.format('function %s: SECURITY DEFINER without search_path = ''''', f.proname) FROM fn f
  WHERE f.prosecdef AND NOT coalesce('search_path=""' = ANY (f.proconfig), false)
  UNION ALL
  SELECT 'default privileges: new functions are executable by PUBLIC (no global default for postgres revokes it)'
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = (SELECT oid FROM r WHERE rolname = 'postgres')
                    AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f')
  UNION ALL
  SELECT 'default privileges: the global default for postgres still gives PUBLIC EXECUTE on new functions'
  FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
  WHERE d.defaclrole = (SELECT oid FROM r WHERE rolname = 'postgres') AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f' AND a.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('default privileges still give %s access to new objects of kind %s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM r WHERE r.oid = a.grantee) END, d.defaclobjtype)
  FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
  WHERE n.nspname = 'public' AND d.defaclrole = (SELECT oid FROM r WHERE rolname = 'postgres')
    AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM r WHERE rolname IN ('anon', 'authenticated', 'app_web', 'media_service', 'monitor_worker', 'video_gateway')))
  UNION ALL
  SELECT pg_catalog.format('schema vault: %s has USAGE', rolname) FROM r
  WHERE rolname IN ('anon', 'authenticated', 'app_web', 'media_service', 'monitor_worker', 'video_gateway')
    AND pg_catalog.has_schema_privilege(r.oid, 'vault', 'USAGE')
  UNION ALL
  SELECT pg_catalog.format('auth.users: %s sign-in account(s) carry the role %s (PostgREST would switch their sessions to it)', pg_catalog.count(*), u.role)
  FROM auth.users u WHERE u.role IS NOT NULL AND u.role NOT IN ('', 'authenticated') GROUP BY u.role
  UNION ALL
  SELECT 'auth.users: the trigger drishti_users_role_check (no service role on a sign-in account) is missing'
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'drishti_users_role_check' AND t.tgenabled <> 'D')
$$;

-- ── privileges (explicit; the replaced functions get back exactly the grants they had) ──────────────────────────────────────────────
REVOKE ALL ON FUNCTION
  public.security_set_mfa(uuid, uuid, boolean, text),
  public.security_mfa_overview(),
  public.mfa_code_lock_owner_clear(uuid, uuid, text),
  public.inventory_write_guard(),
  public.access_check_password_reset(uuid, uuid, uuid),
  public.recorder_save_login(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid, text, integer),
  public.inventory_import_stamp(uuid),
  public.inventory_import_run(uuid, uuid, jsonb, text),
  public.inventory_import_apply(uuid, uuid, jsonb),
  public.privilege_violations()
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION
  public.security_set_mfa(uuid, uuid, boolean, text),
  public.security_mfa_overview(),
  public.access_check_password_reset(uuid, uuid, uuid),
  public.recorder_save_login(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid, text, integer),
  public.inventory_import_stamp(uuid),
  public.inventory_import_run(uuid, uuid, jsonb, text)
TO app_web, service_role;
-- The plan runner without the lock and the stamp: the service key's only (tests, tooling); the web app uses inventory_import_run.
GRANT EXECUTE ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN
    RAISE EXCEPTION 'privilege_violations() is not empty after 0051: %', (SELECT string_agg(v, '; ') FROM public.privilege_violations() v);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
