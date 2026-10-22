-- P2-5b review round 1 (.superpowers/sdd/drishti/p2-5b-review.md). New forward migration: 0023 and 0024 are applied and are not edited.
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0024).
--
-- I-4  An NVR's asset is switched on whenever the NVR is saved (recorder_save; before: asset enabled = location active at creation, and
--      nothing switched it on again), and switching a location on switches its NVRs' assets on. Location activity is enforced on its own
--      (worker filter, monitor_stop_location); the per-NVR monitoring switch (recorders.monitoring_enabled, audited) is never touched.
--      Data fix: unarchived NVR assets at active locations that the old rule left switched off are switched on.
-- M-1  inventory_refresh_statistics is (re)created here: it was added to 0023 after 0023 had been applied, so a database that recorded
--      0023 before that edit lacks it. CREATE OR REPLACE: harmless where it exists.
-- M-2  recorder_save refuses a second NVR of the SAME location with the same address and web port (SQLSTATE DR010). The same address at
--      ANOTHER location is still accepted (decision D5-8: the location gets its own address space); the application warns about it.
-- M-3  monitor_apply_results: a camera result that names the recorder which produced it ("recorder") counts only while the camera is
--      mapped to that recorder. A late result of a round of the camera's previous NVR is ignored.
-- M-5  Switching an NVR's asset off also stops the monitoring of the cameras mapped to it (like the per-NVR monitoring switch).
-- M-8  discovery_apply: everything one camera discovery saves (new cameras, renames, cameras put back on a channel, cameras moved to
--      another channel of the same NVR) and its audit row, in one transaction: all of it or none of it.

-- ═══ I-4 / M-2: recorder_save ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.recorder_save(
  p_org uuid, p_location uuid, p_recorder uuid, p_host text, p_http_port integer, p_rtsp_port integer, p_username text,
  p_expected_channels integer DEFAULT 0, p_name text DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
  -- M-2: two NVRs of one location at the same address and web port are one box typed twice.
  IF EXISTS (
       SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
       WHERE r.location_id = p_location AND r.id IS DISTINCT FROM v_id AND a.ip = btrim(p_host) AND r.http_port = p_http_port) THEN
    RAISE EXCEPTION 'another NVR of this location already has this address' USING ERRCODE = 'DR010';
  END IF;
  FOR v_try IN 1..2 LOOP
    BEGIN
      IF v_id IS NULL THEN
        -- I-4: switched on (before: switched on only when the location was active, and never switched on again).
        INSERT INTO public.assets (org_id, location_id, type, name, ip, tcp_port, enabled, address_space_id)
        VALUES (p_org, p_location, 'nvr', coalesce(v_name, 'NVR'), btrim(p_host), p_http_port, true, v_space)
        RETURNING id INTO v_id;
        INSERT INTO public.recorders (id, org_id, location_id, http_port, rtsp_port, username, expected_channels, created_asset)
        VALUES (v_id, p_org, p_location, p_http_port, p_rtsp_port, nullif(btrim(coalesce(p_username, '')), ''), coalesce(p_expected_channels, 0), true);
        v_created := true;
      ELSE
        UPDATE public.assets SET ip = btrim(p_host), tcp_port = p_http_port, name = coalesce(v_name, name),
               address_space_id = coalesce(v_space, address_space_id), enabled = true
        WHERE id = v_id AND (ip, tcp_port, name, address_space_id, enabled) IS DISTINCT FROM (btrim(p_host), p_http_port, coalesce(v_name, name), coalesce(v_space, address_space_id), true);
        UPDATE public.recorders SET http_port = p_http_port, rtsp_port = p_rtsp_port, username = nullif(btrim(coalesce(p_username, '')), ''),
               expected_channels = coalesce(p_expected_channels, expected_channels)
        WHERE id = v_id;
      END IF;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try = 2 THEN RAISE; END IF;
      -- The address is taken in the company network: this location gets (or reuses) its own address space (D5-8).
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
$$;
REVOKE ALL ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) TO service_role;

-- ═══ I-4: a location switched on switches its NVRs' assets on ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.locations_recorders_on() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.assets SET enabled = true
  WHERE location_id = NEW.id AND org_id = NEW.org_id AND is_recorder AND archived_at IS NULL AND NOT enabled;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.locations_recorders_on() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER locations_recorders_on AFTER UPDATE OF is_active ON public.locations FOR EACH ROW
  WHEN (NOT OLD.is_active AND NEW.is_active) EXECUTE FUNCTION public.locations_recorders_on();

-- I-4 data fix (logged with its count).
DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.assets a SET enabled = true
  FROM public.locations l
  WHERE l.id = a.location_id AND l.is_active AND l.archived_at IS NULL AND a.is_recorder AND a.archived_at IS NULL AND NOT a.enabled;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'P2-5b review fix I-4: % NVR asset(s) at active locations switched on', v_n;
END
$$;

-- ═══ M-5: an NVR asset switched off stops its cameras too ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.monitor_stop_asset() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'device', ARRAY[NEW.id]);
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY[NEW.id]);
  IF NEW.is_recorder THEN
    PERFORM public.monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT c.id FROM public.cameras c WHERE c.recorder_id = NEW.id));
  END IF;
  RETURN NEW;
END
$$;

-- ═══ M-1: inventory_refresh_statistics (see the header) ══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.inventory_refresh_statistics() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  ANALYZE public.locations, public.recorders, public.assets, public.cameras, public.camera_channel_mappings, public.check_state, public.asset_endpoints;
END
$$;
REVOKE ALL ON FUNCTION public.inventory_refresh_statistics() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_refresh_statistics() TO service_role;

-- ═══ M-3: camera results count only from the camera's current recorder ══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
    -- must be mapped to a recorder — to THE recorder that produced the result, when the result names it (review M-3: a late result
    -- of the camera's previous NVR is ignored); a recorder (and so its cameras) must have monitoring switched on and its asset enabled.
    IF NOT (
      (v_type = 'camera' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        JOIN public.recorders rr ON rr.id = c.recorder_id JOIN public.assets ra ON ra.id = rr.id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND rr.monitoring_enabled AND ra.enabled AND ra.archived_at IS NULL
          AND (NOT (r ? 'recorder') OR c.recorder_id::text = lower(r ->> 'recorder')))) OR
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
$$;

-- ═══ M-8: one camera discovery, saved in one transaction ════════════════════════════════════════════════════════════════════
-- p_ops: [{op: 'insert', channel, name, ip} | {op: 'update', id, name, ip} | {op: 'map', id, channel, name, ip}
--         | {op: 'remap', id, channel, name, ip}]
--   insert: a new camera of the recorder's location, mapped to (p_recorder, channel);
--   update: a camera mapped to p_recorder: new name and address;
--   map:    an unmapped camera of the location is put on (p_recorder, channel) (a restored camera; the mapping trigger maps it);
--   remap:  a camera mapped to p_recorder moves to another channel of p_recorder (camera_remap: history kept, audited).
-- Anything that does not fit (a camera of another location or organisation, an archived camera, a camera of another recorder for
-- update / remap, a mapped camera for map) refuses the whole call (SQLSTATE 22023). Writes the 'cameras_discovered' audit row (the
-- shape access audit rows have) and returns the counts. Server only.
CREATE OR REPLACE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_loc uuid;
  o jsonb;
  v_op text;
  v_cam uuid;
  v_n integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_mapped integer := 0;
  v_moved integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT r.location_id INTO v_loc FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_ops must be an array' USING ERRCODE = '22023'; END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) LOOP
    v_op := o ->> 'op';
    IF v_op = 'insert' THEN
      INSERT INTO public.cameras (org_id, location_id, recorder_id, channel, name, camera_ip)
      VALUES (p_org, v_loc, p_recorder, (o ->> 'channel')::integer, o ->> 'name', o ->> 'ip');
      v_created := v_created + 1;
    ELSIF v_op IN ('update', 'map', 'remap') THEN
      v_cam := (o ->> 'id')::uuid;
      IF v_op = 'map' THEN
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip', recorder_id = p_recorder, channel = (o ->> 'channel')::integer
        WHERE id = v_cam AND org_id = p_org AND location_id = v_loc AND archived_at IS NULL AND recorder_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_mapped := v_mapped + 1;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc
                       AND c.archived_at IS NULL AND c.recorder_id = p_recorder) THEN
          RAISE EXCEPTION 'camera % is not on this recorder', v_cam USING ERRCODE = '22023';
        END IF;
        IF v_op = 'remap' THEN
          PERFORM public.camera_remap(p_org, v_cam, p_recorder, (o ->> 'channel')::integer, now(), p_actor);
          v_moved := v_moved + 1;
        ELSE
          v_updated := v_updated + 1;
        END IF;
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip' WHERE id = v_cam AND org_id = p_org;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 0 THEN RAISE EXCEPTION 'camera % cannot be changed by discovery', v_cam USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'unknown discovery change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'cameras_discovered', 'store', v_loc, jsonb_build_object(
    'capability', 'admin.inventory', 'locationIds', jsonb_build_array(v_loc), 'count', 1, 'recorder_id', p_recorder,
    'created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'to_reconcile', coalesce(p_to_reconcile, 0)));
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved);
END
$$;
COMMENT ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid) IS
  'P2-5b review M-8: everything one camera discovery of one NVR saves, and its audit row, in one transaction. Server only.';
REVOKE ALL ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid) TO service_role;

-- ═══ Self-test ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5b review fixes self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.assets a JOIN public.locations l ON l.id = a.location_id
             WHERE a.is_recorder AND a.archived_at IS NULL AND NOT a.enabled AND l.is_active AND l.archived_at IS NULL) THEN
    RAISE EXCEPTION 'P2-5b review fixes self-test: an NVR asset at an active location is still switched off';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
