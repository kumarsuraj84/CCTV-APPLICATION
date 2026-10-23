-- Rollback of 20261021000046_p54_fixture_guards.sql (P5.4 fix round 2). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim: the helpers as they were before 0046 (audit_purge_test_org as in 0045; the others as in their last migration),
-- organizations_test_namespace as in 0044, ops_health_status as in 0041; drops created_as_demo, the production mark, its triggers and
-- the new functions. What changes back: the demo exception by slug again, the helpers without the switch (review N-2 open again).
-- Roll back 0046 before 0045, and both before 0044.

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_purge_test_org(p_org uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF NOT coalesce((SELECT t.honoured FROM public.test_fixture_switch t WHERE t.id), false) THEN
    RAISE EXCEPTION 'audit rows are never purged on this database (the test fixture switch is off)' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org
                 AND ((o.created_as_test AND o.slug LIKE 'test-%') OR (o.slug = 'demo-sample-data' AND o.name LIKE 'DEMO%'))) THEN
    RAISE EXCEPTION 'only an organisation made as a test organisation (or the demo organisation) can be purged' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('drishti.audit_purge_org', p_org::text, true);
  DELETE FROM public.admin_audit_log a WHERE a.org_id = p_org;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_catalog.set_config('drishti.audit_purge_org', '', true);
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.audit_purge_test_org(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.audit_purge_test_org(uuid) TO service_role;
COMMENT ON FUNCTION public.audit_purge_test_org(uuid) IS
  'TEST/DEMO CLEAN-UP ONLY: refused unless the test fixture switch is on (local test stack) and the organisation was made as a test one (created_as_test, slug test-…) or is the demo organisation.';

CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secrets uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be purged' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('drishti.purge_org', p_org::text, true);
  v_secrets := ARRAY(SELECT r.secret_id FROM public.recorders r WHERE r.org_id = p_org AND r.secret_id IS NOT NULL);
  DELETE FROM public.outages WHERE org_id = p_org;
  DELETE FROM public.check_state WHERE org_id = p_org;
  DELETE FROM public.camera_channel_mappings WHERE org_id = p_org;
  DELETE FROM public.cameras WHERE org_id = p_org;
  DELETE FROM public.asset_dependencies WHERE org_id = p_org;
  DELETE FROM public.network_definitions WHERE org_id = p_org;
  DELETE FROM public.asset_endpoints WHERE org_id = p_org;
  UPDATE public.assets SET attached_recorder_id = NULL WHERE org_id = p_org AND attached_recorder_id IS NOT NULL;
  UPDATE public.locations SET uplink_asset_id = NULL, parent_location_id = NULL
  WHERE org_id = p_org AND (uplink_asset_id IS NOT NULL OR parent_location_id IS NOT NULL);
  DELETE FROM public.recorders WHERE org_id = p_org;
  DELETE FROM public.assets WHERE org_id = p_org;
  DELETE FROM public.address_spaces WHERE org_id = p_org;
  DELETE FROM public.locations WHERE org_id = p_org;
  DELETE FROM public.clusters WHERE org_id = p_org;
  DELETE FROM public.regions WHERE org_id = p_org;
  DELETE FROM vault.secrets WHERE id = ANY (v_secrets);
  PERFORM set_config('drishti.purge_org', '', true);
  RETURN jsonb_build_object('secrets_removed', cardinality(v_secrets));
END
$$;
REVOKE ALL ON FUNCTION public.inventory_purge_test_org(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.inventory_purge_test_org(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.access_teardown_test_org_people(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be torn down' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('drishti.teardown_org', p_org::text, true);
  DELETE FROM public.profiles WHERE org_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('drishti.teardown_org', '', true);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.access_teardown_test_org_people(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.access_teardown_test_org_people(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.inventory_require_test_org(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'this test helper only works on organisations made by the tests' USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.inventory_require_test_org(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.access_catalogue_probe_test(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_insert jsonb := '[]'::jsonb;
  v_update jsonb := '[]'::jsonb;
  v_with jsonb := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'the probe only runs for test organisations' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)
    VALUES ('it.zz_catalogue_probe', 'it', 'Probe (test only, always rolled back)', 'low', false, ARRAY['location', 'asset']);
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_insert
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe' AND g.revoked_at IS NULL;
    UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'location', 'asset'] WHERE key = 'it.zz_catalogue_probe';
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_update
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe' AND g.revoked_at IS NULL AND g.scope_kind = 'organization';
    INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)
    VALUES ('it.zz_catalogue_probe_two', 'it', 'Probe (test only, always rolled back)', 'low', false, ARRAY['organization', 'location', 'asset']);
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_with
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe_two' AND g.revoked_at IS NULL AND g.scope_kind = 'organization';
    RAISE EXCEPTION 'probe rolled back' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
  RETURN jsonb_build_object('after_insert_without_org', v_insert, 'after_update_to_org', v_update, 'after_insert_with_org', v_with);
END
$$;
REVOKE ALL ON FUNCTION public.access_catalogue_probe_test(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.access_catalogue_probe_test(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.access_migrate_legacy_test(p_run uuid, p_users uuid[] DEFAULT NULL, p_force boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_users IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(p_users) AS u(id)
       WHERE NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id WHERE p.id = u.id AND o.slug LIKE 'test-%')) THEN
    RAISE EXCEPTION 'the test migration only runs for people of test organisations' USING ERRCODE = '42501';
  END IF;
  RETURN public.access_migrate_legacy(p_run, ARRAY(
    SELECT p.id FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id
    WHERE o.slug LIKE 'test-%' AND (p_users IS NULL OR p.id = ANY (p_users))), p_force);
END
$$;
REVOKE ALL ON FUNCTION public.access_migrate_legacy_test(uuid, uuid[], boolean) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.access_migrate_legacy_test(uuid, uuid[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.media_sessions_age_test(p_sid uuid, p_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'seconds 1..86400' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.media_sessions m JOIN public.organizations o ON o.id = m.org_id WHERE m.id = p_sid AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'only sessions of test organisations' USING ERRCODE = '42501';
  END IF;
  UPDATE public.media_sessions s SET created_at = s.created_at - make_interval(secs => p_seconds), connect_by = s.connect_by - make_interval(secs => p_seconds),
    expires_at = s.expires_at - make_interval(secs => p_seconds) WHERE s.id = p_sid;
END
$$;
REVOKE ALL ON FUNCTION public.media_sessions_age_test(uuid, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_sessions_age_test(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.worker_lease_forget_test() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.worker_leases WHERE (name LIKE 'test:%' OR name LIKE 'monitor:test-%')
    AND (released_at IS NOT NULL OR lease_until < now() - interval '1 minute');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.worker_lease_forget_test() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.worker_lease_forget_test() TO service_role;

CREATE OR REPLACE FUNCTION public.worker_fence_org(p_lease text, p_token bigint, p_org uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_lease IS NOT NULL AND NOT (
    p_lease = 'monitor' OR p_lease LIKE 'monitor:%'
    OR (p_lease LIKE 'test:%' AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug ~ '^test-'))
  ) THEN
    RAISE EXCEPTION 'drishti: worker write refused: results are written only under the worker lease "monitor" or a shard "monitor:<n>" (not "%" for this organisation)', p_lease
      USING ERRCODE = 'WL002';
  END IF;
  PERFORM public.worker_fence(p_lease, p_token);
END
$$;
REVOKE ALL ON FUNCTION public.worker_fence_org(text, bigint, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.ops_health_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_level text;
  v_applied integer := 0;
  v_vault boolean := false;
  v_hk jsonb;
BEGIN
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(version)::text, count(*)::integer FROM supabase_migrations.schema_migrations' INTO v_level, v_applied;
  END IF;
  BEGIN
    SELECT ds.decrypted_secret = 'drishti-vault-canary-v1' INTO v_vault FROM vault.decrypted_secrets ds WHERE ds.name = 'drishti_vault_canary';
    v_vault := coalesce(v_vault, false);
  EXCEPTION WHEN OTHERS THEN
    -- A wrong root key (a restore without the key file) fails to decrypt: reported as "not ok", never as an error with detail.
    v_vault := false;
  END;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'task', h.task, 'last_run_at', h.last_run_at, 'removed', h.last_removed, 'db_role', h.db_role) ORDER BY h.task), '[]'::jsonb)
  INTO v_hk FROM public.housekeeping_runs h;
  RETURN pg_catalog.jsonb_build_object(
    'db_time', now(),
    'migration', pg_catalog.jsonb_build_object('level', v_level, 'applied', v_applied),
    'vault', pg_catalog.jsonb_build_object('ok', v_vault),
    'housekeeping', v_hk);
END
$$;
REVOKE ALL ON FUNCTION public.ops_health_status() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.ops_health_status() TO app_web, service_role;

CREATE OR REPLACE FUNCTION public.organizations_test_namespace() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_as_test := NEW.slug LIKE 'test-%';
    RETURN NEW;
  END IF;
  NEW.created_as_test := OLD.created_as_test;
  IF NEW.slug IS DISTINCT FROM OLD.slug AND NEW.slug LIKE 'test-%' AND NOT OLD.created_as_test
     AND current_user IN ('service_role', 'app_web', 'media_service', 'monitor_worker', 'video_gateway', 'authenticated', 'anon') THEN
    RAISE EXCEPTION 'drishti: an organisation that was not made as one of the test organisations cannot be renamed to test-… (the test helpers trust that name)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.organizations_test_namespace() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

DROP FUNCTION public.test_org_require(uuid, boolean);
DROP FUNCTION public.test_org_allowed(uuid, boolean);
DROP FUNCTION public.test_fixtures_enabled();
DROP TRIGGER test_fixture_switch_no_delete ON public.test_fixture_switch;
DROP FUNCTION public.test_fixture_switch_no_delete();
DROP TRIGGER test_fixture_switch_guard ON public.test_fixture_switch;
DROP FUNCTION public.test_fixture_switch_guard();
ALTER TABLE public.test_fixture_switch DROP COLUMN production;
ALTER TABLE public.organizations DROP COLUMN created_as_demo;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0046: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
