-- Rollback of 20261021000041_p54_ops_audit.sql (P5.4). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim: media_sessions_prune (0029), rate_limit_prune (0035), vault_reads_prune (0033) without the record of their run;
-- the service role's UPDATE, DELETE and TRUNCATE on admin_audit_log (it held ALL since 0002). Drops the append-only triggers,
-- audit_purge_test_org, audit_guard_status, ops_health_status, housekeeping_runs and the Vault canary secret.
-- What is lost: the record of the last housekeeping runs (the Health page then says "not recorded"). Roll the code back with it:
-- tests/setup/fixtures.ts falls back to a direct delete when audit_purge_test_org does not exist; the Health page and
-- /api/health/detail report the database part as "could not be read" without ops_health_status.

BEGIN;

DROP TRIGGER IF EXISTS admin_audit_log_no_update ON public.admin_audit_log;
DROP TRIGGER IF EXISTS admin_audit_log_no_delete ON public.admin_audit_log;
DROP TRIGGER IF EXISTS admin_audit_log_no_truncate ON public.admin_audit_log;
DROP FUNCTION IF EXISTS public.admin_audit_log_append_only();
DROP FUNCTION IF EXISTS public.audit_purge_test_org(uuid);
DROP FUNCTION IF EXISTS public.audit_guard_status();
DROP FUNCTION IF EXISTS public.ops_health_status();
GRANT UPDATE, DELETE, TRUNCATE ON public.admin_audit_log TO service_role;

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
  RETURN n;
END
$$;

DROP TABLE IF EXISTS public.housekeeping_runs;
DELETE FROM vault.secrets WHERE name = 'drishti_vault_canary';

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
