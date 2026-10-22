-- Rollback of 20261021000024_p25b_contract.sql (P2-5b contract migration). Run first, before the rollback of 20261021000023.
-- Puts back the P2-5a transitional seam exactly as it was (the function definitions below are verbatim from the database before the
-- contract migration, i.e. 0019..0022): the legacy NVR columns on locations, the one-way sync trigger, the location-keyed nvr_*
-- wrappers, the 'nvr' target kind in the CHECKs, policies, status_reasons and monitor_apply_results, DR009, the one-time migration
-- functions and the (empty) snapshot table.
--
-- Data: the legacy columns are rebuilt from each location's recorder made by the 5a migration (migrated_from_location_id = the
-- location). A location without such a recorder but with recorders made later gets its FIRST recorder marked as that one
-- (migrated_from_location_id set) and its columns filled from it, which is what the 5a seam would have produced had the location been
-- created through the old form. nvr_secret_id stays NULL (the recorders keep their vault secrets). The snapshot rows (56 locally,
-- already verified by 0021) are not restored. This rollback never has to refuse: everything the 5b model holds fits the 5a model; the
-- 0019 rollback further down the chain refuses as documented there.
BEGIN;

ALTER TABLE public.locations
  ADD COLUMN nvr_ip text,
  ADD COLUMN rtsp_port integer NOT NULL DEFAULT 554,
  ADD COLUMN http_port integer NOT NULL DEFAULT 80,
  ADD COLUMN nvr_username text,
  ADD COLUMN nvr_secret_id uuid,
  ADD COLUMN expected_channels integer NOT NULL DEFAULT 0;
ALTER TABLE public.locations
  ADD CONSTRAINT stores_expected_channels_check CHECK (expected_channels >= 0),
  ADD CONSTRAINT stores_http_port_check CHECK (http_port >= 1 AND http_port <= 65535),
  ADD CONSTRAINT stores_rtsp_port_check CHECK (rtsp_port >= 1 AND rtsp_port <= 65535);
COMMENT ON COLUMN public.locations.nvr_ip IS 'DEPRECATED (P2-5a seam): copied one way to the primary recorder; dropped in P2-5b.';
COMMENT ON COLUMN public.locations.nvr_secret_id IS 'DEPRECATED (P2-5a): the recorder owns its vault secret (recorders.secret_id); always NULL after the migration.';
GRANT SELECT (expected_channels) ON public.locations TO authenticated;

-- The location's 5a NVR: the recorder made from it, else (recorders made after the contract) its first recorder.
UPDATE public.recorders r SET migrated_from_location_id = r.location_id
FROM (
  SELECT DISTINCT ON (x.location_id) x.id FROM public.recorders x JOIN public.assets a ON a.id = x.id AND a.archived_at IS NULL
  WHERE NOT EXISTS (SELECT 1 FROM public.recorders y WHERE y.location_id = x.location_id AND y.migrated_from_location_id = x.location_id)
  ORDER BY x.location_id, x.created_at, x.id
) f
WHERE r.id = f.id;
UPDATE public.locations l SET nvr_ip = a.ip, rtsp_port = r.rtsp_port, http_port = r.http_port, nvr_username = r.username, expected_channels = r.expected_channels
FROM public.recorders r JOIN public.assets a ON a.id = r.id
WHERE r.location_id = l.id AND r.migrated_from_location_id = l.id;

ALTER TABLE public.check_state DROP CONSTRAINT check_state_target_type_check;
ALTER TABLE public.check_state ADD CONSTRAINT check_state_target_type_check CHECK (target_type IN ('camera', 'device', 'recorder', 'nvr'));
ALTER TABLE public.outages DROP CONSTRAINT outages_target_type_check;
ALTER TABLE public.outages ADD CONSTRAINT outages_target_type_check CHECK (target_type IN ('camera', 'device', 'recorder', 'nvr'));

CREATE TABLE public.inventory_migration_snapshot (
  id bigserial PRIMARY KEY,
  taken_at timestamptz NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  capability text NOT NULL,
  cameras uuid[] NOT NULL,
  locations uuid[] NOT NULL,
  assets uuid[] NOT NULL
);
COMMENT ON TABLE public.inventory_migration_snapshot IS
  'P2-5a: every person''s effective sets before the location/recorder migration (old functions). Verified by 20261021000021; dropped by the P2-5b contract migration.';
ALTER TABLE public.inventory_migration_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_migration_snapshot FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.inventory_migration_snapshot_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- ═══ The previous definitions (verbatim from the database before 20261021000024) ════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.recorder_seam_of(p_location uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.location_id = p_location AND r.migrated_from_location_id = p_location
  ORDER BY r.created_at, r.id LIMIT 1
$function$
;

CREATE OR REPLACE FUNCTION public.recorder_ensure_primary(p_location uuid, OUT recorder_id uuid, OUT created boolean, OUT merged boolean, OUT conflict boolean)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  l public.locations%ROWTYPE;
  v_asset uuid;
  v_space uuid;
  v_try integer;
BEGIN
  created := false; merged := false; conflict := false;
  SELECT * INTO l FROM public.locations x WHERE x.id = p_location FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  recorder_id := public.recorder_seam_of(p_location);
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
      WHERE a.org_id = l.org_id AND a.type = 'nvr' AND NOT a.is_recorder AND a.archived_at IS NULL AND a.ip = l.nvr_ip AND a.location_id = l.id
      ORDER BY a.created_at, a.id LIMIT 1;
      IF v_asset IS NOT NULL THEN
        UPDATE public.assets SET tcp_port = coalesce(tcp_port, l.http_port), address_space_id = coalesce(v_space, address_space_id),
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
      -- Cameras of the location without an active mapping go to the legacy NVR on their channel.
      INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
      SELECT c.org_id, c.id, v_asset, c.channel,
             greatest(c.created_at, coalesce((SELECT max(m.valid_to) FROM public.camera_channel_mappings m WHERE m.camera_id = c.id), c.created_at))
      FROM public.cameras c
      WHERE c.location_id = l.id AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.camera_id = c.id AND m.valid_to IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = v_asset AND m.channel = c.channel AND m.valid_to IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.cameras c2 WHERE c2.location_id = l.id AND c2.channel = c.channel AND c2.id < c.id AND c2.archived_at IS NULL
                        AND NOT EXISTS (SELECT 1 FROM public.camera_channel_mappings m2 WHERE m2.camera_id = c2.id AND m2.valid_to IS NULL));
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
$function$
;

CREATE OR REPLACE FUNCTION public.locations_legacy_seam()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF coalesce(current_setting('drishti.legacy_seam', true), '') = 'off' THEN RETURN NULL; END IF;
  IF NEW.nvr_ip IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.nvr_ip, NEW.rtsp_port, NEW.http_port, NEW.nvr_username, NEW.expected_channels)
     IS NOT DISTINCT FROM (OLD.nvr_ip, OLD.rtsp_port, OLD.http_port, OLD.nvr_username, OLD.expected_channels) THEN
    RETURN NULL;
  END IF;
  PERFORM public.recorder_ensure_primary(NEW.id);
  RETURN NULL;
END
$function$
;

CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rec uuid;
BEGIN
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN RAISE EXCEPTION 'empty secret' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_store) THEN RAISE EXCEPTION 'unknown store' USING ERRCODE = 'P0002'; END IF;
  v_rec := coalesce(public.recorder_seam_of(p_store), (public.recorder_ensure_primary(p_store)).recorder_id);
  IF v_rec IS NULL THEN RAISE EXCEPTION 'this location has no NVR' USING ERRCODE = 'P0002'; END IF;
  RETURN public.recorder_store_credential(v_rec, p_secret);
END
$function$
;

CREATE OR REPLACE FUNCTION public.nvr_read_credential(p_store uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.recorder_read_credential(public.recorder_seam_of(p_store))
$function$
;

CREATE OR REPLACE FUNCTION public.nvr_delete_credential(p_store uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rec uuid := public.recorder_seam_of(p_store);
BEGIN
  IF v_rec IS NOT NULL THEN PERFORM public.recorder_delete_credential(v_rec); END IF;
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_migrate_org(p_org uuid, p_fail_at text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  l record;
  v record;
  d record;
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
  c_unlocated integer := 0;
  c_duplicate integer := 0;
  v_out jsonb;
BEGIN
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown organisation' USING ERRCODE = 'P0002'; END IF;
  FOR l IN
    SELECT x.id, x.code, x.nvr_ip, x.nvr_secret_id FROM public.locations x
    WHERE x.org_id = p_org AND x.nvr_ip IS NOT NULL AND x.archived_at IS NULL
    ORDER BY x.created_at, x.id
  LOOP
    IF public.recorder_seam_of(l.id) IS NOT NULL THEN CONTINUE; END IF; -- already migrated: idempotent
    SELECT * INTO v FROM public.recorder_ensure_primary(l.id);
    v_rec := v.recorder_id;
    IF v_rec IS NULL THEN CONTINUE; END IF;
    c_recorders := c_recorders + 1;
    INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
    VALUES (p_org, 'recorder_created', l.id, v_rec, jsonb_build_object('created_asset', NOT v.merged, 'code', l.code));
    IF v.merged THEN
      c_merged := c_merged + 1;
      INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
      VALUES (p_org, 'device_merged', l.id, v_rec, jsonb_build_object('note', 'An nvr device at the same address became this location''s recorder (same id); its monitoring as a device stopped.'));
    END IF;
    IF v.conflict THEN
      c_conflicts := c_conflicts + 1;
      INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
      VALUES (p_org, 'address_conflict', l.id, v_rec, jsonb_build_object('host', l.nvr_ip,
              'note', 'The NVR address is also used elsewhere; the recorder was put in this location''s own address space (D5-8).'));
    END IF;
    -- Review M13: other nvr devices at the NVR's address are reported, never adopted (and never an abort).
    FOR d IN
      SELECT a.id, a.location_id FROM public.assets a
      WHERE a.org_id = p_org AND a.type = 'nvr' AND NOT a.is_recorder AND a.archived_at IS NULL AND a.ip = l.nvr_ip
        AND (a.location_id = l.id OR a.location_id IS NULL) AND a.id <> v_rec
      ORDER BY a.created_at, a.id
    LOOP
      IF d.location_id IS NULL THEN
        c_unlocated := c_unlocated + 1;
        INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
        VALUES (p_org, 'device_unlocated', l.id, v_rec, jsonb_build_object('asset_id', d.id,
                'note', 'An nvr device without a location has this NVR''s address; it was not adopted. Check it and give it a location or archive it.'));
      ELSE
        c_duplicate := c_duplicate + 1;
        INSERT INTO public.inventory_migration_report (org_id, kind, location_id, recorder_id, detail)
        VALUES (p_org, 'device_duplicate', l.id, v_rec, jsonb_build_object('asset_id', d.id,
                'note', 'Another nvr device of this location has the NVR''s address; it was not adopted. It is probably a duplicate record.'));
      END IF;
    END LOOP;
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
    'cameras_unmapped', c_unmapped, 'devices_unlocated', c_unlocated, 'devices_duplicate', c_duplicate, 'device_history_stopped', c_merged,
    'locations_without_cluster', (SELECT count(*) FROM public.locations x WHERE x.org_id = p_org AND x.archived_at IS NULL AND x.cluster_id IS NULL),
    'nvr_rows_left', (SELECT count(*) FROM public.check_state s WHERE s.org_id = p_org AND s.target_type = 'nvr')
                     + (SELECT count(*) FROM public.outages o WHERE o.org_id = p_org AND o.target_type = 'nvr'));
  INSERT INTO public.inventory_migration_report (org_id, kind, detail) VALUES (p_org, 'org_summary', v_out);
  RETURN v_out;
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_unmigrate_org(p_org uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  PERFORM set_config('drishti.purge_org', p_org::text, true);
  PERFORM set_config('drishti.mapping_sync', 'on', true);
  PERFORM set_config('drishti.vault_write', 'on', true);
  FOR r IN SELECT x.* FROM public.recorders x WHERE x.org_id = p_org AND x.migrated_from_location_id IS NOT NULL ORDER BY x.created_at LOOP
    IF r.secret_id IS NOT NULL AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = r.secret_id) THEN
      DELETE FROM vault.secrets WHERE name = 'nvr:' || r.migrated_from_location_id::text AND id <> r.secret_id;
      PERFORM vault.update_secret(r.secret_id, NULL, 'nvr:' || r.migrated_from_location_id::text, 'NVR login for a store');
      UPDATE public.locations SET nvr_secret_id = r.secret_id WHERE id = r.migrated_from_location_id;
    END IF;
    UPDATE public.check_state SET target_type = 'nvr', target_id = r.migrated_from_location_id WHERE org_id = p_org AND target_type = 'recorder' AND target_id = r.id;
    UPDATE public.outages SET target_type = 'nvr', target_id = r.migrated_from_location_id WHERE org_id = p_org AND target_type = 'recorder' AND target_id = r.id;
    UPDATE public.cameras SET recorder_id = NULL WHERE recorder_id = r.id;
    DELETE FROM public.camera_channel_mappings WHERE recorder_id = r.id;
    UPDATE public.assets SET attached_recorder_id = NULL WHERE attached_recorder_id = r.id;
    DELETE FROM public.asset_endpoints WHERE asset_id = r.id AND (r.created_asset OR purpose = 'rtsp');
    DELETE FROM public.recorders WHERE id = r.id;
    IF r.created_asset THEN
      DELETE FROM public.asset_dependencies WHERE child_asset_id = r.id OR parent_asset_id = r.id;
      DELETE FROM public.assets WHERE id = r.id;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('drishti.purge_org', '', true);
  PERFORM set_config('drishti.mapping_sync', '', true);
  PERFORM set_config('drishti.vault_write', '', true);
  RETURN v_n;
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_migrate_org_test(p_org uuid, p_fail_at text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  RETURN public.inventory_migrate_org(p_org, p_fail_at);
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_unmigrate_org_test(p_org uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  RETURN public.inventory_unmigrate_org(p_org);
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_secret_fingerprint_test(p_org uuid)
 RETURNS TABLE(location_id uuid, secret_id uuid, name text, ciphertext_sha256 text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  RETURN QUERY
  SELECT x.loc, s.id, s.name, encode(extensions.digest(s.secret, 'sha256'), 'hex')
  FROM (SELECT l.id AS loc, l.nvr_secret_id AS sid FROM public.locations l WHERE l.org_id = p_org AND l.nvr_secret_id IS NOT NULL
        UNION ALL
        SELECT r.location_id, r.secret_id FROM public.recorders r WHERE r.org_id = p_org AND r.secret_id IS NOT NULL) AS x
  JOIN vault.secrets s ON s.id = x.sid
  ORDER BY 1, 2;
END
$function$
;

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

    IF v_type = 'nvr' THEN
      v_id := public.recorder_seam_of(v_id);
      v_type := 'recorder';
      IF v_id IS NULL THEN CONTINUE; END IF;
    END IF;

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation; a camera
    -- must be mapped to a recorder; a recorder (and so its cameras) must have monitoring switched on and its asset enabled.
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

CREATE OR REPLACE FUNCTION public.status_reasons(p_type text, p_ids uuid[])
 RETURNS TABLE(target_id uuid, reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH it_locs AS MATERIALIZED (SELECT x AS id FROM public.it_view_location_ids() AS x WHERE p_type IN ('camera', 'nvr')),
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
         OR (p_type = 'recorder' AND cs.target_id IN (SELECT id FROM it_recs))
         OR (p_type = 'nvr' AND cs.target_id IN (SELECT id FROM it_locs)))
$function$
;

CREATE OR REPLACE FUNCTION public.monitor_stop_location()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY(SELECT r.id FROM public.recorders r WHERE r.location_id = NEW.id));
  PERFORM public.monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT c.id FROM public.cameras c WHERE c.location_id = NEW.id));
  PERFORM public.monitor_stop_targets(NEW.org_id, 'nvr', ARRAY[NEW.id]);
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_archive(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    IF EXISTS (SELECT 1 FROM public.recorders r JOIN public.locations l ON l.id = r.location_id
               WHERE r.id = p_id AND r.migrated_from_location_id = r.location_id AND l.nvr_ip IS NOT NULL AND l.archived_at IS NULL) THEN
      RAISE EXCEPTION 'this is the location''s own NVR (its NVR address is still set on the location): clear that first' USING ERRCODE = 'DR009';
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
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_stale_name_scan()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosrc ~ '(\mstores\M|store_id|\mdevices\M|nvr_secret_id|nvr_ip|cameras_store_channel|\mstore_status\M|store_nvr_endpoints|capability_store_ids|it_view_store_ids|it_view_device_ids|any_grant_store_ids)'
    AND p.proname NOT IN ('access_legacy_store_grants', 'access_migrate_legacy', 'recorder_ensure_primary', 'locations_legacy_seam',
                          'inventory_purge_test_org', 'inventory_migrate_org', 'inventory_unmigrate_org', 'inventory_secret_fingerprint_test',
                          'inventory_stale_name_scan', 'inventory_archive')
  ORDER BY 1
$function$
;


-- ═══ Grants of the functions made again (as before the contract migration) ══════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.recorder_seam_of(uuid), public.recorder_ensure_primary(uuid), public.locations_legacy_seam(),
  public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid), public.nvr_delete_credential(uuid),
  public.inventory_migrate_org(uuid, text), public.inventory_unmigrate_org(uuid), public.inventory_migrate_org_test(uuid, text),
  public.inventory_unmigrate_org_test(uuid), public.inventory_secret_fingerprint_test(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recorder_seam_of(uuid), public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid),
  public.nvr_delete_credential(uuid), public.inventory_migrate_org_test(uuid, text), public.inventory_unmigrate_org_test(uuid),
  public.inventory_secret_fingerprint_test(uuid)
  TO service_role;
COMMENT ON FUNCTION public.inventory_migrate_org(uuid, text) IS
  'P2-5a: migrate one organisation to locations + recorders + mappings (idempotent). Database owner only; tests use inventory_migrate_org_test.';
COMMENT ON FUNCTION public.inventory_migrate_org_test(uuid, text) IS 'TEST HELPER ONLY: works only on organisations whose slug starts with "test-".';

CREATE TRIGGER locations_seam AFTER INSERT OR UPDATE OF nvr_ip, rtsp_port, http_port, nvr_username, expected_channels ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.locations_legacy_seam();

DROP POLICY check_state_select ON public.check_state;
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated USING (
  org_id = (SELECT public.current_org_id()) AND (
    (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids())) OR
    (target_type = 'device' AND target_id IN (SELECT public.it_view_asset_ids())) OR
    (target_type = 'recorder' AND target_id IN (SELECT public.it_view_recorder_ids())) OR
    (target_type = 'nvr' AND target_id IN (SELECT public.it_view_location_ids()))));
DROP POLICY outages_select ON public.outages;
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated USING (
  org_id = (SELECT public.current_org_id()) AND (
    (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids())) OR
    (target_type = 'device' AND target_id IN (SELECT public.it_view_asset_ids())) OR
    (target_type = 'recorder' AND target_id IN (SELECT public.it_view_recorder_ids())) OR
    (target_type = 'nvr' AND target_id IN (SELECT public.it_view_location_ids()))));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback 0024: privilege_violations() is not empty'; END IF;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
