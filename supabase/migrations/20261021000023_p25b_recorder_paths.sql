-- P2-5b (WP-2.3b) part 1 of 2: what the application's recorder-model code paths need from the database. Additive: nothing is dropped
-- here (the contract migration 20261021000024 removes the transitional seam once no code reads it).
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0022).
--
-- 1. recorder_save: create or change ONE recorder (NVR) of a location — address, ports, login name, expected channels, name — in one
--    transaction. A recorder address already taken in the company network moves the recorder into its location's own address space
--    (decision D5-8, like the 5a migration) instead of failing. The password is never part of it (recorder_store_credential).
-- 2. A camera inserted without a recorder is mapped automatically ONLY when its location has exactly one NVR. With two or more NVRs it
--    stays unmapped (never probed, never streamed: "Not checked yet") until it is mapped explicitly — it is never routed through a
--    guessed box. (Before: always the location's "primary" NVR.)
-- 3. 5a carry-forward: the 'device' history of nvr assets that became recorders is closed for every recorder (idempotent data fix; the
--    guard is the recorders_after_write trigger and monitor_apply_results, which ignores 'device' results for recorder assets).
-- 4. 5a carry-forward: monitor_stop_targets / monitor_stop_target use `search_path = ''` (fully qualified names).

-- ═══ 1. recorder_save ════════════════════════════════════════════════════════════════════════════════════════════════════════
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
$$;
COMMENT ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) IS
  'P2-5b: create (p_recorder NULL) or change one NVR of a location. Server only; the password goes through recorder_store_credential.';
REVOKE ALL ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid) TO service_role;

-- ═══ 1b. Fresh planner statistics after a bulk change ═══════════════════════════════════════════════════════════════════════
-- A bulk import (216 locations, ~4,600 cameras) or a discovery of every NVR changes the inventory tables faster than autovacuum
-- re-analyses them; until then the planner may join cameras and check_state with a nested loop (measured: location_status 1.8 s instead
-- of 18 ms on the VA-20 shape). The importer, "discover all" and the performance test call this once at the end. Server only.
CREATE OR REPLACE FUNCTION public.inventory_refresh_statistics() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  ANALYZE public.locations, public.recorders, public.assets, public.cameras, public.camera_channel_mappings, public.check_state, public.asset_endpoints;
END
$$;
REVOKE ALL ON FUNCTION public.inventory_refresh_statistics() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_refresh_statistics() TO service_role;

-- ═══ 2. A camera without a recorder: mapped only when the location has exactly one NVR ══════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cameras_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec uuid := NEW.recorder_id;
BEGIN
  IF v_rec IS NULL THEN
    SELECT min(r.id::text)::uuid INTO v_rec FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
    WHERE r.location_id = NEW.location_id
    HAVING count(*) = 1;
  END IF;
  IF v_rec IS NOT NULL AND NEW.archived_at IS NULL THEN
    INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
    VALUES (NEW.org_id, NEW.id, v_rec, NEW.channel, NEW.created_at);
  END IF;
  RETURN NULL;
END
$$;

-- ═══ 4. search_path of the two monitoring stop helpers (5a carry-forward) ══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.monitor_stop_targets(p_org uuid, p_type text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.outages SET ended_at = greatest(now(), started_at)
  WHERE org_id = p_org AND target_type = p_type AND target_id = ANY (p_ids) AND ended_at IS NULL;
  DELETE FROM public.check_state WHERE org_id = p_org AND target_type = p_type AND target_id = ANY (p_ids);
END
$$;
CREATE OR REPLACE FUNCTION public.monitor_stop_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, TG_ARGV[0], ARRAY[NEW.id]);
  RETURN NEW;
END
$$;

-- ═══ 3. Data fix: no 'device' state or open 'device' outage for a recorder asset ════════════════════════════════════════════
DO $$
DECLARE
  o record;
BEGIN
  FOR o IN SELECT r.org_id, array_agg(r.id) AS ids FROM public.recorders r GROUP BY r.org_id LOOP
    PERFORM public.monitor_stop_targets(o.org_id, 'device', o.ids);
  END LOOP;
END
$$;

-- ═══ Self-test ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5b self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.check_state cs JOIN public.recorders r ON r.id = cs.target_id WHERE cs.target_type = 'device')
     OR EXISTS (SELECT 1 FROM public.outages o JOIN public.recorders r ON r.id = o.target_id WHERE o.target_type = 'device' AND o.ended_at IS NULL) THEN
    RAISE EXCEPTION 'P2-5b self-test: a recorder asset still has device monitoring';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
