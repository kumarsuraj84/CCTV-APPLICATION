-- P2-5c-2 (.superpowers/sdd/drishti/p2-5c-brief.md, items 1 and 4). New forward migration; 0026 and 0027 are applied and not edited.
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0027).
--
-- 1. inventory_import_apply(org, actor, plan): the validated location import applied in ONE transaction — all of it or none of it.
--    The plan is worked out and shown first by the application (lib/import/locations-plan.ts); this function only carries it out, with
--    the same paths the screens use: recorder_save (DR010, own address space, audit), recorder_store_credential (the vault; the value
--    is never audited or returned), recorder_set_monitoring (with the import as the reason), inventory_move_location (a location that
--    joins a cluster: access versions and audit), inventory_archive (only the items the person confirmed; archive, never delete). A
--    refused location stops everything; its file line is given in the error DETAIL ("import_line:<n>").
-- 2. inventory_ensure_placeholders(org, location, recorder, count): the database twin of lib/inventory/cameras.ts
--    ensurePlaceholderCameras (review I-3 rules: a channel that EVER had a camera on that NVR gets no new "Camera N"; an unmapped camera
--    last on that channel is put back). Kept equal by a parity test (tests/integration/p2-5c-2-import.test.ts).
-- 3. recorder_credentials_match(org, items): which of these NVRs already have exactly this saved password — compared inside the
--    database, the saved value never leaves it. The import preview says "unchanged" instead of re-writing the vault.
-- 4. Wi-Fi inventory (brief item 4): device_capabilities becomes readable by holders of wifi.inventory.view (it was server-only in
--    P2-5a); wifi_inventory() lists the access points, routers and switches the caller holds wifi.inventory.view for, with the
--    reachability monitoring last saw. The credential reference is never returned.

-- ═══ 2. Placeholder cameras (the database twin of ensurePlaceholderCameras) ═════════════════════════════════════════════════
CREATE FUNCTION public.inventory_ensure_placeholders(p_org uuid, p_location uuid, p_recorder uuid, p_count integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing integer[];
  v_single boolean;
  v_back record;
  v_relinked integer := 0;
  v_created integer := 0;
BEGIN
  IF p_count IS NULL OR p_count <= 0 THEN RETURN jsonb_build_object('created', 0, 'relinked', 0); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
                 WHERE r.id = p_recorder AND r.org_id = p_org AND r.location_id = p_location) THEN
    RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
  END IF;
  v_missing := ARRAY(
    SELECT g FROM generate_series(1, least(p_count, 999)) AS g
    WHERE NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = p_recorder AND m.channel = g AND m.valid_to IS NULL)
    ORDER BY g);
  IF cardinality(v_missing) = 0 THEN RETURN jsonb_build_object('created', 0, 'relinked', 0); END IF;
  SELECT count(*) = 1 INTO v_single FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.org_id = p_org AND r.location_id = p_location;
  -- Unmapped cameras that may go back on a missing channel: with one NVR at the location, any by its channel; otherwise only those
  -- whose LAST mapping was on this NVR, by that channel. The lowest id wins a channel (as reattachableByChannel).
  FOR v_back IN
    WITH loose AS (
      SELECT c.id, c.channel FROM public.cameras c
      WHERE c.org_id = p_org AND c.location_id = p_location AND c.archived_at IS NULL AND c.recorder_id IS NULL
    ), last AS (
      SELECT DISTINCT ON (m.camera_id) m.camera_id, m.recorder_id, m.channel
      FROM public.camera_channel_mappings m JOIN loose l ON l.id = m.camera_id
      WHERE m.org_id = p_org AND m.valid_to IS NOT NULL
      ORDER BY m.camera_id, m.valid_to DESC
    ), cand AS (
      SELECT l.id, l.channel AS ch FROM loose l WHERE v_single
      UNION ALL
      SELECT l.id, x.channel AS ch FROM loose l JOIN last x ON x.camera_id = l.id WHERE NOT v_single AND x.recorder_id = p_recorder
    )
    SELECT DISTINCT ON (cand.ch) cand.ch, cand.id FROM cand WHERE cand.ch = ANY (v_missing) ORDER BY cand.ch, cand.id
  LOOP
    UPDATE public.cameras SET recorder_id = p_recorder, channel = v_back.ch WHERE id = v_back.id AND org_id = p_org;
    v_relinked := v_relinked + 1;
  END LOOP;
  INSERT INTO public.cameras (org_id, location_id, recorder_id, channel, name)
  SELECT p_org, p_location, p_recorder, g, 'Camera ' || g FROM unnest(v_missing) AS g
  WHERE NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = p_recorder AND m.channel = g);
  GET DIAGNOSTICS v_created = ROW_COUNT;
  RETURN jsonb_build_object('created', v_created, 'relinked', v_relinked);
END
$$;
COMMENT ON FUNCTION public.inventory_ensure_placeholders(uuid, uuid, uuid, integer) IS
  'P2-5c-2: channels 1..count of a recorder get a camera (an unmapped one back, else a new "Camera N" only on a channel that never had one there; review I-3). Twin of ensurePlaceholderCameras.';

-- ═══ 3. Saved password comparison (never the value) ═════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.recorder_credentials_match(p_org uuid, p_items jsonb) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT r.id
  FROM jsonb_to_recordset(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) AS i(recorder uuid, secret text)
  JOIN public.recorders r ON r.id = i.recorder AND r.org_id = p_org
  JOIN vault.decrypted_secrets ds ON ds.id = r.secret_id
  WHERE i.secret IS NOT NULL AND ds.decrypted_secret = i.secret
$$;
COMMENT ON FUNCTION public.recorder_credentials_match(uuid, jsonb) IS
  'P2-5c-2: the recorders of the organisation whose saved password equals the one given (compared in the database; the value is never returned).';

-- ═══ 1. The import, in one transaction ══════════════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.inventory_import_apply(p_org uuid, p_actor uuid, p_plan jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_item jsonb;
  v_rec jsonb;
  v_fields jsonb;
  v_line integer;
  v_state text;
  v_msg text;
  v_region uuid;
  v_cluster uuid;
  v_loc uuid;
  v_recorder uuid;
  v_id uuid;
  v_cam uuid;
  v_ph jsonb;
  v_on boolean;
  v_was boolean;
  v_channels integer;
  c_regions integer := 0;
  c_clusters integer := 0;
  c_loc_created integer := 0;
  c_loc_updated integer := 0;
  c_rec_created integer := 0;
  c_rec_updated integer := 0;
  c_passwords integer := 0;
  c_cameras integer := 0;
  c_relinked integer := 0;
  a_locations integer := 0;
  a_recorders integer := 0;
  a_cameras integer := 0;
  v_dropped uuid[] := '{}';
BEGIN
  -- The acting person, as recorder_set_monitoring asks: active, password chosen, a super administrator, or an administrator holding
  -- admin.inventory for the whole organisation. The application has asked the same from the person's own summary first.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR (v_role <> 'platform_owner' AND NOT EXISTS (
           SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
           WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
    RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory may import' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'the plan must be an object' USING ERRCODE = '22023'; END IF;

  -- Regions and clusters the file needs (by code; created with the code as name, renamed later on their page).
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'regions', '[]'::jsonb)) AS e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.org_id = p_org AND r.code = v_item->>'code' AND r.archived_at IS NULL) THEN
      INSERT INTO public.regions (org_id, code, name) VALUES (p_org, v_item->>'code', coalesce(nullif(v_item->>'name', ''), v_item->>'code'));
      c_regions := c_regions + 1;
    END IF;
  END LOOP;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'clusters', '[]'::jsonb)) AS e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'code' AND c.archived_at IS NULL) THEN
      v_region := NULL;
      IF v_item->>'region_code' IS NOT NULL THEN
        SELECT r.id INTO v_region FROM public.regions r WHERE r.org_id = p_org AND r.code = v_item->>'region_code' AND r.archived_at IS NULL;
        IF v_region IS NULL THEN RAISE EXCEPTION 'region not found' USING ERRCODE = 'P0002'; END IF;
      END IF;
      INSERT INTO public.clusters (org_id, code, name, region_id) VALUES (p_org, v_item->>'code', coalesce(nullif(v_item->>'name', ''), v_item->>'code'), v_region);
      c_clusters := c_clusters + 1;
    END IF;
  END LOOP;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'locations', '[]'::jsonb)) AS e LOOP
    v_line := (v_item->>'line')::integer;
    BEGIN
      v_fields := coalesce(v_item->'fields', '{}'::jsonb);
      IF v_item->>'action' = 'create' THEN
        v_cluster := NULL;
        IF v_item->>'cluster' IS NOT NULL THEN
          SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'cluster' AND c.archived_at IS NULL;
          IF v_cluster IS NULL THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
        END IF;
        INSERT INTO public.locations (org_id, code, name, kind, city, zone, state, address, cluster_id)
        VALUES (p_org, v_item->>'code', v_fields->>'name', coalesce(v_fields->>'kind', 'store'), v_fields->>'city', v_fields->>'zone',
                v_fields->>'state', v_fields->>'address', v_cluster)
        RETURNING id INTO v_loc;
        c_loc_created := c_loc_created + 1;
        INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
        VALUES (p_org, p_actor, 'location_created', 'location', v_loc, jsonb_build_object('code', v_item->>'code', 'kind', coalesce(v_fields->>'kind', 'store'), 'imported', true));
      ELSE
        v_loc := (v_item->>'id')::uuid;
        PERFORM 1 FROM public.locations l WHERE l.id = v_loc AND l.org_id = p_org AND l.archived_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
        IF v_fields <> '{}'::jsonb THEN
          UPDATE public.locations SET
            name = CASE WHEN v_fields ? 'name' THEN v_fields->>'name' ELSE name END,
            kind = CASE WHEN v_fields ? 'kind' THEN v_fields->>'kind' ELSE kind END,
            city = CASE WHEN v_fields ? 'city' THEN v_fields->>'city' ELSE city END,
            zone = CASE WHEN v_fields ? 'zone' THEN v_fields->>'zone' ELSE zone END,
            state = CASE WHEN v_fields ? 'state' THEN v_fields->>'state' ELSE state END,
            address = CASE WHEN v_fields ? 'address' THEN v_fields->>'address' ELSE address END
          WHERE id = v_loc;
          INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
          VALUES (p_org, p_actor, 'location_updated', 'location', v_loc, jsonb_build_object('changed', (SELECT jsonb_agg(k) FROM jsonb_object_keys(v_fields) AS k), 'imported', true));
        END IF;
        -- A location without a cluster joins the one of the file like any move (access versions, audit); one in a cluster stays.
        IF v_item->>'join_cluster' IS NOT NULL THEN
          SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'join_cluster' AND c.archived_at IS NULL;
          IF v_cluster IS NULL THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
          IF (SELECT l.cluster_id FROM public.locations l WHERE l.id = v_loc) IS NULL THEN
            PERFORM public.inventory_move_location(p_org, v_loc, v_cluster, p_actor);
          END IF;
        END IF;
        IF v_item->>'action' = 'update' THEN c_loc_updated := c_loc_updated + 1; END IF;
      END IF;

      FOR v_rec IN SELECT e.value FROM jsonb_array_elements(coalesce(v_item->'recorders', '[]'::jsonb)) AS e LOOP
        v_line := (v_rec->>'line')::integer;
        v_channels := (v_rec->>'channels')::integer;
        IF v_rec->>'action' = 'unchanged' AND coalesce((v_rec->>'placeholders')::integer, 0) = 0 THEN CONTINUE; END IF;
        IF v_rec->>'action' IN ('create', 'update') THEN
          v_recorder := public.recorder_save(p_org, v_loc, CASE WHEN v_rec->>'action' = 'create' THEN NULL ELSE (v_rec->>'id')::uuid END,
            v_rec->>'host', (v_rec->>'http_port')::integer, (v_rec->>'rtsp_port')::integer, v_rec->>'username', v_channels,
            nullif(v_rec->>'name', ''), p_actor);
          IF v_rec->>'action' = 'create' THEN c_rec_created := c_rec_created + 1; ELSE c_rec_updated := c_rec_updated + 1; END IF;
          IF v_rec ? 'password' THEN
            PERFORM public.recorder_store_credential(v_recorder, v_rec->>'password');
            c_passwords := c_passwords + 1;
            INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
            VALUES (p_org, p_actor, 'recorder_password_set', 'recorder', v_recorder, jsonb_build_object('imported', true));
          END IF;
          IF v_rec ? 'monitoring' THEN
            v_on := (v_rec->>'monitoring')::boolean;
            SELECT r.monitoring_enabled INTO v_was FROM public.recorders r WHERE r.id = v_recorder;
            IF v_was IS DISTINCT FROM v_on THEN
              PERFORM public.recorder_set_monitoring(p_org, v_recorder, v_on,
                CASE WHEN v_on THEN 'Switched on by the CSV import.' ELSE 'Switched off by the CSV import.' END, p_actor);
            END IF;
          END IF;
        ELSE
          v_recorder := (v_rec->>'id')::uuid;
        END IF;
        IF coalesce(v_channels, 0) > 0 THEN
          v_ph := public.inventory_ensure_placeholders(p_org, v_loc, v_recorder, v_channels);
          c_cameras := c_cameras + (v_ph->>'created')::integer;
          c_relinked := c_relinked + (v_ph->>'relinked')::integer;
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RAISE EXCEPTION USING ERRCODE = v_state, MESSAGE = v_msg, DETAIL = 'import_line:' || coalesce(v_line::text, '?');
    END;
  END LOOP;

  -- What the person confirmed to archive (never deleted; history, grants and vault logins are kept; restorable).
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'archive', '[]'::jsonb)) AS e LOOP
    v_id := (v_item->>'id')::uuid;
    IF v_item->>'kind' = 'camera' THEN
      IF EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_id AND c.org_id = p_org AND c.archived_at IS NULL) THEN
        PERFORM public.inventory_archive(p_org, 'camera', v_id, p_actor);
        a_cameras := a_cameras + 1;
        v_dropped := v_dropped || v_id;
      END IF;
    ELSIF v_item->>'kind' = 'recorder' THEN
      FOR v_cam IN SELECT m.camera_id FROM public.camera_channel_mappings m WHERE m.recorder_id = v_id AND m.org_id = p_org AND m.valid_to IS NULL LOOP
        PERFORM public.inventory_archive(p_org, 'camera', v_cam, p_actor);
        v_dropped := v_dropped || v_cam;
      END LOOP;
      PERFORM public.inventory_archive(p_org, 'recorder', v_id, p_actor);
      a_recorders := a_recorders + 1;
    ELSIF v_item->>'kind' = 'location' THEN
      v_dropped := v_dropped || ARRAY(SELECT c.id FROM public.cameras c WHERE c.location_id = v_id AND c.org_id = p_org AND c.archived_at IS NULL);
      PERFORM public.inventory_archive(p_org, 'location', v_id, p_actor);
      a_locations := a_locations + 1;
    ELSE
      RAISE EXCEPTION 'unknown kind to archive' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'locations_imported', 'organization', p_org, jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_set', c_passwords, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked, 'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras));
  RETURN jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_set', c_passwords, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked, 'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras, 'dropped_camera_ids', to_jsonb(v_dropped));
END
$$;
COMMENT ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) IS
  'P2-5c-2: applies a validated location import (lib/import/locations-plan.ts) in one transaction; a refused location names its file line in DETAIL (import_line:<n>).';

-- ═══ 4. Wi-Fi inventory ═════════════════════════════════════════════════════════════════════════════════════════════════════
-- The matrix holds documentation evidence only (vendor, model, firmware, operation, support, source): readable by every holder of
-- wifi.inventory.view at any scope (it is not about a place). has_capability evaluates validity, revocation and MFA like every check.
CREATE POLICY device_capabilities_select ON public.device_capabilities FOR SELECT TO authenticated
  USING ((SELECT public.has_capability('wifi.inventory.view')));
GRANT SELECT ON public.device_capabilities TO authenticated;

CREATE FUNCTION public.wifi_inventory() RETURNS TABLE (
  asset_id uuid, location_id uuid, location_code text, location_name text, asset_type text, role text, name text, vendor text, model text,
  firmware text, serial text, mac text, management_mode text, management_ip text, enabled boolean, lifecycle_state text, assigned_profile_id uuid,
  capability_discovered_at timestamptz, last_inventory_at timestamptz, status text, last_checked_at timestamptz, down_since timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id, a.location_id, l.code, l.name, a.type::text, a.role, a.name, a.vendor, a.model, a.firmware, a.serial, a.mac, a.management_mode,
         a.ip, a.enabled, a.lifecycle_state, a.assigned_profile_id, a.capability_discovered_at, a.last_inventory_at,
         cs.status, cs.last_checked_at, cs.down_since
  FROM public.assets a
  LEFT JOIN public.locations l ON l.id = a.location_id AND l.org_id = a.org_id
  LEFT JOIN public.check_state cs ON cs.org_id = a.org_id AND cs.target_type = 'device' AND cs.target_id = a.id
  WHERE a.org_id = (SELECT public.current_org_id()) AND a.archived_at IS NULL AND NOT a.is_recorder
    AND (a.type::text IN ('access_point', 'router', 'switch') OR lower(coalesce(a.role, '')) IN ('access_point', 'router', 'switch'))
    AND a.id IN (SELECT public.capability_asset_ids('wifi.inventory.view'))
  ORDER BY l.code NULLS LAST, a.name, a.id
$$;
COMMENT ON FUNCTION public.wifi_inventory() IS
  'P2-5c-2: the access points, routers and switches the caller holds wifi.inventory.view for, with the reachability monitoring last saw. Never the credential reference.';

-- ═══ Privileges (default privileges are closed; explicit REVOKE / GRANT) ═════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb), public.inventory_ensure_placeholders(uuid, uuid, uuid, integer),
  public.recorder_credentials_match(uuid, jsonb), public.wifi_inventory() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb), public.inventory_ensure_placeholders(uuid, uuid, uuid, integer),
  public.recorder_credentials_match(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.wifi_inventory() TO authenticated;

-- ═══ Self-test ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5c-2 self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-5c-2 self-test: a function names a removed object'; END IF;
  IF has_function_privilege('authenticated', 'public.inventory_import_apply(uuid, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.recorder_credentials_match(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.inventory_ensure_placeholders(uuid, uuid, uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.wifi_inventory()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.device_capabilities', 'SELECT')
     OR has_table_privilege('authenticated', 'public.device_capabilities', 'INSERT')
     OR has_table_privilege('authenticated', 'public.device_capabilities', 'UPDATE') THEN
    RAISE EXCEPTION 'P2-5c-2 self-test: a server-only object is reachable from outside';
  END IF;
END
$$;
