-- P5.4 fix round 3 (.superpowers/sdd/drishti/p5-4-rereview2.md m6; p5-5-report.md defect 3).
--
-- 1. Housekeeping runs made by the TESTS (a request carrying the test fixtures' header x-drishti-test-fixture: on, on a database whose
--    test fixture switch is on) are recorded under '<task>:test', never as the real run: the Health page's "last run" of the media-session
--    clean-up is the worker's own, not a test's from four minutes ago. A production database (switch off) records every run as the real one.
-- 3. The task list also takes 'backup' (and 'backup:test'): the last good backup, written by backup.ps1 (final review C-I11).
-- 2. worker_lease_set_until_test needs the test fixture switch on, as worker_lease_forget_test does (0046). A lease has no organisation, so
--    the organisation marker does not apply; the test-lease name rule stays.
-- Same signatures and grants as before (the prunes: service_role, monitor_worker; the lease helper: service_role). SECURITY DEFINER with
-- search_path = ''. Rollback: supabase/rollback/20261021000047_p54_housekeeping_test_runs_rollback.sql (dry run: -v drishti_dry_run=1).

BEGIN;

ALTER TABLE public.housekeeping_runs DROP CONSTRAINT housekeeping_runs_task_check;
ALTER TABLE public.housekeeping_runs ADD CONSTRAINT housekeeping_runs_task_check CHECK (task = ANY (ARRAY[
  'media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune',
  'media_sessions_prune:test', 'rate_limit_prune:test', 'vault_reads_prune:test',
  'backup', 'backup:test']));
-- Final review C-I11: deploy/windows/backup.ps1 records each good backup as 'backup' (as the database owner, through psql; a test run
-- as 'backup:test'), so the Health page notices when the nightly backups stop. No API role writes this table.

-- The name a run is recorded under. Owner only (the prunes run as the owner).
CREATE FUNCTION public.housekeeping_task_name(p_task text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_fixture text;
BEGIN
  BEGIN
    v_fixture := (nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb) ->> 'x-drishti-test-fixture';
  EXCEPTION WHEN others THEN
    v_fixture := NULL;
  END;
  IF v_fixture = 'on' AND public.test_fixtures_enabled() THEN RETURN p_task || ':test'; END IF;
  RETURN p_task;
END
$$;
REVOKE ALL ON FUNCTION public.housekeeping_task_name(text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- The three prunes: bodies as in 0045 (media sessions) and 0041 (rate limits, credential reads), with the recorded name.
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
    VALUES (public.housekeeping_task_name('media_sessions_prune'), now(), n, public.service_caller_role())
    ON CONFLICT (task) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_removed = EXCLUDED.last_removed, db_role = EXCLUDED.db_role, runs = h.runs + 1;
  END IF;
  RETURN n;
END
$$;

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
  INSERT INTO public.housekeeping_runs AS h (task, last_run_at, last_removed, db_role)
  VALUES (public.housekeeping_task_name('rate_limit_prune'), now(), n + m, public.service_caller_role())
  ON CONFLICT (task) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_removed = EXCLUDED.last_removed, db_role = EXCLUDED.db_role, runs = h.runs + 1;
  RETURN n + m;
END
$$;

CREATE OR REPLACE FUNCTION public.vault_reads_prune(p_keep interval DEFAULT '180 days') RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '90 days' OR p_keep > interval '3650 days' THEN
    RAISE EXCEPTION 'keep between 90 and 3650 days' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.vault_reads WHERE at < now() - p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.housekeeping_runs AS h (task, last_run_at, last_removed, db_role)
  VALUES (public.housekeeping_task_name('vault_reads_prune'), now(), n, public.service_caller_role())
  ON CONFLICT (task) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_removed = EXCLUDED.last_removed, db_role = EXCLUDED.db_role, runs = h.runs + 1;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.media_sessions_prune(interval, interval, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_sessions_prune(interval, interval, uuid) TO service_role, monitor_worker;
REVOKE ALL ON FUNCTION public.rate_limit_prune(interval) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.rate_limit_prune(interval) TO service_role, monitor_worker;
REVOKE ALL ON FUNCTION public.vault_reads_prune(interval) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.vault_reads_prune(interval) TO service_role, monitor_worker;

CREATE OR REPLACE FUNCTION public.worker_lease_set_until_test(p_name text, p_offset_ms integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.test_fixtures_enabled() THEN
    RAISE EXCEPTION 'test helpers never run on this database (the test fixture switch is off)' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR p_name NOT LIKE 'test:%' OR p_offset_ms IS NULL THEN
    RAISE EXCEPTION 'only test leases (names starting with "test:")' USING ERRCODE = '22023';
  END IF;
  UPDATE public.worker_leases SET lease_until = now() + pg_catalog.make_interval(secs => p_offset_ms / 1000.0) WHERE name = p_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such test lease' USING ERRCODE = '22023'; END IF;
END
$$;
REVOKE ALL ON FUNCTION public.worker_lease_set_until_test(text, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.worker_lease_set_until_test(text, integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P5.4 fix round 3: privilege_violations() is not empty'; END IF;
  IF has_function_privilege('monitor_worker', 'public.housekeeping_task_name(text)', 'EXECUTE') THEN RAISE EXCEPTION 'P5.4 fix round 3: internal name rule exposed'; END IF;
  -- Without the header the real name; this migration runs with no request headers.
  IF public.housekeeping_task_name('media_sessions_prune') <> 'media_sessions_prune' THEN RAISE EXCEPTION 'P5.4 fix round 3: a run without the header is not the real one'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
