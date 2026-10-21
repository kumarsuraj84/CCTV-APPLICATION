-- Monitoring: current status, outage periods, worker state, state function, uptime function, store status view.
-- Rollback: supabase/rollback/20261021000005_monitoring_rollback.sql
BEGIN;

CREATE TABLE public.check_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  target_type text NOT NULL CHECK (target_type IN ('camera', 'device', 'nvr')),
  target_id uuid NOT NULL,  -- for 'nvr' this is the store id
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('up', 'down', 'unknown')),
  last_checked_at timestamptz,
  last_up_at timestamptz,
  first_failure_at timestamptz,
  down_since timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  method text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_state_target_key UNIQUE (org_id, target_type, target_id)
);
CREATE INDEX check_state_status_idx ON public.check_state (org_id, target_type, status);

CREATE TABLE public.outages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  target_type text NOT NULL CHECK (target_type IN ('camera', 'device', 'nvr')),
  target_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  cause text CHECK (cause IS NULL OR cause = 'nvr_down'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outages_order_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX outages_target_idx ON public.outages (org_id, target_type, target_id, started_at);
CREATE INDEX outages_recent_idx ON public.outages (org_id, started_at DESC);
-- At most one open outage per target.
CREATE UNIQUE INDEX outages_one_open_idx ON public.outages (org_id, target_type, target_id) WHERE ended_at IS NULL;

-- Single row: the worker's heartbeat, the "check now" request and the progress of the current run.
CREATE TABLE public.worker_state (
  id integer PRIMARY KEY CHECK (id = 1),
  last_heartbeat timestamptz,
  check_requested_at timestamptz,
  run_started_at timestamptz,
  run_finished_at timestamptz,
  progress_done integer NOT NULL DEFAULT 0,
  progress_total integer NOT NULL DEFAULT 0
);
INSERT INTO public.worker_state (id) VALUES (1);

-- Periods when the worker was not running. Excluded from uptime.
CREATE TABLE public.monitor_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  CONSTRAINT monitor_gaps_order_check CHECK (ended_at >= started_at)
);
CREATE INDEX monitor_gaps_range_idx ON public.monitor_gaps (started_at, ended_at);

CREATE TRIGGER check_state_updated BEFORE UPDATE ON public.check_state FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Status and outages disappear with the thing they describe (the target ids are not foreign keys because they point at three tables).
CREATE OR REPLACE FUNCTION public.monitor_forget_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM check_state WHERE org_id = OLD.org_id AND target_type = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM outages WHERE org_id = OLD.org_id AND target_type = TG_ARGV[0] AND target_id = OLD.id;
  RETURN OLD;
END
$$;
CREATE TRIGGER cameras_forget AFTER DELETE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('camera');
CREATE TRIGGER devices_forget AFTER DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('device');
CREATE TRIGGER stores_forget AFTER DELETE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('nvr');

-- ── The failure / outage rules, in one place ─────────────────────────────────
-- p_results: [{type, id, ok, at, method?, error?, cause?}]. A target goes down after p_threshold failures in a row and comes up on
-- the first success. An outage starts at the time of the first failure of the run of failures.
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

    -- Never trust ids from outside: the target must exist and belong to this organisation.
    IF NOT (
      (v_type = 'camera' AND EXISTS (SELECT 1 FROM cameras WHERE id = v_id AND org_id = p_org)) OR
      (v_type = 'device' AND EXISTS (SELECT 1 FROM devices WHERE id = v_id AND org_id = p_org)) OR
      (v_type = 'nvr' AND EXISTS (SELECT 1 FROM stores WHERE id = v_id AND org_id = p_org))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

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

-- ── Uptime ───────────────────────────────────────────────────────────────────
-- Percent of the observed time a target was up. Observed time excludes the time before the first check and the periods the
-- worker was not running; down time inside such a period is not counted either. No row = nothing observed yet.
CREATE OR REPLACE FUNCTION public.targets_uptime(
  p_org uuid, p_type text, p_ids uuid[], p_window interval, p_now timestamptz DEFAULT now()
) RETURNS TABLE (target_id uuid, uptime_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT cs.target_id AS tid, greatest(p_now - p_window, cs.created_at) AS ws
    FROM check_state cs
    WHERE cs.org_id = p_org AND cs.target_type = p_type AND cs.target_id = ANY (p_ids)
  ),
  obs AS (
    SELECT b.tid, b.ws,
           extract(epoch FROM (p_now - b.ws))
           - coalesce((SELECT sum(extract(epoch FROM (least(g.ended_at, p_now) - greatest(g.started_at, b.ws))))
                       FROM monitor_gaps g WHERE g.ended_at > b.ws AND g.started_at < p_now), 0) AS observed
    FROM base b
    WHERE b.ws < p_now
  ),
  dn AS (
    SELECT o.tid,
           sum(
             extract(epoch FROM (least(coalesce(ou.ended_at, p_now), p_now) - greatest(ou.started_at, o.ws)))
             - coalesce((SELECT sum(greatest(0, extract(epoch FROM (
                           least(coalesce(ou.ended_at, p_now), g.ended_at, p_now) - greatest(ou.started_at, g.started_at, o.ws)))))
                         FROM monitor_gaps g
                         WHERE g.ended_at > greatest(ou.started_at, o.ws) AND g.started_at < least(coalesce(ou.ended_at, p_now), p_now)), 0)
           ) AS down
    FROM obs o
    JOIN outages ou ON ou.org_id = p_org AND ou.target_type = p_type AND ou.target_id = o.tid
                   AND ou.started_at < p_now AND coalesce(ou.ended_at, p_now) > o.ws
    GROUP BY o.tid
  )
  SELECT o.tid,
         CASE WHEN o.observed <= 0 THEN NULL
              ELSE round(100 * greatest(0, least(o.observed, o.observed - coalesce(d.down, 0))) / o.observed, 2) END
  FROM obs o LEFT JOIN dn d ON d.tid = o.tid
$$;

-- ── Per-store summary, evaluated with the reader's own visibility ────────────
CREATE VIEW public.store_status WITH (security_invoker = true) AS
SELECT s.id AS store_id,
       s.org_id,
       count(c.id)::integer AS cameras_total,
       (count(c.id) FILTER (WHERE cs.status = 'up'))::integer AS cameras_live,
       (count(c.id) FILTER (WHERE cs.status = 'down'))::integer AS cameras_down,
       (count(c.id) FILTER (WHERE cs.status IS NULL OR cs.status = 'unknown'))::integer AS cameras_unknown,
       nvr.status AS nvr_status,
       nvr.down_since AS nvr_down_since,
       nvr.last_checked_at AS nvr_checked_at
FROM public.stores s
LEFT JOIN public.cameras c ON c.store_id = s.id
LEFT JOIN public.check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera' AND cs.target_id = c.id
LEFT JOIN public.check_state nvr ON nvr.org_id = s.org_id AND nvr.target_type = 'nvr' AND nvr.target_id = s.id
GROUP BY s.id, s.org_id, nvr.status, nvr.down_since, nvr.last_checked_at;

-- ── Row-level security and grants ────────────────────────────────────────────
ALTER TABLE public.check_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitor_gaps ENABLE ROW LEVEL SECURITY;

-- People read the status of exactly the things they may see.
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.visible_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.visible_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.visible_store_ids()))
    )
  );
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.visible_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.visible_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.visible_store_ids()))
    )
  );

REVOKE ALL ON public.check_state, public.outages, public.worker_state, public.monitor_gaps, public.store_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.check_state, public.outages, public.store_status TO authenticated;
GRANT ALL ON public.check_state, public.outages, public.worker_state, public.monitor_gaps, public.store_status TO service_role;

REVOKE EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer), public.targets_uptime(uuid, text, uuid[], interval, timestamptz),
  public.monitor_forget_target() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer), public.targets_uptime(uuid, text, uuid[], interval, timestamptz),
  public.monitor_forget_target() TO service_role;

COMMIT;
