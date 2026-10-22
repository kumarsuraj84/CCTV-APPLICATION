-- Rollback of 20261021000022_p25_review_fixes.sql (P2-5a review fix round 1). Run before the rollbacks of 0021 / 0020 / 0019.
-- Puts back the 0019 / 0020 / 0021 definitions (taken verbatim from those files) and removes what 0022 added.
-- NOT undone: the data fix (the 'device' state of adopted nvr devices stays forgotten, their outages stay closed); access versions
-- raised meanwhile stay raised. LOST: the report rows of kinds device_unlocated / device_duplicate; the remembered on/off state of
-- archived rows (a later restore turns them on, as before 0022). The uplink column and parent links stay as they are; only the
-- foreign key, the cycle trigger and the address-space rule go.
BEGIN;
DELETE FROM public.inventory_migration_report WHERE kind IN ('device_unlocated', 'device_duplicate');
ALTER TABLE public.inventory_migration_report DROP CONSTRAINT inventory_migration_report_kind_check;
ALTER TABLE public.inventory_migration_report ADD CONSTRAINT inventory_migration_report_kind_check CHECK (kind IN (
  'org_summary', 'recorder_created', 'device_merged', 'address_conflict', 'secret_missing', 'secret_dangling', 'camera_unmapped'));

DROP TRIGGER asset_endpoints_space ON public.asset_endpoints;
DROP TRIGGER assets_space ON public.assets;
DROP TRIGGER locations_parent ON public.locations;
DROP FUNCTION public.assets_space_check();
DROP FUNCTION public.locations_parent_check();
DROP INDEX public.locations_uplink_idx;
ALTER TABLE public.locations DROP CONSTRAINT locations_uplink_fk;
REVOKE SELECT (migrated_from_location_id) ON public.recorders FROM authenticated;

DROP POLICY asset_endpoints_select ON public.asset_endpoints;
CREATE POLICY asset_endpoints_select ON public.asset_endpoints FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND asset_id IN (SELECT public.it_view_asset_ids()));

-- ═══ The previous definitions (verbatim from 20261021000019 / 0020 / 0021) ═══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.it_view_recorder_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id FROM public.recorders r WHERE r.id IN (SELECT public.it_view_asset_ids())
$$;

CREATE OR REPLACE FUNCTION public.any_grant_cluster_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE area <> 'admin'
  )
  SELECT c.id FROM public.clusters c JOIN g ON g.org_id = c.org_id AND g.scope_kind = 'organization' WHERE c.archived_at IS NULL
  UNION
  SELECT c.id FROM public.clusters c JOIN g ON g.scope_kind = 'cluster' AND g.scope_id = c.id WHERE c.archived_at IS NULL
  UNION
  SELECT c.id FROM public.clusters c JOIN public.regions r ON r.id = c.region_id AND r.archived_at IS NULL
  JOIN g ON g.scope_kind = 'region' AND g.scope_id = r.id WHERE c.archived_at IS NULL
  UNION
  SELECT c.id FROM public.clusters c JOIN public.locations l ON l.cluster_id = c.id
  WHERE c.archived_at IS NULL AND l.id IN (SELECT public.any_grant_location_ids())
$$;

CREATE OR REPLACE FUNCTION public.any_grant_region_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE area <> 'admin'
  )
  SELECT r.id FROM public.regions r JOIN g ON g.org_id = r.org_id AND g.scope_kind = 'organization' WHERE r.archived_at IS NULL
  UNION
  SELECT r.id FROM public.regions r JOIN g ON g.scope_kind = 'region' AND g.scope_id = r.id WHERE r.archived_at IS NULL
  UNION
  SELECT r.id FROM public.regions r JOIN public.clusters c ON c.region_id = r.id
  WHERE r.archived_at IS NULL AND c.id IN (SELECT public.any_grant_cluster_ids())
$$;

CREATE OR REPLACE FUNCTION public.recorder_primary_of(p_location uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.location_id = p_location ORDER BY r.created_at, r.id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.recorder_ensure_primary(p_location uuid, OUT recorder_id uuid, OUT created boolean, OUT merged boolean, OUT conflict boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  l public.locations%ROWTYPE;
  v_asset uuid;
  v_space uuid;
  v_try integer;
BEGIN
  created := false; merged := false; conflict := false;
  SELECT * INTO l FROM public.locations x WHERE x.id = p_location FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  recorder_id := public.recorder_primary_of(p_location);
  IF recorder_id IS NULL AND l.nvr_ip IS NULL THEN RETURN; END IF;
  FOR v_try IN 1..2 LOOP
    BEGIN
      IF recorder_id IS NOT NULL THEN
        IF l.nvr_ip IS NOT NULL THEN
          UPDATE public.assets SET ip = l.nvr_ip, tcp_port = l.http_port, address_space_id = coalesce(v_space, address_space_id)
          WHERE id = recorder_id AND (ip, tcp_port, address_space_id) IS DISTINCT FROM (l.nvr_ip, l.http_port, coalesce(v_space, address_space_id));
          UPDATE public.recorders SET http_port = l.http_port, rtsp_port = l.rtsp_port, username = l.nvr_username, expected_channels = l.expected_channels
          WHERE id = recorder_id AND (http_port, rtsp_port, username, expected_channels) IS DISTINCT FROM (l.http_port, l.rtsp_port, l.nvr_username, l.expected_channels);
        END IF;
        RETURN;
      END IF;
      SELECT a.id INTO v_asset FROM public.assets a
      WHERE a.org_id = l.org_id AND a.type = 'nvr' AND NOT a.is_recorder AND a.archived_at IS NULL AND a.ip = l.nvr_ip
        AND (a.location_id = l.id OR a.location_id IS NULL)
      ORDER BY (a.location_id = l.id) DESC NULLS LAST, a.created_at, a.id LIMIT 1;
      IF v_asset IS NOT NULL THEN
        UPDATE public.assets SET location_id = l.id, tcp_port = coalesce(tcp_port, l.http_port), address_space_id = coalesce(v_space, address_space_id),
               enabled = enabled AND l.is_active
        WHERE id = v_asset;
        merged := true;
      ELSE
        INSERT INTO public.assets (org_id, location_id, type, name, ip, tcp_port, enabled, address_space_id)
        VALUES (l.org_id, l.id, 'nvr', 'NVR', l.nvr_ip, l.http_port, l.is_active, v_space)
        RETURNING id INTO v_asset;
      END IF;
      INSERT INTO public.recorders (id, org_id, location_id, http_port, rtsp_port, username, expected_channels, migrated_from_location_id, created_asset)
      VALUES (v_asset, l.org_id, l.id, l.http_port, l.rtsp_port, l.nvr_username, l.expected_channels, l.id, NOT merged);
      recorder_id := v_asset;
      created := true;
      -- Cameras of the location without an active mapping go to the new primary recorder on their channel.
      INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
      SELECT c.org_id, c.id, v_asset, c.channel,
             greatest(c.created_at, coalesce((SELECT max(m.valid_to) FROM public.camera_channel_mappings m WHERE m.camera_id = c.id), c.created_at))
      FROM public.cameras c
      WHERE c.location_id = l.id AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.camera_id = c.id AND m.valid_to IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.cameras c2 WHERE c2.location_id = l.id AND c2.channel = c.channel AND c2.id < c.id AND c2.archived_at IS NULL);
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      IF v_try = 2 THEN RAISE; END IF;
      -- The address is taken in the company network: this location gets (or reuses) its own address space.
      SELECT s.id INTO v_space FROM public.address_spaces s WHERE s.location_id = l.id AND s.kind = 'location_nat';
      IF v_space IS NULL THEN
        INSERT INTO public.address_spaces (org_id, name, kind, location_id, notes)
        VALUES (l.org_id, 'Location ' || l.code || ' (own addresses)', 'location_nat', l.id,
                'Made because the NVR address of this location is also used elsewhere (SD-WAN addressing unknown, D5-8).')
        RETURNING id INTO v_space;
      END IF;
      conflict := true; merged := false; v_asset := NULL;
    END;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec uuid;
BEGIN
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN RAISE EXCEPTION 'empty secret' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_store) THEN RAISE EXCEPTION 'unknown store' USING ERRCODE = 'P0002'; END IF;
  v_rec := coalesce(public.recorder_primary_of(p_store), (public.recorder_ensure_primary(p_store)).recorder_id);
  IF v_rec IS NULL THEN RAISE EXCEPTION 'this location has no NVR' USING ERRCODE = 'P0002'; END IF;
  RETURN public.recorder_store_credential(v_rec, p_secret);
END
$$;

CREATE OR REPLACE FUNCTION public.nvr_read_credential(p_store uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.recorder_read_credential(public.recorder_primary_of(p_store))
$$;

CREATE OR REPLACE FUNCTION public.nvr_delete_credential(p_store uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec uuid := public.recorder_primary_of(p_store);
BEGIN
  IF v_rec IS NOT NULL THEN PERFORM public.recorder_delete_credential(v_rec); END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.recorder_read_credential(p_recorder uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds
  WHERE ds.id = (SELECT r.secret_id FROM public.recorders r WHERE r.id = p_recorder)
$$;

CREATE OR REPLACE FUNCTION public.recorders_after_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM set_config('drishti.recorder_sync', 'on', true);
    UPDATE public.assets SET is_recorder = false WHERE id = OLD.id;
    PERFORM set_config('drishti.recorder_sync', '', true);
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM set_config('drishti.recorder_sync', 'on', true);
    UPDATE public.assets SET is_recorder = true WHERE id = NEW.id AND NOT is_recorder;
    PERFORM set_config('drishti.recorder_sync', '', true);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.rtsp_port IS DISTINCT FROM OLD.rtsp_port THEN
    PERFORM public.asset_sync_endpoints(NEW.id);
  END IF;
  RETURN NULL;
END
$$;

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

    IF v_type = 'nvr' THEN
      v_id := public.recorder_primary_of(v_id);
      v_type := 'recorder';
      IF v_id IS NULL THEN CONTINUE; END IF;
    END IF;

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation, and (for
    -- recorders and their cameras) have monitoring switched on.
    IF NOT (
      (v_type = 'camera' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        LEFT JOIN public.recorders rr ON rr.id = c.recorder_id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND coalesce(rr.monitoring_enabled, true))) OR
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

CREATE OR REPLACE FUNCTION public.inventory_archive(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_at timestamptz := now();
  v_n integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_kind = 'camera' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings SET valid_to = greatest(v_at, valid_from + interval '1 microsecond')
    WHERE camera_id = p_id AND org_id = p_org AND valid_to IS NULL;
    UPDATE public.cameras SET is_active = false, archived_at = v_at, recorder_id = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    PERFORM set_config('drishti.mapping_sync', '', true);
  ELSIF p_kind IN ('asset', 'recorder') THEN
    IF p_kind = 'recorder' AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = p_id AND r.org_id = p_org) THEN
      RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = p_id AND m.valid_to IS NULL) THEN
      RAISE EXCEPTION 'move or archive the cameras of this NVR first' USING ERRCODE = 'DR004';
    END IF;
    UPDATE public.assets SET enabled = false, archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings m SET valid_to = greatest(v_at, m.valid_from + interval '1 microsecond')
    FROM public.cameras c WHERE m.camera_id = c.id AND c.location_id = p_id AND c.org_id = p_org AND m.valid_to IS NULL;
    UPDATE public.cameras SET is_active = false, archived_at = v_at, recorder_id = NULL WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    PERFORM set_config('drishti.mapping_sync', '', true);
    UPDATE public.assets SET enabled = false, archived_at = v_at WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    UPDATE public.locations SET is_active = false, archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'cluster' THEN
    UPDATE public.clusters SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'region' THEN
    UPDATE public.regions SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_archived', p_kind, p_id, jsonb_build_object('archived_at', v_at));
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id, 'archived_at', v_at);
END
$$;

CREATE OR REPLACE FUNCTION public.inventory_restore(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_at timestamptz;
  v_n integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_kind = 'camera' THEN
    UPDATE public.cameras SET archived_at = NULL, is_active = true WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind IN ('asset', 'recorder') THEN
    UPDATE public.assets SET archived_at = NULL, enabled = true WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    SELECT l.archived_at INTO v_at FROM public.locations l WHERE l.id = p_id AND l.org_id = p_org AND l.archived_at IS NOT NULL;
    IF v_at IS NOT NULL THEN
      UPDATE public.locations SET archived_at = NULL, is_active = true WHERE id = p_id;
      v_n := 1;
      -- What was archived with it comes back with it; cameras get their last mapping again when its channel is still free.
      UPDATE public.assets SET archived_at = NULL, enabled = true WHERE location_id = p_id AND archived_at = v_at;
      UPDATE public.cameras SET archived_at = NULL, is_active = true WHERE location_id = p_id AND archived_at = v_at;
      INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
      SELECT DISTINCT ON (m.recorder_id, m.channel) m.org_id, m.camera_id, m.recorder_id, m.channel, greatest(now(), m.valid_to)
      FROM public.camera_channel_mappings m JOIN public.cameras c ON c.id = m.camera_id AND c.archived_at IS NULL
      WHERE c.location_id = p_id AND m.valid_to >= v_at
        AND m.valid_to = (SELECT max(y.valid_to) FROM public.camera_channel_mappings y WHERE y.camera_id = m.camera_id)
        AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings x WHERE x.camera_id = m.camera_id AND x.valid_to IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings x WHERE x.recorder_id = m.recorder_id AND x.channel = m.channel AND x.valid_to IS NULL)
      ORDER BY m.recorder_id, m.channel, m.valid_to DESC;
    END IF;
  ELSIF p_kind = 'cluster' THEN
    UPDATE public.clusters SET archived_at = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'region' THEN
    UPDATE public.regions SET archived_at = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_restored', p_kind, p_id, '{}'::jsonb);
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id);
END
$$;

CREATE OR REPLACE FUNCTION public.camera_remap(p_org uuid, p_camera uuid, p_recorder uuid, p_channel integer, p_at timestamptz DEFAULT now(), p_actor uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.cameras%ROWTYPE;
  v_id uuid;
  v_at timestamptz;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT * INTO c FROM public.cameras x WHERE x.id = p_camera AND x.org_id = p_org FOR UPDATE;
  IF NOT FOUND OR c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  IF p_channel IS NULL OR p_channel < 1 THEN RAISE EXCEPTION 'a channel number is needed' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
                 WHERE r.id = p_recorder AND r.org_id = p_org AND r.location_id = c.location_id) THEN
    RAISE EXCEPTION 'a camera can only be mapped to a recorder at its own location' USING ERRCODE = 'DR006';
  END IF;
  -- The switch moment; never before the current mapping began (a mapping made earlier in the same transaction).
  v_at := greatest(p_at, coalesce((SELECT m.valid_from + interval '1 microsecond' FROM public.camera_channel_mappings m
                                   WHERE m.camera_id = p_camera AND m.valid_to IS NULL), p_at));
  PERFORM set_config('drishti.mapping_sync', 'on', true);
  UPDATE public.camera_channel_mappings SET valid_to = v_at WHERE camera_id = p_camera AND valid_to IS NULL;
  INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from, created_by)
  VALUES (p_org, p_camera, p_recorder, p_channel, v_at, p_actor) RETURNING id INTO v_id;
  UPDATE public.cameras SET recorder_id = p_recorder, channel = p_channel WHERE id = p_camera;
  PERFORM set_config('drishti.mapping_sync', '', true);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'camera_remapped', 'camera', p_camera, jsonb_build_object('from_recorder', c.recorder_id, 'from_channel', c.channel,
          'to_recorder', p_recorder, 'to_channel', p_channel, 'mapping_id', v_id));
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.cameras_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec uuid;
  v_at timestamptz;
BEGIN
  IF coalesce(current_setting('drishti.mapping_sync', true), '') = 'on' THEN RETURN NEW; END IF;
  IF (NEW.recorder_id, NEW.channel) IS NOT DISTINCT FROM (OLD.recorder_id, OLD.channel) AND NEW.location_id = OLD.location_id THEN
    RETURN NEW;
  END IF;
  v_rec := NEW.recorder_id;
  IF v_rec IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = v_rec AND r.location_id = NEW.location_id) THEN
    RAISE EXCEPTION 'a camera can only be mapped to a recorder at its own location' USING ERRCODE = 'DR006';
  END IF;
  IF (NEW.recorder_id, NEW.channel) IS DISTINCT FROM (OLD.recorder_id, OLD.channel) THEN
    v_at := greatest(now(), coalesce((SELECT m.valid_from + interval '1 microsecond' FROM public.camera_channel_mappings m
                                      WHERE m.camera_id = NEW.id AND m.valid_to IS NULL), now()));
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings SET valid_to = v_at WHERE camera_id = NEW.id AND valid_to IS NULL;
    IF v_rec IS NOT NULL AND NEW.archived_at IS NULL THEN
      INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
      VALUES (NEW.org_id, NEW.id, v_rec, NEW.channel, v_at);
    END IF;
    PERFORM set_config('drishti.mapping_sync', '', true);
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.cameras_monitoring_off(p_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id FROM public.cameras c JOIN public.recorders r ON r.id = c.recorder_id
  WHERE c.id = ANY (p_ids) AND NOT r.monitoring_enabled AND c.id IN (SELECT public.any_cctv_camera_ids())
$$;

CREATE OR REPLACE FUNCTION public.network_definitions_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF jsonb_typeof(NEW.vlan_map) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'vlan_map must be an object' USING ERRCODE = '22023'; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(NEW.vlan_map) LOOP
    IF k NOT IN ('staff', 'guest', 'device', 'other') THEN RAISE EXCEPTION 'unknown VLAN purpose %', k USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(v) <> 'number' OR (v #>> '{}')::numeric NOT BETWEEN 1 AND 4094 OR (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) THEN
      RAISE EXCEPTION 'VLAN ids are whole numbers from 1 to 4094' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.inventory_migrate_org(p_org uuid, p_fail_at text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  l record;
  v record;
  v_rec uuid;
  v_hash_before text;
  v_cipher_before text;
  v_hash_after text;
  v_cipher_after text;
  v_n integer;
  c_recorders integer := 0;
  c_merged integer := 0;
  c_conflicts integer := 0;
  c_missing integer := 0;
  c_dangling integer := 0;
  c_cameras integer := 0;
  c_state integer := 0;
  c_outages integer := 0;
  c_unmapped integer := 0;
  v_out jsonb;
BEGIN
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown organisation' USING ERRCODE = 'P0002'; END IF;
  FOR l IN
    SELECT x.id, x.code, x.nvr_ip, x.nvr_secret_id FROM public.locations x
    WHERE x.org_id = p_org AND x.nvr_ip IS NOT NULL AND x.archived_at IS NULL
    ORDER BY x.created_at, x.id
  LOOP
    IF public.recorder_primary_of(l.id) IS NOT NULL THEN CONTINUE; END IF; -- already migrated: idempotent
    SELECT * INTO v FROM public.recorder_ensure_primary(l.id);
    v_rec := v.recorder_id;
    IF v_rec IS NULL THEN CONTINUE; END IF;
    c_recorders := c_recorders + 1;
    INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
    VALUES (p_org, 'recorder_created', l.id, v_rec, jsonb_build_object('created_asset', NOT v.merged, 'code', l.code));
    IF v.merged THEN
      c_merged := c_merged + 1;
      INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
      VALUES (p_org, 'device_merged', l.id, v_rec, jsonb_build_object('note', 'An nvr device at the same address became this location''s recorder (same id).'));
    END IF;
    IF v.conflict THEN
      c_conflicts := c_conflicts + 1;
      INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
      VALUES (p_org, 'address_conflict', l.id, v_rec, jsonb_build_object('host', l.nvr_ip,
              'note', 'The NVR address is also used elsewhere; the recorder was put in this location''s own address space (D5-8).'));
    END IF;
    SELECT count(*) INTO v_n FROM public.camera_channel_mappings m WHERE m.recorder_id = v_rec AND m.valid_to IS NULL;
    c_cameras := c_cameras + v_n;

    -- The vault secret: rename in place, re-point, prove the stored value is untouched (hashes stay inside this transaction).
    IF l.nvr_secret_id IS NULL THEN
      c_missing := c_missing + 1;
      INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
      VALUES (p_org, 'secret_missing', l.id, v_rec, jsonb_build_object('note', 'No NVR password was saved for this location.'));
    ELSIF NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = l.nvr_secret_id) THEN
      c_dangling := c_dangling + 1;
      INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
      VALUES (p_org, 'secret_dangling', l.id, v_rec, jsonb_build_object('note', 'The saved password pointer led to nothing; the recorder has no password yet.'));
      UPDATE public.locations SET nvr_secret_id = NULL WHERE id = l.id;
    ELSE
      SELECT encode(extensions.digest(coalesce(ds.decrypted_secret, ''), 'sha256'), 'hex'), encode(extensions.digest(s.secret, 'sha256'), 'hex')
      INTO v_hash_before, v_cipher_before
      FROM vault.secrets s JOIN vault.decrypted_secrets ds ON ds.id = s.id WHERE s.id = l.nvr_secret_id;
      DELETE FROM vault.secrets WHERE name = 'recorder:' || v_rec::text AND id <> l.nvr_secret_id;
      PERFORM vault.update_secret(l.nvr_secret_id, NULL, 'recorder:' || v_rec::text, 'Recorder login');
      PERFORM set_config('drishti.vault_write', 'on', true);
      UPDATE public.recorders SET secret_id = l.nvr_secret_id WHERE id = v_rec;
      PERFORM set_config('drishti.vault_write', '', true);
      UPDATE public.locations SET nvr_secret_id = NULL WHERE id = l.id;
      SELECT encode(extensions.digest(coalesce(ds.decrypted_secret, ''), 'sha256'), 'hex'), encode(extensions.digest(s.secret, 'sha256'), 'hex')
      INTO v_hash_after, v_cipher_after
      FROM vault.secrets s JOIN vault.decrypted_secrets ds ON ds.id = s.id WHERE s.id = l.nvr_secret_id;
      IF v_hash_after IS DISTINCT FROM v_hash_before OR v_cipher_after IS DISTINCT FROM v_cipher_before THEN
        RAISE EXCEPTION 'P2-5a migration: the vault secret of location % changed while being renamed', l.id;
      END IF;
    END IF;

    -- Monitoring history: ('nvr', location) → ('recorder', recorder). Ids, times and causes stay; one open outage per target holds.
    UPDATE public.check_state SET target_type = 'recorder', target_id = v_rec WHERE org_id = p_org AND target_type = 'nvr' AND target_id = l.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    c_state := c_state + v_n;
    UPDATE public.outages SET target_type = 'recorder', target_id = v_rec WHERE org_id = p_org AND target_type = 'nvr' AND target_id = l.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    c_outages := c_outages + v_n;
    IF p_fail_at = 'after_rekey' THEN RAISE EXCEPTION 'injected failure (test): nothing of this run may remain'; END IF;
  END LOOP;

  FOR l IN
    SELECT c.id, c.location_id FROM public.cameras c
    WHERE c.org_id = p_org AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.camera_id = c.id AND m.valid_to IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public.inventory_migration_report r WHERE r.org_id = p_org AND r.kind = 'camera_unmapped' AND r.detail ->> 'camera_id' = c.id::text)
  LOOP
    c_unmapped := c_unmapped + 1;
    INSERT INTO public.inventory_migration_report (org_id, kind, location_id, detail)
    VALUES (p_org, 'camera_unmapped', l.location_id, jsonb_build_object('camera_id', l.id, 'note', 'This location has no NVR to map the camera to.'));
  END LOOP;

  v_out := jsonb_build_object(
    'recorders_created', c_recorders, 'devices_merged', c_merged, 'address_conflicts', c_conflicts, 'secrets_missing', c_missing,
    'secrets_dangling', c_dangling, 'cameras_mapped', c_cameras, 'check_state_rekeyed', c_state, 'outages_rekeyed', c_outages,
    'cameras_unmapped', c_unmapped,
    'locations_without_cluster', (SELECT count(*) FROM public.locations x WHERE x.org_id = p_org AND x.archived_at IS NULL AND x.cluster_id IS NULL),
    'nvr_rows_left', (SELECT count(*) FROM public.check_state s WHERE s.org_id = p_org AND s.target_type = 'nvr')
                     + (SELECT count(*) FROM public.outages o WHERE o.org_id = p_org AND o.target_type = 'nvr'));
  INSERT INTO public.inventory_migration_report (org_id, kind, detail) VALUES (p_org, 'org_summary', v_out);
  RETURN v_out;
END
$$;

CREATE OR REPLACE FUNCTION public.inventory_stale_name_scan() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosrc ~ '(\mstores\M|store_id|\mdevices\M|nvr_secret_id|nvr_ip|cameras_store_channel|\mstore_status\M|store_nvr_endpoints|capability_store_ids|it_view_store_ids|it_view_device_ids|any_grant_store_ids)'
    AND p.proname NOT IN ('access_legacy_store_grants', 'access_migrate_legacy', 'recorder_ensure_primary', 'locations_legacy_seam',
                          'inventory_purge_test_org', 'inventory_migrate_org', 'inventory_unmigrate_org', 'inventory_secret_fingerprint_test',
                          'inventory_stale_name_scan')
  ORDER BY 1
$$;

CREATE OR REPLACE VIEW public.location_status WITH (security_barrier = true) AS
SELECT l.id AS location_id, l.org_id,
       coalesce(cam.total, 0) AS cameras_total, coalesce(cam.live, 0) AS cameras_live, coalesce(cam.down, 0) AS cameras_down,
       coalesce(cam.unknown, 0) AS cameras_unknown,
       rec.status AS nvr_status, rec.down_since AS nvr_down_since, rec.checked_at AS nvr_checked_at,
       coalesce(cam.stale, 0) AS cameras_stale, coalesce(rec.stale, false) AS nvr_stale,
       coalesce(rec.total, 0) AS recorders_total, coalesce(rec.up, 0) AS recorders_up, coalesce(rec.down, 0) AS recorders_down,
       coalesce(rec.unknown, 0) AS recorders_unknown, coalesce(rec.off, 0) AS recorders_monitoring_off,
       coalesce(cam.off, 0) AS cameras_monitoring_off
FROM public.locations l
-- One grouped pass over the visible cameras (the visible set is hashed once; a per-location LATERAL walked all of it for every
-- location: 192 ms → see docs/drishti/locations-model.md, performance).
LEFT JOIN (
  SELECT c.location_id,
         count(*)::integer AS total,
         (count(*) FILTER (WHERE cs.status = 'up' AND cs.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes())))::integer AS live,
         (count(*) FILTER (WHERE cs.status = 'down'))::integer AS down,
         (count(*) FILTER (WHERE (cs.status IS NULL OR cs.status = 'unknown') AND coalesce(r.monitoring_enabled, true)))::integer AS unknown,
         (count(*) FILTER (WHERE cs.status = 'up' AND NOT coalesce(cs.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes()), false)))::integer AS stale,
         (count(*) FILTER (WHERE r.monitoring_enabled = false))::integer AS off
  FROM public.cameras c
  LEFT JOIN public.check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera' AND cs.target_id = c.id
  LEFT JOIN public.recorders r ON r.id = c.recorder_id
  WHERE c.org_id = (SELECT public.current_org_id()) AND c.is_active AND c.archived_at IS NULL
    AND c.id IN (SELECT public.any_cctv_camera_ids())
  GROUP BY c.location_id
) cam ON cam.location_id = l.id
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS total,
         (count(*) FILTER (WHERE r.monitoring_enabled AND rs.status = 'up'))::integer AS up,
         (count(*) FILTER (WHERE r.monitoring_enabled AND rs.status = 'down'))::integer AS down,
         (count(*) FILTER (WHERE r.monitoring_enabled AND (rs.status IS NULL OR rs.status = 'unknown')))::integer AS unknown,
         (count(*) FILTER (WHERE NOT r.monitoring_enabled))::integer AS off,
         CASE WHEN bool_or(r.monitoring_enabled AND rs.status = 'down') THEN 'down'
              WHEN bool_or(r.monitoring_enabled AND rs.id IS NULL) THEN NULL
              WHEN bool_or(r.monitoring_enabled AND rs.status = 'unknown') THEN 'unknown'
              WHEN bool_or(r.monitoring_enabled AND rs.status = 'up') THEN 'up'
              ELSE NULL END AS status,
         min(rs.down_since) FILTER (WHERE r.monitoring_enabled AND rs.status = 'down') AS down_since,
         min(rs.last_checked_at) FILTER (WHERE r.monitoring_enabled) AS checked_at,
         bool_or(r.monitoring_enabled AND rs.status = 'up'
                 AND NOT coalesce(rs.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes()), false)) AS stale
  FROM public.recorders r
  JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL AND a.enabled
  LEFT JOIN public.check_state rs ON rs.org_id = r.org_id AND rs.target_type = 'recorder' AND rs.target_id = r.id
  WHERE r.location_id = l.id AND r.id IN (SELECT public.it_view_recorder_ids())
) rec ON true
WHERE l.org_id = (SELECT public.current_org_id()) AND l.is_active AND l.archived_at IS NULL
  AND l.id IN (SELECT public.any_grant_location_ids());

CREATE OR REPLACE VIEW public.recorder_status WITH (security_barrier = true) AS
SELECT r.id AS recorder_id, r.org_id, r.location_id, a.name, r.monitoring_enabled,
       CASE WHEN r.monitoring_enabled THEN rs.status END AS status,
       CASE WHEN r.monitoring_enabled THEN rs.down_since END AS down_since,
       CASE WHEN r.monitoring_enabled THEN rs.last_checked_at END AS checked_at,
       coalesce(r.monitoring_enabled AND rs.status = 'up'
                AND NOT coalesce(rs.last_checked_at >= now() - make_interval(mins => public.monitor_stale_after_minutes()), false), false) AS stale
FROM public.recorders r
JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
LEFT JOIN public.check_state rs ON rs.org_id = r.org_id AND rs.target_type = 'recorder' AND rs.target_id = r.id
WHERE r.org_id = (SELECT public.current_org_id()) AND r.id IN (SELECT public.it_view_recorder_ids());

CREATE OR REPLACE VIEW public.recorder_endpoints WITH (security_barrier = true) AS
SELECT r.id AS recorder_id, r.org_id, r.location_id, a.ip AS host, r.http_port, r.rtsp_port, r.username, r.monitoring_enabled
FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
WHERE r.org_id = (SELECT public.current_org_id()) AND r.id IN (SELECT public.it_view_recorder_ids());

CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secrets uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be purged' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('drishti.purge_org', p_org::text, true);
  v_secrets := ARRAY(SELECT r.secret_id FROM public.recorders r WHERE r.org_id = p_org AND r.secret_id IS NOT NULL
                     UNION SELECT l.nvr_secret_id FROM public.locations l WHERE l.org_id = p_org AND l.nvr_secret_id IS NOT NULL);
  DELETE FROM public.outages WHERE org_id = p_org;
  DELETE FROM public.check_state WHERE org_id = p_org;
  DELETE FROM public.camera_channel_mappings WHERE org_id = p_org;
  DELETE FROM public.cameras WHERE org_id = p_org;
  DELETE FROM public.asset_dependencies WHERE org_id = p_org;
  DELETE FROM public.network_definitions WHERE org_id = p_org;
  DELETE FROM public.asset_endpoints WHERE org_id = p_org;
  UPDATE public.assets SET attached_recorder_id = NULL WHERE org_id = p_org AND attached_recorder_id IS NOT NULL;
  DELETE FROM public.recorders WHERE org_id = p_org;
  DELETE FROM public.assets WHERE org_id = p_org;
  DELETE FROM public.address_spaces WHERE org_id = p_org;
  UPDATE public.locations SET parent_location_id = NULL WHERE org_id = p_org AND parent_location_id IS NOT NULL;
  DELETE FROM public.locations WHERE org_id = p_org;
  DELETE FROM public.clusters WHERE org_id = p_org;
  DELETE FROM public.regions WHERE org_id = p_org;
  DELETE FROM vault.secrets WHERE id = ANY (v_secrets);
  PERFORM set_config('drishti.purge_org', '', true);
  RETURN jsonb_build_object('secrets_removed', cardinality(v_secrets));
END
$$;

-- ═══ What 0022 added ════════════════════════════════════════════════════════════════════════════════════════════════════════
DROP FUNCTION public.inventory_remap_effects(uuid, uuid, uuid, uuid);
DROP FUNCTION public.access_bump_versions(uuid[]);
DROP FUNCTION public.inventory_affected_people(uuid, text, uuid);
DROP FUNCTION public.it_view_endpoint_asset_ids();
DROP FUNCTION public.recorder_seam_of(uuid);
ALTER TABLE public.cameras DROP COLUMN archived_was_active;
ALTER TABLE public.locations DROP COLUMN archived_was_active;
ALTER TABLE public.assets DROP COLUMN archived_was_enabled;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0022: privilege violations'; END IF;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
