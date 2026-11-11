-- Rollback of 20261021000048_fx_nvr_login_rollout.sql (final fix X). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Removes the shared NVR login state and its functions, the bulk monitoring switch and the vault_reads (at) index; puts back verbatim
-- monitor_run_started / monitor_run_finished of 0039, discovery_apply of 0026 and privilege_violations() of 0044. The application code
-- of final fix X calls the removed functions: roll the code back with it (the paths then fail closed: nothing contacts an NVR whose
-- login state cannot be read).

BEGIN;

DROP FUNCTION public.recorder_set_monitoring_bulk(uuid, text, uuid, boolean, text, uuid);
DROP FUNCTION public.media_session_login_refused(uuid);
DROP FUNCTION public.media_session_login_check(uuid);
DROP FUNCTION public.nvr_login_state_age_test(uuid, integer);
DROP FUNCTION public.nvr_login_try_again(uuid, uuid, uuid);
DROP FUNCTION public.nvr_login_report(uuid, text, text, text, integer, integer);
DROP FUNCTION public.nvr_login_gate(uuid[], text, boolean, integer);
DROP FUNCTION public.nvr_login_current(uuid, uuid, text);
DROP FUNCTION public.nvr_login_version(uuid);
DROP FUNCTION public.nvr_login_path_ok(text);
DROP TABLE public.nvr_login_state;
DROP INDEX public.vault_reads_at_idx;

CREATE OR REPLACE FUNCTION public.monitor_run_started(p_lease text, p_fencing_token bigint, p_at timestamptz, p_total integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence_global(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_state SET run_started_at = p_at, run_finished_at = NULL, progress_done = 0, progress_total = GREATEST(0, coalesce(p_total, 0))
  WHERE id = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_run_finished(p_lease text, p_fencing_token bigint, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence_global(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_state SET run_finished_at = p_at WHERE id = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL, p_findings jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_loc uuid;
  o jsonb;
  f jsonb;
  v_op text;
  v_cam uuid;
  v_other uuid;
  v_n integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_mapped integer := 0;
  v_moved integer := 0;
  v_found integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT r.location_id INTO v_loc FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_ops must be an array' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(coalesce(p_findings, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_findings must be an array' USING ERRCODE = '22023'; END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) LOOP
    v_op := o ->> 'op';
    IF v_op = 'insert' THEN
      INSERT INTO public.cameras (org_id, location_id, recorder_id, channel, name, camera_ip)
      VALUES (p_org, v_loc, p_recorder, (o ->> 'channel')::integer, o ->> 'name', o ->> 'ip');
      v_created := v_created + 1;
    ELSIF v_op IN ('update', 'map', 'remap') THEN
      v_cam := (o ->> 'id')::uuid;
      IF v_op = 'map' THEN
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip', recorder_id = p_recorder, channel = (o ->> 'channel')::integer
        WHERE id = v_cam AND org_id = p_org AND location_id = v_loc AND archived_at IS NULL AND recorder_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_mapped := v_mapped + 1;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc
                       AND c.archived_at IS NULL AND c.recorder_id = p_recorder) THEN
          RAISE EXCEPTION 'camera % is not on this recorder', v_cam USING ERRCODE = '22023';
        END IF;
        IF v_op = 'remap' THEN
          PERFORM public.camera_remap(p_org, v_cam, p_recorder, (o ->> 'channel')::integer, now(), p_actor);
          v_moved := v_moved + 1;
        ELSE
          v_updated := v_updated + 1;
        END IF;
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip' WHERE id = v_cam AND org_id = p_org;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 0 THEN RAISE EXCEPTION 'camera % cannot be changed by discovery', v_cam USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'unknown discovery change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- The reconciliation list: this discovery's findings replace the open ones of the same NVR.
  UPDATE public.discovery_findings SET resolved_at = now(), resolved_by = p_actor, resolution = 'superseded'
  WHERE org_id = p_org AND recorder_id = p_recorder AND resolved_at IS NULL;
  FOR f IN SELECT * FROM jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) LOOP
    v_cam := (f ->> 'camera_id')::uuid;
    v_other := NULLIF(f ->> 'other_camera_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc)
       OR (v_other IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_other AND c.org_id = p_org AND c.location_id = v_loc)) THEN
      RAISE EXCEPTION 'a finding names a camera of another location' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.discovery_findings (org_id, recorder_id, location_id, kind, channel, camera_id, other_camera_id, reported_name, because, found_by)
    VALUES (p_org, p_recorder, v_loc, f ->> 'kind', NULLIF(f ->> 'channel', '')::integer, v_cam, v_other, left(f ->> 'reported_name', 200), f ->> 'because', p_actor);
    v_found := v_found + 1;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'cameras_discovered', 'store', v_loc, jsonb_build_object(
    'capability', 'admin.inventory', 'locationIds', jsonb_build_array(v_loc), 'count', 1, 'recorder_id', p_recorder,
    'created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'to_reconcile', coalesce(p_to_reconcile, 0), 'findings', v_found));
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'findings', v_found);
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
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps', 'worker_leases', 'test_fixture_switch')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'worker_leases', 'test_fixture_switch') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
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
  SELECT pg_catalog.format('function %s: monitor_worker may execute it without a fencing token (every worker write takes p_fencing_token)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
    AND NOT ('p_fencing_token' = ANY (coalesce(x.proargnames, '{}'::text[])))
    AND x.proname NOT IN ('worker_acquire_lease', 'recorder_credential_read', 'media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune')
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
  public.monitor_run_started(text, bigint, timestamptz, integer),
  public.monitor_run_finished(text, bigint, timestamptz),
  public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb),
  public.privilege_violations()
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.monitor_run_started(text, bigint, timestamptz, integer), public.monitor_run_finished(text, bigint, timestamptz) TO service_role, monitor_worker;
GRANT EXECUTE ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb) TO service_role, app_web;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0048: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
