-- P2-6 review round 1 (.superpowers/sdd/drishti/p2-6-review.md): the database half of the fixes.
--
--   I-3 / I-4  sign_in_attempts + sign_in_gate / sign_in_finish: the sign-in delay as ONE atomic step. A try is let through only when
--              the rising delay of its e-mail address + IP has passed, and it is counted as a failure in the same step (row lock), so
--              simultaneous tries cannot all pass the same check. A success clears it; a try the sign-in service could not answer
--              (429, server error, no answer) is given back. A known client IP has its own ceiling of tries over all addresses.
--   M-1        app_web may UPDATE only the columns of recorders and profiles that the web code writes (the monitoring switch, NVR
--              logins and ports, roles, organisation and status go through their audited functions); service_role_grants() is the
--              exact snapshot of the four service roles' grants that the tests compare.
--   M-2        media_service no longer holds the rate-limit functions (only the web app counts, through app_web).
--   M-3        security_unlocked_organizations(): the web app's production start-up check refuses while any organisation in use has not
--              locked the service key out of NVR logins.
--   M-5        a GoTrue account can only carry the role "authenticated" (a trigger on auth.users), so PostgREST can never switch a person's
--              session to a service role; privilege_violations() also reports such an account and a missing trigger.
--   M-8        privilege_violations(): why only the default privileges of postgres are checked (comment below).
--   M-10       refused NVR login reads leave a line in the database server log (a refused read rolls back, so it cannot be logged in
--              vault_reads); the line names role, recorder, purpose and reason, never a value.
-- Rollback: supabase/rollback/20261021000035_p26_review_fixes_rollback.sql (dry run: psql -v drishti_dry_run=1 -f …).

BEGIN;

-- ── 1. Sign-in attempts (I-3, I-4) ───────────────────────────────────────────
-- One row per key: "sign_in:<hash of IP and e-mail address>" (failures since the count was last cleared, and the time of the last try)
-- or "sign_in_ip:<hash of IP>" (tries in the current 15-minute window). Keys are built by lib/rate-limit-shared.ts; never an address.
CREATE TABLE public.sign_in_attempts (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 8 AND 200),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_start timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz
);
CREATE INDEX sign_in_attempts_window_idx ON public.sign_in_attempts (window_start);
ALTER TABLE public.sign_in_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sign_in_attempts FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.sign_in_attempts TO service_role;

/** Seconds to wait after `failures` failures before the next try: 0, 0, 0, 5, 10, 20, ... at most 300 (lib/rate-limit-shared.ts). */
CREATE FUNCTION public.sign_in_delay_sec(p_failures integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_failures IS NULL OR p_failures < 3 THEN 0
              ELSE LEAST(300, 5 * (2 ^ LEAST(16, p_failures - 3))::integer) END
$$;
REVOKE ALL ON FUNCTION public.sign_in_delay_sec(integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

/**
 * May this e-mail address + IP try a password now? ONE atomic step: the key's row is locked (INSERT … ON CONFLICT DO UPDATE), its count
 * forgotten after 15 minutes without a try, refused ('wait') while last try + delay(failures) lies ahead; otherwise, when the IP is
 * known, its ceiling is checked ('ip'), and the try is counted as a failure and stamped. A second simultaneous try waits for the lock,
 * then sees the first one's count and stamp. The web app calls sign_in_finish afterwards.
 */
CREATE FUNCTION public.sign_in_gate(p_key text, p_ip_key text DEFAULT NULL, p_ip_limit integer DEFAULT 100)
RETURNS TABLE (allowed boolean, wait_sec integer, reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_window constant interval := interval '15 minutes';
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_failures integer;
  v_last timestamptz;
  v_delay integer;
  v_wait integer;
  v_ip_count integer;
  v_ip_start timestamptz;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 200 OR (p_ip_key IS NOT NULL AND (length(p_ip_key) NOT BETWEEN 8 AND 200 OR p_ip_key = p_key))
     OR p_ip_limit IS NULL OR p_ip_limit NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bad sign-in gate request' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sign_in_attempts AS a (key, failures, window_start, last_attempt_at) VALUES (p_key, 0, v_now, NULL)
  ON CONFLICT (key) DO UPDATE SET
    failures = CASE WHEN a.last_attempt_at < v_now - v_window THEN 0 ELSE a.failures END,
    last_attempt_at = CASE WHEN a.last_attempt_at < v_now - v_window THEN NULL ELSE a.last_attempt_at END
  RETURNING a.failures, a.last_attempt_at INTO v_failures, v_last;
  -- The row is locked now; the time of this try is taken after the lock (a try that waited for it is decided at its own time).
  v_now := pg_catalog.clock_timestamp();
  v_delay := public.sign_in_delay_sec(v_failures);
  v_wait := CASE WHEN v_last IS NULL OR v_delay = 0 THEN 0
                 ELSE GREATEST(0, CEIL(EXTRACT(epoch FROM (v_last + pg_catalog.make_interval(secs => v_delay) - v_now)))::integer) END;
  IF v_wait > 0 THEN
    RETURN QUERY SELECT false, v_wait, 'wait'::text;
    RETURN;
  END IF;
  IF p_ip_key IS NOT NULL THEN
    INSERT INTO public.sign_in_attempts AS a (key, failures, window_start, last_attempt_at) VALUES (p_ip_key, 0, v_now, NULL)
    ON CONFLICT (key) DO UPDATE SET
      failures = CASE WHEN a.window_start < v_now - v_window THEN 0 ELSE a.failures END,
      window_start = CASE WHEN a.window_start < v_now - v_window THEN v_now ELSE a.window_start END
    RETURNING a.failures, a.window_start INTO v_ip_count, v_ip_start;
    IF v_ip_count >= p_ip_limit THEN
      RETURN QUERY SELECT false, GREATEST(1, CEIL(EXTRACT(epoch FROM (v_ip_start + v_window - v_now)))::integer), 'ip'::text;
      RETURN;
    END IF;
    UPDATE public.sign_in_attempts SET failures = failures + 1, last_attempt_at = v_now WHERE key = p_ip_key;
  END IF;
  UPDATE public.sign_in_attempts SET failures = failures + 1, last_attempt_at = v_now WHERE key = p_key;
  RETURN QUERY SELECT true, 0, NULL::text;
END
$$;
REVOKE ALL ON FUNCTION public.sign_in_gate(text, text, integer) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.sign_in_gate(text, text, integer) TO service_role, app_web;

/** After the password check: 'succeeded' clears the key; 'not_counted' gives the try back (the sign-in service could not answer). */
CREATE FUNCTION public.sign_in_finish(p_key text, p_outcome text, p_ip_key text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 200 OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'not_counted') THEN
    RAISE EXCEPTION 'bad sign-in finish request' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'succeeded' THEN
    DELETE FROM public.sign_in_attempts WHERE key = p_key;
  ELSE
    UPDATE public.sign_in_attempts SET failures = GREATEST(0, failures - 1) WHERE key = p_key OR (p_ip_key IS NOT NULL AND key = p_ip_key);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.sign_in_finish(text, text, text) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.sign_in_finish(text, text, text) TO service_role, app_web;

-- The worker's housekeeping (rate_limit_prune) now also removes sign-in rows that would be forgotten anyway (15 minutes without a try
-- and an ended IP window) and are older than `p_keep`. Same signature and grants as in 20261021000033.
CREATE OR REPLACE FUNCTION public.rate_limit_prune(p_keep interval DEFAULT '1 hour') RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer; m integer;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '0' OR p_keep > interval '30 days' THEN RAISE EXCEPTION 'keep between 0 and 30 days' USING ERRCODE = '22023'; END IF;
  DELETE FROM public.rate_limit_hits h WHERE h.window_start + pg_catalog.make_interval(secs => h.window_sec) < now() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.sign_in_attempts s
  WHERE coalesce(s.last_attempt_at, s.window_start) < now() - interval '15 minutes' - p_keep AND s.window_start < now() - interval '15 minutes' - p_keep;
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END
$$;

-- ── 2. M-2: only the web app counts ──────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, integer), public.rate_limit_state(text, integer), public.rate_limit_clear(text)
  FROM media_service;

-- ── 3. M-1: column grants of app_web on recorders and profiles ───────────────
-- The web code writes recorders.clock_offset_sec / clock_offset_source (lib/inventory/recorder-admin.ts) and profiles.full_name /
-- location_id / must_reset_password (lib/admin/users.ts, lib/actions/auth.ts); everything else goes through the audited functions
-- (recorder_save, recorder_set_monitoring, recorder_store_credential, change_person_role, set_person_active).
REVOKE UPDATE ON public.recorders, public.profiles FROM app_web;
GRANT UPDATE (clock_offset_sec, clock_offset_source) ON public.recorders TO app_web;
GRANT UPDATE (full_name, location_id, must_reset_password) ON public.profiles TO app_web;

/** The table, column and schema grants of the four service roles, one row each (tests compare them to an exact snapshot). */
CREATE FUNCTION public.service_role_grants() RETURNS TABLE (grantee text, relation text, privilege text, column_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH r AS (
    SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN ('app_web', 'media_service', 'monitor_worker', 'video_gateway')
  )
  SELECT r.rolname::text, c.relname::text, a.privilege_type::text, NULL::text
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT r.rolname::text, c.relname::text, a.privilege_type::text, at.attname::text
  FROM pg_catalog.pg_attribute at JOIN pg_catalog.pg_class c ON c.oid = at.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a JOIN r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND at.attacl IS NOT NULL AND NOT at.attisdropped
  UNION ALL
  SELECT r.rolname::text, 'schema:' || n.nspname::text, a.privilege_type::text, NULL::text
  FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a JOIN r ON r.oid = a.grantee
$$;
REVOKE ALL ON FUNCTION public.service_role_grants() FROM PUBLIC, anon, authenticated, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.service_role_grants() TO service_role;

-- ── 4. M-3: organisations that still let the service key read NVR logins ─────
/** The organisations in use (trial or active) without security_settings.service_role_credential_reads = false. */
CREATE FUNCTION public.security_unlocked_organizations() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id FROM public.organizations o
  WHERE o.status IN ('trial', 'active') AND public.service_role_may_read_credentials(o.id)
  ORDER BY o.id
$$;
REVOKE ALL ON FUNCTION public.security_unlocked_organizations() FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.security_unlocked_organizations() TO service_role, app_web;

-- ── 5. M-5: a GoTrue account never carries a service role ────────────────────
-- PostgREST switches to the `role` claim of a session JWT, and GoTrue copies the account's role into it. The authenticator is a
-- member of the three BYPASSRLS service roles, so an account with role app_web would read every organisation. The app never sets
-- a role (lib/admin/users.ts); this trigger makes sure nothing else can (GoTrue's admin API answers an error).
CREATE FUNCTION public.auth_users_role_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.role IS NOT NULL AND NEW.role NOT IN ('', 'authenticated') THEN
    RAISE EXCEPTION 'a sign-in account can only have the role authenticated' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.auth_users_role_check() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER drishti_users_role_check BEFORE INSERT OR UPDATE OF role ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auth_users_role_check();

-- ── 6. M-10: refused credential reads leave a server log line ────────────────
-- Same bodies as 20261021000033 plus RAISE LOG before each refusal (a refused read raises, so a vault_reads row would be rolled back).
CREATE OR REPLACE FUNCTION public.recorder_credential_read(p_recorder uuid, p_purpose text, p_actor uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text := public.service_caller_role();
  v_org uuid;
  v_secret uuid;
  v_on boolean;
  v text;
BEGIN
  IF p_purpose IS NULL OR NOT public.credential_purpose_allowed(v_role, p_purpose) THEN
    RAISE LOG 'drishti: NVR login read refused (role %, recorder %, purpose %, reason purpose_not_allowed)', v_role, p_recorder, coalesce(p_purpose, 'none');
    RAISE EXCEPTION 'this service may not read NVR logins for this purpose' USING ERRCODE = '42501';
  END IF;
  SELECT r.org_id, r.secret_id, r.monitoring_enabled INTO v_org, v_secret, v_on FROM public.recorders r WHERE r.id = p_recorder;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_role = 'service_role' AND NOT public.service_role_may_read_credentials(v_org) THEN
    RAISE LOG 'drishti: NVR login read refused (role %, recorder %, purpose %, reason service_key_locked)', v_role, p_recorder, p_purpose;
    RAISE EXCEPTION 'NVR logins are not read with the service key in this organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT v_on THEN
    RAISE LOG 'drishti: NVR login read refused (role %, recorder %, purpose %, reason monitoring_off)', v_role, p_recorder, p_purpose;
    RAISE EXCEPTION 'monitoring is switched off for this NVR: its login is not read' USING ERRCODE = '55000';
  END IF;
  SELECT ds.decrypted_secret INTO v FROM vault.decrypted_secrets ds WHERE ds.id = v_secret;
  INSERT INTO public.vault_reads (org_id, recorder_id, db_role, actor_id, purpose, outcome)
  VALUES (v_org, p_recorder, v_role, p_actor, p_purpose, CASE WHEN v IS NULL THEN 'none' ELSE 'read' END);
  RETURN v;
END
$$;

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
    RAISE LOG 'drishti: NVR login read refused (role %, recorder %, purpose unspecified, reason service_key_locked)', v_role, p_recorder;
    RAISE EXCEPTION 'NVR logins are not read with the service key in this organisation' USING ERRCODE = '42501';
  END IF;
  IF NOT v_on THEN
    RAISE LOG 'drishti: NVR login read refused (role %, recorder %, purpose unspecified, reason monitoring_off)', v_role, p_recorder;
    RAISE EXCEPTION 'monitoring is switched off for this NVR: its login is not read' USING ERRCODE = '55000';
  END IF;
  SELECT ds.decrypted_secret INTO v FROM vault.decrypted_secrets ds WHERE ds.id = v_secret;
  INSERT INTO public.vault_reads (org_id, recorder_id, db_role, purpose, outcome)
  VALUES (v_org, p_recorder, v_role, 'unspecified', CASE WHEN v IS NULL THEN 'none' ELSE 'read' END);
  RETURN v;
END
$$;

-- ── 7. privilege_violations(), extended (M-1, M-2, M-5, M-8, the new sign-in table) ──
-- As in 20261021000033, plus: sign_in_attempts is a server-only table written by the database only; app_web may not hold table-wide
-- UPDATE on recorders or profiles (column grants only); media_service may not hold the limiter or sign-in functions; no GoTrue account
-- carries a role other than authenticated, and the trigger that ensures it is in place.
-- M-8, why the default-privilege clauses look at postgres only: every object in schema public is created by the migrations, which run
-- as postgres (supabase migration up). supabase_admin's defaults in public (ALL to anon/authenticated on new tables, sequences and
-- functions) are the platform's own and cannot be changed by postgres; an object created by supabase_admin would still be caught by the
-- per-object clauses above (relations, columns, functions), which do not depend on who created it.
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
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = x.relname)
  UNION ALL
  SELECT pg_catalog.format('%s: app_web may %s (observations are written by the worker)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.relname IN ('check_state', 'outages', 'worker_state', 'monitor_gaps', 'media_sessions') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
  UNION ALL
  SELECT pg_catalog.format('%s: app_web may UPDATE every column (column grants only; the rest goes through the audited functions)', x.relname)
  FROM relacl x WHERE x.relname IN ('recorders', 'profiles') AND x.privilege_type = 'UPDATE' AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
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
  SELECT pg_catalog.format('function %s: media_service may execute (only the web app counts sign-ins and limits)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'media_service')
    AND x.proname IN ('rate_limit_hit', 'rate_limit_state', 'rate_limit_clear', 'sign_in_gate', 'sign_in_finish')
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

NOTIFY pgrst, 'reload schema';

COMMIT;
