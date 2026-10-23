-- P5.4 review round 1 (.superpowers/sdd/drishti/p5-4-review.md), the database half.
--
--   I-5  audit_purge_test_org (the only way an audit row of admin_audit_log is ever deleted) trusted the slug alone, and the service key
--        could rename a real organisation to test-…. It now also requires
--          - organizations.created_as_test (migration 0044: fixed when the organisation is made, never changed; an API role cannot
--            rename a real organisation into test-…, and the database owner's rename keeps it false), and
--          - the test fixture switch (public.test_fixture_switch, migration 0044: off on every database, switched on only by
--            supabase/seed.sql on the local test stack): on a production database the purge refuses everything.
--        The demo organisation (scripts/seed-demo.ts, which runs on the local stack only) is still accepted by its slug and name, but
--        only where the switch is on, so a rename to demo-sample-data opens nothing on a production database either.
--   M-9  media_sessions_prune(p_org => …) (one organisation, the tests) no longer records the global "last run" of the clean-up: only
--        the whole clean-up (p_org NULL, the worker's housekeeping) does, so the Health page never reports a partial run.
-- Same signatures and grants as before (service_role; the prune also monitor_worker). SECURITY DEFINER with search_path = ''.
-- Rollback: supabase/rollback/20261021000045_p54_review_fixes_rollback.sql (puts back the bodies of 0041; dry run: -v drishti_dry_run=1).

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

CREATE OR REPLACE FUNCTION public.media_sessions_prune(p_keep interval DEFAULT '30 days', p_unopened_keep interval DEFAULT '1 day', p_org uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n integer;
BEGIN
  IF p_keep IS NULL OR p_unopened_keep IS NULL OR p_keep < interval '0' OR p_unopened_keep < interval '0' THEN
    RAISE EXCEPTION 'retention must not be negative' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.media_sessions m
  WHERE (p_org IS NULL OR m.org_id = p_org)
    AND ((m.opened_at IS NULL AND m.connect_by < now() - p_unopened_keep)
         OR coalesce(m.closed_at, m.revoked_at, CASE WHEN m.expires_at <= now() THEN m.expires_at END) < now() - p_keep);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF p_org IS NULL THEN
    INSERT INTO public.housekeeping_runs AS h (task, last_run_at, last_removed, db_role)
    VALUES ('media_sessions_prune', now(), n, public.service_caller_role())
    ON CONFLICT (task) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_removed = EXCLUDED.last_removed, db_role = EXCLUDED.db_role, runs = h.runs + 1;
  END IF;
  RETURN n;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P5.4 review fixes: privilege_violations() is not empty'; END IF;
  IF has_function_privilege('app_web', 'public.audit_purge_test_org(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'P5.4 review fixes: app_web may purge audit rows'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
