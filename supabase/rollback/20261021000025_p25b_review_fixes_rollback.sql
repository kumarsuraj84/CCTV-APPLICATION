-- Rollback of 20261021000025_p25b_review_fixes.sql. Run before the rollback of 20261021000024.
-- Puts back the previous definitions of recorder_save (0023), monitor_stop_asset (0019) and monitor_apply_results (0024), verbatim
-- from pg_get_functiondef of the database before 0025 was applied; removes discovery_apply and the location trigger.
-- NOT undone: the I-4 data fix (NVR assets at active locations that were switched on stay on; switching them off again would stop their
-- monitoring for no reason). inventory_refresh_statistics stays: it belongs to 0023 (0025 only re-creates it, M-1).
BEGIN;
DROP FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid);
DROP TRIGGER locations_recorders_on ON public.locations;
DROP FUNCTION public.locations_recorders_on();

CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2)
 RETURNS void
 LANGUAGE plpgsql
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
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation; a camera
    -- must be mapped to a recorder; a recorder (and so its cameras) must have monitoring switched on and its asset enabled. Any other
    -- kind (the old 'nvr' + location id of the P2-5a seam among them) is ignored.
    IF NOT (
      (v_type = 'camera' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        JOIN public.recorders rr ON rr.id = c.recorder_id JOIN public.assets ra ON ra.id = rr.id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND rr.monitoring_enabled AND ra.enabled AND ra.archived_at IS NULL)) OR
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
$function$
;

CREATE OR REPLACE FUNCTION public.monitor_stop_asset()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'device', ARRAY[NEW.id]);
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY[NEW.id]);
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.recorder_save(p_org uuid, p_location uuid, p_recorder uuid, p_host text, p_http_port integer, p_rtsp_port integer, p_username text, p_expected_channels integer DEFAULT 0, p_name text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  l public.locations%ROWTYPE;
  v_id uuid := p_recorder;
  v_space uuid;
  v_try integer;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_created boolean := false;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_host IS NULL OR btrim(p_host) = '' OR length(p_host) > 253 THEN RAISE EXCEPTION 'an NVR address is needed' USING ERRCODE = '22023'; END IF;
  IF p_http_port IS NULL OR p_http_port NOT BETWEEN 1 AND 65535 OR p_rtsp_port IS NULL OR p_rtsp_port NOT BETWEEN 1 AND 65535 THEN
    RAISE EXCEPTION 'a port must be from 1 to 65535' USING ERRCODE = '22023';
  END IF;
  IF p_expected_channels IS NOT NULL AND p_expected_channels NOT BETWEEN 0 AND 999 THEN
    RAISE EXCEPTION 'the number of cameras must be from 0 to 999' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 200 THEN RAISE EXCEPTION 'the NVR name is too long' USING ERRCODE = '22023'; END IF;
  SELECT * INTO l FROM public.locations x WHERE x.id = p_location AND x.org_id = p_org AND x.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
  IF v_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
       WHERE r.id = v_id AND r.org_id = p_org AND r.location_id = p_location) THEN
    RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
  END IF;
  FOR v_try IN 1..2 LOOP
    BEGIN
      IF v_id IS NULL THEN
        INSERT INTO public.assets (org_id, location_id, type, name, ip, tcp_port, enabled, address_space_id)
        VALUES (p_org, p_location, 'nvr', coalesce(v_name, 'NVR'), btrim(p_host), p_http_port, l.is_active, v_space)
        RETURNING id INTO v_id;
        INSERT INTO public.recorders (id, org_id, location_id, http_port, rtsp_port, username, expected_channels, created_asset)
        VALUES (v_id, p_org, p_location, p_http_port, p_rtsp_port, nullif(btrim(coalesce(p_username, '')), ''), coalesce(p_expected_channels, 0), true);
        v_created := true;
      ELSE
        UPDATE public.assets SET ip = btrim(p_host), tcp_port = p_http_port, name = coalesce(v_name, name),
               address_space_id = coalesce(v_space, address_space_id)
        WHERE id = v_id AND (ip, tcp_port, name, address_space_id) IS DISTINCT FROM (btrim(p_host), p_http_port, coalesce(v_name, name), coalesce(v_space, address_space_id));
        UPDATE public.recorders SET http_port = p_http_port, rtsp_port = p_rtsp_port, username = nullif(btrim(coalesce(p_username, '')), ''),
               expected_channels = coalesce(p_expected_channels, expected_channels)
        WHERE id = v_id;
      END IF;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try = 2 THEN RAISE; END IF;
      -- The address is taken in the company network: this location gets (or reuses) its own address space (D5-8).
      -- (The failed attempt was rolled back; a new recorder gets a new id on the second try.)
      IF p_recorder IS NULL THEN v_id := NULL; v_created := false; END IF;
      SELECT s.id INTO v_space FROM public.address_spaces s WHERE s.location_id = l.id AND s.kind = 'location_nat';
      IF v_space IS NULL THEN
        INSERT INTO public.address_spaces (org_id, name, kind, location_id, notes)
        VALUES (l.org_id, 'Location ' || l.code || ' (own addresses)', 'location_nat', l.id,
                'Made because an NVR address of this location is also used elsewhere (SD-WAN addressing unknown, D5-8).')
        RETURNING id INTO v_space;
      END IF;
    END;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, CASE WHEN v_created THEN 'recorder_created' ELSE 'recorder_updated' END, 'recorder', v_id,
          jsonb_build_object('location_id', p_location, 'own_address_space', v_space IS NOT NULL));
  RETURN v_id;
END
$function$
;


REVOKE ALL ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback 0025: privilege_violations() is not empty'; END IF;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
