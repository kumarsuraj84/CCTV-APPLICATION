-- P2-5c-2 review round 1 (.superpowers/sdd/drishti/p2-5c-2-review.md, Part B). New forward migration; 0028 is applied and not edited.
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0030).
--
-- B-I3  The import preview is no longer a password oracle: recorder_credentials_match (which told the preview whether a password in
--       the file equalled the saved one) is DROPPED. The preview now says "set" whenever the file gives a password and "kept" when the
--       cell is empty. inventory_import_apply compares inside the database and writes (and audits) a given password only when it
--       differs from the saved one — re-importing the same file still writes nothing — and it accepts a password for an NVR the plan
--       does not otherwise change (checked to be of this organisation and location). The answer reports how many passwords the file
--       GAVE, never how many differed (the count of writes goes only to the audit row).

DROP FUNCTION public.recorder_credentials_match(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.inventory_import_apply(p_org uuid, p_actor uuid, p_plan jsonb) RETURNS jsonb
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
  c_given integer := 0;
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
        IF v_rec->>'action' = 'unchanged' AND coalesce((v_rec->>'placeholders')::integer, 0) = 0 AND NOT (v_rec ? 'password') THEN CONTINUE; END IF;
        IF v_rec->>'action' IN ('create', 'update') THEN
          v_recorder := public.recorder_save(p_org, v_loc, CASE WHEN v_rec->>'action' = 'create' THEN NULL ELSE (v_rec->>'id')::uuid END,
            v_rec->>'host', (v_rec->>'http_port')::integer, (v_rec->>'rtsp_port')::integer, v_rec->>'username', v_channels,
            nullif(v_rec->>'name', ''), p_actor);
          IF v_rec->>'action' = 'create' THEN c_rec_created := c_rec_created + 1; ELSE c_rec_updated := c_rec_updated + 1; END IF;
          IF v_rec ? 'monitoring' THEN
            v_on := (v_rec->>'monitoring')::boolean;
            SELECT r.monitoring_enabled INTO v_was FROM public.recorders r WHERE r.id = v_recorder;
            IF v_was IS DISTINCT FROM v_on THEN
              PERFORM public.recorder_set_monitoring(p_org, v_recorder, v_on,
                CASE WHEN v_on THEN 'Switched on by the CSV import.' ELSE 'Switched off by the CSV import.' END, p_actor);
            END IF;
          END IF;
        ELSE
          -- An NVR the plan does not otherwise change: it must be a live NVR of this organisation and location.
          v_recorder := (v_rec->>'id')::uuid;
          PERFORM 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
          WHERE r.id = v_recorder AND r.org_id = p_org AND r.location_id = v_loc;
          IF NOT FOUND THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
        END IF;
        -- B-I3: a password the file gives is written (and audited, without the value) only when it differs from the saved one.
        IF v_rec ? 'password' THEN
          c_given := c_given + 1;
          IF NOT EXISTS (SELECT 1 FROM public.recorders r JOIN vault.decrypted_secrets ds ON ds.id = r.secret_id
                         WHERE r.id = v_recorder AND ds.decrypted_secret = v_rec->>'password') THEN
            PERFORM public.recorder_store_credential(v_recorder, v_rec->>'password');
            c_passwords := c_passwords + 1;
            INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
            VALUES (p_org, p_actor, 'recorder_password_set', 'recorder', v_recorder, jsonb_build_object('imported', true));
          END IF;
        END IF;
        IF coalesce(v_channels, 0) > 0 AND (v_rec->>'action' <> 'unchanged' OR coalesce((v_rec->>'placeholders')::integer, 0) > 0) THEN
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
    'passwords_given', c_given, 'passwords_written', c_passwords, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked,
    'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras));
  RETURN jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_given', c_given, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked, 'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras, 'dropped_camera_ids', to_jsonb(v_dropped));
END
$$;
COMMENT ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) IS
  'P2-5c-2: applies a validated location import (lib/import/locations-plan.ts) in one transaction; a refused location names its file line in DETAIL (import_line:<n>). Review B-I3: a given password is written only when it differs; the answer never says which differed.';
-- (CREATE OR REPLACE keeps the grants of 0028: service_role only. Stated again on purpose.)
REVOKE ALL ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_import_apply(uuid, uuid, jsonb) TO service_role;

-- ═══ Self-test ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5c-2 review self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-5c-2 review self-test: a function names a removed object'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'recorder_credentials_match') THEN
    RAISE EXCEPTION 'P2-5c-2 review self-test: the password comparison still exists';
  END IF;
  IF has_function_privilege('authenticated', 'public.inventory_import_apply(uuid, uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2-5c-2 review self-test: the import is reachable from outside';
  END IF;
END
$$;

