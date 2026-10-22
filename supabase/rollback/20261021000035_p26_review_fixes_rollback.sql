-- Rollback of 20261021000035_p26_review_fixes.sql (P2-6 review round 1). Runs in its own transaction (review M-13).
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim the 20261021000033 bodies of recorder_credential_read, recorder_read_credential, rate_limit_prune and
-- privilege_violations, the table-wide UPDATE of app_web on recorders and profiles and media_service's limiter functions; drops the
-- sign-in gate (table and functions), the grant snapshot, the list of unlocked organisations and the trigger on auth.users.
-- BEFORE running it: take the web app back to the P2-6 code of commit ab60a9b (the round-1 app calls sign_in_gate, sign_in_finish and,
-- in production, security_unlocked_organizations). What is lost: the sign-in counts (every address starts again from nothing).

BEGIN;

DROP TRIGGER IF EXISTS drishti_users_role_check ON auth.users;
DROP FUNCTION IF EXISTS public.auth_users_role_check();
DROP FUNCTION IF EXISTS public.security_unlocked_organizations();
DROP FUNCTION IF EXISTS public.service_role_grants();
DROP FUNCTION IF EXISTS public.sign_in_finish(text, text, text);
DROP FUNCTION IF EXISTS public.sign_in_gate(text, text, integer);
DROP FUNCTION IF EXISTS public.sign_in_delay_sec(integer);
DROP TABLE IF EXISTS public.sign_in_attempts;

REVOKE UPDATE (clock_offset_sec, clock_offset_source) ON public.recorders FROM app_web;
REVOKE UPDATE (full_name, location_id, must_reset_password) ON public.profiles FROM app_web;
GRANT UPDATE ON public.recorders, public.profiles TO app_web;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, integer, integer), public.rate_limit_state(text, integer), public.rate_limit_clear(text)
  TO media_service;

CREATE OR REPLACE FUNCTION public.rate_limit_prune(p_keep interval DEFAULT '1 hour') RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '0' OR p_keep > interval '30 days' THEN RAISE EXCEPTION 'keep between 0 and 30 days' USING ERRCODE = '22023'; END IF;
  DELETE FROM public.rate_limit_hits h WHERE h.window_start + pg_catalog.make_interval(secs => h.window_sec) < now() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

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

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
