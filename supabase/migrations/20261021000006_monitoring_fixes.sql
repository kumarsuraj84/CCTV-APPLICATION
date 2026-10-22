-- Monitoring fixes after the final review: stale states, switched-off targets, outages across a worker stop,
-- the times of the last rounds, and a check request stamped with the database clock.
-- Rollback: supabase/rollback/20261021000006_monitoring_fixes_rollback.sql
BEGIN;

-- ── How old a "Live" result may get before it is shown as "Not checked lately" ─
-- The one place this number lives in SQL. lib/queries/status.ts mirrors it as STALE_AFTER_MINUTES (a test keeps the two equal).
CREATE OR REPLACE FUNCTION public.monitor_stale_after_minutes() RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$ SELECT 20 $$;

-- ── Worker state: when the last scheduled rounds finished ────────────────────
ALTER TABLE public.worker_state
  ADD COLUMN last_devices_round_at timestamptz,
  ADD COLUMN last_cameras_round_at timestamptz;

-- ── "Check now", stamped with the database clock ─────────────────────────────
-- The web server and the database may disagree about the time; the worker compares this stamp with times written by the database.
CREATE OR REPLACE FUNCTION public.monitor_request_check() RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE worker_state SET check_requested_at = now() WHERE id = 1 RETURNING check_requested_at
$$;

-- ── The failure / outage rules ───────────────────────────────────────────────
-- Changes against 0005:
--  * a result for a switched-off target (inactive store or camera, disabled device) is ignored;
--  * after a worker stop (a monitor_gaps row that overlaps the time between the last check and this result) a run of failures from before the stop does not count:
--    the run starts again, so an outage can never be dated before the stop.
CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';

    -- Never trust ids from outside: the target must exist, be switched on and belong to this organisation.
    IF NOT (
      (v_type = 'camera' AND EXISTS (
        SELECT 1 FROM cameras c JOIN stores st ON st.id = c.store_id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND st.is_active)) OR
      (v_type = 'device' AND EXISTS (SELECT 1 FROM devices WHERE id = v_id AND org_id = p_org AND enabled)) OR
      (v_type = 'nvr' AND EXISTS (SELECT 1 FROM stores WHERE id = v_id AND org_id = p_org AND is_active))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

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
      UPDATE outages SET ended_at = greatest(v_at, started_at)
      WHERE org_id = p_org AND target_type = v_type AND target_id = v_id AND ended_at IS NULL;
    ELSE
      s.error := v_error;
      -- A run of failures that began before the worker was stopped is not continued: nobody knows what happened during the stop.
      IF s.consecutive_failures > 0 AND s.status <> 'down' AND v_prev_checked IS NOT NULL
         AND EXISTS (SELECT 1 FROM monitor_gaps g WHERE g.ended_at > v_prev_checked AND g.started_at < v_at) THEN
        s.consecutive_failures := 0;
        s.first_failure_at := NULL;
      END IF;
      IF s.consecutive_failures = 0 THEN s.first_failure_at := v_at; END IF;
      s.consecutive_failures := s.consecutive_failures + 1;
      IF s.consecutive_failures >= p_threshold AND s.status <> 'down' THEN
        s.status := 'down';
        s.down_since := coalesce(s.first_failure_at, v_at);
        INSERT INTO outages (org_id, target_type, target_id, started_at, cause)
        VALUES (p_org, v_type, v_id, s.down_since, v_cause)
        ON CONFLICT (org_id, target_type, target_id) WHERE ended_at IS NULL DO NOTHING;
      END IF;
    END IF;

    UPDATE check_state
    SET status = s.status, last_checked_at = s.last_checked_at, last_up_at = s.last_up_at,
        first_failure_at = s.first_failure_at, down_since = s.down_since,
        consecutive_failures = s.consecutive_failures, method = s.method, error = s.error
    WHERE id = s.id;
  END LOOP;
END
$$;

-- ── Switching a target off ───────────────────────────────────────────────────
-- Its open outages end now and its status is forgotten, so it leaves every count; switched on again it starts as "Not checked yet".
-- (Deleting the thing altogether is monitor_forget_target in 0005, which also deletes the outage history.)
CREATE OR REPLACE FUNCTION public.monitor_stop_targets(p_org uuid, p_type text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE outages SET ended_at = greatest(now(), started_at)
  WHERE org_id = p_org AND target_type = p_type AND target_id = ANY (p_ids) AND ended_at IS NULL;
  DELETE FROM check_state WHERE org_id = p_org AND target_type = p_type AND target_id = ANY (p_ids);
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_stop_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM monitor_stop_targets(NEW.org_id, TG_ARGV[0], ARRAY[NEW.id]);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_stop_store() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM monitor_stop_targets(NEW.org_id, 'nvr', ARRAY[NEW.id]);
  PERFORM monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT id FROM cameras WHERE store_id = NEW.id));
  RETURN NEW;
END
$$;

CREATE TRIGGER stores_stop AFTER UPDATE OF is_active ON public.stores
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION public.monitor_stop_store();
CREATE TRIGGER devices_stop AFTER UPDATE OF enabled ON public.devices
  FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled) EXECUTE FUNCTION public.monitor_stop_target('device');
CREATE TRIGGER cameras_stop AFTER UPDATE OF is_active ON public.cameras
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION public.monitor_stop_target('camera');

-- ── Per-store summary ────────────────────────────────────────────────────────
-- Only switched-on stores and cameras. A camera or NVR that was "up" but not checked for longer than monitor_stale_after_minutes() is
-- counted as stale, not live. The earlier columns keep their meaning (cameras_live now excludes stale); cameras_stale and nvr_stale are new.
DROP VIEW public.store_status;
CREATE VIEW public.store_status WITH (security_invoker = true) AS
SELECT s.id AS store_id,
       s.org_id,
       count(c.id)::integer AS cameras_total,
       (count(c.id) FILTER (WHERE cs.status = 'up' AND cs.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes())))::integer AS cameras_live,
       (count(c.id) FILTER (WHERE cs.status = 'down'))::integer AS cameras_down,
       (count(c.id) FILTER (WHERE cs.status IS NULL OR cs.status = 'unknown'))::integer AS cameras_unknown,
       nvr.status AS nvr_status,
       nvr.down_since AS nvr_down_since,
       nvr.last_checked_at AS nvr_checked_at,
       (count(c.id) FILTER (WHERE cs.status = 'up' AND NOT coalesce(cs.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes()), false)))::integer AS cameras_stale,
       coalesce(nvr.status = 'up' AND NOT coalesce(nvr.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes()), false), false) AS nvr_stale
FROM public.stores s
LEFT JOIN public.cameras c ON c.store_id = s.id AND c.is_active
LEFT JOIN public.check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera' AND cs.target_id = c.id
LEFT JOIN public.check_state nvr ON nvr.org_id = s.org_id AND nvr.target_type = 'nvr' AND nvr.target_id = s.id
WHERE s.is_active
GROUP BY s.id, s.org_id, nvr.status, nvr.down_since, nvr.last_checked_at;

-- ── Grants (the defaults are closed) ─────────────────────────────────────────
REVOKE ALL ON public.store_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.store_status TO authenticated;
GRANT ALL ON public.store_status TO service_role;

-- The view calls this as the reader, so the reader needs to run it. It reveals nothing.
REVOKE EXECUTE ON FUNCTION public.monitor_stale_after_minutes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.monitor_stale_after_minutes() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.monitor_request_check(), public.monitor_apply_results(uuid, jsonb, integer),
  public.monitor_stop_targets(uuid, text, uuid[]), public.monitor_stop_target(), public.monitor_stop_store() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monitor_request_check(), public.monitor_apply_results(uuid, jsonb, integer),
  public.monitor_stop_targets(uuid, text, uuid[]), public.monitor_stop_target(), public.monitor_stop_store() TO service_role;

COMMIT;
