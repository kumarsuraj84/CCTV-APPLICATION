-- P2-5a data migration (brief item 2, impact map 2.2 M4): every location with legacy NVR data gets its NVR as an asset + recorders
-- row (an nvr-typed device at the same address is adopted, D5-2), every camera a channel mapping, the vault secret is renamed in place
-- from nvr:<location> to recorder:<recorder id> (same row, same ciphertext; never decrypted to anyone), and the 'nvr' monitoring history
-- is re-keyed to ('recorder', recorder id). One function per organisation (inventory_migrate_org), run here for all organisations in
-- this one transaction; the result is checked against the snapshot that 20261021000019 took with the OLD functions: for every person
-- and every capability the cameras and the whole locations are identical, and the assets differ only by the NVR assets created here for
-- locations the person already covered whole (the NVR was already visible to them as the location's NVR). Any difference aborts.

CREATE TABLE public.inventory_migration_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('org_summary', 'recorder_created', 'device_merged', 'address_conflict', 'secret_missing', 'secret_dangling', 'camera_unmapped')),
  location_id uuid,
  recorder_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX inventory_migration_report_org_idx ON public.inventory_migration_report (org_id, run_at DESC);
COMMENT ON TABLE public.inventory_migration_report IS 'P2-5a: what the location/recorder migration did and every decision it made, per organisation.';
ALTER TABLE public.inventory_migration_report ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_migration_report FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.inventory_migration_report TO service_role;

CREATE FUNCTION public.inventory_migrate_org(p_org uuid, p_fail_at text DEFAULT NULL) RETURNS jsonb
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
COMMENT ON FUNCTION public.inventory_migrate_org(uuid, text) IS 'P2-5a: migrate one organisation to locations + recorders + mappings (idempotent). Database owner only; tests use inventory_migrate_org_test.';

-- Back to the pre-P2-5a shape for one organisation (the rollback of this file, and the test fixtures for the legacy shape): recorders
-- that carry a location's legacy NVR are removed (their vault secret renamed back to nvr:<location> and pointed to by the location),
-- their history re-keyed back to ('nvr', location), their cameras unmapped. Database owner only.
CREATE FUNCTION public.inventory_unmigrate_org(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
$$;

CREATE FUNCTION public.inventory_require_test_org(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'this test helper only works on organisations made by the tests' USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE FUNCTION public.inventory_migrate_org_test(p_org uuid, p_fail_at text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  RETURN public.inventory_migrate_org(p_org, p_fail_at);
END
$$;
COMMENT ON FUNCTION public.inventory_migrate_org_test(uuid, text) IS 'TEST HELPER ONLY: works only on organisations whose slug starts with "test-".';

CREATE FUNCTION public.inventory_unmigrate_org_test(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  RETURN public.inventory_unmigrate_org(p_org);
END
$$;
COMMENT ON FUNCTION public.inventory_unmigrate_org_test(uuid) IS 'TEST HELPER ONLY: works only on organisations whose slug starts with "test-".';

-- For the tests: which vault rows the organisation points at (legacy pointer or recorder), their names and a hash of the stored
-- CIPHERTEXT (never the value).
CREATE FUNCTION public.inventory_secret_fingerprint_test(p_org uuid)
RETURNS TABLE (location_id uuid, secret_id uuid, name text, ciphertext_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
$$;

-- Function bodies that still name the old tables or columns, outside the listed legacy evaluators, the seam and this migration.
CREATE FUNCTION public.inventory_stale_name_scan() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosrc ~ '(\mstores\M|store_id|\mdevices\M|nvr_secret_id|nvr_ip|cameras_store_channel|\mstore_status\M|store_nvr_endpoints|capability_store_ids|it_view_store_ids|it_view_device_ids|any_grant_store_ids)'
    AND p.proname NOT IN ('access_legacy_store_grants', 'access_migrate_legacy', 'recorder_ensure_primary', 'locations_legacy_seam',
                          'inventory_purge_test_org', 'inventory_migrate_org', 'inventory_unmigrate_org', 'inventory_secret_fingerprint_test',
                          'inventory_stale_name_scan')
  ORDER BY 1
$$;

REVOKE ALL ON FUNCTION public.inventory_migrate_org(uuid, text), public.inventory_unmigrate_org(uuid), public.inventory_require_test_org(uuid),
  public.inventory_migrate_org_test(uuid, text), public.inventory_unmigrate_org_test(uuid), public.inventory_secret_fingerprint_test(uuid),
  public.inventory_stale_name_scan() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_migrate_org_test(uuid, text), public.inventory_unmigrate_org_test(uuid),
  public.inventory_secret_fingerprint_test(uuid), public.inventory_stale_name_scan() TO service_role;

-- ═══ Run it for every organisation, then prove nobody's access changed ═════════════════════════════════════════════════════
DO $$
DECLARE
  o record;
  s record;
  v_cams uuid[];
  v_locs uuid[];
  v_assets uuid[];
  v_expected uuid[];
  v_bad integer := 0;
BEGIN
  FOR o IN SELECT x.id FROM public.organizations x ORDER BY x.created_at, x.id LOOP
    PERFORM public.inventory_migrate_org(o.id);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.check_state WHERE target_type = 'nvr') OR EXISTS (SELECT 1 FROM public.outages WHERE target_type = 'nvr') THEN
    RAISE EXCEPTION 'P2-5a migration: monitoring rows of type nvr are left';
  END IF;
  FOR s IN SELECT * FROM public.inventory_migration_snapshot LOOP
    v_cams := ARRAY(SELECT x FROM public.access_cameras_for(s.user_id, ARRAY[s.capability], s.taken_at, true, true) AS x ORDER BY 1);
    v_locs := ARRAY(SELECT x FROM public.access_locations_for(s.user_id, ARRAY[s.capability], s.taken_at, true, true) AS x ORDER BY 1);
    v_assets := ARRAY(SELECT x FROM public.access_assets_for(s.user_id, ARRAY[s.capability], s.taken_at, true, true) AS x ORDER BY 1);
    v_expected := ARRAY(
      SELECT x FROM unnest(s.assets) AS x
      UNION
      SELECT r.recorder_id FROM public.inventory_migration_report r
      WHERE r.org_id = s.org_id AND r.kind = 'recorder_created' AND (r.detail ->> 'created_asset')::boolean AND r.location_id = ANY (s.locations)
      ORDER BY 1);
    IF v_cams IS DISTINCT FROM s.cameras OR v_locs IS DISTINCT FROM s.locations OR v_assets IS DISTINCT FROM v_expected THEN
      v_bad := v_bad + 1;
      RAISE WARNING 'P2-5a migration: effective access changed for person % capability %', s.user_id, s.capability;
    END IF;
  END LOOP;
  IF v_bad > 0 THEN RAISE EXCEPTION 'P2-5a migration check failed: % person/capability sets would change', v_bad; END IF;
END
$$;

ANALYZE public.locations;
ANALYZE public.cameras;
ANALYZE public.assets;
ANALYZE public.recorders;
ANALYZE public.camera_channel_mappings;
ANALYZE public.asset_endpoints;
ANALYZE public.check_state;
ANALYZE public.outages;

NOTIFY pgrst, 'reload schema';
