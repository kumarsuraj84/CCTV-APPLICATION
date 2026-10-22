-- Undoes 20261021000012_capability_access_fixes.sql: brings back the 0009 definitions (non-monotonic grants, preview and expiry
-- without the organisation, the migration callable by the service role and not skipping migrated people, the person foreign key).
-- Run before the rollbacks of 0011, 0010, 0009, 0008.
-- WARNING: grants of people whose profile was deleted after 0012 have no person any more; they are deleted here, because the
-- restored foreign key (with ON DELETE CASCADE) cannot point at a missing profile.
BEGIN;

-- ── Grants and their person ──────────────────────────────────────────────────
DELETE FROM public.access_grants g WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = g.user_id AND p.org_id = g.org_id);
ALTER TABLE public.access_grants DROP CONSTRAINT IF EXISTS access_grants_org_fk;
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations (id);
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_user_fk FOREIGN KEY (user_id, org_id) REFERENCES public.profiles (id, org_id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.access_grants_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_kinds text[];
BEGIN
  SELECT c.scope_kinds INTO v_kinds FROM public.capabilities c WHERE c.key = NEW.capability;
  IF v_kinds IS NULL THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF NOT (NEW.scope_kind = ANY (v_kinds)) THEN
    RAISE EXCEPTION 'a % grant cannot have % scope', NEW.capability, NEW.scope_kind USING ERRCODE = '22023';
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a grant cannot start revoked' USING ERRCODE = '22023';
  END IF;
  NEW.location_id := CASE WHEN NEW.scope_kind = 'location' THEN NEW.scope_id END;
  NEW.camera_id := CASE WHEN NEW.scope_kind = 'camera' THEN NEW.scope_id END;
  NEW.asset_id := CASE WHEN NEW.scope_kind = 'asset' THEN NEW.scope_id END;
  NEW.granted_at := now();
  RETURN NEW;
END
$$;

-- ── Identity helpers (0001) ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid() AND is_active AND NOT coalesce(must_reset_password, false)
$$;
CREATE OR REPLACE FUNCTION public.current_user_role() RETURNS public.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE id = auth.uid() AND is_active AND NOT coalesce(must_reset_password, false)
$$;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO PUBLIC;

-- ── MFA and the rules (0009) ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mfa_enforced() RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.access_caller_aal2() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT auth.jwt()) ->> 'aal', '') = 'aal2'
$$;
CREATE OR REPLACE FUNCTION public.access_grants_of(p_user uuid, p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS TABLE (org_id uuid, capability text, area text, scope_kind text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.org_id, g.capability, c.area, g.scope_kind, g.scope_id
  FROM public.access_grants g
  JOIN public.profiles p ON p.id = g.user_id AND p.org_id = g.org_id
  JOIN public.capabilities c ON c.key = g.capability
  WHERE g.user_id = p_user
    AND g.revoked_at IS NULL
    AND g.valid_from <= p_at AND (g.valid_until IS NULL OR g.valid_until > p_at)
    AND (p_ignore_status OR (p.is_active AND NOT p.must_reset_password))
    AND (NOT c.requires_mfa OR NOT public.mfa_enforced() OR p_aal2)
$$;
DROP FUNCTION IF EXISTS public.access_session_capabilities(uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.access_grants_eval(uuid, timestamptz, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.access_aal2_of(jsonb);

-- ── Reporting names (0009) ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.report_effective_camera_ids(uuid, text, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.report_effective_device_ids(uuid, text, timestamptz, boolean);
CREATE OR REPLACE FUNCTION public.access_effective_camera_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;
CREATE OR REPLACE FUNCTION public.access_effective_device_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_devices_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;

-- ── Writes (0009) ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.access_put_grant(
  p_org uuid, p_user uuid, p_spec jsonb, p_actor uuid, p_reason text, p_source text, p_needs_review boolean,
  OUT grant_id uuid, OUT added boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_from timestamptz := NULLIF(p_spec ->> 'valid_from', '')::timestamptz;
  v_until timestamptz := NULLIF(p_spec ->> 'valid_until', '')::timestamptz;
  v_g public.access_grants%ROWTYPE;
BEGIN
  PERFORM public.access_check_spec(p_org, p_spec);
  SELECT * INTO v_g FROM public.access_grants g
  WHERE g.user_id = p_user AND g.capability = v_cap AND g.scope_kind = v_kind AND g.scope_id IS NOT DISTINCT FROM v_scope AND g.revoked_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_g.valid_until IS NOT DISTINCT FROM v_until AND ((v_from IS NULL AND v_g.valid_from <= now()) OR v_g.valid_from = v_from) THEN
      grant_id := v_g.id;
      added := false;
      RETURN;
    END IF;
    UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = 'Replaced by a grant with other dates.'
    WHERE id = v_g.id;
  END IF;
  INSERT INTO public.access_grants (org_id, user_id, capability, scope_kind, scope_id, valid_from, valid_until, granted_by, reason, source, needs_review)
  VALUES (p_org, p_user, v_cap, v_kind, v_scope, coalesce(v_from, now()), v_until, p_actor, p_reason, p_source, p_needs_review)
  RETURNING id INTO grant_id;
  added := true;
END
$$;
DROP FUNCTION IF EXISTS public.access_merge_window(timestamptz, timestamptz, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.grant_access(
  p_org uuid, p_user uuid, p_grants jsonb, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_spec jsonb;
  v_put record;
  v_ids uuid[] := '{}';
  v_added integer := 0;
BEGIN
  IF jsonb_typeof(p_grants) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'grants must be a list' USING ERRCODE = '22023'; END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  FOR v_spec IN SELECT e.value FROM jsonb_array_elements(p_grants) AS e LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_spec, p_actor, p_reason, 'manual', false);
    v_ids := v_ids || v_put.grant_id;
    IF v_put.added THEN v_added := v_added + 1; END IF;
  END LOOP;
  IF v_added > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'grant_ids', to_jsonb(v_ids), 'added', v_added, 'unchanged', cardinality(v_ids) - v_added);
END
$$;

CREATE OR REPLACE FUNCTION public.revoke_grant(
  p_org uuid, p_user uuid, p_grant_ids uuid[], p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_n integer;
BEGIN
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_grant_ids, '{}')) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = x.id AND g.user_id = p_user AND g.org_id = p_org)) THEN
    RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = coalesce(p_reason, 'Revoked.')
  WHERE id = ANY (coalesce(p_grant_ids, '{}')) AND user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'revoked', v_n);
END
$$;

CREATE OR REPLACE FUNCTION public.replace_user_grants(
  p_org uuid, p_user uuid, p_capabilities text[], p_scope_kinds text[], p_grants jsonb,
  p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_spec jsonb;
  v_put record;
  v_added integer := 0;
  v_revoked integer := 0;
  v_kept integer := 0;
BEGIN
  IF jsonb_typeof(p_grants) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'grants must be a list' USING ERRCODE = '22023'; END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_grants) AS e
             WHERE NOT (e.value ->> 'capability' = ANY (p_capabilities)) OR NOT (e.value ->> 'scope_kind' = ANY (p_scope_kinds))) THEN
    RAISE EXCEPTION 'a grant is outside the capabilities or scope kinds being replaced' USING ERRCODE = '22023';
  END IF;
  WITH wanted AS (
    SELECT DISTINCT e.value ->> 'capability' AS cap, e.value ->> 'scope_kind' AS kind, NULLIF(e.value ->> 'scope_id', '')::uuid AS sid
    FROM jsonb_array_elements(p_grants) AS e
  )
  UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor, revoke_reason = coalesce(p_reason, 'Removed from the access list.')
  WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL
    AND g.capability = ANY (p_capabilities) AND g.scope_kind = ANY (p_scope_kinds)
    AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.cap = g.capability AND w.kind = g.scope_kind AND w.sid IS NOT DISTINCT FROM g.scope_id);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  FOR v_spec IN SELECT e.value FROM jsonb_array_elements(p_grants) AS e LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_spec, p_actor, p_reason, 'manual', false);
    IF v_put.added THEN v_added := v_added + 1; ELSE v_kept := v_kept + 1; END IF;
  END LOOP;
  IF v_added + v_revoked > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'added', v_added, 'revoked', v_revoked, 'unchanged', v_kept);
END
$$;
DROP FUNCTION IF EXISTS public.access_check_actor(uuid, uuid);

-- ── Preview and expiry (0009 signatures) ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.preview_access_change(uuid, uuid, jsonb, timestamptz, integer);
CREATE OR REPLACE FUNCTION public.preview_access_change(p_user uuid, p_changes jsonb, p_at timestamptz DEFAULT now(), p_sample integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_version bigint;
  v_active boolean;
  v_before jsonb;
  v_after jsonb;
  v_change jsonb;
  v_revoke uuid[] := '{}';
  v_cap text;
  v_out jsonb := '{}'::jsonb;
  v_sample integer := least(greatest(coalesce(p_sample, 10), 0), 100);
BEGIN
  SELECT p.org_id, p.access_version, (p.is_active AND NOT p.must_reset_password) INTO v_org, v_version, v_active
  FROM public.profiles p WHERE p.id = p_user;
  IF v_org IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'changes must be a list' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'capability', g.capability, 'scope_kind', g.scope_kind, 'scope_id', g.scope_id,
                                               'valid_from', g.valid_from, 'valid_until', g.valid_until)), '[]'::jsonb)
  INTO v_before
  FROM public.access_grants g WHERE g.user_id = p_user AND g.org_id = v_org AND g.revoked_at IS NULL;
  v_after := v_before;
  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e LOOP
    IF v_change ->> 'op' = 'revoke' THEN
      IF NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = NULLIF(v_change ->> 'grant_id', '')::uuid AND g.user_id = p_user) THEN
        RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
      END IF;
      v_revoke := v_revoke || (v_change ->> 'grant_id')::uuid;
    ELSIF v_change ->> 'op' = 'grant' THEN
      PERFORM public.access_check_spec(v_org, v_change - 'op');
      v_after := v_after || jsonb_build_array((v_change - 'op') || jsonb_build_object('valid_from', coalesce(NULLIF(v_change ->> 'valid_from', ''), now()::text)));
    ELSE
      RAISE EXCEPTION 'unknown change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_after FROM jsonb_array_elements(v_after) AS e
  WHERE e.value ->> 'id' IS NULL OR NOT ((e.value ->> 'id')::uuid = ANY (v_revoke));
  FOR v_cap IN
    SELECT DISTINCT e.value ->> 'capability' FROM jsonb_array_elements(v_before || v_after) AS e ORDER BY 1
  LOOP
    WITH b AS (SELECT * FROM public.access_items(v_org, v_cap, v_before, now())),
         a AS (SELECT * FROM public.access_items(v_org, v_cap, v_after, p_at)),
         added AS (SELECT a.item_id, a.label FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.item_id = a.item_id)),
         removed AS (SELECT b.item_id, b.label FROM b WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.item_id = b.item_id))
    SELECT v_out || jsonb_build_object(v_cap, jsonb_build_object(
      'target', (SELECT CASE c.area WHEN 'cctv' THEN 'camera' WHEN 'it' THEN 'asset' WHEN 'wifi' THEN 'location' ELSE 'organization' END
                 FROM public.capabilities c WHERE c.key = v_cap),
      'added_count', (SELECT count(*) FROM added),
      'removed_count', (SELECT count(*) FROM removed),
      'sample_added', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.item_id, 'label', s.label) ORDER BY s.label, s.item_id)
                                FROM (SELECT * FROM added ORDER BY label, item_id LIMIT v_sample) s), '[]'::jsonb),
      'sample_removed', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.item_id, 'label', s.label) ORDER BY s.label, s.item_id)
                                  FROM (SELECT * FROM removed ORDER BY label, item_id LIMIT v_sample) s), '[]'::jsonb)
    ))
    INTO v_out;
  END LOOP;
  RETURN jsonb_build_object('version', v_version, 'at', p_at, 'person_active', v_active, 'capabilities', v_out);
END
$$;

DROP FUNCTION IF EXISTS public.access_expiring(uuid, interval);
CREATE OR REPLACE FUNCTION public.access_expiring(p_within interval)
RETURNS TABLE (grant_id uuid, org_id uuid, user_id uuid, capability text, scope_kind text, scope_id uuid, valid_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.id, g.org_id, g.user_id, g.capability, g.scope_kind, g.scope_id, g.valid_until
  FROM public.access_grants g
  WHERE g.revoked_at IS NULL AND g.valid_until IS NOT NULL AND g.valid_until > now() AND g.valid_until <= now() + p_within
  ORDER BY g.valid_until, g.id
$$;

-- ── Migration (0009 signature: callable by the service role, does not skip migrated people) ─────
DROP FUNCTION IF EXISTS public.access_migrate_legacy_test(uuid, uuid[], boolean);
DROP FUNCTION IF EXISTS public.access_migrate_legacy(uuid, uuid[], boolean);
DROP FUNCTION IF EXISTS public.access_legacy_store_ids(uuid, boolean);
CREATE OR REPLACE FUNCTION public.access_migrate_legacy(p_run uuid, p_users uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_person record;
  v_store record;
  v_cap text;
  v_camera uuid;
  v_put record;
  v_stores uuid[];
  v_zones text[];
  v_cams uuid[];
  v_narrowed uuid[];
  v_notes text[];
  v_added integer;
  v_total integer := 0;
  v_lost integer;
  v_home_code text;
  v_admin_caps text[] := ARRAY['cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view',
    'it.monitoring.operate', 'wifi.inventory.view', 'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory',
    'admin.alerts', 'admin.audit.read'];
  v_manager_caps text[] := ARRAY['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'];
  v_reason text := 'Migrated from the old access model (P2-1).';
BEGIN
  IF p_run IS NULL THEN RAISE EXCEPTION 'a run id is needed' USING ERRCODE = '22023'; END IF;
  FOR v_person IN
    SELECT p.id, p.org_id, p.role, p.store_id, p.is_active, p.must_reset_password FROM public.profiles p
    WHERE p_users IS NULL OR p.id = ANY (p_users)
    ORDER BY p.org_id, p.id
  LOOP
    v_added := 0;
    v_notes := '{}';
    v_stores := ARRAY(SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = v_person.id ORDER BY a.store_id);
    v_zones := ARRAY(SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = v_person.id ORDER BY z.zone);
    v_cams := ARRAY(SELECT a.camera_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id AND c.org_id = v_person.org_id
                    WHERE a.user_id = v_person.id ORDER BY a.camera_id);
    v_narrowed := ARRAY(SELECT DISTINCT c.store_id FROM public.cameras c WHERE c.id = ANY (v_cams));
    FOR v_store IN
      SELECT s.id, s.code,
             CASE WHEN s.id = ANY (v_stores) THEN 'migrated:store' WHEN s.zone = ANY (v_zones) THEN 'migrated:zone' ELSE 'migrated:home' END AS source
      FROM public.stores s
      WHERE s.org_id = v_person.org_id
        AND (s.id = ANY (v_stores) OR s.zone = ANY (v_zones) OR s.id = v_person.store_id)
        AND NOT (s.id = ANY (v_narrowed))
      ORDER BY s.code, s.id
    LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'location', 'scope_id', v_store.id),
          NULL, v_reason, v_store.source, v_store.source = 'migrated:home');
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;
    FOREACH v_camera IN ARRAY v_cams LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'camera', 'scope_id', v_camera), NULL, v_reason, 'migrated:camera', false);
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;
    IF v_person.role = 'manager' THEN
      FOREACH v_cap IN ARRAY v_manager_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:manager', true);
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Manager role saw everything: migrated as organisation-wide live, playback, IT inventory and IT monitoring grants, flagged for review (D-2a).'::text;
    ELSIF v_person.role IN ('admin', 'platform_owner') THEN
      FOREACH v_cap IN ARRAY v_admin_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:admin', false);
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Administrator: organisation-wide administrative set granted so existing administrator work keeps working.'::text;
    END IF;
    IF v_person.store_id IS NOT NULL THEN
      SELECT s.code INTO v_home_code FROM public.stores s WHERE s.id = v_person.store_id;
      IF v_person.store_id = ANY (v_narrowed) THEN
        v_notes := v_notes || format('Home store %s had camera grants inside it, so only those cameras were kept (as before).', v_home_code);
      ELSIF NOT (v_person.store_id = ANY (v_stores))
            AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = v_person.store_id AND s.zone = ANY (v_zones)) THEN
        v_notes := v_notes || format('Home store %s was a hidden grant: migrated as explicit live and playback grants, flagged for review (D-2a). The home store now grants nothing by itself (AC-7).', v_home_code);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_zones) AS z(zone)
               WHERE NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.org_id = v_person.org_id AND s.zone = z.zone)) THEN
      v_notes := v_notes || 'A zone grant had no stores in it: nothing to migrate for that zone.'::text;
    END IF;
    IF v_person.role NOT IN ('manager', 'admin', 'platform_owner') THEN
      SELECT count(*) INTO v_lost FROM public.access_legacy_device_ids(v_person.id, true);
      IF v_lost > 0 THEN
        v_notes := v_notes || format('IT devices no longer visible: %s. They were visible only through a store, zone or home-store grant, which is not migrated (directive AC-4).', v_lost);
      END IF;
    END IF;
    IF NOT v_person.is_active THEN
      v_notes := v_notes || 'Account inactive: grants were migrated and take effect only if the account is reactivated.'::text;
    ELSIF v_person.must_reset_password THEN
      v_notes := v_notes || 'The person must still choose a password: the grants take effect after that.'::text;
    END IF;
    INSERT INTO public.access_migration_report (run_id, org_id, user_id, old_model, new_grants, note)
    VALUES (
      p_run, v_person.org_id, v_person.id,
      jsonb_build_object(
        'role', v_person.role, 'is_active', v_person.is_active, 'must_reset_password', v_person.must_reset_password,
        'home_store_id', v_person.store_id, 'stores', to_jsonb(v_stores), 'zones', to_jsonb(v_zones), 'cameras', to_jsonb(v_cams),
        'legacy_camera_count', (SELECT count(*) FROM public.access_legacy_camera_ids(v_person.id, true)),
        'legacy_device_count', (SELECT count(*) FROM public.access_legacy_device_ids(v_person.id, true))),
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'capability', g.capability, 'scope_kind', g.scope_kind, 'scope_id', g.scope_id,
                                                    'source', g.source, 'needs_review', g.needs_review) ORDER BY g.capability, g.scope_kind, g.scope_id)
                FROM public.access_grants g WHERE g.user_id = v_person.id AND g.revoked_at IS NULL), '[]'::jsonb),
      NULLIF(array_to_string(v_notes, ' '), '')
    );
    IF v_added > 0 THEN PERFORM public.access_bump_version(v_person.id); END IF;
    v_total := v_total + v_added;
  END LOOP;
  RETURN v_total;
END
$$;

-- ── Privileges as in 0009 ────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  public.access_effective_camera_ids(uuid, text, timestamptz, boolean), public.access_effective_device_ids(uuid, text, timestamptz, boolean),
  public.preview_access_change(uuid, jsonb, timestamptz, integer), public.access_expiring(interval), public.access_migrate_legacy(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.access_effective_camera_ids(uuid, text, timestamptz, boolean), public.access_effective_device_ids(uuid, text, timestamptz, boolean),
  public.preview_access_change(uuid, jsonb, timestamptz, integer), public.access_expiring(interval), public.access_migrate_legacy(uuid, uuid[])
  TO service_role;

COMMIT;
