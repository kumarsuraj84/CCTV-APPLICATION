-- Rollback of 20261021000045_p54_review_fixes.sql (P5.4 review round 1). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim the bodies of 20261021000041: audit_purge_test_org (slug only) and media_sessions_prune (records every run).
-- What changes back: the purge no longer needs created_as_test or the test fixture switch (review I-5 open again).

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_purge_test_org(p_org uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be purged' USING ERRCODE = '42501';
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
COMMENT ON FUNCTION public.audit_purge_test_org(uuid) IS 'TEST/DEMO CLEAN-UP ONLY: organisations whose slug starts with "test-" or is "demo-sample-data".';

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
  INSERT INTO public.housekeeping_runs AS h (task, last_run_at, last_removed, db_role)
  VALUES ('media_sessions_prune', now(), n, public.service_caller_role())
  ON CONFLICT (task) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_removed = EXCLUDED.last_removed, db_role = EXCLUDED.db_role, runs = h.runs + 1;
  RETURN n;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
