-- Puts the monitoring objects back as they were after 0005.
BEGIN;

DROP TRIGGER IF EXISTS stores_stop ON public.stores;
DROP TRIGGER IF EXISTS devices_stop ON public.devices;
DROP TRIGGER IF EXISTS cameras_stop ON public.cameras;
DROP FUNCTION IF EXISTS public.monitor_stop_store();
DROP FUNCTION IF EXISTS public.monitor_stop_target();
DROP FUNCTION IF EXISTS public.monitor_stop_targets(uuid, text, uuid[]);

DROP VIEW IF EXISTS public.store_status;
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
REVOKE ALL ON public.store_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.store_status TO authenticated;
GRANT ALL ON public.store_status TO service_role;

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

DROP FUNCTION IF EXISTS public.monitor_request_check();
ALTER TABLE public.worker_state DROP COLUMN IF EXISTS last_devices_round_at, DROP COLUMN IF EXISTS last_cameras_round_at;
DROP FUNCTION IF EXISTS public.monitor_stale_after_minutes();

REVOKE EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer) TO service_role;

COMMIT;
