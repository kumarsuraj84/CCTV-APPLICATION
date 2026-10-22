-- Rollback of 20261021000019_p25_locations_recorders_access.sql (P2-5a core). Run AFTER the rollbacks of 20261021000021 and
-- 20261021000020 (it refuses otherwise). Puts back stores / devices, and the old access functions, policies, views and triggers exactly
-- as they were before P2-5a (their definitions are taken verbatim from the pre-migration schema dump), and the old catalogue scope kinds.
-- REFUSES, changing nothing, while any of these exist (the old model cannot hold them):
--   recorders (the 0021 rollback removes the migrated ones; recorders added by people must be archived and purged first),
--   region / cluster / recorder grants (revoked ones too), archived locations / assets / cameras (restore them first: the old model has
--   no archive), locations without an NVR address or login (head offices), assets without an address, assets of a type added by
--   20261021000018, 'recorder' monitoring history. Run the rollback of 20261021000022 first (it refuses nothing; this one checks).
-- LOST: regions, clusters, location kind / cluster / parent / uplink, the new asset attributes (serial, MAC, vendor, …), address spaces
-- and endpoints, mapping history and the migration snapshot. An NVR device adopted by the migration keeps its location and enabled
-- flag as the migration set them. The device_type values added by 20261021000018 stay (an enum value cannot be dropped).
-- Two devices at one address (allowed per address space since P2-5a) or two cameras on one store channel make the old unique keys
-- fail: the rollback then stops with that error and changes nothing.
BEGIN;
DO $$
DECLARE
  v text;
BEGIN
  IF to_regprocedure('public.inventory_migrate_org(uuid, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'roll back 20261021000021_p25_inventory_migrate first';
  END IF;
  IF to_regclass('public.network_definitions') IS NOT NULL THEN
    RAISE EXCEPTION 'roll back 20261021000020_p25_inventory_extensions first';
  END IF;
  SELECT string_agg(x, '; ') INTO v FROM (
    SELECT format('%s recorder(s)', count(*)) AS x FROM public.recorders HAVING count(*) > 0
    UNION ALL SELECT format('%s region, cluster or recorder grant(s)', count(*)) FROM public.access_grants
      WHERE scope_kind IN ('region', 'cluster', 'recorder') HAVING count(*) > 0
    UNION ALL SELECT format('%s archived location(s)', count(*)) FROM public.locations WHERE archived_at IS NOT NULL HAVING count(*) > 0
    UNION ALL SELECT format('%s archived asset(s)', count(*)) FROM public.assets WHERE archived_at IS NOT NULL HAVING count(*) > 0
    UNION ALL SELECT format('%s archived camera(s)', count(*)) FROM public.cameras WHERE archived_at IS NOT NULL HAVING count(*) > 0
    UNION ALL SELECT format('%s location(s) without an NVR address or login', count(*)) FROM public.locations
      WHERE nvr_ip IS NULL OR nvr_username IS NULL HAVING count(*) > 0
    UNION ALL SELECT format('%s asset(s) without an address', count(*)) FROM public.assets WHERE ip IS NULL HAVING count(*) > 0
    -- Review M10: the old application does not know the asset types added by 20261021000018 (an enum value cannot be dropped).
    UNION ALL SELECT format('%s asset(s) of a type added by P2-5a', count(*)) FROM public.assets
      WHERE type::text IN ('sdwan_edge', 'switch', 'access_point', 'router', 'ups', 'printer', 'desktop', 'laptop') HAVING count(*) > 0
    UNION ALL SELECT format('%s recorder state / outage row(s)', count(*)) FROM (
      SELECT 1 FROM public.check_state WHERE target_type = 'recorder' UNION ALL SELECT 1 FROM public.outages WHERE target_type = 'recorder') h
      HAVING count(*) > 0
  ) t;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'P2-5a rollback refused, the old model cannot hold: %', v USING ERRCODE = '55000';
  END IF;
END
$$;

-- ═══ 1. New views, policies and triggers on the tables that stay ════════════════════════════════════════════════════════════
DROP VIEW public.location_hierarchy;
DROP VIEW public.camera_endpoints;
DROP VIEW public.recorder_endpoints;
DROP VIEW public.recorder_status;
DROP VIEW public.location_status;
DROP POLICY locations_select ON public.locations;
DROP POLICY assets_select ON public.assets;
DROP POLICY check_state_select ON public.check_state;
DROP POLICY outages_select ON public.outages;
DROP TRIGGER organizations_global_space ON public.organizations;
DROP TRIGGER locations_keep ON public.locations;
DROP TRIGGER locations_moved ON public.locations;
DROP TRIGGER locations_seam ON public.locations;
DROP TRIGGER locations_stop ON public.locations;
DROP TRIGGER cameras_keep ON public.cameras;
DROP TRIGGER cameras_map ON public.cameras;
DROP TRIGGER cameras_remap ON public.cameras;
DROP TRIGGER assets_attached ON public.assets;
DROP TRIGGER assets_endpoints ON public.assets;
DROP TRIGGER assets_guard ON public.assets;
DROP TRIGGER assets_keep ON public.assets;
DROP TRIGGER assets_stop ON public.assets;

-- ═══ 2. New tables and columns (what pointed at them first) ═════════════════════════════════════════════════════════════════
DROP TABLE public.inventory_migration_snapshot;
ALTER TABLE public.access_grants DROP CONSTRAINT access_grants_scope;
ALTER TABLE public.access_grants DROP CONSTRAINT access_grants_scope_kind_check;
ALTER TABLE public.access_grants DROP COLUMN region_id, DROP COLUMN cluster_id, DROP COLUMN recorder_id;
DROP TABLE public.camera_channel_mappings;
DROP TABLE public.asset_endpoints;
ALTER TABLE public.cameras DROP COLUMN recorder_id, DROP COLUMN archived_at;
ALTER TABLE public.assets DROP COLUMN attached_recorder_id;
DROP TABLE public.recorders;
ALTER TABLE public.assets
  DROP CONSTRAINT assets_id_location_key,
  DROP COLUMN address_space_id, DROP COLUMN is_recorder, DROP COLUMN serial, DROP COLUMN mac, DROP COLUMN vendor, DROP COLUMN model,
  DROP COLUMN firmware, DROP COLUMN role, DROP COLUMN owner, DROP COLUMN criticality, DROP COLUMN lifecycle_state,
  DROP COLUMN warranty_until, DROP COLUMN last_inventory_at, DROP COLUMN management_mode, DROP COLUMN capability_discovered_at,
  DROP COLUMN credential_ref, DROP COLUMN config_owner, DROP COLUMN assigned_profile_id, DROP COLUMN archived_at;
DROP TABLE public.address_spaces;
DROP INDEX public.locations_org_code_key;
ALTER TABLE public.locations
  DROP COLUMN kind, DROP COLUMN cluster_id, DROP COLUMN parent_location_id, DROP COLUMN uplink_asset_id, DROP COLUMN archived_at;
DROP TABLE public.clusters;
DROP TABLE public.regions;
DROP INDEX public.cameras_location_idx;

-- ═══ 3. Functions made by P2-5a ═════════════════════════════════════════════════════════════════════════════════════════════
DROP FUNCTION public.access_location_expand(uuid, uuid[], uuid[], uuid[]);
DROP FUNCTION public.access_ancestry(uuid, text, uuid);
DROP FUNCTION public.access_scope_covers(uuid, text, uuid, text, uuid);
DROP FUNCTION public.access_target_ancestry(uuid, jsonb);
DROP FUNCTION public.access_camera_set(uuid, boolean, uuid[], uuid[], uuid[], uuid[], uuid[]);
DROP FUNCTION public.access_asset_set(uuid, boolean, uuid[], uuid[], uuid[], uuid[], uuid[]);
DROP FUNCTION public.access_location_set(uuid, boolean, uuid[], uuid[], uuid[]);
DROP FUNCTION public.access_assets_for(uuid, text[], timestamptz, boolean, boolean);
DROP FUNCTION public.access_locations_for(uuid, text[], timestamptz, boolean, boolean);
DROP FUNCTION public.capability_location_ids(text);
DROP FUNCTION public.capability_asset_ids(text);
DROP FUNCTION public.it_view_location_ids();
DROP FUNCTION public.it_view_asset_ids();
DROP FUNCTION public.it_view_recorder_ids();
DROP FUNCTION public.any_grant_location_ids();
DROP FUNCTION public.any_grant_cluster_ids();
DROP FUNCTION public.any_grant_region_ids();
DROP FUNCTION public.report_effective_asset_ids(uuid, text, timestamptz, boolean);
DROP FUNCTION public.my_access_summary();
DROP FUNCTION public.access_grant_summary(uuid);
DROP FUNCTION public.cameras_monitoring_off(uuid[]);
DROP FUNCTION public.inventory_refuse_delete();
DROP FUNCTION public.organizations_global_space();
DROP FUNCTION public.address_space_global(uuid);
DROP FUNCTION public.asset_sync_endpoints(uuid);
DROP FUNCTION public.assets_after_write();
DROP FUNCTION public.assets_before_update();
DROP FUNCTION public.assets_attached_check();
DROP FUNCTION public.monitor_stop_asset();
DROP FUNCTION public.monitor_stop_location();
DROP FUNCTION public.recorders_before_write();
DROP FUNCTION public.recorders_after_write();
DROP FUNCTION public.recorder_monitoring_stop();
DROP FUNCTION public.mappings_before_write();
DROP FUNCTION public.mappings_after_write();
DROP FUNCTION public.recorder_primary_of(uuid);
DROP FUNCTION public.cameras_after_insert();
DROP FUNCTION public.cameras_before_update();
DROP FUNCTION public.recorder_store_credential(uuid, text);
DROP FUNCTION public.recorder_read_credential(uuid);
DROP FUNCTION public.recorder_delete_credential(uuid);
DROP FUNCTION public.recorder_credential_status(uuid, uuid);
DROP FUNCTION public.recorder_ensure_primary(uuid);
DROP FUNCTION public.locations_legacy_seam();
DROP FUNCTION public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid);
DROP FUNCTION public.inventory_archive(uuid, text, uuid, uuid);
DROP FUNCTION public.inventory_restore(uuid, text, uuid, uuid);
DROP FUNCTION public.inventory_hierarchy_moved();
DROP FUNCTION public.inventory_node_archived();
DROP FUNCTION public.inventory_move_location(uuid, uuid, uuid, uuid);
DROP FUNCTION public.inventory_move_cluster(uuid, uuid, uuid, uuid);
DROP FUNCTION public.preview_hierarchy_change(uuid, text, uuid, uuid);
DROP FUNCTION public.recorder_set_monitoring(uuid, uuid, boolean, text, uuid);
DROP FUNCTION public.inventory_purge_test_org(uuid);
DROP FUNCTION public.inventory_propose_hierarchy(uuid);
DROP FUNCTION public.inventory_effective_snapshot(uuid, timestamptz);

-- ═══ 4. Renames back (ids unchanged) and the old keys ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.profiles RENAME COLUMN location_id TO store_id;
ALTER TABLE public.profiles RENAME CONSTRAINT profiles_location_fk TO profiles_store_fk;
ALTER INDEX public.profiles_location_idx RENAME TO profiles_store_idx;
COMMENT ON COLUMN public.profiles.store_id IS 'Home location: information only. It grants nothing (directive AC-7, P2-1).';

ALTER TABLE public.assets ALTER COLUMN ip SET NOT NULL;
ALTER TABLE public.assets ADD CONSTRAINT devices_org_ip_port_key UNIQUE NULLS NOT DISTINCT (org_id, ip, tcp_port);
ALTER TRIGGER assets_updated ON public.assets RENAME TO devices_updated;
ALTER INDEX public.assets_org_idx RENAME TO devices_org_idx;
ALTER INDEX public.assets_location_idx RENAME TO devices_store_idx;
ALTER TABLE public.assets RENAME CONSTRAINT assets_tcp_port_check TO devices_tcp_port_check;
ALTER TABLE public.assets RENAME CONSTRAINT assets_org_id_fkey TO devices_org_id_fkey;
ALTER TABLE public.assets RENAME CONSTRAINT assets_location_fk TO devices_store_fk;
ALTER TABLE public.assets RENAME CONSTRAINT assets_id_org_key TO devices_id_org_key;
ALTER TABLE public.assets RENAME CONSTRAINT assets_pkey TO devices_pkey;
ALTER TABLE public.assets RENAME COLUMN location_id TO store_id;
ALTER TABLE public.assets RENAME TO devices;

ALTER TABLE public.cameras RENAME CONSTRAINT cameras_location_fk TO cameras_store_fk;
ALTER TABLE public.cameras RENAME COLUMN location_id TO store_id;
ALTER TABLE public.cameras ADD CONSTRAINT cameras_store_channel_key UNIQUE (store_id, channel);

ALTER TABLE public.locations ALTER COLUMN nvr_ip SET NOT NULL, ALTER COLUMN nvr_username SET NOT NULL;
COMMENT ON COLUMN public.locations.nvr_ip IS NULL;
COMMENT ON COLUMN public.locations.nvr_secret_id IS NULL;
ALTER TABLE public.locations ADD CONSTRAINT stores_org_code_key UNIQUE (org_id, code);
ALTER TRIGGER locations_updated ON public.locations RENAME TO stores_updated;
ALTER INDEX public.locations_org_zone_idx RENAME TO stores_org_zone_idx;
ALTER TABLE public.locations RENAME CONSTRAINT locations_org_id_fkey TO stores_org_id_fkey;
ALTER TABLE public.locations RENAME CONSTRAINT locations_code_upper TO stores_code_upper;
ALTER TABLE public.locations RENAME CONSTRAINT locations_id_org_key TO stores_id_org_key;
ALTER TABLE public.locations RENAME CONSTRAINT locations_pkey TO stores_pkey;
ALTER TABLE public.locations RENAME TO stores;

-- ═══ 5. Old checks: catalogue, grants, monitoring history ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.check_state DROP CONSTRAINT check_state_target_type_check;
ALTER TABLE public.check_state ADD CONSTRAINT check_state_target_type_check CHECK (target_type IN ('camera', 'device', 'nvr'));
ALTER TABLE public.outages DROP CONSTRAINT outages_target_type_check;
ALTER TABLE public.outages ADD CONSTRAINT outages_target_type_check CHECK (target_type IN ('camera', 'device', 'nvr'));
UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'location', 'camera'] WHERE area = 'cctv';
UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'location', 'asset'] WHERE area IN ('it', 'wifi');
UPDATE public.capabilities SET scope_kinds = ARRAY['organization'] WHERE area = 'admin';
ALTER TABLE public.capabilities DROP CONSTRAINT capabilities_scope_kinds_check;
ALTER TABLE public.capabilities ADD CONSTRAINT capabilities_scope_kinds_check CHECK (
  scope_kinds <@ ARRAY['organization', 'location', 'camera', 'asset'] AND cardinality(scope_kinds) > 0);
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_scope_kind_check CHECK (scope_kind IN ('organization', 'location', 'camera', 'asset'));
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_scope CHECK ((((scope_kind = 'organization'::text) AND (scope_id IS NULL) AND (location_id IS NULL) AND (camera_id IS NULL) AND (asset_id IS NULL)) OR ((scope_kind = 'location'::text) AND (scope_id IS NOT NULL) AND (camera_id IS NULL) AND (asset_id IS NULL) AND ((location_id = scope_id) OR ((location_id IS NULL) AND (revoked_at IS NOT NULL)))) OR ((scope_kind = 'camera'::text) AND (scope_id IS NOT NULL) AND (location_id IS NULL) AND (asset_id IS NULL) AND ((camera_id = scope_id) OR ((camera_id IS NULL) AND (revoked_at IS NOT NULL)))) OR ((scope_kind = 'asset'::text) AND (scope_id IS NOT NULL) AND (location_id IS NULL) AND (camera_id IS NULL) AND ((asset_id = scope_id) OR ((asset_id IS NULL) AND (revoked_at IS NOT NULL))))));

-- Devices: back to the whole-table read grant.
REVOKE SELECT (id, org_id, store_id, type, name, ip, tcp_port, notes, enabled, created_at, updated_at) ON public.devices FROM authenticated;
GRANT SELECT ON public.devices TO authenticated;

-- ═══ 6. The old functions, verbatim from the pre-P2-5a schema dump (replaced in place; dropped ones made again) ═════════════
SET LOCAL check_function_bodies = false;

CREATE OR REPLACE FUNCTION public.access_camera_set(p_org uuid, p_org_wide boolean, p_locations uuid[], p_cameras uuid[]) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT c.id FROM public.cameras c WHERE p_org_wide AND c.org_id = p_org
  UNION
  SELECT c.id FROM public.cameras c WHERE NOT p_org_wide AND c.org_id = p_org AND c.store_id = ANY (p_locations)
  UNION
  SELECT c.id FROM public.cameras c WHERE NOT p_org_wide AND c.org_id = p_org AND c.id = ANY (p_cameras)
$$;

CREATE OR REPLACE FUNCTION public.access_store_set(p_org uuid, p_org_wide boolean, p_locations uuid[]) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT s.id FROM public.stores s WHERE p_org_wide AND s.org_id = p_org
  UNION
  SELECT s.id FROM public.stores s WHERE NOT p_org_wide AND s.org_id = p_org AND s.id = ANY (p_locations)
$$;

CREATE OR REPLACE FUNCTION public.access_device_set(p_org uuid, p_org_wide boolean, p_locations uuid[], p_assets uuid[]) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT d.id FROM public.devices d WHERE p_org_wide AND d.org_id = p_org
  UNION
  SELECT d.id FROM public.devices d WHERE NOT p_org_wide AND d.org_id = p_org AND d.store_id = ANY (p_locations)
  UNION
  SELECT d.id FROM public.devices d WHERE NOT p_org_wide AND d.org_id = p_org AND d.id = ANY (p_assets)
$$;

CREATE OR REPLACE FUNCTION public.access_cameras_for(p_user uuid, p_caps text[], p_at timestamp with time zone, p_ignore_status boolean, p_aal2 boolean) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_camera_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'camera')
  ) AS x
$$;

CREATE OR REPLACE FUNCTION public.access_stores_for(p_user uuid, p_caps text[], p_at timestamp with time zone, p_ignore_status boolean, p_aal2 boolean) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_store_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location')
  ) AS x
$$;

CREATE OR REPLACE FUNCTION public.access_devices_for(p_user uuid, p_caps text[], p_at timestamp with time zone, p_ignore_status boolean, p_aal2 boolean) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_device_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'asset')
  ) AS x
$$;

CREATE OR REPLACE FUNCTION public.capability_camera_ids(p_cap text) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_cameras_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.capability_store_ids(p_cap text) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_stores_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.capability_device_ids(p_cap text) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_devices_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.any_cctv_camera_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_cameras_for((SELECT auth.uid()), ARRAY['cctv.live', 'cctv.playback', 'cctv.export'], now(), false,
                                         public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.it_view_store_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_stores_for((SELECT auth.uid()), ARRAY['it.inventory.view', 'it.monitoring.view'], now(), false,
                                        public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.it_view_device_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_devices_for((SELECT auth.uid()), ARRAY['it.inventory.view', 'it.monitoring.view'], now(), false,
                                         public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.any_grant_store_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE area <> 'admin'
  )
  SELECT s.id FROM public.stores s JOIN g ON g.org_id = s.org_id AND g.scope_kind = 'organization'
  UNION
  SELECT g.scope_id FROM g WHERE g.scope_kind = 'location'
  UNION
  SELECT c.store_id FROM public.cameras c JOIN g ON g.org_id = c.org_id AND g.scope_kind = 'camera' AND g.scope_id = c.id
  UNION
  SELECT d.store_id FROM public.devices d JOIN g ON g.org_id = d.org_id AND g.scope_kind = 'asset' AND g.scope_id = d.id
  WHERE d.store_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.has_capability_for(p_cap text, p_kind text, p_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE capability = p_cap
  )
  SELECT CASE p_kind
    WHEN 'camera' THEN EXISTS (
      SELECT 1 FROM public.cameras c JOIN g ON g.org_id = c.org_id
      WHERE c.id = p_id AND (g.scope_kind = 'organization' OR (g.scope_kind = 'location' AND g.scope_id = c.store_id)
                             OR (g.scope_kind = 'camera' AND g.scope_id = c.id)))
    WHEN 'location' THEN EXISTS (
      SELECT 1 FROM public.stores s JOIN g ON g.org_id = s.org_id
      WHERE s.id = p_id AND (g.scope_kind = 'organization' OR (g.scope_kind = 'location' AND g.scope_id = s.id)))
    WHEN 'asset' THEN EXISTS (
      SELECT 1 FROM public.devices d JOIN g ON g.org_id = d.org_id
      WHERE d.id = p_id AND (g.scope_kind = 'organization' OR (g.scope_kind = 'location' AND g.scope_id = d.store_id)
                             OR (g.scope_kind = 'asset' AND g.scope_id = d.id)))
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.cameras_with_capability(p_cap text, p_ids uuid[]) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE capability = p_cap
  )
  SELECT c.id FROM public.cameras c
  WHERE c.id = ANY (p_ids)
    AND EXISTS (SELECT 1 FROM g WHERE g.org_id = c.org_id
                AND (g.scope_kind = 'organization' OR (g.scope_kind = 'location' AND g.scope_id = c.store_id)
                     OR (g.scope_kind = 'camera' AND g.scope_id = c.id)))
$$;

CREATE OR REPLACE FUNCTION public.report_effective_camera_ids(p_user uuid, p_cap text, p_at timestamp with time zone DEFAULT now(), p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_cameras_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;

COMMENT ON FUNCTION public.report_effective_camera_ids(p_user uuid, p_cap text, p_at timestamp with time zone, p_ignore_status boolean) IS 'REPORTING ONLY: treats every session as MFA-verified and can ignore the person''s status. Never use for authorisation.';

CREATE OR REPLACE FUNCTION public.report_effective_device_ids(p_user uuid, p_cap text, p_at timestamp with time zone DEFAULT now(), p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT x FROM public.access_devices_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;

COMMENT ON FUNCTION public.report_effective_device_ids(p_user uuid, p_cap text, p_at timestamp with time zone, p_ignore_status boolean) IS 'REPORTING ONLY: treats every session as MFA-verified and can ignore the person''s status. Never use for authorisation.';

CREATE OR REPLACE FUNCTION public.my_access_summary() RETURNS TABLE(capability text, organization_wide boolean, location_ids uuid[], camera_ids uuid[], asset_ids uuid[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT g.capability,
         bool_or(g.scope_kind = 'organization'),
         coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'location'), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'camera'), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'asset'), '{}'::uuid[])
  FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) g
  GROUP BY g.capability
  ORDER BY g.capability
$$;

COMMENT ON FUNCTION public.my_access_summary() IS 'The caller''s effective capabilities now, with their granted scopes (P2-2). For display decisions and page gates; per-resource checks use has_capability_for / cameras_with_capability.';

CREATE OR REPLACE FUNCTION public.access_grant_summary(p_org uuid) RETURNS TABLE(user_id uuid, capability text, organization_wide boolean, locations integer, cameras integer, assets integer, next_expiry timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT g.user_id, g.capability,
         bool_or(g.scope_kind = 'organization'),
         (count(*) FILTER (WHERE g.scope_kind = 'location'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'camera'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'asset'))::integer,
         min(g.valid_until)
  FROM public.access_grants g
  WHERE g.org_id = p_org AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
  GROUP BY g.user_id, g.capability
  ORDER BY g.user_id, g.capability
$$;

CREATE OR REPLACE FUNCTION public.access_check_spec(p_org uuid, p_spec jsonb) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_kinds text[];
  v_found boolean;
BEGIN
  IF jsonb_typeof(p_spec) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'a grant must be an object' USING ERRCODE = '22023'; END IF;
  SELECT c.scope_kinds INTO v_kinds FROM public.capabilities c WHERE c.key = v_cap;
  IF v_kinds IS NULL THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF v_kind IS NULL OR NOT (v_kind = ANY (v_kinds)) THEN RAISE EXCEPTION 'scope kind not allowed for this capability' USING ERRCODE = '22023'; END IF;
  IF v_kind = 'organization' THEN
    IF v_scope IS NOT NULL THEN RAISE EXCEPTION 'an organisation grant has no scope id' USING ERRCODE = '22023'; END IF;
    RETURN;
  END IF;
  IF v_scope IS NULL THEN RAISE EXCEPTION 'scope id missing' USING ERRCODE = '22023'; END IF;
  -- (a CASE inside IF would end the condition at its first THEN, so the answer goes into a variable first)
  v_found := CASE v_kind
    WHEN 'location' THEN EXISTS (SELECT 1 FROM public.stores s WHERE s.id = v_scope AND s.org_id = p_org)
    WHEN 'camera' THEN EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_scope AND c.org_id = p_org)
    WHEN 'asset' THEN EXISTS (SELECT 1 FROM public.devices d WHERE d.id = v_scope AND d.org_id = p_org)
    ELSE false END;
  IF NOT v_found THEN
    RAISE EXCEPTION 'scope outside organisation' USING ERRCODE = '22023';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.access_check_grantor(p_org uuid, p_actor uuid, p_user uuid, p_spec jsonb, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_until timestamptz := NULLIF(p_spec ->> 'valid_until', '')::timestamptz;
  v_role public.user_role;
  v_target public.user_role;
  v_c public.capabilities%ROWTYPE;
  v_parent uuid;
BEGIN
  v_role := public.access_check_manager(p_org, p_actor, p_user);
  SELECT * INTO v_c FROM public.capabilities c WHERE c.key = v_cap;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF (v_c.risk = 'high' OR v_c.key = 'cctv.export') AND length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'reason required for %', v_cap USING ERRCODE = '22023';
  END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_c.area = 'admin' AND v_target NOT IN ('admin', 'platform_owner') THEN
    RAISE EXCEPTION 'administration rights only for administrators' USING ERRCODE = '42501';
  END IF;
  -- Owner ruling E-1: downloads (cctv.export) only for administrators and super administrators.
  IF v_cap = 'cctv.export' AND v_target NOT IN ('admin', 'platform_owner') THEN
    RAISE EXCEPTION 'download rights only for administrators' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'platform_owner' THEN RETURN; END IF;
  IF v_cap = ANY (public.access_owner_only()) THEN
    RAISE EXCEPTION 'only a platform owner may give %', v_cap USING ERRCODE = '42501';
  END IF;
  v_parent := CASE v_kind
    WHEN 'camera' THEN (SELECT c.store_id FROM public.cameras c WHERE c.id = v_scope AND c.org_id = p_org)
    WHEN 'asset' THEN (SELECT d.store_id FROM public.devices d WHERE d.id = v_scope AND d.org_id = p_org)
    ELSE NULL END;
  IF NOT EXISTS (
    SELECT 1 FROM public.access_grants g
    WHERE g.user_id = p_actor AND g.org_id = p_org AND g.capability = v_cap AND g.revoked_at IS NULL
      AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
      AND (g.valid_until IS NULL OR (v_until IS NOT NULL AND g.valid_until >= v_until))
      AND (g.scope_kind = 'organization'
           OR (g.scope_kind = v_kind AND g.scope_id = v_scope)
           OR (g.scope_kind = 'location' AND v_kind IN ('camera', 'asset') AND v_parent IS NOT NULL AND g.scope_id = v_parent))
  ) THEN
    RAISE EXCEPTION '% at this scope or for this long is not held by the acting person', v_cap USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.access_items(p_org uuid, p_cap text, p_specs jsonb, p_at timestamp with time zone) RETURNS TABLE(item_id uuid, label text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH g AS MATERIALIZED (
    SELECT e.value ->> 'scope_kind' AS kind, NULLIF(e.value ->> 'scope_id', '')::uuid AS sid
    FROM jsonb_array_elements(p_specs) AS e
    WHERE e.value ->> 'capability' = p_cap
      AND coalesce(NULLIF(e.value ->> 'valid_from', '')::timestamptz, '-infinity') <= p_at
      AND coalesce(NULLIF(e.value ->> 'valid_until', '')::timestamptz, 'infinity') > p_at
  ),
  a AS (SELECT c.area FROM public.capabilities c WHERE c.key = p_cap),
  org_wide AS (SELECT EXISTS (SELECT 1 FROM g WHERE g.kind = 'organization') AS yes)
  SELECT c.id, s.code || ' · ' || c.name
  FROM public.access_camera_set(p_org, (SELECT yes FROM org_wide), ARRAY(SELECT sid FROM g WHERE kind = 'location'),
                                ARRAY(SELECT sid FROM g WHERE kind = 'camera')) AS x
  JOIN public.cameras c ON c.id = x JOIN public.stores s ON s.id = c.store_id
  WHERE (SELECT area FROM a) = 'cctv'
  UNION ALL
  SELECT d.id, d.name || coalesce(' · ' || s.code, '')
  FROM public.access_device_set(p_org, (SELECT yes FROM org_wide), ARRAY(SELECT sid FROM g WHERE kind = 'location'),
                                ARRAY(SELECT sid FROM g WHERE kind = 'asset')) AS x
  JOIN public.devices d ON d.id = x LEFT JOIN public.stores s ON s.id = d.store_id
  WHERE (SELECT area FROM a) = 'it'
  UNION ALL
  SELECT s.id, s.code || ' · ' || s.name
  FROM public.access_store_set(p_org, (SELECT yes FROM org_wide), ARRAY(SELECT sid FROM g WHERE kind = 'location')) AS x
  JOIN public.stores s ON s.id = x
  WHERE (SELECT area FROM a) = 'wifi'
  UNION ALL
  SELECT d.id, d.name FROM public.devices d
  WHERE (SELECT area FROM a) = 'wifi' AND d.org_id = p_org AND d.id IN (SELECT sid FROM g WHERE kind = 'asset')
  UNION ALL
  SELECT o.id, 'Whole organisation' FROM public.organizations o
  WHERE (SELECT area FROM a) = 'admin' AND o.id = p_org AND (SELECT yes FROM org_wide)
$$;

CREATE OR REPLACE FUNCTION public.status_reasons(p_type text, p_ids uuid[]) RETURNS TABLE(target_id uuid, reason text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH it_stores AS MATERIALIZED (SELECT x AS id FROM public.it_view_store_ids() AS x),
       cams AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x WHERE p_type = 'camera'),
       devs AS MATERIALIZED (SELECT x AS id FROM public.it_view_device_ids() AS x WHERE p_type = 'device')
  SELECT cs.target_id,
         CASE
           WHEN cs.error IS NULL OR cs.error = '' THEN NULL
           WHEN p_type <> 'camera' THEN cs.error
           WHEN c.store_id IN (SELECT id FROM it_stores) THEN cs.error
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
         OR (p_type = 'nvr' AND cs.target_id IN (SELECT id FROM it_stores)))
$$;

COMMENT ON FUNCTION public.status_reasons(p_type text, p_ids uuid[]) IS 'Why targets are offline, for the caller (P2-2 fix I-1): the checker''s text only with the IT view; camera-terms reasons otherwise.';

CREATE OR REPLACE FUNCTION public.access_legacy_store_grants(p_user uuid, p_ignore_status boolean) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT s.id FROM public.stores s
  JOIN public.profiles p ON p.id = p_user AND p.org_id = s.org_id AND (p_ignore_status OR (p.is_active AND NOT p.must_reset_password))
  WHERE s.id IN (SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = p_user)
     OR s.zone IN (SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = p_user)
     OR s.id = p.store_id
$$;

CREATE OR REPLACE FUNCTION public.access_legacy_camera_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  SELECT c.id FROM public.cameras c JOIN p ON p.org_id = c.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT a.camera_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id JOIN p ON p.org_id = c.org_id
  WHERE a.user_id = p_user
  UNION
  SELECT c.id FROM public.cameras c JOIN p ON p.org_id = c.org_id
  WHERE c.store_id IN (SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x)
    AND c.store_id NOT IN (SELECT c2.store_id FROM public.cameras c2 JOIN public.user_camera_access a ON a.camera_id = c2.id WHERE a.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION public.access_legacy_device_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  SELECT d.id FROM public.devices d JOIN p ON p.org_id = d.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT d.id FROM public.devices d JOIN p ON p.org_id = d.org_id
  WHERE d.store_id IN (SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x)
$$;

CREATE OR REPLACE FUNCTION public.access_legacy_store_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  SELECT s.id FROM public.stores s JOIN p ON p.org_id = s.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x
  UNION
  SELECT c.store_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id JOIN p ON p.org_id = c.org_id
  WHERE a.user_id = p_user
$$;

CREATE OR REPLACE FUNCTION public.access_migrate_legacy(p_run uuid, p_users uuid[] DEFAULT NULL::uuid[], p_force boolean DEFAULT false) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_person record;
  v_store record;
  v_cap text;
  v_camera uuid;
  v_put record;
  v_stores uuid[];
  v_zones text[];
  v_cams uuid[];
  v_narrowed uuid[];
  v_notes text[];
  v_ids uuid[];
  v_old uuid[];
  v_new uuid[];
  v_added integer;
  v_total integer := 0;
  v_lost integer;
  v_home_code text;
  v_admin_caps text[] := ARRAY['cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view',
    'it.monitoring.operate', 'wifi.inventory.view', 'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory',
    'admin.alerts', 'admin.audit.read'];
  v_manager_caps text[] := ARRAY['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'];
  v_reason text := 'Migrated from the old access model (P2-1).';
BEGIN
  IF p_run IS NULL THEN RAISE EXCEPTION 'a run id is needed' USING ERRCODE = '22023'; END IF;
  FOR v_person IN
    SELECT p.id, p.org_id, p.role, p.store_id, p.is_active, p.must_reset_password FROM public.profiles p
    WHERE p_users IS NULL OR p.id = ANY (p_users)
    ORDER BY p.org_id, p.id
  LOOP
    -- Somebody already migrated is never migrated again (that would bring back what an administrator revoked), unless forced.
    IF NOT p_force AND EXISTS (SELECT 1 FROM public.access_migration_report r WHERE r.user_id = v_person.id) THEN
      CONTINUE;
    END IF;
    v_added := 0;
    v_notes := '{}';
    v_ids := '{}';
    v_stores := ARRAY(SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = v_person.id ORDER BY a.store_id);
    v_zones := ARRAY(SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = v_person.id ORDER BY z.zone);
    v_cams := ARRAY(SELECT a.camera_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id AND c.org_id = v_person.org_id
                    WHERE a.user_id = v_person.id ORDER BY a.camera_id);
    v_narrowed := ARRAY(SELECT DISTINCT c.store_id FROM public.cameras c WHERE c.id = ANY (v_cams));

    FOR v_store IN
      SELECT s.id, s.code,
             CASE WHEN s.id = ANY (v_stores) THEN 'migrated:store' WHEN s.zone = ANY (v_zones) THEN 'migrated:zone' ELSE 'migrated:home' END AS source
      FROM public.stores s
      WHERE s.org_id = v_person.org_id
        AND (s.id = ANY (v_stores) OR s.zone = ANY (v_zones) OR s.id = v_person.store_id)
        AND NOT (s.id = ANY (v_narrowed))
      ORDER BY s.code, s.id
    LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'location', 'scope_id', v_store.id),
          NULL, v_reason, v_store.source, v_store.source = 'migrated:home');
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;

    FOREACH v_camera IN ARRAY v_cams LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'camera', 'scope_id', v_camera), NULL, v_reason, 'migrated:camera', false);
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;

    IF v_person.role = 'manager' THEN
      FOREACH v_cap IN ARRAY v_manager_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:manager', true);
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Manager role saw everything: migrated as organisation-wide live, playback, IT inventory and IT monitoring grants, flagged for review (D-2a).'::text;
    ELSIF v_person.role IN ('admin', 'platform_owner') THEN
      FOREACH v_cap IN ARRAY v_admin_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:admin', false);
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Administrator: organisation-wide administrative set granted so existing administrator work keeps working.'::text;
    END IF;

    -- Self-check, person by person; any failure aborts the whole run.
    FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
      v_new := ARRAY(SELECT x FROM public.access_camera_set(v_person.org_id,
        EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'organization'),
        ARRAY(SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'location'),
        ARRAY(SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'camera')) AS x ORDER BY 1);
      v_old := ARRAY(SELECT x FROM public.access_legacy_camera_ids(v_person.id, true) AS x ORDER BY 1);
      IF v_new IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'P2-1 migration check failed: % cameras would change for person %', v_cap, v_person.id;
      END IF;
    END LOOP;
    v_new := ARRAY(
      SELECT s.id FROM public.stores s WHERE s.org_id = v_person.org_id
        AND EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'organization')
      UNION
      SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'location'
      UNION
      SELECT c.store_id FROM public.access_grants g JOIN public.cameras c ON c.id = g.scope_id
      WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'camera'
      ORDER BY 1);
    v_old := ARRAY(SELECT x FROM public.access_legacy_store_ids(v_person.id, true) AS x ORDER BY 1);
    IF v_new IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'P2-1 migration check failed: visible stores would change for person %', v_person.id;
    END IF;
    IF v_person.role NOT IN ('admin', 'platform_owner') AND EXISTS (
         SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids)
         AND (g.capability LIKE 'admin.%' OR g.capability LIKE 'wifi.%' OR g.capability = 'cctv.export')) THEN
      RAISE EXCEPTION 'P2-1 migration check failed: an administrative, Wi-Fi or export capability for non-administrator %', v_person.id;
    END IF;
    IF v_person.role NOT IN ('manager', 'admin', 'platform_owner') AND EXISTS (
         SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability NOT IN ('cctv.live', 'cctv.playback')) THEN
      RAISE EXCEPTION 'P2-1 migration check failed: more than live and playback for person %', v_person.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.access_grants g JOIN public.capabilities c ON c.key = g.capability
               WHERE g.id = ANY (v_ids) AND c.area = 'it' AND c.risk = 'high') THEN
      RAISE EXCEPTION 'P2-1 migration check failed: a high-risk IT capability for person %', v_person.id;
    END IF;

    IF v_person.store_id IS NOT NULL THEN
      SELECT s.code INTO v_home_code FROM public.stores s WHERE s.id = v_person.store_id;
      IF v_person.store_id = ANY (v_narrowed) THEN
        v_notes := v_notes || format('Home store %s had camera grants inside it, so only those cameras were kept (as before).', v_home_code);
      ELSIF NOT (v_person.store_id = ANY (v_stores))
            AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = v_person.store_id AND s.zone = ANY (v_zones)) THEN
        v_notes := v_notes || format('Home store %s was a hidden grant: migrated as explicit live and playback grants, flagged for review (D-2a). The home store now grants nothing by itself (AC-7).', v_home_code);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_zones) AS z(zone)
               WHERE NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.org_id = v_person.org_id AND s.zone = z.zone)) THEN
      v_notes := v_notes || 'A zone grant had no stores in it: nothing to migrate for that zone.'::text;
    END IF;
    IF v_person.role NOT IN ('manager', 'admin', 'platform_owner') THEN
      SELECT count(*) INTO v_lost FROM public.access_legacy_device_ids(v_person.id, true);
      IF v_lost > 0 THEN
        v_notes := v_notes || format('IT devices no longer visible: %s. They were visible only through a store, zone or home-store grant, which is not migrated (directive AC-4).', v_lost);
      END IF;
    END IF;
    IF NOT v_person.is_active THEN
      v_notes := v_notes || 'Account inactive: grants were migrated and take effect only if the account is reactivated.'::text;
    ELSIF v_person.must_reset_password THEN
      v_notes := v_notes || 'The person must still choose a password: the grants take effect after that.'::text;
    END IF;
    IF p_force THEN v_notes := v_notes || 'Run again on purpose (forced).'::text; END IF;

    INSERT INTO public.access_migration_report (run_id, org_id, user_id, old_model, new_grants, note)
    VALUES (
      p_run, v_person.org_id, v_person.id,
      jsonb_build_object(
        'role', v_person.role, 'is_active', v_person.is_active, 'must_reset_password', v_person.must_reset_password,
        'home_store_id', v_person.store_id, 'stores', to_jsonb(v_stores), 'zones', to_jsonb(v_zones), 'cameras', to_jsonb(v_cams),
        'legacy_camera_count', (SELECT count(*) FROM public.access_legacy_camera_ids(v_person.id, true)),
        'legacy_device_count', (SELECT count(*) FROM public.access_legacy_device_ids(v_person.id, true))),
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'capability', g.capability, 'scope_kind', g.scope_kind, 'scope_id', g.scope_id,
                                                    'source', g.source, 'needs_review', g.needs_review) ORDER BY g.capability, g.scope_kind, g.scope_id)
                FROM public.access_grants g WHERE g.user_id = v_person.id AND g.revoked_at IS NULL), '[]'::jsonb),
      NULLIF(array_to_string(v_notes, ' '), '')
    );
    IF v_added > 0 THEN PERFORM public.access_bump_version(v_person.id); END IF;
    v_total := v_total + v_added;
  END LOOP;
  RETURN v_total;
END
$$;

CREATE OR REPLACE FUNCTION public.access_grants_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_kinds text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'the person is not in this organisation' USING ERRCODE = '23503';
  END IF;
  SELECT c.scope_kinds INTO v_kinds FROM public.capabilities c WHERE c.key = NEW.capability;
  IF v_kinds IS NULL THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF NOT (NEW.scope_kind = ANY (v_kinds)) THEN
    RAISE EXCEPTION 'a % grant cannot have % scope', NEW.capability, NEW.scope_kind USING ERRCODE = '22023';
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a grant cannot start revoked' USING ERRCODE = '22023';
  END IF;
  NEW.location_id := CASE WHEN NEW.scope_kind = 'location' THEN NEW.scope_id END;
  NEW.camera_id := CASE WHEN NEW.scope_kind = 'camera' THEN NEW.scope_id END;
  NEW.asset_id := CASE WHEN NEW.scope_kind = 'asset' THEN NEW.scope_id END;
  NEW.granted_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.access_grants_before_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.user_id, NEW.capability, NEW.scope_kind, NEW.scope_id, NEW.valid_from, NEW.valid_until,
      NEW.granted_by, NEW.granted_at, NEW.reason, NEW.source, NEW.needs_review)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.user_id, OLD.capability, OLD.scope_kind, OLD.scope_id, OLD.valid_from, OLD.valid_until,
      OLD.granted_by, OLD.granted_at, OLD.reason, OLD.source, OLD.needs_review) THEN
    RAISE EXCEPTION 'access grants are append-only' USING ERRCODE = '42501';
  END IF;
  IF (NEW.location_id IS DISTINCT FROM OLD.location_id AND NEW.location_id IS NOT NULL)
     OR (NEW.camera_id IS DISTINCT FROM OLD.camera_id AND NEW.camera_id IS NOT NULL)
     OR (NEW.asset_id IS DISTINCT FROM OLD.asset_id AND NEW.asset_id IS NOT NULL) THEN
    RAISE EXCEPTION 'access grants are append-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked grant stays revoked' USING ERRCODE = '42501';
  END IF;
  IF (OLD.location_id IS NOT NULL AND NEW.location_id IS NULL) OR (OLD.camera_id IS NOT NULL AND NEW.camera_id IS NULL)
     OR (OLD.asset_id IS NOT NULL AND NEW.asset_id IS NULL) THEN
    NEW.revoked_at := coalesce(NEW.revoked_at, now());
    NEW.revoke_reason := coalesce(NEW.revoke_reason, 'What the grant pointed at was deleted.');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

    -- Never trust ids from outside: the target must exist, be switched on and belong to this organisation.
    IF NOT (
      (v_type = 'camera' AND EXISTS (
        SELECT 1 FROM cameras c JOIN stores st ON st.id = c.store_id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND st.is_active)) OR
      (v_type = 'device' AND EXISTS (SELECT 1 FROM devices WHERE id = v_id AND org_id = p_org AND enabled)) OR
      (v_type = 'nvr' AND EXISTS (SELECT 1 FROM stores WHERE id = v_id AND org_id = p_org AND is_active))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

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
      UPDATE outages SET ended_at = greatest(v_at, started_at)
      WHERE org_id = p_org AND target_type = v_type AND target_id = v_id AND ended_at IS NULL;
    ELSE
      s.error := v_error;
      -- A run of failures that began before the worker was stopped is not continued: nobody knows what happened during the stop.
      IF s.consecutive_failures > 0 AND s.status <> 'down' AND v_prev_checked IS NOT NULL
         AND EXISTS (SELECT 1 FROM monitor_gaps g WHERE g.ended_at > v_prev_checked AND g.started_at < v_at) THEN
        s.consecutive_failures := 0;
        s.first_failure_at := NULL;
      END IF;
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

CREATE OR REPLACE FUNCTION public.monitor_forget_target() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM check_state WHERE org_id = OLD.org_id AND target_type = TG_ARGV[0] AND target_id = OLD.id;
  DELETE FROM outages WHERE org_id = OLD.org_id AND target_type = TG_ARGV[0] AND target_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_stop_store() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM monitor_stop_targets(NEW.org_id, 'nvr', ARRAY[NEW.id]);
  PERFORM monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT id FROM cameras WHERE store_id = NEW.id));
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN RAISE EXCEPTION 'empty secret'; END IF;
  SELECT nvr_secret_id INTO v_existing FROM stores WHERE id = p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown store'; END IF;
  IF v_existing IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_existing) THEN
    v_existing := NULL;
  END IF;
  IF v_existing IS NULL THEN
    DELETE FROM vault.secrets WHERE name = 'nvr:' || p_store::text;
    v_id := vault.create_secret(p_secret, 'nvr:' || p_store::text, 'NVR login for a store');
    UPDATE stores SET nvr_secret_id = v_id WHERE id = p_store;
  ELSE
    PERFORM vault.update_secret(v_existing, p_secret);
    v_id := v_existing;
  END IF;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.nvr_read_credential(p_store uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds
  WHERE ds.id = (SELECT nvr_secret_id FROM public.stores WHERE id = p_store)
$$;

CREATE OR REPLACE FUNCTION public.nvr_delete_credential(p_store uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
DECLARE
  v_secret uuid;
BEGIN
  SELECT nvr_secret_id INTO v_secret FROM stores WHERE id = p_store;
  IF v_secret IS NOT NULL THEN
    UPDATE stores SET nvr_secret_id = NULL WHERE id = p_store;
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;
END
$$;

-- Privileges of the restored functions: nobody first (new functions get the schema defaults), then exactly the old grants.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN (
             'access_camera_set', 'access_store_set', 'access_device_set', 'access_cameras_for', 'access_stores_for', 'access_devices_for',
             'capability_camera_ids', 'capability_store_ids', 'capability_device_ids', 'any_cctv_camera_ids', 'it_view_store_ids',
             'it_view_device_ids', 'any_grant_store_ids', 'has_capability_for', 'cameras_with_capability', 'report_effective_camera_ids',
             'report_effective_device_ids', 'my_access_summary', 'access_grant_summary', 'access_check_spec', 'access_check_grantor',
             'access_items', 'status_reasons', 'access_legacy_store_grants', 'access_legacy_camera_ids', 'access_legacy_device_ids',
             'access_legacy_store_ids', 'access_migrate_legacy', 'access_grants_before_insert', 'access_grants_before_update',
             'monitor_apply_results', 'monitor_forget_target', 'monitor_stop_store', 'nvr_store_credential', 'nvr_read_credential',
             'nvr_delete_credential')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END
$$;

-- The old function grants (verbatim from the dump).
REVOKE ALL ON FUNCTION public.access_camera_set(p_org uuid, p_org_wide boolean, p_locations uuid[], p_cameras uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_store_set(p_org uuid, p_org_wide boolean, p_locations uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_device_set(p_org uuid, p_org_wide boolean, p_locations uuid[], p_assets uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_cameras_for(p_user uuid, p_caps text[], p_at timestamp with time zone, p_ignore_status boolean, p_aal2 boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_stores_for(p_user uuid, p_caps text[], p_at timestamp with time zone, p_ignore_status boolean, p_aal2 boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_devices_for(p_user uuid, p_caps text[], p_at timestamp with time zone, p_ignore_status boolean, p_aal2 boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capability_camera_ids(p_cap text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.capability_camera_ids(p_cap text) TO authenticated;
GRANT ALL ON FUNCTION public.capability_camera_ids(p_cap text) TO service_role;
REVOKE ALL ON FUNCTION public.capability_store_ids(p_cap text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.capability_store_ids(p_cap text) TO authenticated;
GRANT ALL ON FUNCTION public.capability_store_ids(p_cap text) TO service_role;
REVOKE ALL ON FUNCTION public.capability_device_ids(p_cap text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.capability_device_ids(p_cap text) TO authenticated;
GRANT ALL ON FUNCTION public.capability_device_ids(p_cap text) TO service_role;
REVOKE ALL ON FUNCTION public.any_cctv_camera_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.any_cctv_camera_ids() TO authenticated;
GRANT ALL ON FUNCTION public.any_cctv_camera_ids() TO service_role;
REVOKE ALL ON FUNCTION public.it_view_store_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.it_view_store_ids() TO authenticated;
GRANT ALL ON FUNCTION public.it_view_store_ids() TO service_role;
REVOKE ALL ON FUNCTION public.it_view_device_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.it_view_device_ids() TO authenticated;
GRANT ALL ON FUNCTION public.it_view_device_ids() TO service_role;
REVOKE ALL ON FUNCTION public.any_grant_store_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.any_grant_store_ids() TO authenticated;
GRANT ALL ON FUNCTION public.any_grant_store_ids() TO service_role;
REVOKE ALL ON FUNCTION public.has_capability_for(p_cap text, p_kind text, p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_capability_for(p_cap text, p_kind text, p_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.has_capability_for(p_cap text, p_kind text, p_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.cameras_with_capability(p_cap text, p_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cameras_with_capability(p_cap text, p_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.cameras_with_capability(p_cap text, p_ids uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.report_effective_camera_ids(p_user uuid, p_cap text, p_at timestamp with time zone, p_ignore_status boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_effective_camera_ids(p_user uuid, p_cap text, p_at timestamp with time zone, p_ignore_status boolean) TO service_role;
REVOKE ALL ON FUNCTION public.report_effective_device_ids(p_user uuid, p_cap text, p_at timestamp with time zone, p_ignore_status boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_effective_device_ids(p_user uuid, p_cap text, p_at timestamp with time zone, p_ignore_status boolean) TO service_role;
REVOKE ALL ON FUNCTION public.my_access_summary() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_access_summary() TO authenticated;
REVOKE ALL ON FUNCTION public.access_grant_summary(p_org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.access_grant_summary(p_org uuid) TO service_role;
REVOKE ALL ON FUNCTION public.access_check_spec(p_org uuid, p_spec jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_check_grantor(p_org uuid, p_actor uuid, p_user uuid, p_spec jsonb, p_reason text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_items(p_org uuid, p_cap text, p_specs jsonb, p_at timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.status_reasons(p_type text, p_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.status_reasons(p_type text, p_ids uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.access_legacy_store_grants(p_user uuid, p_ignore_status boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_legacy_camera_ids(p_user uuid, p_ignore_status boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.access_legacy_camera_ids(p_user uuid, p_ignore_status boolean) TO service_role;
REVOKE ALL ON FUNCTION public.access_legacy_device_ids(p_user uuid, p_ignore_status boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.access_legacy_device_ids(p_user uuid, p_ignore_status boolean) TO service_role;
REVOKE ALL ON FUNCTION public.access_legacy_store_ids(p_user uuid, p_ignore_status boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.access_legacy_store_ids(p_user uuid, p_ignore_status boolean) TO service_role;
REVOKE ALL ON FUNCTION public.access_migrate_legacy(p_run uuid, p_users uuid[], p_force boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_grants_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.access_grants_before_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer) TO service_role;
REVOKE ALL ON FUNCTION public.monitor_forget_target() FROM PUBLIC;
GRANT ALL ON FUNCTION public.monitor_forget_target() TO service_role;
REVOKE ALL ON FUNCTION public.monitor_stop_store() FROM PUBLIC;
GRANT ALL ON FUNCTION public.monitor_stop_store() TO service_role;
REVOKE ALL ON FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) TO service_role;
REVOKE ALL ON FUNCTION public.nvr_read_credential(p_store uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.nvr_read_credential(p_store uuid) TO service_role;
REVOKE ALL ON FUNCTION public.nvr_delete_credential(p_store uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.nvr_delete_credential(p_store uuid) TO service_role;

-- ═══ 7. The old views, policies and triggers (verbatim from the dump) ═════════════════════════════════════════════════════════
CREATE VIEW public.store_status WITH (security_invoker='true') AS
 SELECT s.id AS store_id,
    s.org_id,
    (count(c.id))::integer AS cameras_total,
    (count(c.id) FILTER (WHERE ((cs.status = 'up'::text) AND (cs.last_checked_at >= (now() - make_interval(mins => public.monitor_stale_after_minutes()))))))::integer AS cameras_live,
    (count(c.id) FILTER (WHERE (cs.status = 'down'::text)))::integer AS cameras_down,
    (count(c.id) FILTER (WHERE ((cs.status IS NULL) OR (cs.status = 'unknown'::text))))::integer AS cameras_unknown,
    nvr.status AS nvr_status,
    nvr.down_since AS nvr_down_since,
    nvr.last_checked_at AS nvr_checked_at,
    (count(c.id) FILTER (WHERE ((cs.status = 'up'::text) AND (NOT COALESCE((cs.last_checked_at >= (now() - make_interval(mins => public.monitor_stale_after_minutes()))), false)))))::integer AS cameras_stale,
    COALESCE(((nvr.status = 'up'::text) AND (NOT COALESCE((nvr.last_checked_at >= (now() - make_interval(mins => public.monitor_stale_after_minutes()))), false))), false) AS nvr_stale
   FROM (((public.stores s
     LEFT JOIN public.cameras c ON (((c.store_id = s.id) AND c.is_active)))
     LEFT JOIN public.check_state cs ON (((cs.org_id = c.org_id) AND (cs.target_type = 'camera'::text) AND (cs.target_id = c.id))))
     LEFT JOIN public.check_state nvr ON (((nvr.org_id = s.org_id) AND (nvr.target_type = 'nvr'::text) AND (nvr.target_id = s.id))))
  WHERE s.is_active
  GROUP BY s.id, s.org_id, nvr.status, nvr.down_since, nvr.last_checked_at;

CREATE VIEW public.store_nvr_endpoints WITH (security_barrier='true') AS
 SELECT id AS store_id,
    org_id,
    nvr_ip,
    rtsp_port,
    http_port,
    nvr_username
   FROM public.stores s
  WHERE ((org_id = ( SELECT public.current_org_id() AS current_org_id)) AND (id IN ( SELECT public.it_view_store_ids() AS it_view_store_ids)));

COMMENT ON VIEW public.store_nvr_endpoints IS 'NVR address and login of the locations the caller has an IT view of (it.inventory.view or it.monitoring.view). Never the vault id.';
CREATE VIEW public.camera_endpoints WITH (security_barrier='true') AS
 SELECT id AS camera_id,
    org_id,
    store_id,
    camera_ip
   FROM public.cameras c
  WHERE ((org_id = ( SELECT public.current_org_id() AS current_org_id)) AND (store_id IN ( SELECT public.it_view_store_ids() AS it_view_store_ids)));

COMMENT ON VIEW public.camera_endpoints IS 'Camera addresses of the locations the caller has an IT view of.';
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated USING (((org_id = ( SELECT public.current_org_id() AS current_org_id)) AND (((target_type = 'camera'::text) AND (target_id IN ( SELECT public.any_cctv_camera_ids() AS any_cctv_camera_ids))) OR ((target_type = 'device'::text) AND (target_id IN ( SELECT public.it_view_device_ids() AS it_view_device_ids))) OR ((target_type = 'nvr'::text) AND (target_id IN ( SELECT public.it_view_store_ids() AS it_view_store_ids))))));
CREATE POLICY devices_select ON public.devices FOR SELECT TO authenticated USING (((org_id = ( SELECT public.current_org_id() AS current_org_id)) AND (id IN ( SELECT public.it_view_device_ids() AS it_view_device_ids))));
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated USING (((org_id = ( SELECT public.current_org_id() AS current_org_id)) AND (((target_type = 'camera'::text) AND (target_id IN ( SELECT public.any_cctv_camera_ids() AS any_cctv_camera_ids))) OR ((target_type = 'device'::text) AND (target_id IN ( SELECT public.it_view_device_ids() AS it_view_device_ids))) OR ((target_type = 'nvr'::text) AND (target_id IN ( SELECT public.it_view_store_ids() AS it_view_store_ids))))));
CREATE POLICY stores_select ON public.stores FOR SELECT TO authenticated USING (((org_id = ( SELECT public.current_org_id() AS current_org_id)) AND (id IN ( SELECT public.any_grant_store_ids() AS any_grant_store_ids))));
CREATE TRIGGER cameras_forget AFTER DELETE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('camera');
CREATE TRIGGER devices_forget AFTER DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('device');
CREATE TRIGGER devices_stop AFTER UPDATE OF enabled ON public.devices FOR EACH ROW WHEN ((old.enabled AND (NOT new.enabled))) EXECUTE FUNCTION public.monitor_stop_target('device');
CREATE TRIGGER stores_forget AFTER DELETE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.monitor_forget_target('nvr');
CREATE TRIGGER stores_stop AFTER UPDATE OF is_active ON public.stores FOR EACH ROW WHEN ((old.is_active AND (NOT new.is_active))) EXECUTE FUNCTION public.monitor_stop_store();

REVOKE ALL ON public.store_status, public.store_nvr_endpoints, public.camera_endpoints FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.store_status TO service_role;
GRANT SELECT ON TABLE public.store_status TO authenticated;
GRANT SELECT ON TABLE public.store_nvr_endpoints TO authenticated, service_role;
GRANT SELECT ON TABLE public.camera_endpoints TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5a rollback: privilege violations'; END IF;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
