-- P5.4 fix round 2 (.superpowers/sdd/drishti/p5-4-rereview.md N-2; release1-cleanups-review.md Important 1 and Minor 2).
--
-- 1. organizations.created_as_demo: fixed when the organisation is made (slug demo-sample-data then), never changed afterwards, like
--    created_as_test (migration 0044). An API role cannot rename an organisation into demo-sample-data unless it was made as the demo
--    one; the database owner's rename keeps the marker false. The demo exception of the clean-up helpers no longer trusts a slug or a
--    name: only this marker.
-- 2. Every test helper (audit_purge_test_org, inventory_purge_test_org, access_teardown_test_org_people, inventory_require_test_org and
--    the two security-settings helpers that call it, access_catalogue_probe_test, access_migrate_legacy_test, media_sessions_age_test,
--    worker_lease_forget_test, the test lease branch of worker_fence_org) now needs BOTH the test fixture switch on AND an
--    organisation made as a test one (or, for the three clean-ups, made as the demo one). Never the slug alone.
-- 3. A production database can be marked: test_fixture_switch.production = true (deploy/windows/update.ps1 sets it). From then on the
--    switch cannot be turned on (supabase/seed.sql fails loudly there), and the mark cannot be taken back by an UPDATE.
-- 4. test_fixtures_enabled(): whether the switch is on, for the web app (its production start-up refuses while it is on; the worker's role
--    may call only fenced functions, privilege_violations)
--    and in ops_health_status() (the Health page fails while it is on in production).
-- Explicit REVOKE/GRANT; SECURITY DEFINER with search_path = ''. Rollback: supabase/rollback/20261021000046_p54_fixture_guards_rollback.sql
-- (dry run: -v drishti_dry_run=1). Roll back 0046 before 0045, and both before 0044.

BEGIN;

-- ── 1. created_as_demo ───────────────────────────────────────────────────────
ALTER TABLE public.organizations ADD COLUMN created_as_demo boolean NOT NULL DEFAULT false;
UPDATE public.organizations SET created_as_demo = true WHERE slug = 'demo-sample-data' AND name LIKE 'DEMO%';
COMMENT ON COLUMN public.organizations.created_as_demo IS
  'P5.4 fix round 2: the organisation was made as the demo one (scripts/seed-demo.ts, slug demo-sample-data); fixed at creation. Only such an organisation may be renamed into demo-sample-data by an API role.';

-- As 0044, plus the demo marker and the demo slug.
CREATE OR REPLACE FUNCTION public.organizations_test_namespace() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_as_test := NEW.slug LIKE 'test-%';
    NEW.created_as_demo := NEW.slug = 'demo-sample-data';
    RETURN NEW;
  END IF;
  NEW.created_as_test := OLD.created_as_test;
  NEW.created_as_demo := OLD.created_as_demo;
  IF NEW.slug IS DISTINCT FROM OLD.slug AND NEW.slug LIKE 'test-%' AND NOT OLD.created_as_test
     AND current_user IN ('service_role', 'app_web', 'media_service', 'monitor_worker', 'video_gateway', 'authenticated', 'anon') THEN
    RAISE EXCEPTION 'drishti: an organisation that was not made as one of the test organisations cannot be renamed to test-… (the test helpers trust that name)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.slug IS DISTINCT FROM OLD.slug AND NEW.slug = 'demo-sample-data' AND NOT OLD.created_as_demo
     AND current_user IN ('service_role', 'app_web', 'media_service', 'monitor_worker', 'video_gateway', 'authenticated', 'anon') THEN
    RAISE EXCEPTION 'drishti: an organisation that was not made as the demo organisation cannot be renamed to demo-sample-data'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.organizations_test_namespace() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- ── 3. The production mark of the switch ─────────────────────────────────────
ALTER TABLE public.test_fixture_switch ADD COLUMN production boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.test_fixture_switch.production IS
  'P5.4 fix round 2: set by deploy/windows/update.ps1 on a production database. Then honoured can never be set (supabase/seed.sql fails), and this mark cannot be cleared by an UPDATE.';

CREATE FUNCTION public.test_fixture_switch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.production AND NOT NEW.production THEN
    RAISE EXCEPTION 'drishti: this database is marked as a production one; the mark is never taken back' USING ERRCODE = '42501';
  END IF;
  IF NEW.honoured AND (OLD.production OR NEW.production) THEN
    RAISE EXCEPTION 'drishti: this is a production database: the test fixture switch stays off (supabase/seed.sql must never be applied here)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.test_fixture_switch_guard() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER test_fixture_switch_guard BEFORE UPDATE ON public.test_fixture_switch FOR EACH ROW EXECUTE FUNCTION public.test_fixture_switch_guard();
CREATE FUNCTION public.test_fixture_switch_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'drishti: the test fixture switch row is never deleted' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.test_fixture_switch_no_delete() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER test_fixture_switch_no_delete BEFORE DELETE OR TRUNCATE ON public.test_fixture_switch FOR EACH STATEMENT EXECUTE FUNCTION public.test_fixture_switch_no_delete();

-- ── 4. test_fixtures_enabled() ───────────────────────────────────────────────
CREATE FUNCTION public.test_fixtures_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT t.honoured FROM public.test_fixture_switch t WHERE t.id), false)
$$;
REVOKE ALL ON FUNCTION public.test_fixtures_enabled() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.test_fixtures_enabled() TO service_role, app_web;

-- ── 2. One rule for every test helper ────────────────────────────────────────
-- True only with the switch on AND an organisation made as a test one that still has a test name (p_demo: or made as the demo one
-- and still named so). The marker fixed at creation decides; the name alone never does. Owner only (the helpers run as the owner).
CREATE FUNCTION public.test_org_allowed(p_org uuid, p_demo boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.test_fixtures_enabled()
     AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org
                 AND ((o.created_as_test AND o.slug LIKE 'test-%') OR (p_demo AND o.created_as_demo AND o.slug = 'demo-sample-data')))
$$;
REVOKE ALL ON FUNCTION public.test_org_allowed(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- The same two refusals, the same texts, for every clean-up.
CREATE FUNCTION public.test_org_require(p_org uuid, p_demo boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.test_fixtures_enabled() THEN
    RAISE EXCEPTION 'test helpers never run on this database (the test fixture switch is off)' USING ERRCODE = '42501';
  END IF;
  IF NOT public.test_org_allowed(p_org, p_demo) THEN
    RAISE EXCEPTION 'only an organisation made as a test organisation%', CASE WHEN p_demo THEN ' (or made as the demo organisation)' ELSE '' END
      USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.test_org_require(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.audit_purge_test_org(p_org uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  PERFORM public.test_org_require(p_org, true);
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
  'TEST/DEMO CLEAN-UP ONLY: refused unless the test fixture switch is on and the organisation was made as a test one (created_as_test) or as the demo one (created_as_demo).';

CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secrets uuid[];
BEGIN
  PERFORM public.test_org_require(p_org, true);
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
  PERFORM public.test_org_require(p_org, true);
  PERFORM set_config('drishti.teardown_org', p_org::text, true);
  DELETE FROM public.profiles WHERE org_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('drishti.teardown_org', '', true);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.access_teardown_test_org_people(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.access_teardown_test_org_people(uuid) TO service_role;

-- Owner only (called by security_settings_set_test and security_settings_set_mfa_test, which keep their grants).
CREATE OR REPLACE FUNCTION public.inventory_require_test_org(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.test_org_require(p_org, false);
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
  PERFORM public.test_org_require(p_org, false);
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
  IF NOT public.test_fixtures_enabled() THEN
    RAISE EXCEPTION 'test helpers never run on this database (the test fixture switch is off)' USING ERRCODE = '42501';
  END IF;
  IF p_users IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(p_users) AS u(id)
       WHERE NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id WHERE p.id = u.id AND o.created_as_test AND o.slug LIKE 'test-%')) THEN
    RAISE EXCEPTION 'the test migration only runs for people of test organisations' USING ERRCODE = '42501';
  END IF;
  RETURN public.access_migrate_legacy(p_run, ARRAY(
    SELECT p.id FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id
    WHERE o.created_as_test AND o.slug LIKE 'test-%' AND (p_users IS NULL OR p.id = ANY (p_users))), p_force);
END
$$;
REVOKE ALL ON FUNCTION public.access_migrate_legacy_test(uuid, uuid[], boolean) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.access_migrate_legacy_test(uuid, uuid[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.media_sessions_age_test(p_sid uuid, p_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'seconds 1..86400' USING ERRCODE = '22023'; END IF;
  IF NOT public.test_fixtures_enabled() THEN
    RAISE EXCEPTION 'test helpers never run on this database (the test fixture switch is off)' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.media_sessions m JOIN public.organizations o ON o.id = m.org_id WHERE m.id = p_sid AND o.created_as_test AND o.slug LIKE 'test-%') THEN
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
  IF NOT public.test_fixtures_enabled() THEN
    RAISE EXCEPTION 'test helpers never run on this database (the test fixture switch is off)' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.worker_leases WHERE (name LIKE 'test:%' OR name LIKE 'monitor:test-%')
    AND (released_at IS NOT NULL OR lease_until < now() - interval '1 minute');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.worker_lease_forget_test() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.worker_lease_forget_test() TO service_role;

-- The test leases ("test:<id>") write only for an organisation made as a test one, and only where the switch is on.
CREATE OR REPLACE FUNCTION public.worker_fence_org(p_lease text, p_token bigint, p_org uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_lease IS NOT NULL AND NOT (
    p_lease = 'monitor' OR p_lease LIKE 'monitor:%'
    OR (p_lease LIKE 'test:%' AND public.test_org_allowed(p_org, false))
  ) THEN
    RAISE EXCEPTION 'drishti: worker write refused: results are written only under the worker lease "monitor" or a shard "monitor:<n>" (not "%" for this organisation)', p_lease
      USING ERRCODE = 'WL002';
  END IF;
  PERFORM public.worker_fence(p_lease, p_token);
END
$$;
REVOKE ALL ON FUNCTION public.worker_fence_org(text, bigint, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- ── ops_health_status(): as 0041, plus the switch ───────────────────────────
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
    v_vault := false;
  END;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'task', h.task, 'last_run_at', h.last_run_at, 'removed', h.last_removed, 'db_role', h.db_role) ORDER BY h.task), '[]'::jsonb)
  INTO v_hk FROM public.housekeeping_runs h;
  RETURN pg_catalog.jsonb_build_object(
    'db_time', now(),
    'migration', pg_catalog.jsonb_build_object('level', v_level, 'applied', v_applied),
    'vault', pg_catalog.jsonb_build_object('ok', v_vault),
    'housekeeping', v_hk,
    'test_fixtures', pg_catalog.jsonb_build_object(
      'on', public.test_fixtures_enabled(),
      'production', coalesce((SELECT t.production FROM public.test_fixture_switch t WHERE t.id), false)));
END
$$;
REVOKE ALL ON FUNCTION public.ops_health_status() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.ops_health_status() TO app_web, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P5.4 fix round 2: privilege_violations() is not empty'; END IF;
  IF has_function_privilege('service_role', 'public.test_org_allowed(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.test_org_require(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P5.4 fix round 2: the internal test rule is callable through the API';
  END IF;
  IF NOT has_function_privilege('app_web', 'public.test_fixtures_enabled()', 'EXECUTE')
     OR has_function_privilege('monitor_worker', 'public.test_fixtures_enabled()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.test_fixtures_enabled()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P5.4 fix round 2: test_fixtures_enabled grants';
  END IF;
  IF has_table_privilege('service_role', 'public.test_fixture_switch', 'UPDATE') THEN RAISE EXCEPTION 'P5.4 fix round 2: the switch is writable'; END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.created_as_demo AND o.slug <> 'demo-sample-data') THEN
    RAISE EXCEPTION 'P5.4 fix round 2: created_as_demo was not filled from the slug';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
