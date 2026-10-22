-- P2-6 (WP-2.4, D-14, D-14a, D-11): per-service database roles, logged credential reads, the shared rate limiter, SQL hygiene.
--
-- Spike (docs/drishti/adr-service-roles.md): PostgREST on the pinned stack switches to the role named by a JWT's `role` claim when the
-- authenticator is a member of it. So every server process gets its own least-privilege role and its own JWT (scripts/gen-secrets.mjs):
--   app_web        the web app: the tables/RPCs its code uses; NO credential read, no observation writes, no worker/gateway/test RPCs
--   media_service  the video path (and, until WP-4.3, the NVR discovery / connection test of the web process): routes, media sessions,
--                  credential reads for video purposes, the access audit of video
--   monitor_worker the worker: monitoring inputs, monitor_apply_results, its own worker_state columns, credential reads for monitoring,
--                  housekeeping (media_sessions_prune, rate_limit_prune, vault_reads_prune)
--   video_gateway  the gateway: EXECUTE on media_session_open / media_sessions_still_valid / media_session_close and nothing else
-- The service role keeps what it has (administrator's break-glass key: scripts, seeding, tests). Per organisation,
-- security_settings.service_role_credential_reads = false makes the database refuse NVR credential reads by the service role.
--
-- Also (brief items 4, 6, 7 and the addendum):
--   * vault_reads: every credential read is logged (role, person when known, recorder, purpose, outcome, time; never a value)
--   * recorder_credential_read(recorder, purpose, actor): the only credential read for services; purposes per role
--   * rate_limit_hits + rate_limit_hit / rate_limit_state / rate_limit_clear / rate_limit_prune (D-11)
--   * search_path '' on the four remaining SECURITY DEFINER functions (monitor_request_check, revoke_user_sessions, targets_uptime,
--     privilege_violations), privilege_violations() extended to functions, sequences, views, the global default ACL and the new roles
--   * monitor_apply_results: a camera result MUST name its recorder (review M-3 of P2-5b)
--   * inventory_import_apply: its saved-password comparison is logged (import_compare)
-- Rollback: supabase/rollback/20261021000033_p26_service_roles_rollback.sql (dry run: BEGIN; \i …; ROLLBACK;).

BEGIN;

-- ── 1. Roles ──────────────────────────────────────────────────────────────────
-- Roles belong to the whole database cluster, so they may already exist (a database reset keeps them): created once, attributes set
-- every time. NOLOGIN: only the authenticator (PostgREST) may switch to them. NOINHERIT: they never pick up another role's rights.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_web', 'media_service', 'monitor_worker', 'video_gateway'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
    END IF;
  END LOOP;
END $$;
-- The three server roles read across the organisations they serve (as the service role does today); every query in their code is
-- org-scoped explicitly. The gateway reads no table at all, so it does not bypass row-level security.
ALTER ROLE app_web NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE media_service NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE monitor_worker NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE video_gateway NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- No role settings of their own: like the service role, they keep the authenticator's statement and lock timeouts.
GRANT app_web, media_service, monitor_worker, video_gateway TO authenticator;

GRANT USAGE ON SCHEMA public TO app_web, media_service, monitor_worker, video_gateway;

-- Closed defaults stay closed: nothing new is executable by PUBLIC (the global default of the migration owner), and no default
-- privilege reaches the new roles (each object in this file and later ones grants them explicitly).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ── 2. Security settings (per organisation) ──────────────────────────────────
-- Written only by the database owner (psql, a migration) — never through the API, not even by the service role, so a process that
-- holds the service key cannot switch its own lock off. The runbook (docs/drishti/runbooks/secret-rotation.md) gives the statement.
CREATE TABLE public.security_settings (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- true (default, development): the service role may still read NVR logins (tooling, tests, processes without their own key yet).
  -- false (production checklist): only media_service and monitor_worker may; the service role is refused (42501).
  service_role_credential_reads boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(note) <= 500)
);
ALTER TABLE public.security_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.security_settings FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.security_settings TO service_role;

CREATE FUNCTION public.service_role_may_read_credentials(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.service_role_credential_reads FROM public.security_settings s WHERE s.org_id = p_org), true)
$$;
REVOKE ALL ON FUNCTION public.service_role_may_read_credentials(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Tests only: set the lock for a TEST organisation (inventory_require_test_org refuses every other one).
CREATE FUNCTION public.security_settings_set_test(p_org uuid, p_service_role_credential_reads boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  INSERT INTO public.security_settings (org_id, service_role_credential_reads, note)
  VALUES (p_org, p_service_role_credential_reads, 'test fixture')
  ON CONFLICT (org_id) DO UPDATE SET service_role_credential_reads = EXCLUDED.service_role_credential_reads, updated_at = now();
END
$$;
REVOKE ALL ON FUNCTION public.security_settings_set_test(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.security_settings_set_test(uuid, boolean) TO service_role;

-- ── 3. Credential reads: purposes per role, and the log ──────────────────────
CREATE TABLE public.vault_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  recorder_id uuid,                 -- no foreign key: the log outlives an archived or purged recorder
  db_role text NOT NULL CHECK (length(db_role) BETWEEN 1 AND 63),
  actor_id uuid,                    -- the person the read was for, when the service knows it (an admin's discovery, a viewer's stream)
  purpose text NOT NULL CHECK (purpose IN ('monitoring', 'discovery', 'connection_test', 'live', 'playback', 'vod', 'export', 'import_compare', 'unspecified')),
  outcome text NOT NULL CHECK (outcome IN ('read', 'none', 'compared')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_reads_org_at_idx ON public.vault_reads (org_id, at DESC);
CREATE INDEX vault_reads_recorder_at_idx ON public.vault_reads (recorder_id, at DESC);
ALTER TABLE public.vault_reads ENABLE ROW LEVEL SECURITY;
-- Append-only through the credential functions; readable by the service role (diagnostics) only.
REVOKE ALL ON public.vault_reads FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.vault_reads TO service_role;

-- Who is calling: the role PostgREST switched to (SET ROLE survives into SECURITY DEFINER functions), else the session's user.
CREATE FUNCTION public.service_caller_role() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(nullif(nullif(pg_catalog.current_setting('role', true), ''), 'none'), session_user::text)
$$;
REVOKE ALL ON FUNCTION public.service_caller_role() FROM PUBLIC, anon, authenticated, service_role;

-- Which role may read NVR logins for which purpose (D-14). The service role: any purpose (break-glass), subject to the per-org lock.
CREATE FUNCTION public.credential_purpose_allowed(p_role text, p_purpose text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_role
    WHEN 'service_role' THEN p_purpose IN ('monitoring', 'discovery', 'connection_test', 'live', 'playback', 'vod', 'export', 'unspecified')
    WHEN 'postgres' THEN p_purpose IN ('monitoring', 'discovery', 'connection_test', 'live', 'playback', 'vod', 'export', 'unspecified')
    WHEN 'monitor_worker' THEN p_purpose IN ('monitoring')
    WHEN 'media_service' THEN p_purpose IN ('live', 'playback', 'vod', 'export', 'discovery', 'connection_test')
    ELSE false END
$$;
REVOKE ALL ON FUNCTION public.credential_purpose_allowed(text, text) FROM PUBLIC, anon, authenticated, service_role;

/**
 * The saved login of ONE recorder for ONE purpose, logged in vault_reads (never the value). Refuses (42501) a role that may not read
 * for that purpose and the service role of an organisation that locked it out; refuses (55000) a switched-off NVR, like
 * recorder_read_credential. NULL for an unknown recorder (nothing logged) or one without a saved password (logged as 'none').
 */
CREATE FUNCTION public.recorder_credential_read(p_recorder uuid, p_purpose text, p_actor uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := public.service_caller_role();
  v_org uuid;
  v_secret uuid;
  v_on boolean;
  v text;
BEGIN
  IF p_purpose IS NULL OR NOT public.credential_purpose_allowed(v_role, p_purpose) THEN
    RAISE EXCEPTION 'this service may not read NVR logins for this purpose' USING ERRCODE = '42501';
  END IF;
  SELECT r.org_id, r.secret_id, r.monitoring_enabled INTO v_org, v_secret, v_on FROM public.recorders r WHERE r.id = p_recorder;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_role = 'service_role' AND NOT public.service_role_may_read_credentials(v_org) THEN
    RAISE EXCEPTION 'NVR logins are not read with the service key in this organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT v_on THEN
    RAISE EXCEPTION 'monitoring is switched off for this NVR: its login is not read' USING ERRCODE = '55000';
  END IF;
  SELECT ds.decrypted_secret INTO v FROM vault.decrypted_secrets ds WHERE ds.id = v_secret;
  INSERT INTO public.vault_reads (org_id, recorder_id, db_role, actor_id, purpose, outcome)
  VALUES (v_org, p_recorder, v_role, p_actor, p_purpose, CASE WHEN v IS NULL THEN 'none' ELSE 'read' END);
  RETURN v;
END
$$;
REVOKE ALL ON FUNCTION public.recorder_credential_read(uuid, text, uuid) FROM PUBLIC, anon, authenticated, app_web, video_gateway;
GRANT EXECUTE ON FUNCTION public.recorder_credential_read(uuid, text, uuid) TO service_role, media_service, monitor_worker;

-- The legacy read (service role tooling and tests): logged as 'unspecified', refused when the organisation locked the service role out.
CREATE OR REPLACE FUNCTION public.recorder_read_credential(p_recorder uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := public.service_caller_role();
  v_org uuid;
  v_secret uuid;
  v_on boolean;
  v text;
BEGIN
  SELECT r.org_id, r.secret_id, r.monitoring_enabled INTO v_org, v_secret, v_on FROM public.recorders r WHERE r.id = p_recorder;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_role = 'service_role' AND NOT public.service_role_may_read_credentials(v_org) THEN
    RAISE EXCEPTION 'NVR logins are not read with the service key in this organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT v_on THEN
    RAISE EXCEPTION 'monitoring is switched off for this NVR: its login is not read' USING ERRCODE = '55000';
  END IF;
  SELECT ds.decrypted_secret INTO v FROM vault.decrypted_secrets ds WHERE ds.id = v_secret;
  INSERT INTO public.vault_reads (org_id, recorder_id, db_role, purpose, outcome)
  VALUES (v_org, p_recorder, v_role, 'unspecified', CASE WHEN v IS NULL THEN 'none' ELSE 'read' END);
  RETURN v;
END
$$;
REVOKE ALL ON FUNCTION public.recorder_read_credential(uuid) FROM PUBLIC, anon, authenticated, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.recorder_read_credential(uuid) TO service_role;

-- Internal (no grants): does the saved password of a recorder equal this one? Logged as 'import_compare'. Only inventory_import_apply
-- uses it (P2-5c-2 B-I3: a callable comparison would be an oracle).
CREATE FUNCTION public.recorder_secret_equals(p_org uuid, p_recorder uuid, p_secret text, p_actor uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_same boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.recorders r JOIN vault.decrypted_secrets ds ON ds.id = r.secret_id
                 WHERE r.id = p_recorder AND r.org_id = p_org AND ds.decrypted_secret = p_secret) INTO v_same;
  INSERT INTO public.vault_reads (org_id, recorder_id, db_role, actor_id, purpose, outcome)
  VALUES (p_org, p_recorder, public.service_caller_role(), p_actor, 'import_compare', 'compared');
  RETURN v_same;
END
$$;
REVOKE ALL ON FUNCTION public.recorder_secret_equals(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- The log is kept for 180 days by default (the worker prunes it; at most 90..3650 days kept).
CREATE FUNCTION public.vault_reads_prune(p_keep interval DEFAULT '180 days') RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '90 days' OR p_keep > interval '3650 days' THEN
    RAISE EXCEPTION 'keep between 90 and 3650 days' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.vault_reads WHERE at < now() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.vault_reads_prune(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_reads_prune(interval) TO service_role, monitor_worker;

-- ── 4. inventory_import_apply: the saved-password comparison is logged ────────
-- Unchanged from 20261021000031 except the one comparison (marked P2-6), which now goes through recorder_secret_equals.
CREATE OR REPLACE FUNCTION public.inventory_import_apply(p_org uuid, p_actor uuid, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role public.user_role;
  v_item jsonb;
  v_rec jsonb;
  v_fields jsonb;
  v_line integer;
  v_state text;
  v_msg text;
  v_region uuid;
  v_cluster uuid;
  v_loc uuid;
  v_recorder uuid;
  v_id uuid;
  v_cam uuid;
  v_ph jsonb;
  v_on boolean;
  v_was boolean;
  v_channels integer;
  c_regions integer := 0;
  c_clusters integer := 0;
  c_loc_created integer := 0;
  c_loc_updated integer := 0;
  c_rec_created integer := 0;
  c_rec_updated integer := 0;
  c_passwords integer := 0;
  c_given integer := 0;
  c_cameras integer := 0;
  c_relinked integer := 0;
  a_locations integer := 0;
  a_recorders integer := 0;
  a_cameras integer := 0;
  v_dropped uuid[] := '{}';
BEGIN
  -- The acting person, as recorder_set_monitoring asks: active, password chosen, a super administrator, or an administrator holding
  -- admin.inventory for the whole organisation. The application has asked the same from the person's own summary first.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR (v_role <> 'platform_owner' AND NOT EXISTS (
           SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
           WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
    RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory may import' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'the plan must be an object' USING ERRCODE = '22023'; END IF;

  -- Regions and clusters the file needs (by code; created with the code as name, renamed later on their page).
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'regions', '[]'::jsonb)) AS e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.org_id = p_org AND r.code = v_item->>'code' AND r.archived_at IS NULL) THEN
      INSERT INTO public.regions (org_id, code, name) VALUES (p_org, v_item->>'code', coalesce(nullif(v_item->>'name', ''), v_item->>'code'));
      c_regions := c_regions + 1;
    END IF;
  END LOOP;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'clusters', '[]'::jsonb)) AS e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'code' AND c.archived_at IS NULL) THEN
      v_region := NULL;
      IF v_item->>'region_code' IS NOT NULL THEN
        SELECT r.id INTO v_region FROM public.regions r WHERE r.org_id = p_org AND r.code = v_item->>'region_code' AND r.archived_at IS NULL;
        IF v_region IS NULL THEN RAISE EXCEPTION 'region not found' USING ERRCODE = 'P0002'; END IF;
      END IF;
      INSERT INTO public.clusters (org_id, code, name, region_id) VALUES (p_org, v_item->>'code', coalesce(nullif(v_item->>'name', ''), v_item->>'code'), v_region);
      c_clusters := c_clusters + 1;
    END IF;
  END LOOP;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'locations', '[]'::jsonb)) AS e LOOP
    v_line := (v_item->>'line')::integer;
    BEGIN
      v_fields := coalesce(v_item->'fields', '{}'::jsonb);
      IF v_item->>'action' = 'create' THEN
        v_cluster := NULL;
        IF v_item->>'cluster' IS NOT NULL THEN
          SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'cluster' AND c.archived_at IS NULL;
          IF v_cluster IS NULL THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
        END IF;
        INSERT INTO public.locations (org_id, code, name, kind, city, zone, state, address, cluster_id)
        VALUES (p_org, v_item->>'code', v_fields->>'name', coalesce(v_fields->>'kind', 'store'), v_fields->>'city', v_fields->>'zone',
                v_fields->>'state', v_fields->>'address', v_cluster)
        RETURNING id INTO v_loc;
        c_loc_created := c_loc_created + 1;
        INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
        VALUES (p_org, p_actor, 'location_created', 'location', v_loc, jsonb_build_object('code', v_item->>'code', 'kind', coalesce(v_fields->>'kind', 'store'), 'imported', true));
      ELSE
        v_loc := (v_item->>'id')::uuid;
        PERFORM 1 FROM public.locations l WHERE l.id = v_loc AND l.org_id = p_org AND l.archived_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
        IF v_fields <> '{}'::jsonb THEN
          UPDATE public.locations SET
            name = CASE WHEN v_fields ? 'name' THEN v_fields->>'name' ELSE name END,
            kind = CASE WHEN v_fields ? 'kind' THEN v_fields->>'kind' ELSE kind END,
            city = CASE WHEN v_fields ? 'city' THEN v_fields->>'city' ELSE city END,
            zone = CASE WHEN v_fields ? 'zone' THEN v_fields->>'zone' ELSE zone END,
            state = CASE WHEN v_fields ? 'state' THEN v_fields->>'state' ELSE state END,
            address = CASE WHEN v_fields ? 'address' THEN v_fields->>'address' ELSE address END
          WHERE id = v_loc;
          INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
          VALUES (p_org, p_actor, 'location_updated', 'location', v_loc, jsonb_build_object('changed', (SELECT jsonb_agg(k) FROM jsonb_object_keys(v_fields) AS k), 'imported', true));
        END IF;
        -- A location without a cluster joins the one of the file like any move (access versions, audit); one in a cluster stays.
        IF v_item->>'join_cluster' IS NOT NULL THEN
          SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'join_cluster' AND c.archived_at IS NULL;
          IF v_cluster IS NULL THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
          IF (SELECT l.cluster_id FROM public.locations l WHERE l.id = v_loc) IS NULL THEN
            PERFORM public.inventory_move_location(p_org, v_loc, v_cluster, p_actor);
          END IF;
        END IF;
        IF v_item->>'action' = 'update' THEN c_loc_updated := c_loc_updated + 1; END IF;
      END IF;

      FOR v_rec IN SELECT e.value FROM jsonb_array_elements(coalesce(v_item->'recorders', '[]'::jsonb)) AS e LOOP
        v_line := (v_rec->>'line')::integer;
        v_channels := (v_rec->>'channels')::integer;
        IF v_rec->>'action' = 'unchanged' AND coalesce((v_rec->>'placeholders')::integer, 0) = 0 AND NOT (v_rec ? 'password') THEN CONTINUE; END IF;
        IF v_rec->>'action' IN ('create', 'update') THEN
          v_recorder := public.recorder_save(p_org, v_loc, CASE WHEN v_rec->>'action' = 'create' THEN NULL ELSE (v_rec->>'id')::uuid END,
            v_rec->>'host', (v_rec->>'http_port')::integer, (v_rec->>'rtsp_port')::integer, v_rec->>'username', v_channels,
            nullif(v_rec->>'name', ''), p_actor);
          IF v_rec->>'action' = 'create' THEN c_rec_created := c_rec_created + 1; ELSE c_rec_updated := c_rec_updated + 1; END IF;
          IF v_rec ? 'monitoring' THEN
            v_on := (v_rec->>'monitoring')::boolean;
            SELECT r.monitoring_enabled INTO v_was FROM public.recorders r WHERE r.id = v_recorder;
            IF v_was IS DISTINCT FROM v_on THEN
              PERFORM public.recorder_set_monitoring(p_org, v_recorder, v_on,
                CASE WHEN v_on THEN 'Switched on by the CSV import.' ELSE 'Switched off by the CSV import.' END, p_actor);
            END IF;
          END IF;
        ELSE
          -- An NVR the plan does not otherwise change: it must be a live NVR of this organisation and location.
          v_recorder := (v_rec->>'id')::uuid;
          PERFORM 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
          WHERE r.id = v_recorder AND r.org_id = p_org AND r.location_id = v_loc;
          IF NOT FOUND THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
        END IF;
        -- B-I3: a password the file gives is written (and audited, without the value) only when it differs from the saved one.
        -- P2-6: the comparison reads the vault, so it is logged (vault_reads, purpose import_compare; never the value).
        IF v_rec ? 'password' THEN
          c_given := c_given + 1;
          IF NOT public.recorder_secret_equals(p_org, v_recorder, v_rec->>'password', p_actor) THEN
            PERFORM public.recorder_store_credential(v_recorder, v_rec->>'password');
            c_passwords := c_passwords + 1;
            INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
            VALUES (p_org, p_actor, 'recorder_password_set', 'recorder', v_recorder, jsonb_build_object('imported', true));
          END IF;
        END IF;
        IF coalesce(v_channels, 0) > 0 AND (v_rec->>'action' <> 'unchanged' OR coalesce((v_rec->>'placeholders')::integer, 0) > 0) THEN
          v_ph := public.inventory_ensure_placeholders(p_org, v_loc, v_recorder, v_channels);
          c_cameras := c_cameras + (v_ph->>'created')::integer;
          c_relinked := c_relinked + (v_ph->>'relinked')::integer;
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RAISE EXCEPTION USING ERRCODE = v_state, MESSAGE = v_msg, DETAIL = 'import_line:' || coalesce(v_line::text, '?');
    END;
  END LOOP;

  -- What the person confirmed to archive (never deleted; history, grants and vault logins are kept; restorable).
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'archive', '[]'::jsonb)) AS e LOOP
    v_id := (v_item->>'id')::uuid;
    IF v_item->>'kind' = 'camera' THEN
      IF EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_id AND c.org_id = p_org AND c.archived_at IS NULL) THEN
        PERFORM public.inventory_archive(p_org, 'camera', v_id, p_actor);
        a_cameras := a_cameras + 1;
        v_dropped := v_dropped || v_id;
      END IF;
    ELSIF v_item->>'kind' = 'recorder' THEN
      FOR v_cam IN SELECT m.camera_id FROM public.camera_channel_mappings m WHERE m.recorder_id = v_id AND m.org_id = p_org AND m.valid_to IS NULL LOOP
        PERFORM public.inventory_archive(p_org, 'camera', v_cam, p_actor);
        v_dropped := v_dropped || v_cam;
      END LOOP;
      PERFORM public.inventory_archive(p_org, 'recorder', v_id, p_actor);
      a_recorders := a_recorders + 1;
    ELSIF v_item->>'kind' = 'location' THEN
      v_dropped := v_dropped || ARRAY(SELECT c.id FROM public.cameras c WHERE c.location_id = v_id AND c.org_id = p_org AND c.archived_at IS NULL);
      PERFORM public.inventory_archive(p_org, 'location', v_id, p_actor);
      a_locations := a_locations + 1;
    ELSE
      RAISE EXCEPTION 'unknown kind to archive' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'locations_imported', 'organization', p_org, jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_given', c_given, 'passwords_written', c_passwords, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked,
    'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras));
  RETURN jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_given', c_given, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked, 'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras, 'dropped_camera_ids', to_jsonb(v_dropped));
END
$function$;
REVOKE ALL ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) TO service_role;

-- ── 5. Shared rate limiter (D-11) ─────────────────────────────────────────────
-- One row per key, window size and window start (fixed windows). Keys are built by lib/rate-limit-shared.ts (never a password; an
-- e-mail address is hashed there before it is used in a key).
CREATE TABLE public.rate_limit_hits (
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  window_sec integer NOT NULL CHECK (window_sec BETWEEN 1 AND 86400),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
  last_hit_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, window_sec, window_start)
);
CREATE INDEX rate_limit_hits_end_idx ON public.rate_limit_hits (window_start);
ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_hits FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.rate_limit_hits TO service_role;

CREATE FUNCTION public.rate_limit_window_start(p_window_sec integer, p_at timestamptz) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT pg_catalog.to_timestamp(pg_catalog.floor(EXTRACT(epoch FROM p_at) / p_window_sec) * p_window_sec)
$$;
REVOKE ALL ON FUNCTION public.rate_limit_window_start(integer, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

/** Counts one hit on a key in the current window (atomic upsert) and says whether it is within the limit. */
CREATE FUNCTION public.rate_limit_hit(p_key text, p_limit integer, p_window_sec integer)
RETURNS TABLE (allowed boolean, hits integer, reset_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_start timestamptz;
  v_hits integer;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100000
     OR p_window_sec IS NULL OR p_window_sec NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'bad rate limit request' USING ERRCODE = '22023';
  END IF;
  v_start := public.rate_limit_window_start(p_window_sec, now());
  INSERT INTO public.rate_limit_hits AS h (key, window_sec, window_start, hits, last_hit_at)
  VALUES (p_key, p_window_sec, v_start, 1, now())
  ON CONFLICT (key, window_sec, window_start) DO UPDATE SET hits = h.hits + 1, last_hit_at = now()
  RETURNING h.hits INTO v_hits;
  RETURN QUERY SELECT v_hits <= p_limit, v_hits, v_start + pg_catalog.make_interval(secs => p_window_sec);
END
$$;
REVOKE ALL ON FUNCTION public.rate_limit_hit(text, integer, integer) FROM PUBLIC, anon, authenticated, video_gateway, monitor_worker;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, integer) TO service_role, app_web, media_service;

/** The hits of a key in the current window and the time of the last one, without counting (sign-in delays). */
CREATE FUNCTION public.rate_limit_state(p_key text, p_window_sec integer)
RETURNS TABLE (hits integer, last_hit_at timestamptz, reset_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_start timestamptz;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_window_sec IS NULL OR p_window_sec NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'bad rate limit request' USING ERRCODE = '22023';
  END IF;
  v_start := public.rate_limit_window_start(p_window_sec, now());
  RETURN QUERY
    SELECT coalesce(h.hits, 0), h.last_hit_at, v_start + pg_catalog.make_interval(secs => p_window_sec)
    FROM (SELECT 1) AS one LEFT JOIN public.rate_limit_hits h ON h.key = p_key AND h.window_sec = p_window_sec AND h.window_start = v_start;
END
$$;
REVOKE ALL ON FUNCTION public.rate_limit_state(text, integer) FROM PUBLIC, anon, authenticated, video_gateway, monitor_worker;
GRANT EXECUTE ON FUNCTION public.rate_limit_state(text, integer) TO service_role, app_web, media_service;

/** Forgets a key in every window (a successful sign-in clears its failures). */
CREATE FUNCTION public.rate_limit_clear(p_key text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.rate_limit_hits WHERE key = p_key
$$;
REVOKE ALL ON FUNCTION public.rate_limit_clear(text) FROM PUBLIC, anon, authenticated, video_gateway, monitor_worker;
GRANT EXECUTE ON FUNCTION public.rate_limit_clear(text) TO service_role, app_web, media_service;

/** Removes windows that ended more than `p_keep` ago (the worker runs it). */
CREATE FUNCTION public.rate_limit_prune(p_keep interval DEFAULT '1 hour') RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '0' OR p_keep > interval '30 days' THEN RAISE EXCEPTION 'keep between 0 and 30 days' USING ERRCODE = '22023'; END IF;
  DELETE FROM public.rate_limit_hits h WHERE h.window_start + pg_catalog.make_interval(secs => h.window_sec) < now() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.rate_limit_prune(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_prune(interval) TO service_role, monitor_worker;

-- ── 6. search_path '' on the last four SECURITY DEFINER functions ─────────────
CREATE OR REPLACE FUNCTION public.monitor_request_check() RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.worker_state SET check_requested_at = now() WHERE id = 1 RETURNING check_requested_at
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user;
  -- Refresh tokens are removed with their session (ON DELETE CASCADE); this also removes any left over.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;
END
$$;

CREATE OR REPLACE FUNCTION public.targets_uptime(p_org uuid, p_type text, p_ids uuid[], p_window interval, p_now timestamptz DEFAULT now())
RETURNS TABLE(target_id uuid, uptime_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH base AS (
    SELECT cs.target_id AS tid, greatest(p_now - p_window, cs.created_at) AS ws
    FROM public.check_state cs
    WHERE cs.org_id = p_org AND cs.target_type = p_type AND cs.target_id = ANY (p_ids)
  ),
  obs AS (
    SELECT b.tid, b.ws,
           extract(epoch FROM (p_now - b.ws))
           - coalesce((SELECT sum(extract(epoch FROM (least(g.ended_at, p_now) - greatest(g.started_at, b.ws))))
                       FROM public.monitor_gaps g WHERE g.ended_at > b.ws AND g.started_at < p_now), 0) AS observed
    FROM base b
    WHERE b.ws < p_now
  ),
  dn AS (
    SELECT o.tid,
           sum(
             extract(epoch FROM (least(coalesce(ou.ended_at, p_now), p_now) - greatest(ou.started_at, o.ws)))
             - coalesce((SELECT sum(greatest(0, extract(epoch FROM (
                           least(coalesce(ou.ended_at, p_now), g.ended_at, p_now) - greatest(ou.started_at, g.started_at, o.ws)))))
                         FROM public.monitor_gaps g
                         WHERE g.ended_at > greatest(ou.started_at, o.ws) AND g.started_at < least(coalesce(ou.ended_at, p_now), p_now)), 0)
           ) AS down
    FROM obs o
    JOIN public.outages ou ON ou.org_id = p_org AND ou.target_type = p_type AND ou.target_id = o.tid
                   AND ou.started_at < p_now AND coalesce(ou.ended_at, p_now) > o.ws
    GROUP BY o.tid
  )
  SELECT o.tid,
         CASE WHEN o.observed <= 0 THEN NULL
              ELSE round(100 * greatest(0, least(o.observed, o.observed - coalesce(d.down, 0))) / o.observed, 2) END
  FROM obs o LEFT JOIN dn d ON d.tid = o.tid
$$;

-- ── 7. monitor_apply_results: a camera result must name its recorder ──────────
-- Review M-3 (P2-5b) made a named recorder binding; P2-6 makes it required: a camera result without `recorder` (or naming another NVR
-- than the camera's ACTIVE mapping) is ignored, so a late or forged result can never change a camera's state.
CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r jsonb;
  v_type text;
  v_id uuid;
  v_ok boolean;
  v_at timestamptz;
  v_method text;
  v_error text;
  v_cause text;
  v_prev_checked timestamptz;
  s public.check_state%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation; a camera
    -- must be mapped to THE recorder that produced the result, and the result must name it (P2-6: required); a recorder (and so its
    -- cameras) must have monitoring switched on and its asset enabled.
    IF NOT (
      (v_type = 'camera' AND r ? 'recorder' AND jsonb_typeof(r -> 'recorder') = 'string' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        JOIN public.recorders rr ON rr.id = c.recorder_id JOIN public.assets ra ON ra.id = rr.id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND rr.monitoring_enabled AND ra.enabled AND ra.archived_at IS NULL
          AND c.recorder_id::text = lower(r ->> 'recorder'))) OR
      (v_type = 'device' AND EXISTS (
        SELECT 1 FROM public.assets a WHERE a.id = v_id AND a.org_id = p_org AND a.enabled AND a.archived_at IS NULL AND NOT a.is_recorder)) OR
      (v_type = 'recorder' AND EXISTS (
        SELECT 1 FROM public.recorders rr JOIN public.assets a ON a.id = rr.id JOIN public.locations l ON l.id = rr.location_id
        WHERE rr.id = v_id AND rr.org_id = p_org AND rr.monitoring_enabled AND a.enabled AND a.archived_at IS NULL
          AND l.is_active AND l.archived_at IS NULL))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM public.check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

    v_prev_checked := s.last_checked_at;
    s.last_checked_at := v_at;
    s.method := v_method;
    IF v_ok THEN
      s.status := 'up';
      s.consecutive_failures := 0;
      s.last_up_at := v_at;
      s.first_failure_at := NULL;
      s.down_since := NULL;
      s.error := NULL;
      UPDATE public.outages SET ended_at = greatest(v_at, started_at)
      WHERE org_id = p_org AND target_type = v_type AND target_id = v_id AND ended_at IS NULL;
    ELSE
      s.error := v_error;
      -- A run of failures that began before the worker was stopped is not continued: nobody knows what happened during the stop.
      IF s.consecutive_failures > 0 AND s.status <> 'down' AND v_prev_checked IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.monitor_gaps g WHERE g.ended_at > v_prev_checked AND g.started_at < v_at) THEN
        s.consecutive_failures := 0;
        s.first_failure_at := NULL;
      END IF;
      IF s.consecutive_failures = 0 THEN s.first_failure_at := v_at; END IF;
      s.consecutive_failures := s.consecutive_failures + 1;
      IF s.consecutive_failures >= p_threshold AND s.status <> 'down' THEN
        s.status := 'down';
        s.down_since := coalesce(s.first_failure_at, v_at);
        INSERT INTO public.outages (org_id, target_type, target_id, started_at, cause)
        VALUES (p_org, v_type, v_id, s.down_since, v_cause)
        ON CONFLICT (org_id, target_type, target_id) WHERE ended_at IS NULL DO NOTHING;
      END IF;
    END IF;

    UPDATE public.check_state
    SET status = s.status, last_checked_at = s.last_checked_at, last_up_at = s.last_up_at,
        first_failure_at = s.first_failure_at, down_since = s.down_since,
        consecutive_failures = s.consecutive_failures, method = s.method, error = s.error
    WHERE id = s.id;
  END LOOP;
END
$function$;

-- ── 8. Grants of the service roles (explicit; nothing else) ───────────────────
-- video_gateway: the three registry calls and nothing else (no table, no other function).
GRANT EXECUTE ON FUNCTION public.media_session_open, public.media_sessions_still_valid, public.media_session_close TO video_gateway;

-- media_service: the camera route, the media sessions, credential reads for video (above), the access audit rows of video.
GRANT SELECT ON public.cameras, public.locations, public.camera_channel_mappings, public.recorders, public.assets TO media_service;
GRANT INSERT ON public.admin_audit_log TO media_service;
GRANT EXECUTE ON FUNCTION public.media_session_create, public.media_session_open, public.media_sessions_still_valid, public.media_session_close
  TO media_service;

-- monitor_worker: what services/worker and lib/monitor/supabase-db.ts read and write, nothing more.
GRANT SELECT ON public.assets, public.recorders, public.locations, public.camera_channel_mappings, public.cameras, public.check_state, public.worker_state
  TO monitor_worker;
GRANT UPDATE (last_heartbeat, last_devices_round_at, last_cameras_round_at, run_started_at, run_finished_at, progress_done, progress_total)
  ON public.worker_state TO monitor_worker;
GRANT UPDATE (camera_ip) ON public.cameras TO monitor_worker;
GRANT INSERT ON public.monitor_gaps TO monitor_worker;
GRANT EXECUTE ON FUNCTION public.monitor_apply_results, public.media_sessions_prune TO monitor_worker;

-- app_web: the tables and operations the web code uses (scan of lib/, app/, components/ in P2-6) and the RPCs it calls. No credential
-- read, no observation write (check_state, outages, worker_state, monitor_gaps are read-only), no worker, gateway, test or diagnostic
-- function. NVR passwords are written (never read) through recorder_store_credential.
GRANT SELECT ON
  public.access_grant_reviews, public.access_grants, public.access_migration_report, public.address_spaces, public.asset_dependencies,
  public.asset_endpoints, public.assets, public.camera_channel_mappings, public.camera_endpoints, public.camera_group_items,
  public.camera_group_rules, public.camera_groups, public.cameras, public.capabilities, public.check_state, public.clusters,
  public.device_capabilities, public.discovery_findings, public.location_status, public.locations, public.media_sessions,
  public.monitor_gaps, public.network_definitions, public.organizations, public.outages, public.profiles, public.recorder_status,
  public.recorders, public.regions, public.worker_state
  TO app_web;
GRANT INSERT ON
  public.admin_audit_log, public.asset_dependencies, public.asset_endpoints, public.assets, public.camera_group_items,
  public.camera_group_rules, public.camera_groups, public.cameras, public.clusters, public.locations, public.network_definitions,
  public.profiles, public.regions
  TO app_web;
GRANT UPDATE ON
  public.asset_endpoints, public.assets, public.camera_group_items, public.camera_groups, public.cameras, public.clusters,
  public.discovery_findings, public.locations, public.network_definitions, public.profiles, public.recorders, public.regions
  TO app_web;
GRANT DELETE ON public.asset_dependencies, public.camera_group_items, public.camera_group_rules, public.camera_groups, public.network_definitions
  TO app_web;
GRANT EXECUTE ON FUNCTION
  public.access_grant_summary, public.access_review_keep, public.access_review_self_confirm, public.access_target_ancestry,
  public.apply_access_change, public.camera_merge, public.camera_remap, public.change_person_role, public.discovery_apply,
  public.grant_platform_owner_all, public.inventory_apply_proposals, public.inventory_archive, public.inventory_import_apply,
  public.inventory_move_cluster, public.inventory_move_location, public.inventory_propose_hierarchy, public.inventory_refresh_statistics,
  public.inventory_restore, public.media_sessions_revalidate, public.media_sessions_revoke_user, public.monitor_request_check,
  public.preview_access_change, public.preview_hierarchy_change, public.preview_hierarchy_proposals, public.recorder_primary_of,
  public.recorder_save, public.recorder_set_monitoring, public.recorder_store_credential, public.revoke_user_sessions,
  public.set_person_active, public.targets_uptime
  TO app_web;

-- ── 9. privilege_violations(), extended (brief item 4) ───────────────────────
-- Everything a reviewer would otherwise check by hand, as one list (empty = clean):
--   relations: authenticated may only SELECT; anon and PUBLIC nothing; sequences and the server-only tables nothing for people;
--   functions: no EXECUTE for PUBLIC or anon; every SECURITY DEFINER function pins search_path = ''; credential reads only for the
--     service role, media_service and monitor_worker; video_gateway only its three functions and no table;
--   app_web never writes observations or the server-only tables;
--   default ACLs: the global function default must not give PUBLIC EXECUTE (an absent entry means it does), the public schema's
--     defaults must give nothing to anon, authenticated or PUBLIC.
CREATE OR REPLACE FUNCTION public.privilege_violations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ), relacl AS (
    SELECT rel.relname, rel.relkind, a.grantee, a.privilege_type FROM rel CROSS JOIN LATERAL pg_catalog.aclexplode(rel.relacl) a
  ), colacl AS (
    SELECT c.relname, a.grantee, a.privilege_type FROM pg_catalog.pg_attribute at JOIN pg_catalog.pg_class c ON c.oid = at.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a
    WHERE n.nspname = 'public' AND at.attacl IS NOT NULL
  ), fn AS (
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, p.proowner FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  ), fnacl AS (
    SELECT fn.proname, a.grantee FROM fn CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(fn.proacl, pg_catalog.acldefault('f', fn.proowner))) a
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
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'security_settings') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = x.relname)
  UNION ALL
  SELECT pg_catalog.format('%s: app_web may %s (observations are written by the worker)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.relname IN ('check_state', 'outages', 'worker_state', 'monitor_gaps', 'media_sessions') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
  UNION ALL
  SELECT pg_catalog.format('%s: video_gateway has %s (it may only call its three functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('%s (column): video_gateway has %s', x.relname, x.privilege_type) FROM colacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('function %s: PUBLIC may execute', x.proname) FROM fnacl x WHERE x.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('function %s: anon may execute', x.proname) FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'anon')
  UNION ALL
  SELECT pg_catalog.format('function %s: video_gateway may execute (only media_session_open, media_sessions_still_valid, media_session_close)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
    AND x.proname NOT IN ('media_session_open', 'media_sessions_still_valid', 'media_session_close')
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
$$;
REVOKE ALL ON FUNCTION public.privilege_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

-- The check checks itself (brief item 4): makes a function without grants and search_path, one with PUBLIC EXECUTE and a default that
-- would give PUBLIC EXECUTE to new functions, reads privilege_violations(), and undoes all three (a sub-transaction that is always
-- rolled back). Returns the lines that named them.
CREATE FUNCTION public.privilege_violations_selftest() RETURNS text[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_seen text[];
BEGIN
  BEGIN
    EXECUTE 'CREATE FUNCTION public.zz_privilege_probe_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 1 $f$';
    EXECUTE 'CREATE FUNCTION public.zz_privilege_probe_public() RETURNS integer LANGUAGE sql SET search_path = '''' AS $f$ SELECT 1 $f$';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.zz_privilege_probe_public() TO PUBLIC';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC';
    SELECT pg_catalog.array_agg(v ORDER BY v) INTO v_seen FROM public.privilege_violations() AS v
    WHERE v LIKE '%zz_privilege_probe%' OR v LIKE 'default privileges%';
    RAISE EXCEPTION 'undo the probe' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- everything above is rolled back; v_seen keeps what was read
  END;
  RETURN coalesce(v_seen, '{}');
END
$$;
REVOKE ALL ON FUNCTION public.privilege_violations_selftest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.privilege_violations_selftest() TO service_role;

-- The function catalogue the tests read also lists every role (unchanged shape; function_privileges already returns all grantees).

-- PostgREST: the new roles and functions are visible at once.
NOTIFY pgrst, 'reload schema';

COMMIT;
