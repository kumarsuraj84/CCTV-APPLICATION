-- Final fix X round 2 (review of final fix X: M-8, M-10; rulings NB-10, NB-12 in docs/drishti/DECISIONS.md).
--
--   1. M-10 (NB-10): a NEW saved login (a corrected password) is a fresh state: the refusal times go with the old login, so the
--      3-in-30-minutes pause is lifted and the corrected password is tried at once; if it is refused too, the first window (15 minutes)
--      follows. nvr_login_current is replaced (same signature) to clear them; lib/nvr/login-policy.ts has the same rule.
--   2. M-8 (NB-12): go2rtc's text for a refused RTSP login may differ from the one the gateway knows. So the gateway also reports every
--      unexplained source failure (an error text it does not know, or the source closing before any video) by session id with a hash
--      of the text (never the text: it can carry an address or a password). Two identical unexplained failures of one NVR's streams
--      within 10 minutes, with no video from that NVR in between, count as a refused login for that window (fail safe), path 'gateway'.
--      Video from any stream of the NVR clears the count. media_session_login_report(p_sid, p_kind, p_hash) for video_gateway.
--   3. privilege_violations(): the gateway's third login function.
-- Rollback: supabase/rollback/20261021000050_fx_nvr_login_round2_rollback.sql (dry run: -v drishti_dry_run=1).

BEGIN;

ALTER TABLE public.nvr_login_state
  ADD COLUMN unexplained timestamptz[] NOT NULL DEFAULT '{}' CHECK (cardinality(unexplained) <= 10),
  ADD COLUMN unexplained_hash text CHECK (unexplained_hash IS NULL OR unexplained_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN last_video_at timestamptz;

-- As in 20261021000048, plus: a new login also clears the refusal times (NB-10) and the unexplained failures.
CREATE OR REPLACE FUNCTION public.nvr_login_current(p_recorder uuid, p_org uuid, p_version text) RETURNS public.nvr_login_state
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  st public.nvr_login_state;
BEGIN
  INSERT INTO public.nvr_login_state (recorder_id, org_id, version) VALUES (p_recorder, p_org, p_version) ON CONFLICT (recorder_id) DO NOTHING;
  SELECT * INTO st FROM public.nvr_login_state s WHERE s.recorder_id = p_recorder FOR UPDATE;
  IF st.version IS DISTINCT FROM p_version THEN
    UPDATE public.nvr_login_state s
    SET version = p_version, outcome = NULL, level = 0, refused_until = NULL, attempt_until = NULL, attempt_path = NULL, last_ok_at = NULL,
        refusals = '{}', unexplained = '{}', unexplained_hash = NULL, updated_at = now()
    WHERE s.recorder_id = p_recorder
    RETURNING * INTO st;
  END IF;
  RETURN st;
END
$$;

/**
 * The gateway's report about one open (or just closed) live or playback session's go2rtc source: 'video' (a picture played: the
 * unexplained failures of that NVR are cleared) or 'unexplained' (a failure the gateway cannot read; p_hash = sha256 hex of its text).
 * Answers 'cleared', 'counted', 'refused' (the second identical one: a refused login for the window) or 'ignored' (no such session, no
 * NVR, no saved login, or the login already stands refused).
 */
CREATE FUNCTION public.media_session_login_report(p_sid uuid, p_kind text, p_hash text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cam uuid;
  v_org uuid;
  v_rec uuid;
  v_ver text;
  st public.nvr_login_state;
  v_now constant timestamptz := now();
  v_list timestamptz[];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('video', 'unexplained') THEN RAISE EXCEPTION 'video or unexplained' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'unexplained' AND (p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'a sha256 hex hash' USING ERRCODE = '22023'; END IF;
  SELECT m.camera_id, m.org_id INTO v_cam, v_org FROM public.media_sessions m
  WHERE m.id = p_sid AND m.opened_at IS NOT NULL AND m.opened_at > v_now - interval '1 hour' AND m.kind IN ('live', 'playback');
  IF v_cam IS NULL THEN RETURN 'ignored'; END IF;
  v_rec := (SELECT mp.recorder_id FROM public.camera_channel_mappings mp WHERE mp.camera_id = v_cam AND mp.org_id = v_org AND mp.valid_to IS NULL);
  IF v_rec IS NULL THEN RETURN 'ignored'; END IF;
  v_ver := public.nvr_login_version(v_rec);
  IF v_ver IS NULL THEN RETURN 'ignored'; END IF;
  st := public.nvr_login_current(v_rec, v_org, v_ver);
  IF p_kind = 'video' THEN
    UPDATE public.nvr_login_state s SET unexplained = '{}', unexplained_hash = NULL, last_video_at = v_now, updated_at = v_now WHERE s.recorder_id = v_rec;
    RETURN 'cleared';
  END IF;
  IF st.outcome = 'refused' THEN RETURN 'ignored'; END IF;
  v_list := CASE WHEN st.unexplained_hash IS NOT DISTINCT FROM p_hash
                 THEN ARRAY(SELECT t FROM unnest(st.unexplained) AS t WHERE t > v_now - interval '10 minutes' ORDER BY t)
                 ELSE '{}'::timestamptz[] END;
  v_list := (ARRAY(SELECT t FROM unnest(v_list || v_now) AS t ORDER BY t DESC LIMIT 10))::timestamptz[];
  UPDATE public.nvr_login_state s SET unexplained = v_list, unexplained_hash = p_hash, updated_at = v_now WHERE s.recorder_id = v_rec;
  IF cardinality(v_list) >= 2 THEN
    PERFORM public.nvr_login_report(v_rec, v_ver, 'refused', 'gateway');
    UPDATE public.nvr_login_state s SET unexplained = '{}', unexplained_hash = NULL WHERE s.recorder_id = v_rec;
    RETURN 'refused';
  END IF;
  RETURN 'counted';
END
$$;

-- As in 20261021000048, with the gateway's third login function in its list.
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
  SELECT pg_catalog.format('%s: app_web may UPDATE every column (column grants only; the rest goes through the audited functions)', x.relname)
  FROM relacl x WHERE x.relname IN ('recorders', 'profiles') AND x.privilege_type = 'UPDATE' AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
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

-- ── privileges (explicit; the replaced functions get back exactly the grants they had) ──
REVOKE ALL ON FUNCTION
  public.nvr_login_current(uuid, uuid, text),
  public.media_session_login_report(uuid, text, text),
  public.privilege_violations()
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_login_report(uuid, text, text) TO service_role, media_service, video_gateway;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN
    RAISE EXCEPTION 'privilege_violations() is not empty after 0050: %', (SELECT string_agg(v, '; ') FROM public.privilege_violations() v);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;