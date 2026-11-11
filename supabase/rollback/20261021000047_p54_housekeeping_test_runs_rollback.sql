-- Rollback of 20261021000047_p54_housekeeping_test_runs.sql (P5.4 fix round 3). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim the prunes of 0045 / 0041 and worker_lease_set_until_test of 0036; removes the ':test' rows (the old CHECK does not
-- allow them, nor 'backup') and the name rule. Roll back 0047 before 0046.

BEGIN;

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
  VALUES ('rate_limit_prune', now(), n + m, public.service_caller_role())
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
  VALUES ('vault_reads_prune', now(), n, public.service_caller_role())
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
  IF p_name IS NULL OR p_name NOT LIKE 'test:%' OR p_offset_ms IS NULL THEN
    RAISE EXCEPTION 'only test leases (names starting with "test:")' USING ERRCODE = '22023';
  END IF;
  UPDATE public.worker_leases SET lease_until = now() + pg_catalog.make_interval(secs => p_offset_ms / 1000.0) WHERE name = p_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such test lease' USING ERRCODE = '22023'; END IF;
END
$$;
REVOKE ALL ON FUNCTION public.worker_lease_set_until_test(text, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.worker_lease_set_until_test(text, integer) TO service_role;

DROP FUNCTION public.housekeeping_task_name(text);
DELETE FROM public.housekeeping_runs WHERE task LIKE '%:test' OR task = 'backup';
ALTER TABLE public.housekeeping_runs DROP CONSTRAINT housekeeping_runs_task_check;
ALTER TABLE public.housekeeping_runs ADD CONSTRAINT housekeeping_runs_task_check CHECK (task = ANY (ARRAY['media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune']));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0047: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
