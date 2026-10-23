-- P5.4 operational readiness, the database half (.superpowers/sdd/drishti/p5-brief.md, P5.4 items 3 and 5).
--
--   housekeeping_runs     when each housekeeping prune last ran, how many rows it removed and under which database role (the worker
--                         runs them every 10 minutes as monitor_worker: lib/monitor/housekeeping.ts). The three prunes
--                         (media_sessions_prune, rate_limit_prune, vault_reads_prune) are unchanged except that each records its run.
--                         P2-4: never-opened media session rows pile up until media_sessions_prune runs; the Health page now shows
--                         when it last did.
--   ops_health_status()   for the web app's Health page and /api/health/detail (app_web, service_role): the database clock, the
--                         migration level (supabase_migrations.schema_migrations), the Vault round trip (the canary secret below
--                         decrypts to its known text: proves the Vault's root key is the one the secrets were written with) and the
--                         housekeeping runs. Never a secret value.
--   Vault canary          vault secret 'drishti_vault_canary' with a fixed, non-secret text. Health uses it; the restore test
--                         (tests/integration/backup-restore.test.ts) decrypts it in the restored copy.
--   admin_audit_log       append-only (brief item 5): UPDATE, DELETE and TRUNCATE revoked from every API role (the service role had
--                         ALL since 20261021000002); triggers refuse UPDATE, DELETE and TRUNCATE by anybody, the owner included,
--                         except the delete done by audit_purge_test_org (test and demo organisations only, as the table owner with
--                         its transaction-local flag). The app keeps INSERT (app_web, media_service) and SELECT.
--   audit_guard_status()  (service_role) the guards of admin_audit_log, auth_events and vault_reads as one answer, for the tests.
-- Grants: explicit REVOKE ALL first; ops_health_status to app_web and service_role; audit_purge_test_org and audit_guard_status to
-- service_role; the trigger functions to nobody. Every SECURITY DEFINER function with SET search_path = ''.
-- Rollback: supabase/rollback/20261021000041_p54_ops_audit_rollback.sql (dry run: psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f …).

BEGIN;

-- ── 1. Housekeeping runs ─────────────────────────────────────────────────────
CREATE TABLE public.housekeeping_runs (
  task text PRIMARY KEY CHECK (task IN ('media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune')),
  last_run_at timestamptz NOT NULL,
  last_removed integer NOT NULL CHECK (last_removed >= 0),
  db_role text NOT NULL CHECK (length(db_role) BETWEEN 1 AND 63),
  runs bigint NOT NULL DEFAULT 1 CHECK (runs >= 1)
);
ALTER TABLE public.housekeeping_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.housekeeping_runs FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.housekeeping_runs TO service_role;

-- The three prunes: bodies verbatim from 20261021000029 (media sessions), 20261021000035 (rate limits) and 20261021000033 (credential
-- reads), plus one upsert of their run. Same signatures, so their grants stay as they are (service_role, monitor_worker).
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

-- ── 2. The Vault canary ──────────────────────────────────────────────────────
-- A fixed text, not a secret: it only proves that what the Vault stores can be decrypted with the root key this server has.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.name = 'drishti_vault_canary') THEN
    PERFORM vault.create_secret('drishti-vault-canary-v1', 'drishti_vault_canary',
      'CityKart Drishti: Vault round-trip check for the Health page and the restore test. Not a secret; do not delete.');
  END IF;
END
$$;

-- ── 3. ops_health_status() ───────────────────────────────────────────────────
CREATE FUNCTION public.ops_health_status() RETURNS jsonb
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

-- ── 4. admin_audit_log append-only ───────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON public.admin_audit_log FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- UPDATE and TRUNCATE: always refused. DELETE: refused unless it is the clean-up of a test or demo organisation (audit_purge_test_org,
-- which runs as the table owner and sets the transaction-local flag to that organisation). The flag alone is not enough.
CREATE FUNCTION public.admin_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('drishti.audit_purge_org', true) = OLD.org_id::text
       AND current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.admin_audit_log_append_only() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER admin_audit_log_no_update BEFORE UPDATE ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_append_only();
CREATE TRIGGER admin_audit_log_no_delete BEFORE DELETE ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_append_only();
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON public.admin_audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_log_append_only();

-- Test and demo clean-up only (tests/setup/fixtures.ts cleanupOrg, scripts/seed-demo.ts). Returns how many rows went.
CREATE FUNCTION public.audit_purge_test_org(p_org uuid) RETURNS integer
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

-- ── 5. audit_guard_status() ──────────────────────────────────────────────────
-- "writers": roles other than the table owner holding UPDATE, DELETE or TRUNCATE (vault_reads: also INSERT), on the table or a column.
CREATE FUNCTION public.audit_guard_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH t AS (
    SELECT c.oid, c.relname::text AS relname, c.relowner, c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('admin_audit_log', 'auth_events', 'vault_reads')
  ), acl AS (
    SELECT t.relname, a.grantee, a.privilege_type FROM t CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))) a
    WHERE a.grantee <> t.relowner
    UNION ALL
    SELECT t.relname, a.grantee, a.privilege_type FROM t JOIN pg_catalog.pg_attribute at ON at.attrelid = t.oid AND at.attacl IS NOT NULL
    CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a WHERE a.grantee <> t.relowner
  ), w AS (
    SELECT acl.relname, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE (SELECT r.rolname::text FROM pg_catalog.pg_roles r WHERE r.oid = acl.grantee) END AS who
    FROM acl
    WHERE acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') OR (acl.relname = 'vault_reads' AND acl.privilege_type = 'INSERT')
  ), trig AS (
    SELECT tg.tgname::text AS tgname FROM pg_catalog.pg_trigger tg
    WHERE tg.tgrelid IN ('public.admin_audit_log'::regclass, 'public.auth_events'::regclass) AND tg.tgenabled <> 'D' AND NOT tg.tgisinternal
  )
  SELECT pg_catalog.jsonb_build_object(
    'admin_audit_log', pg_catalog.jsonb_build_object(
      'update_blocked', EXISTS (SELECT 1 FROM trig WHERE tgname = 'admin_audit_log_no_update'),
      'delete_blocked', EXISTS (SELECT 1 FROM trig WHERE tgname = 'admin_audit_log_no_delete'),
      'truncate_blocked', EXISTS (SELECT 1 FROM trig WHERE tgname = 'admin_audit_log_no_truncate'),
      'writers', coalesce((SELECT pg_catalog.jsonb_agg(DISTINCT w.who) FROM w WHERE w.relname = 'admin_audit_log'), '[]'::jsonb)),
    'auth_events', pg_catalog.jsonb_build_object(
      'update_blocked', EXISTS (SELECT 1 FROM trig WHERE tgname = 'auth_events_no_update'),
      'delete_blocked', EXISTS (SELECT 1 FROM trig WHERE tgname = 'auth_events_no_delete'),
      'truncate_blocked', EXISTS (SELECT 1 FROM trig WHERE tgname = 'auth_events_no_truncate'),
      'writers', coalesce((SELECT pg_catalog.jsonb_agg(DISTINCT w.who) FROM w WHERE w.relname = 'auth_events'), '[]'::jsonb)),
    'vault_reads', pg_catalog.jsonb_build_object(
      'writers', coalesce((SELECT pg_catalog.jsonb_agg(DISTINCT w.who) FROM w WHERE w.relname = 'vault_reads'), '[]'::jsonb)))
$$;
REVOKE ALL ON FUNCTION public.audit_guard_status() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.audit_guard_status() TO service_role;

-- ── Self-test ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P5.4 self-test: privilege_violations() is not empty'; END IF;
  IF has_table_privilege('service_role', 'public.admin_audit_log', 'UPDATE') OR has_table_privilege('service_role', 'public.admin_audit_log', 'DELETE')
     OR has_table_privilege('app_web', 'public.admin_audit_log', 'UPDATE') OR has_table_privilege('app_web', 'public.admin_audit_log', 'DELETE') THEN
    RAISE EXCEPTION 'P5.4 self-test: an API role may still change audit rows';
  END IF;
  IF NOT (public.ops_health_status() -> 'vault' ->> 'ok')::boolean THEN RAISE EXCEPTION 'P5.4 self-test: the Vault canary does not decrypt'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
