-- Rollback of 20261021000051_final_cleanup.sql (Release 1 final clean-up). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim security_set_mfa, security_mfa_overview and access_check_password_reset of 0049 and privilege_violations() of 0050,
-- the whole-table INSERT / UPDATE of app_web on regions, clusters, locations, cameras and assets, TRUNCATE of the service key on
-- locations, cameras and assets, and the web app's EXECUTE on inventory_import_apply; drops the break-glass function, the write guard
-- and its triggers, recorder_save_login and the import stamp / runner. The application code of the clean-up calls recorder_save_login,
-- inventory_import_stamp and inventory_import_run and reads security_mfa_overview().slug: roll the code back with it.

BEGIN;

DROP TRIGGER regions_write_guard ON public.regions;
DROP TRIGGER clusters_write_guard ON public.clusters;
DROP TRIGGER locations_write_guard ON public.locations;
DROP TRIGGER cameras_write_guard ON public.cameras;
DROP TRIGGER assets_write_guard ON public.assets;
DROP FUNCTION public.inventory_write_guard();
DROP FUNCTION public.mfa_code_lock_owner_clear(uuid, uuid, text);
DROP FUNCTION public.recorder_save_login(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid, text, integer);
DROP FUNCTION public.inventory_import_run(uuid, uuid, jsonb, text);
DROP FUNCTION public.inventory_import_stamp(uuid);

REVOKE INSERT, UPDATE ON public.regions, public.clusters, public.locations, public.cameras, public.assets FROM app_web;
GRANT INSERT, UPDATE ON public.regions, public.clusters, public.locations, public.cameras, public.assets TO app_web;
GRANT TRUNCATE ON public.locations, public.cameras, public.assets TO service_role;

CREATE OR REPLACE FUNCTION public.security_set_mfa(p_org uuid, p_actor uuid, p_enforced boolean, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_enforced IS NULL THEN RAISE EXCEPTION 'on or off?' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF p_actor IS NULL THEN
    IF public.service_caller_role() NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
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

DROP FUNCTION public.security_mfa_overview();
CREATE FUNCTION public.security_mfa_overview()
RETURNS TABLE (org_id uuid, enforced boolean, opted_out boolean, reason text, off_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id,
         coalesce(s.mfa_enforced, public.mfa_default_enforced()),
         NOT coalesce(s.mfa_enforced, public.mfa_default_enforced()) AND s.mfa_off_reason IS NOT NULL,
         s.mfa_off_reason, s.mfa_off_at
  FROM public.organizations o LEFT JOIN public.security_settings s ON s.org_id = o.id
  WHERE o.status IN ('trial', 'active')
  ORDER BY o.id
$$;

CREATE OR REPLACE FUNCTION public.access_check_password_reset(p_org uuid, p_actor uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
  v_missing text;
BEGIN
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
  -- Every live or future grant of the person must be held by the administrator: the same capability, at an equal or wider scope, now
  -- and for at least as long (the rule of giving a grant, access_check_grantor).
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

-- privilege_violations() as in 20261021000050.
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

REVOKE ALL ON FUNCTION
  public.security_set_mfa(uuid, uuid, boolean, text),
  public.security_mfa_overview(),
  public.access_check_password_reset(uuid, uuid, uuid),
  public.inventory_import_apply(uuid, uuid, jsonb),
  public.privilege_violations()
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION
  public.security_set_mfa(uuid, uuid, boolean, text),
  public.security_mfa_overview(),
  public.access_check_password_reset(uuid, uuid, uuid),
  public.inventory_import_apply(uuid, uuid, jsonb)
TO app_web, service_role;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0051: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
