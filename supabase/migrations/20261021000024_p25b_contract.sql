-- P2-5b (WP-2.3b) part 2 of 2: the CONTRACT migration. Removes the transitional seam of P2-5a (decision D5-7, impact map 2.3 / 5.2):
-- no code reads the legacy store shape any more (the application runs on recorders and channel mappings; grep proof in the P2-5b
-- report and tests/integration/contract-p2-5b.test.ts).
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0023).
--
-- Removed:
--   * locations.nvr_ip, rtsp_port, http_port, nvr_username, nvr_secret_id, expected_channels (the NVR data lives on recorders);
--   * the one-way sync trigger locations_seam with locations_legacy_seam() and recorder_ensure_primary();
--   * the location-keyed wrappers nvr_store_credential / nvr_read_credential / nvr_delete_credential (recorder_* are the only path);
--   * recorder_seam_of() (only the seam used it; recorder_primary_of stays: the legacy single-NVR form and CSV still need "the
--     location's primary recorder");
--   * the 'nvr' target kind: monitor_apply_results' ('nvr', location) alias, the 'nvr' branches of check_state_select /
--     outages_select / status_reasons / monitor_stop_location, and 'nvr' in the two target_type CHECKs;
--   * DR009 in inventory_archive (it protected the legacy NVR address that no longer exists);
--   * the one-time migration machinery that reads the legacy columns: inventory_migrate_org(_test), inventory_unmigrate_org(_test),
--     inventory_secret_fingerprint_test and the snapshot table inventory_migration_snapshot (56 rows locally; their check passed in
--     20261021000021). inventory_migration_report stays (history).
-- There never was a compatibility view (ruling 1 of P2-5a), so none is dropped.
--
-- Refused (nothing changes) when data would be lost: a location whose legacy NVR address has no recorder made from it, a location that
-- still holds a vault secret of its own, or any check_state / outages row of kind 'nvr'.

-- ═══ 0. Preconditions ════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.locations l
             WHERE l.nvr_ip IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.location_id = l.id AND r.migrated_from_location_id = l.id)) THEN
    RAISE EXCEPTION 'P2-5b contract: a location names an NVR address that no recorder was made from; run the recorder migration first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.locations l WHERE l.nvr_secret_id IS NOT NULL) THEN
    RAISE EXCEPTION 'P2-5b contract: a location still holds an NVR secret of its own (recorders own their secrets)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.check_state WHERE target_type = 'nvr') OR EXISTS (SELECT 1 FROM public.outages WHERE target_type = 'nvr') THEN
    RAISE EXCEPTION 'P2-5b contract: monitoring history of the old kind ''nvr'' exists; re-key it to ''recorder'' first';
  END IF;
END
$$;

-- ═══ 1. The seam: trigger, sync functions, wrappers ═══════════════════════════════════════════════════════════════════════════
DROP TRIGGER locations_seam ON public.locations;
DROP FUNCTION public.locations_legacy_seam();
DROP FUNCTION public.recorder_ensure_primary(uuid);
DROP FUNCTION public.nvr_store_credential(uuid, text);
DROP FUNCTION public.nvr_read_credential(uuid);
DROP FUNCTION public.nvr_delete_credential(uuid);

-- ═══ 2. The one-time migration machinery (it reads the legacy columns) ═══════════════════════════════════════════════════════
DROP FUNCTION public.inventory_migrate_org_test(uuid, text);
DROP FUNCTION public.inventory_unmigrate_org_test(uuid);
DROP FUNCTION public.inventory_migrate_org(uuid, text);
DROP FUNCTION public.inventory_unmigrate_org(uuid);
DROP FUNCTION public.inventory_secret_fingerprint_test(uuid);
DROP TABLE public.inventory_migration_snapshot;

-- ═══ 3. Results: only camera, device and recorder ═══════════════════════════════════════════════════════════════════════════
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
$$;

-- ═══ 4. Reasons, stop trigger, archive, purge, stale-name scan without the seam ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.status_reasons(p_type text, p_ids uuid[]) RETURNS TABLE(target_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH it_locs AS MATERIALIZED (SELECT x AS id FROM public.it_view_location_ids() AS x WHERE p_type = 'camera'),
       it_recs AS MATERIALIZED (SELECT x AS id FROM public.it_view_recorder_ids() AS x WHERE p_type IN ('camera', 'recorder')),
       cams AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x WHERE p_type = 'camera'),
       devs AS MATERIALIZED (SELECT x AS id FROM public.it_view_asset_ids() AS x WHERE p_type = 'device')
  SELECT cs.target_id,
         CASE
           WHEN cs.error IS NULL OR cs.error = '' THEN NULL
           WHEN p_type <> 'camera' THEN cs.error
           WHEN c.location_id IN (SELECT id FROM it_locs) OR c.recorder_id IN (SELECT id FROM it_recs) THEN cs.error
           WHEN cs.method = 'nvr_down' THEN 'Recorder not reachable.'
           ELSE 'The camera is not responding.'
         END
  FROM public.check_state cs
  LEFT JOIN public.cameras c ON p_type = 'camera' AND c.id = cs.target_id AND c.org_id = cs.org_id
  WHERE cs.org_id = (SELECT public.current_org_id())
    AND cs.target_type = p_type
    AND cs.target_id = ANY (p_ids)
    AND ((p_type = 'camera' AND cs.target_id IN (SELECT id FROM cams))
         OR (p_type = 'device' AND cs.target_id IN (SELECT id FROM devs))
         OR (p_type = 'recorder' AND cs.target_id IN (SELECT id FROM it_recs)))
$$;

CREATE OR REPLACE FUNCTION public.monitor_stop_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY(SELECT r.id FROM public.recorders r WHERE r.location_id = NEW.id));
  PERFORM public.monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT c.id FROM public.cameras c WHERE c.location_id = NEW.id));
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.inventory_archive(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_at timestamptz := now();
  v_n integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_kind NOT IN ('camera', 'asset', 'recorder', 'location', 'cluster', 'region') THEN
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  v_people := public.inventory_affected_people(p_org, p_kind, p_id);
  IF p_kind = 'camera' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings SET valid_to = greatest(v_at, valid_from + interval '1 microsecond')
    WHERE camera_id = p_id AND org_id = p_org AND valid_to IS NULL;
    UPDATE public.cameras SET archived_was_active = is_active, is_active = false, archived_at = v_at, recorder_id = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    PERFORM set_config('drishti.mapping_sync', '', true);
  ELSIF p_kind IN ('asset', 'recorder') THEN
    IF p_kind = 'recorder' AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = p_id AND r.org_id = p_org) THEN
      RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = p_id AND m.valid_to IS NULL) THEN
      RAISE EXCEPTION 'move or archive the cameras of this NVR first' USING ERRCODE = 'DR004';
    END IF;
    UPDATE public.assets SET archived_was_enabled = enabled, enabled = false, archived_at = v_at
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings m SET valid_to = greatest(v_at, m.valid_from + interval '1 microsecond')
    FROM public.cameras c WHERE m.camera_id = c.id AND c.location_id = p_id AND c.org_id = p_org AND m.valid_to IS NULL;
    UPDATE public.cameras SET archived_was_active = is_active, is_active = false, archived_at = v_at, recorder_id = NULL
    WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    PERFORM set_config('drishti.mapping_sync', '', true);
    UPDATE public.assets SET archived_was_enabled = enabled, enabled = false, archived_at = v_at
    WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    UPDATE public.locations SET archived_was_active = is_active, is_active = false, archived_at = v_at
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'cluster' THEN
    IF EXISTS (SELECT 1 FROM public.locations l WHERE l.cluster_id = p_id AND l.org_id = p_org AND l.archived_at IS NULL) THEN
      RAISE EXCEPTION 'the cluster still has locations: move or archive them first' USING ERRCODE = 'DR007';
    END IF;
    UPDATE public.clusters SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    IF EXISTS (SELECT 1 FROM public.clusters c WHERE c.region_id = p_id AND c.org_id = p_org AND c.archived_at IS NULL) THEN
      RAISE EXCEPTION 'the region still has clusters: move or archive them first' USING ERRCODE = 'DR007';
    END IF;
    UPDATE public.regions SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_archived', p_kind, p_id, jsonb_build_object('archived_at', v_at, 'affected_people', cardinality(v_people)));
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id, 'archived_at', v_at);
END
$$;

CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secrets uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be purged' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('drishti.purge_org', p_org::text, true);
  v_secrets := ARRAY(SELECT r.secret_id FROM public.recorders r WHERE r.org_id = p_org AND r.secret_id IS NOT NULL);
  DELETE FROM public.outages WHERE org_id = p_org;
  DELETE FROM public.check_state WHERE org_id = p_org;
  DELETE FROM public.camera_channel_mappings WHERE org_id = p_org;
  DELETE FROM public.cameras WHERE org_id = p_org;
  DELETE FROM public.asset_dependencies WHERE org_id = p_org;
  DELETE FROM public.network_definitions WHERE org_id = p_org;
  DELETE FROM public.asset_endpoints WHERE org_id = p_org;
  UPDATE public.assets SET attached_recorder_id = NULL WHERE org_id = p_org AND attached_recorder_id IS NOT NULL;
  UPDATE public.locations SET uplink_asset_id = NULL, parent_location_id = NULL
  WHERE org_id = p_org AND (uplink_asset_id IS NOT NULL OR parent_location_id IS NOT NULL);
  DELETE FROM public.recorders WHERE org_id = p_org;
  DELETE FROM public.assets WHERE org_id = p_org;
  DELETE FROM public.address_spaces WHERE org_id = p_org;
  DELETE FROM public.locations WHERE org_id = p_org;
  DELETE FROM public.clusters WHERE org_id = p_org;
  DELETE FROM public.regions WHERE org_id = p_org;
  DELETE FROM vault.secrets WHERE id = ANY (v_secrets);
  PERFORM set_config('drishti.purge_org', '', true);
  RETURN jsonb_build_object('secrets_removed', cardinality(v_secrets));
END
$$;

-- The source scan of P2-5a, now also for every name of the removed seam (it must find nothing outside its own body).
CREATE OR REPLACE FUNCTION public.inventory_stale_name_scan() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (p.prosrc ~ '(\mstores\M|store_id|\mdevices\M|nvr_secret_id|nvr_ip|nvr_username|cameras_store_channel|\mstore_status\M|store_nvr_endpoints|capability_store_ids|it_view_store_ids|it_view_device_ids|any_grant_store_ids|recorder_seam_of|recorder_ensure_primary|nvr_store_credential|nvr_read_credential|nvr_delete_credential|inventory_migration_snapshot)'
         OR p.prosrc ~ $re$(target_type|v_type|p_type)\s*=\s*'nvr'|'nvr'\s*,\s*ARRAY|IN\s*\([^)]*'nvr'$re$)
    AND p.proname NOT IN ('access_legacy_store_grants', 'access_migrate_legacy', 'inventory_stale_name_scan')
  ORDER BY 1
$$;

-- ═══ 5. Policies and CHECKs without 'nvr' ═══════════════════════════════════════════════════════════════════════════════════
DROP POLICY check_state_select ON public.check_state;
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated USING (
  org_id = (SELECT public.current_org_id()) AND (
    (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids())) OR
    (target_type = 'device' AND target_id IN (SELECT public.it_view_asset_ids())) OR
    (target_type = 'recorder' AND target_id IN (SELECT public.it_view_recorder_ids()))));
DROP POLICY outages_select ON public.outages;
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated USING (
  org_id = (SELECT public.current_org_id()) AND (
    (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids())) OR
    (target_type = 'device' AND target_id IN (SELECT public.it_view_asset_ids())) OR
    (target_type = 'recorder' AND target_id IN (SELECT public.it_view_recorder_ids()))));

ALTER TABLE public.check_state DROP CONSTRAINT check_state_target_type_check;
ALTER TABLE public.check_state ADD CONSTRAINT check_state_target_type_check CHECK (target_type IN ('camera', 'device', 'recorder'));
ALTER TABLE public.outages DROP CONSTRAINT outages_target_type_check;
ALTER TABLE public.outages ADD CONSTRAINT outages_target_type_check CHECK (target_type IN ('camera', 'device', 'recorder'));
COMMENT ON COLUMN public.check_state.target_id IS 'camera id, asset (device) id or recorder id, by target_type.';

-- ═══ 6. recorder_seam_of (no caller left) and the legacy columns ════════════════════════════════════════════════════════════
DROP FUNCTION public.recorder_seam_of(uuid);
ALTER TABLE public.locations
  DROP COLUMN nvr_ip,
  DROP COLUMN rtsp_port,
  DROP COLUMN http_port,
  DROP COLUMN nvr_username,
  DROP COLUMN nvr_secret_id,
  DROP COLUMN expected_channels;

-- ═══ Self-test ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_stale text;
BEGIN
  SELECT string_agg(x, ', ') INTO v_stale FROM public.inventory_stale_name_scan() AS x;
  IF v_stale IS NOT NULL THEN RAISE EXCEPTION 'P2-5b contract self-test: functions still name the removed seam: %', v_stale; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND (qual ~ '''nvr''' OR with_check ~ '''nvr''')) THEN
    RAISE EXCEPTION 'P2-5b contract self-test: a policy still names the target kind nvr';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_views WHERE schemaname = 'public' AND definition ~ '(nvr_ip|nvr_username|nvr_secret_id)') THEN
    RAISE EXCEPTION 'P2-5b contract self-test: a view still names a legacy NVR column';
  END IF;
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5b contract self-test: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
