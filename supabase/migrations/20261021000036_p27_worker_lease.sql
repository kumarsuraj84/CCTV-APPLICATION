-- P2-7 (WP-2.5, decision D-8, tracker SO-14): an atomic worker lease with a fencing token, replacing the heartbeat-only start-up guard.
--
--   worker_leases          one row per lease name ('monitor'; later shards 'monitor:shard-<n>'; tests 'test:<uuid>'): holder, lease_until,
--                          fencing_token, holder_info. Written ONLY by the functions below (nobody holds INSERT/UPDATE/DELETE on it).
--   worker_acquire_lease   one atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE lease_until <= now() OR holder = p_holder. A new epoch
--                          (a takeover, or the same holder after its lease ended) increments the token; the live holder asking again
--                          keeps its token. Only the database clock (now()) is used.
--   worker_renew_lease     extends the lease only for the same holder and token while it has not ended (a stale token fails).
--   worker_release_lease   ends it at once, so another worker can take it immediately (graceful shutdown).
--   worker_fence           internal: the check every worker write runs FIRST, in the write's own transaction:
--                          SELECT ... FROM worker_leases WHERE name = p_lease FOR SHARE, then token = p_token and lease_until > now().
--                          FOR SHARE conflicts with the row lock that acquire / renew / release take (FOR NO KEY UPDATE), so a takeover
--                          waits for every fenced write that is in progress, and a write that starts after a takeover sees the new
--                          token and is refused: an accepted write is always ordered before the takeover (docs/drishti/worker-lease.md).
--                          A refusal is SQLSTATE WL001 and rolls back the whole call (a batch is applied whole or not at all).
--   Every worker write now goes through a fenced function taking (p_lease, p_fencing_token):
--     monitor_apply_results (new signature; the 3-argument version is dropped, so an unfenced call cannot resolve), monitor_heartbeat,
--     monitor_record_gap, monitor_mark_round, monitor_run_started, monitor_run_progress, monitor_run_finished, monitor_save_camera_ips.
--     The worker's direct table writes (worker_state columns, monitor_gaps insert, cameras.camera_ip) are revoked from monitor_worker.
--   SQL guard (D-8): monitor_apply_results skips a result older than its target's last_checked_at (the late-result rule was in the
--     worker's memory only).
--   check_requested_at stays in worker_state (decision recorded in docs/drishti/worker-lease.md): it is written by the web app
--     (monitor_request_check, not a worker write) and the worker's run start/finish that answer it are fenced.
--   privilege_violations(): worker_leases is written by the database only; monitor_worker holds no table or column write; every
--     function monitor_worker may execute takes p_fencing_token, except the lease functions that hand out tokens, the credential read
--     and the three housekeeping prunes (idempotent, time-based; the worker runs them only while it holds the lease).
-- Grants: the lease and fenced functions to monitor_worker and service_role (the development fallback of P2-6 runs the worker on the
-- service key; production refuses that key in the worker's environment); test helpers (names 'test:' only) to service_role.
-- Rollback: supabase/rollback/20261021000036_p27_worker_lease_rollback.sql (dry run: psql -v drishti_dry_run=1 -f …).

BEGIN;

-- ── 1. The lease table ───────────────────────────────────────────────────────
CREATE TABLE public.worker_leases (
  name text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 100 AND name ~ '^[a-z][a-z0-9_-]*(:[a-z0-9_-]+)*$'),
  holder uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  holder_info jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(holder_info) = 'object' AND pg_column_size(holder_info) <= 2048),
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL,
  released_at timestamptz
);
ALTER TABLE public.worker_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_leases FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
-- Read-only: the web app shows the holder, token and age (lib/monitor/health.ts); the service role for diagnostics and tests.
GRANT SELECT ON public.worker_leases TO service_role, app_web;

-- ── 2. The fence (internal) ──────────────────────────────────────────────────
/** Raises WL001 unless p_lease is held with p_token right now (database clock). Locks the lease row FOR SHARE until the caller commits. */
CREATE FUNCTION public.worker_fence(p_lease text, p_token bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
DECLARE
  v_token bigint;
  v_until timestamptz;
  v_released timestamptz;
BEGIN
  IF p_lease IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'drishti: worker write refused: no lease given (lease %, token %)', coalesce(p_lease, 'none'), coalesce(p_token::text, 'none')
      USING ERRCODE = 'WL001', HINT = 'Only the worker holding the lease may write. This worker must stop and wait in standby.';
  END IF;
  SELECT l.fencing_token, l.lease_until, l.released_at INTO v_token, v_until, v_released
  FROM public.worker_leases l WHERE l.name = p_lease
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'drishti: worker write refused: the worker lease % is not held by anyone', p_lease
      USING ERRCODE = 'WL001', HINT = 'Only the worker holding the lease may write. This worker must stop and wait in standby.';
  END IF;
  IF v_token <> p_token THEN
    RAISE EXCEPTION 'drishti: worker write refused: the worker lease % is not held with token % (stale; another worker took over)', p_lease, p_token
      USING ERRCODE = 'WL001', HINT = 'Only the worker holding the lease may write. This worker must stop and wait in standby.';
  END IF;
  IF v_released IS NOT NULL OR v_until <= now() THEN
    RAISE EXCEPTION 'drishti: worker write refused: the worker lease % with token % has ended (not renewed in time)', p_lease, p_token
      USING ERRCODE = 'WL001', HINT = 'Only the worker holding the lease may write. This worker must stop and wait in standby.';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.worker_fence(text, bigint) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- ── 3. Acquire, renew, release ───────────────────────────────────────────────
CREATE FUNCTION public.worker_acquire_lease(p_name text, p_holder uuid, p_ttl_sec integer DEFAULT 20, p_holder_info jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (acquired boolean, fencing_token bigint, lease_until timestamptz, retry_after_ms integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_token bigint;
  v_until timestamptz;
BEGIN
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 100 OR p_name !~ '^[a-z][a-z0-9_-]*(:[a-z0-9_-]+)*$' THEN
    RAISE EXCEPTION 'a lease name is lower-case letters, digits, "-" and "_", in parts separated by ":"' USING ERRCODE = '22023';
  END IF;
  IF p_holder IS NULL THEN RAISE EXCEPTION 'a holder is required' USING ERRCODE = '22023'; END IF;
  IF p_ttl_sec IS NULL OR p_ttl_sec NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'the lease time is 1 to 900 seconds' USING ERRCODE = '22023'; END IF;
  IF p_holder_info IS NULL OR jsonb_typeof(p_holder_info) <> 'object' OR pg_catalog.pg_column_size(p_holder_info) > 2048 THEN
    RAISE EXCEPTION 'the holder information is a small JSON object' USING ERRCODE = '22023';
  END IF;
  -- One statement: a free name is inserted (token 1); a held one is taken only when it has ended or is already this holder's. Two
  -- callers at once: the second waits for the first one's row and then sees it live, so exactly one of them gets the lease.
  INSERT INTO public.worker_leases AS l (name, holder, lease_until, fencing_token, holder_info, acquired_at, renewed_at, released_at)
  VALUES (p_name, p_holder, v_now + pg_catalog.make_interval(secs => p_ttl_sec), 1, p_holder_info, v_now, v_now, NULL)
  ON CONFLICT (name) DO UPDATE SET
    fencing_token = CASE WHEN l.holder = EXCLUDED.holder AND l.lease_until > v_now AND l.released_at IS NULL THEN l.fencing_token ELSE l.fencing_token + 1 END,
    acquired_at = CASE WHEN l.holder = EXCLUDED.holder AND l.lease_until > v_now AND l.released_at IS NULL THEN l.acquired_at ELSE v_now END,
    holder = EXCLUDED.holder,
    lease_until = EXCLUDED.lease_until,
    holder_info = EXCLUDED.holder_info,
    renewed_at = v_now,
    released_at = NULL
  WHERE l.lease_until <= v_now OR l.released_at IS NOT NULL OR l.holder = EXCLUDED.holder
  RETURNING l.fencing_token, l.lease_until INTO v_token, v_until;
  IF v_token IS NOT NULL THEN
    RETURN QUERY SELECT true, v_token, v_until, 0;
    RETURN;
  END IF;
  SELECT l.lease_until INTO v_until FROM public.worker_leases l WHERE l.name = p_name;
  RETURN QUERY SELECT false, NULL::bigint, v_until, GREATEST(0, CEIL(EXTRACT(epoch FROM (v_until - v_now)) * 1000))::integer;
END
$$;

CREATE FUNCTION public.worker_renew_lease(p_name text, p_holder uuid, p_fencing_token bigint, p_ttl_sec integer DEFAULT 20)
RETURNS TABLE (renewed boolean, lease_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_until timestamptz;
BEGIN
  IF p_ttl_sec IS NULL OR p_ttl_sec NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'the lease time is 1 to 900 seconds' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_leases l SET lease_until = v_now + pg_catalog.make_interval(secs => p_ttl_sec), renewed_at = v_now
  WHERE l.name = p_name AND l.holder = p_holder AND l.fencing_token = p_fencing_token AND l.lease_until > v_now AND l.released_at IS NULL
  RETURNING l.lease_until INTO v_until;
  IF FOUND THEN
    RETURN QUERY SELECT true, v_until;
    RETURN;
  END IF;
  SELECT l.lease_until INTO v_until FROM public.worker_leases l WHERE l.name = p_name;
  RETURN QUERY SELECT false, v_until;
END
$$;

CREATE FUNCTION public.worker_release_lease(p_name text, p_holder uuid, p_fencing_token bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.worker_leases l SET lease_until = LEAST(l.lease_until, now()), released_at = now()
  WHERE l.name = p_name AND l.holder = p_holder AND l.fencing_token = p_fencing_token AND l.released_at IS NULL;
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION public.worker_acquire_lease(text, uuid, integer, jsonb), public.worker_renew_lease(text, uuid, bigint, integer),
  public.worker_release_lease(text, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.worker_acquire_lease(text, uuid, integer, jsonb), public.worker_renew_lease(text, uuid, bigint, integer),
  public.worker_release_lease(text, uuid, bigint)
  TO service_role, monitor_worker;

-- Test helpers (service role only; lease names starting with "test:" only, so the worker's own lease can never be touched by them).
/** Sets a test lease's lease_until to the database's now() plus p_offset_ms (negative = ended). */
CREATE FUNCTION public.worker_lease_set_until_test(p_name text, p_offset_ms integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_name IS NULL OR p_name NOT LIKE 'test:%' OR p_offset_ms IS NULL THEN
    RAISE EXCEPTION 'only test leases (names starting with "test:")' USING ERRCODE = '22023';
  END IF;
  UPDATE public.worker_leases SET lease_until = now() + pg_catalog.make_interval(secs => p_offset_ms / 1000.0) WHERE name = p_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such test lease' USING ERRCODE = '22023'; END IF;
END
$$;
/** Removes test leases that ended (released, or not renewed for a minute). Returns how many. */
CREATE FUNCTION public.worker_lease_forget_test() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.worker_leases WHERE name LIKE 'test:%' AND (released_at IS NOT NULL OR lease_until < now() - interval '1 minute');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION public.worker_lease_set_until_test(text, integer), public.worker_lease_forget_test()
  FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.worker_lease_set_until_test(text, integer), public.worker_lease_forget_test() TO service_role;

-- ── 4. monitor_apply_results, fenced, with the SQL late-result guard ──────────
-- Same rules as 20261021000033 (a camera result must name the recorder of its active mapping, targets switched off or archived are
-- ignored, gaps reset a run of failures), plus: the fence first; a result older than the target's last check is skipped.
DROP FUNCTION public.monitor_apply_results(uuid, jsonb, integer);
CREATE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer, p_lease text, p_fencing_token bigint)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r jsonb;
  v_type text;
  v_id uuid;
  v_ok boolean;
  v_at timestamptz;
  v_method text;
  v_error text;
  v_cause text;
  v_prev_checked timestamptz;
  s public.check_state%ROWTYPE;
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation; a camera
    -- must be mapped to THE recorder that produced the result, and the result must name it; a recorder (and so its cameras) must have
    -- monitoring switched on and its asset enabled.
    IF NOT (
      (v_type = 'camera' AND r ? 'recorder' AND jsonb_typeof(r -> 'recorder') = 'string' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        JOIN public.recorders rr ON rr.id = c.recorder_id JOIN public.assets ra ON ra.id = rr.id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND rr.monitoring_enabled AND ra.enabled AND ra.archived_at IS NULL
          AND c.recorder_id::text = lower(r ->> 'recorder'))) OR
      (v_type = 'device' AND EXISTS (
        SELECT 1 FROM public.assets a WHERE a.id = v_id AND a.org_id = p_org AND a.enabled AND a.archived_at IS NULL AND NOT a.is_recorder)) OR
      (v_type = 'recorder' AND EXISTS (
        SELECT 1 FROM public.recorders rr JOIN public.assets a ON a.id = rr.id JOIN public.locations l ON l.id = rr.location_id
        WHERE rr.id = v_id AND rr.org_id = p_org AND rr.monitoring_enabled AND a.enabled AND a.archived_at IS NULL
          AND l.is_active AND l.archived_at IS NULL))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM public.check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

    -- P2-7 (D-8): a result older than the last one applied for this target is late (a slow round, a worker that was paused): skipped.
    IF s.last_checked_at IS NOT NULL AND v_at < s.last_checked_at THEN
      CONTINUE;
    END IF;

    v_prev_checked := s.last_checked_at;
    s.last_checked_at := v_at;
    s.method := v_method;
    IF v_ok THEN
      s.status := 'up';
      s.consecutive_failures := 0;
      s.last_up_at := v_at;
      s.first_failure_at := NULL;
      s.down_since := NULL;
      s.error := NULL;
      UPDATE public.outages SET ended_at = greatest(v_at, started_at)
      WHERE org_id = p_org AND target_type = v_type AND target_id = v_id AND ended_at IS NULL;
    ELSE
      s.error := v_error;
      -- A run of failures that began before the worker was stopped is not continued: nobody knows what happened during the stop.
      IF s.consecutive_failures > 0 AND s.status <> 'down' AND v_prev_checked IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.monitor_gaps g WHERE g.ended_at > v_prev_checked AND g.started_at < v_at) THEN
        s.consecutive_failures := 0;
        s.first_failure_at := NULL;
      END IF;
      IF s.consecutive_failures = 0 THEN s.first_failure_at := v_at; END IF;
      s.consecutive_failures := s.consecutive_failures + 1;
      IF s.consecutive_failures >= p_threshold AND s.status <> 'down' THEN
        s.status := 'down';
        s.down_since := coalesce(s.first_failure_at, v_at);
        INSERT INTO public.outages (org_id, target_type, target_id, started_at, cause)
        VALUES (p_org, v_type, v_id, s.down_since, v_cause)
        ON CONFLICT (org_id, target_type, target_id) WHERE ended_at IS NULL DO NOTHING;
      END IF;
    END IF;

    UPDATE public.check_state
    SET status = s.status, last_checked_at = s.last_checked_at, last_up_at = s.last_up_at,
        first_failure_at = s.first_failure_at, down_since = s.down_since,
        consecutive_failures = s.consecutive_failures, method = s.method, error = s.error
    WHERE id = s.id;
  END LOOP;
END
$function$;

-- ── 5. The worker's other writes, fenced ──────────────────────────────────────
CREATE FUNCTION public.monitor_heartbeat(p_lease text, p_fencing_token bigint, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_state SET last_heartbeat = p_at WHERE id = 1;
END
$$;

CREATE FUNCTION public.monitor_record_gap(p_lease text, p_fencing_token bigint, p_from timestamptz, p_to timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'a gap needs a start and an end after it' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.monitor_gaps (started_at, ended_at) VALUES (p_from, p_to);
END
$$;

-- p_kind 'assets' = the round of devices and NVRs (worker_state.last_devices_round_at), 'cameras' = the camera round. (The word of the
-- P2-5a model; the old table name is kept out of function bodies, see inventory_stale_name_scan.)
CREATE FUNCTION public.monitor_mark_round(p_lease text, p_fencing_token bigint, p_kind text, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  IF p_at IS NULL OR p_kind IS NULL OR p_kind NOT IN ('assets', 'cameras') THEN RAISE EXCEPTION 'a round is assets or cameras, with a time' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'assets' THEN UPDATE public.worker_state SET last_devices_round_at = p_at WHERE id = 1;
  ELSE UPDATE public.worker_state SET last_cameras_round_at = p_at WHERE id = 1;
  END IF;
END
$$;

CREATE FUNCTION public.monitor_run_started(p_lease text, p_fencing_token bigint, p_at timestamptz, p_total integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_state SET run_started_at = p_at, run_finished_at = NULL, progress_done = 0, progress_total = GREATEST(0, coalesce(p_total, 0))
  WHERE id = 1;
END
$$;

CREATE FUNCTION public.monitor_run_progress(p_lease text, p_fencing_token bigint, p_done integer, p_total integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  UPDATE public.worker_state SET progress_done = GREATEST(0, coalesce(p_done, 0)), progress_total = GREATEST(0, coalesce(p_total, 0)) WHERE id = 1;
END
$$;

CREATE FUNCTION public.monitor_run_finished(p_lease text, p_fencing_token bigint, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_state SET run_finished_at = p_at WHERE id = 1;
END
$$;

/**
 * Camera addresses an NVR reported: [{camera, ip, recorder}]. Saved only while the camera is still on that recorder (a camera moved
 * meanwhile keeps its new NVR's address) and only as a plain address; anything else in the list is skipped. Returns how many were saved.
 */
CREATE FUNCTION public.monitor_save_camera_ips(p_lease text, p_fencing_token bigint, p_org uuid, p_rows jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r jsonb;
  v_ip inet;
  n integer := 0;
  k integer;
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  PERFORM public.worker_fence(p_lease, p_fencing_token);
  IF p_org IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'an organisation and a list are required' USING ERRCODE = '22023'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    CONTINUE WHEN jsonb_typeof(r) <> 'object' OR coalesce(r ->> 'camera', '') !~ v_uuid OR coalesce(r ->> 'recorder', '') !~ v_uuid
      OR length(coalesce(r ->> 'ip', '')) NOT BETWEEN 2 AND 45 OR (r ->> 'ip') LIKE '%/%';
    BEGIN
      v_ip := (r ->> 'ip')::inet;
    EXCEPTION WHEN invalid_text_representation THEN
      CONTINUE;
    END;
    UPDATE public.cameras SET camera_ip = pg_catalog.host(v_ip)
    WHERE id = (r ->> 'camera')::uuid AND org_id = p_org AND recorder_id = (r ->> 'recorder')::uuid;
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;
  END LOOP;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer, text, bigint), public.monitor_heartbeat(text, bigint, timestamptz),
  public.monitor_record_gap(text, bigint, timestamptz, timestamptz), public.monitor_mark_round(text, bigint, text, timestamptz),
  public.monitor_run_started(text, bigint, timestamptz, integer), public.monitor_run_progress(text, bigint, integer, integer),
  public.monitor_run_finished(text, bigint, timestamptz), public.monitor_save_camera_ips(text, bigint, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer, text, bigint), public.monitor_heartbeat(text, bigint, timestamptz),
  public.monitor_record_gap(text, bigint, timestamptz, timestamptz), public.monitor_mark_round(text, bigint, text, timestamptz),
  public.monitor_run_started(text, bigint, timestamptz, integer), public.monitor_run_progress(text, bigint, integer, integer),
  public.monitor_run_finished(text, bigint, timestamptz), public.monitor_save_camera_ips(text, bigint, uuid, jsonb)
  TO service_role, monitor_worker;

-- ── 6. No direct table writes by the worker any more ─────────────────────────
REVOKE UPDATE (last_heartbeat, last_devices_round_at, last_cameras_round_at, run_started_at, run_finished_at, progress_done, progress_total)
  ON public.worker_state FROM monitor_worker;
REVOKE INSERT ON public.monitor_gaps FROM monitor_worker;
REVOKE UPDATE (camera_ip) ON public.cameras FROM monitor_worker;

-- ── 7. privilege_violations(), extended ──────────────────────────────────────
-- As in 20261021000035, plus: worker_leases is a server-only table written by the database only; monitor_worker holds no table or
-- column write (its writes are fenced functions); every function monitor_worker may execute takes p_fencing_token, except the lease
-- functions that hand out tokens, the logged credential read and the three housekeeping prunes; worker_fence has no grant at all.
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
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, p.proowner, p.proargnames FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  ), fnacl AS (
    SELECT fn.proname, fn.proargnames, a.grantee FROM fn CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(fn.proacl, pg_catalog.acldefault('f', fn.proowner))) a
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
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps', 'worker_leases')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'worker_leases') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
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
  SELECT pg_catalog.format('function worker_fence: %s may execute it (internal; only the fenced functions call it)', (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname = 'worker_fence'
    AND x.grantee <> (SELECT p.proowner FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'worker_fence' LIMIT 1)
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

NOTIFY pgrst, 'reload schema';

COMMIT;
