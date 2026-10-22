-- P2-5a core (decision D-4, ruling C-1 CONFIRMED, decisions D5-1..D5-12 of docs/drishti/p2-5-impact-map.md; M2 of its section 2.1).
-- One atomic transaction: renames break text-bodied functions only when they are called, so every rename and every function rewrite
-- commit together, and a self-test at the end turns "found at first call" into "migration fails".
-- APPLY ONLY THROUGH `npx supabase migration up` (or `supabase db push`): the CLI runs each migration file in one transaction. The file
-- has no BEGIN/COMMIT of its own; fed statement by statement to psql without -1 it could stop half-way (review M1, docs/drishti/locations-model.md §10).
--
--   Organization → Region → Cluster → Location → NVR (recorder) → Camera   (a strict tree; IT assets belong to a location;
--   region and cluster are optional for a location — owner amendment to R-1)
--
-- * stores → locations, devices → assets, cameras.store_id → location_id, devices.store_id → location_id, profiles.store_id →
--   location_id: in place, ids unchanged (grants, groups, history keep pointing at the same rows).
-- * New: regions, clusters, recorders (1:1 extension of an asset of type nvr, shared id), camera_channel_mappings (validity history,
--   the two partial uniques of D-4 and no-overlap exclusions), address_spaces + asset_endpoints (one 'global' space per organisation;
--   address uniqueness per space replaces the organisation-wide ip/port key).
-- * Archive instead of delete: archived_at on regions, clusters, locations, assets (and so recorders) and cameras; hard DELETE refused
--   (SQLSTATE DR003) except by inventory_purge_test_org for test/demo organisations. The delete triggers that erased monitoring history
--   (monitor_forget_target) are gone. Deactivation keeps its tested semantics (open outages closed, current state forgotten).
-- * Grant scope kinds organization, region, cluster, location, recorder, camera, asset with dynamic expansion in every effective-access
--   function; archived nodes grant nothing; the union rule and every P2-1..P2-3 fix are kept (bodies taken from the latest definitions:
--   0009/0012/0013/0014/0015/0017).
-- * Transitional seam (ruling D5-7, removed by the P2-5b contract migration): the legacy NVR columns stay on locations (nullable,
--   deprecated) with a one-way sync to the location's primary recorder; nvr_*_credential(p_store) wrap the recorder functions;
--   monitor_apply_results accepts 'nvr' + location id and writes ('recorder', primary recorder id); check_state/outages accept both.
-- * Owner addition (2026-10-22): recorders.monitoring_enabled (switch monitoring off per NVR; nothing contacts a switched-off NVR).
--
-- Error codes: DR003 delete refused (archive instead), DR004 recorder still has cameras, DR005 dependency cycle (M3),
-- DR006 a camera can only be mapped to a recorder at its own location.

-- ═══ 0. Snapshot with the OLD functions, before anything changes (verified by 20261021000021) ═══════════════════════════════════
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

INSERT INTO public.inventory_migration_snapshot (taken_at, org_id, user_id, capability, cameras, locations, assets)
SELECT now(), p.org_id, p.id, c.key,
       ARRAY(SELECT x FROM public.access_cameras_for(p.id, ARRAY[c.key], now(), true, true) AS x ORDER BY 1),
       ARRAY(SELECT x FROM public.access_stores_for(p.id, ARRAY[c.key], now(), true, true) AS x ORDER BY 1),
       ARRAY(SELECT x FROM public.access_devices_for(p.id, ARRAY[c.key], now(), true, true) AS x ORDER BY 1)
FROM public.profiles p CROSS JOIN public.capabilities c;

-- ═══ 1. Objects that depend on what is renamed or replaced (recreated below) ═══════════════════════════════════════════════════
DROP POLICY stores_select ON public.stores;
DROP POLICY devices_select ON public.devices;
DROP POLICY check_state_select ON public.check_state;
DROP POLICY outages_select ON public.outages;
DROP VIEW public.store_status;
DROP VIEW public.store_nvr_endpoints;
DROP VIEW public.camera_endpoints;
DROP TRIGGER stores_forget ON public.stores;
DROP TRIGGER cameras_forget ON public.cameras;
DROP TRIGGER devices_forget ON public.devices;
DROP TRIGGER stores_stop ON public.stores;
DROP TRIGGER devices_stop ON public.devices;

DROP FUNCTION public.capability_store_ids(text);
DROP FUNCTION public.capability_device_ids(text);
DROP FUNCTION public.it_view_store_ids();
DROP FUNCTION public.it_view_device_ids();
DROP FUNCTION public.any_grant_store_ids();
DROP FUNCTION public.report_effective_device_ids(uuid, text, timestamptz, boolean);
DROP FUNCTION public.access_stores_for(uuid, text[], timestamptz, boolean, boolean);
DROP FUNCTION public.access_devices_for(uuid, text[], timestamptz, boolean, boolean);
DROP FUNCTION public.access_store_set(uuid, boolean, uuid[]);
DROP FUNCTION public.access_device_set(uuid, boolean, uuid[], uuid[]);
DROP FUNCTION public.access_camera_set(uuid, boolean, uuid[], uuid[]);
DROP FUNCTION public.my_access_summary();
DROP FUNCTION public.access_grant_summary(uuid);
DROP FUNCTION public.monitor_forget_target();
DROP FUNCTION public.monitor_stop_store();

-- ═══ 2. Renames (ids unchanged) ═══════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.stores RENAME TO locations;
ALTER TABLE public.locations RENAME CONSTRAINT stores_pkey TO locations_pkey;
ALTER TABLE public.locations RENAME CONSTRAINT stores_id_org_key TO locations_id_org_key;
ALTER TABLE public.locations RENAME CONSTRAINT stores_code_upper TO locations_code_upper;
ALTER TABLE public.locations RENAME CONSTRAINT stores_org_id_fkey TO locations_org_id_fkey;
ALTER INDEX public.stores_org_zone_idx RENAME TO locations_org_zone_idx;
ALTER TRIGGER stores_updated ON public.locations RENAME TO locations_updated;

ALTER TABLE public.cameras RENAME COLUMN store_id TO location_id;
ALTER TABLE public.cameras RENAME CONSTRAINT cameras_store_fk TO cameras_location_fk;

ALTER TABLE public.devices RENAME TO assets;
ALTER TABLE public.assets RENAME COLUMN store_id TO location_id;
ALTER TABLE public.assets RENAME CONSTRAINT devices_pkey TO assets_pkey;
ALTER TABLE public.assets RENAME CONSTRAINT devices_id_org_key TO assets_id_org_key;
ALTER TABLE public.assets RENAME CONSTRAINT devices_store_fk TO assets_location_fk;
ALTER TABLE public.assets RENAME CONSTRAINT devices_org_id_fkey TO assets_org_id_fkey;
ALTER TABLE public.assets RENAME CONSTRAINT devices_tcp_port_check TO assets_tcp_port_check;
ALTER INDEX public.devices_store_idx RENAME TO assets_location_idx;
ALTER INDEX public.devices_org_idx RENAME TO assets_org_idx;
ALTER TRIGGER devices_updated ON public.assets RENAME TO assets_updated;
-- D5-8: address uniqueness moves to asset_endpoints (per address space); the address is an attribute, not the identity.
ALTER TABLE public.assets DROP CONSTRAINT devices_org_ip_port_key;
ALTER TABLE public.assets ALTER COLUMN ip DROP NOT NULL;

ALTER TABLE public.profiles RENAME COLUMN store_id TO location_id;
ALTER TABLE public.profiles RENAME CONSTRAINT profiles_store_fk TO profiles_location_fk;
ALTER INDEX public.profiles_store_idx RENAME TO profiles_location_idx;
COMMENT ON COLUMN public.profiles.location_id IS 'Home location: information only. It grants nothing (directive AC-7, P2-1).';

-- ═══ 3. Hierarchy: regions and clusters (ruling C-1: each cluster in ONE region, each location in ONE cluster) ═════════════════
CREATE TABLE public.regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  code text NOT NULL CHECK (code = upper(code) AND length(btrim(code)) BETWEEN 1 AND 50),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regions_id_org_key UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX regions_org_code_key ON public.regions (org_id, code) WHERE archived_at IS NULL;

CREATE TABLE public.clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  -- Optional (owner amendment to R-1): a cluster need not belong to a region.
  region_id uuid,
  code text NOT NULL CHECK (code = upper(code) AND length(btrim(code)) BETWEEN 1 AND 50),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clusters_id_org_key UNIQUE (id, org_id),
  CONSTRAINT clusters_region_fk FOREIGN KEY (region_id, org_id) REFERENCES public.regions (id, org_id)
);
CREATE UNIQUE INDEX clusters_org_code_key ON public.clusters (org_id, code) WHERE archived_at IS NULL;
CREATE INDEX clusters_region_idx ON public.clusters (region_id) WHERE region_id IS NOT NULL;
CREATE TRIGGER regions_updated BEFORE UPDATE ON public.regions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER clusters_updated BEFORE UPDATE ON public.clusters FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══ 4. New columns on locations, cameras and assets ═══════════════════════════════════════════════════════════════════════
ALTER TABLE public.locations
  ADD COLUMN kind text NOT NULL DEFAULT 'store' CHECK (kind IN ('store', 'head_office', 'dc', 'warehouse', 'other')),
  -- Optional (owner amendment to R-1, 2026-10-22): a location need not belong to a cluster; the UI shows "No cluster". Region and
  -- cluster scopes simply expand to nothing for it; organisation, location, recorder, camera and asset scopes work as always.
  ADD COLUMN cluster_id uuid,
  ADD COLUMN parent_location_id uuid,
  -- The location's uplink (SD-WAN edge, D-5). No foreign key yet: a second locations↔assets relationship would make every PostgREST
  -- embed between them ambiguous (PGRST201); the key is added with the hinted embeds in P2-5c.
  ADD COLUMN uplink_asset_id uuid,
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT locations_cluster_fk FOREIGN KEY (cluster_id, org_id) REFERENCES public.clusters (id, org_id),
  ADD CONSTRAINT locations_parent_fk FOREIGN KEY (parent_location_id, org_id) REFERENCES public.locations (id, org_id),
  ADD CONSTRAINT locations_parent_not_self CHECK (parent_location_id IS NULL OR parent_location_id <> id),
  ADD CONSTRAINT locations_archived_inactive CHECK (archived_at IS NULL OR NOT is_active);
CREATE INDEX locations_cluster_idx ON public.locations (cluster_id) WHERE cluster_id IS NOT NULL;
-- An archived location frees its code (the history row keeps it); codes stay unique among the others. The code is the stable short
-- code (e.g. JCL); the name is a freely editable display name (owner amendment to R-1).
ALTER TABLE public.locations DROP CONSTRAINT stores_org_code_key;
CREATE UNIQUE INDEX locations_org_code_key ON public.locations (org_id, code) WHERE archived_at IS NULL;
-- Legacy NVR columns (D5-7): nullable and deprecated; a head office or DC has no NVR. Dropped by the P2-5b contract migration.
ALTER TABLE public.locations ALTER COLUMN nvr_ip DROP NOT NULL, ALTER COLUMN nvr_username DROP NOT NULL;
COMMENT ON COLUMN public.locations.nvr_ip IS 'DEPRECATED (P2-5a seam): copied one way to the primary recorder; dropped in P2-5b.';
COMMENT ON COLUMN public.locations.nvr_secret_id IS 'DEPRECATED (P2-5a): the recorder owns its vault secret (recorders.secret_id); always NULL after the migration.';

CREATE TABLE public.address_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- global: the company network reachable from head office. location_nat: a location whose addresses overlap others (SD-WAN NAT;
  -- the real SD-WAN addressing is an external unknown, see docs/drishti/locations-model.md). sdwan/other: modelled later.
  kind text NOT NULL CHECK (kind IN ('global', 'location_nat', 'sdwan', 'other')),
  location_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT address_spaces_id_org_key UNIQUE (id, org_id),
  CONSTRAINT address_spaces_org_name_key UNIQUE (org_id, name),
  CONSTRAINT address_spaces_location_fk FOREIGN KEY (location_id, org_id) REFERENCES public.locations (id, org_id),
  CONSTRAINT address_spaces_location_kind CHECK ((kind = 'location_nat') = (location_id IS NOT NULL))
);
CREATE UNIQUE INDEX address_spaces_one_global ON public.address_spaces (org_id) WHERE kind = 'global';
CREATE UNIQUE INDEX address_spaces_one_per_location ON public.address_spaces (location_id) WHERE kind = 'location_nat';

ALTER TABLE public.cameras
  ADD COLUMN recorder_id uuid,
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT cameras_archived_inactive CHECK (archived_at IS NULL OR NOT is_active);
COMMENT ON COLUMN public.cameras.recorder_id IS 'Cache of the ACTIVE camera_channel_mappings row (the truth), kept by triggers; channel likewise. Not readable by signed-in people (ruling C-1: the recorder is shown to IT users only).';

ALTER TABLE public.assets
  ADD COLUMN address_space_id uuid,
  ADD COLUMN is_recorder boolean NOT NULL DEFAULT false,
  ADD COLUMN attached_recorder_id uuid,
  ADD COLUMN serial text CHECK (serial IS NULL OR length(serial) <= 200),
  ADD COLUMN mac text CHECK (mac IS NULL OR mac ~* '^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$'),
  ADD COLUMN vendor text CHECK (vendor IS NULL OR length(vendor) <= 100),
  ADD COLUMN model text CHECK (model IS NULL OR length(model) <= 100),
  ADD COLUMN firmware text CHECK (firmware IS NULL OR length(firmware) <= 100),
  ADD COLUMN role text CHECK (role IS NULL OR length(role) <= 100),
  ADD COLUMN owner text CHECK (owner IS NULL OR length(owner) <= 200),
  ADD COLUMN criticality text CHECK (criticality IS NULL OR criticality IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('planned', 'active', 'maintenance', 'retired', 'disposed')),
  ADD COLUMN warranty_until date,
  ADD COLUMN last_inventory_at timestamptz,
  ADD COLUMN management_mode text CHECK (management_mode IS NULL OR length(management_mode) <= 100),
  ADD COLUMN capability_discovered_at timestamptz,
  -- A vault reference NAME (never the secret itself).
  ADD COLUMN credential_ref text CHECK (credential_ref IS NULL OR credential_ref ~ '^[A-Za-z0-9_:.-]{1,200}$'),
  ADD COLUMN config_owner text CHECK (config_owner IS NULL OR length(config_owner) <= 200),
  ADD COLUMN assigned_profile_id uuid,
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT assets_id_location_key UNIQUE (id, location_id),
  ADD CONSTRAINT assets_space_fk FOREIGN KEY (address_space_id, org_id) REFERENCES public.address_spaces (id, org_id),
  ADD CONSTRAINT assets_archived_disabled CHECK (archived_at IS NULL OR NOT enabled);
CREATE INDEX assets_space_idx ON public.assets (address_space_id) WHERE address_space_id IS NOT NULL;

-- ═══ 5. Recorders, endpoints and channel mappings ═════════════════════════════════════════════════════════════════════════
CREATE TABLE public.recorders (
  id uuid PRIMARY KEY,                       -- = assets.id (D5-2: one id for the box everywhere)
  org_id uuid NOT NULL,
  location_id uuid NOT NULL,
  http_port integer NOT NULL DEFAULT 80 CHECK (http_port BETWEEN 1 AND 65535),
  rtsp_port integer NOT NULL DEFAULT 554 CHECK (rtsp_port BETWEEN 1 AND 65535),
  username text CHECK (username IS NULL OR length(username) <= 200),
  secret_id uuid,                            -- vault.secrets id, name 'recorder:<id>'; never readable by signed-in people
  expected_channels integer NOT NULL DEFAULT 0 CHECK (expected_channels >= 0),
  clock_offset_sec integer CHECK (clock_offset_sec IS NULL OR abs(clock_offset_sec) <= 86400),
  clock_offset_source text CHECK (clock_offset_source IS NULL OR clock_offset_source IN ('manual', 'measured', 'ntp')),
  vendor_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(vendor_capabilities) = 'object'),
  -- Owner addition 2026-10-22: a switched-off NVR (and its cameras) is never contacted by the worker, discovery, live or playback.
  monitoring_enabled boolean NOT NULL DEFAULT true,
  monitoring_disabled_reason text CHECK (monitoring_disabled_reason IS NULL OR length(monitoring_disabled_reason) <= 500),
  monitoring_disabled_at timestamptz,
  monitoring_disabled_by uuid,
  migrated_from_location_id uuid,            -- set when the recorder carries the location's legacy NVR (migration or seam)
  created_asset boolean NOT NULL DEFAULT true, -- false when an existing nvr-typed device was adopted (merge, D5-2)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recorders_id_org_key UNIQUE (id, org_id),
  CONSTRAINT recorders_asset_fk FOREIGN KEY (id, org_id) REFERENCES public.assets (id, org_id),
  CONSTRAINT recorders_asset_location_fk FOREIGN KEY (id, location_id) REFERENCES public.assets (id, location_id) ON UPDATE CASCADE,
  CONSTRAINT recorders_location_fk FOREIGN KEY (location_id, org_id) REFERENCES public.locations (id, org_id),
  CONSTRAINT recorders_off_has_reason CHECK (monitoring_enabled OR length(btrim(coalesce(monitoring_disabled_reason, ''))) >= 3)
);
CREATE INDEX recorders_location_idx ON public.recorders (location_id, created_at, id);
CREATE TRIGGER recorders_updated BEFORE UPDATE ON public.recorders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.assets ADD CONSTRAINT assets_attached_recorder_fk FOREIGN KEY (attached_recorder_id, org_id) REFERENCES public.recorders (id, org_id);
ALTER TABLE public.cameras ADD CONSTRAINT cameras_recorder_fk FOREIGN KEY (recorder_id, org_id) REFERENCES public.recorders (id, org_id);
CREATE INDEX cameras_location_idx ON public.cameras (location_id);
CREATE INDEX cameras_recorder_idx ON public.cameras (recorder_id) WHERE recorder_id IS NOT NULL;
CREATE INDEX assets_attached_recorder_idx ON public.assets (attached_recorder_id) WHERE attached_recorder_id IS NOT NULL;

CREATE TABLE public.asset_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  address_space_id uuid NOT NULL,
  host text NOT NULL CHECK (length(btrim(host)) BETWEEN 1 AND 255),
  port integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  purpose text NOT NULL CHECK (purpose IN ('management', 'rtsp', 'snmp', 'other')),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_endpoints_asset_fk FOREIGN KEY (asset_id, org_id) REFERENCES public.assets (id, org_id),
  CONSTRAINT asset_endpoints_space_fk FOREIGN KEY (address_space_id, org_id) REFERENCES public.address_spaces (id, org_id)
);
-- AL-6: one address (host + port) per address space; a missing port counts as one value (like the old NULLS NOT DISTINCT key).
CREATE UNIQUE INDEX asset_endpoints_address_key ON public.asset_endpoints (org_id, address_space_id, lower(host), coalesce(port, 0)) WHERE retired_at IS NULL;
CREATE INDEX asset_endpoints_asset_idx ON public.asset_endpoints (asset_id);

CREATE TABLE public.camera_channel_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  recorder_id uuid NOT NULL,
  channel integer NOT NULL CHECK (channel > 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camera_channel_mappings_order CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT camera_channel_mappings_camera_fk FOREIGN KEY (camera_id, org_id) REFERENCES public.cameras (id, org_id),
  CONSTRAINT camera_channel_mappings_recorder_fk FOREIGN KEY (recorder_id, org_id) REFERENCES public.recorders (id, org_id),
  CONSTRAINT camera_channel_mappings_camera_no_overlap EXCLUDE USING gist (camera_id WITH =, tstzrange(valid_from, valid_to) WITH &&),
  CONSTRAINT camera_channel_mappings_channel_no_overlap EXCLUDE USING gist (recorder_id WITH =, channel WITH =, tstzrange(valid_from, valid_to) WITH &&)
);
-- The two partial uniques of D-4: a camera has one active mapping; a recorder channel has one active camera.
CREATE UNIQUE INDEX camera_channel_mappings_active_channel ON public.camera_channel_mappings (recorder_id, channel) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX camera_channel_mappings_active_camera ON public.camera_channel_mappings (camera_id) WHERE valid_to IS NULL;
CREATE INDEX camera_channel_mappings_recorder_idx ON public.camera_channel_mappings (recorder_id) WHERE valid_to IS NULL;

-- Camera identity no longer depends on the channel (brief item 1); the mapping uniques above replace it.
ALTER TABLE public.cameras DROP CONSTRAINT cameras_store_channel_key;

-- ═══ 6. Capability catalogue and grants: seven scope kinds ════════════════════════════════════════════════════════════════
ALTER TABLE public.capabilities DROP CONSTRAINT capabilities_scope_kinds_check;
ALTER TABLE public.capabilities ADD CONSTRAINT capabilities_scope_kinds_check CHECK (
  scope_kinds <@ ARRAY['organization', 'region', 'cluster', 'location', 'recorder', 'camera', 'asset'] AND cardinality(scope_kinds) > 0);
-- D5-6: cctv at camera granularity; it at asset (a recorder grant covers the NVR's own asset and assets attached to it); wifi at
-- location/asset; admin organisation-wide only. A CCTV scope never reveals IT assets: cctv expansions only ever return cameras.
-- (The capabilities_grant_platform_owners_on_scope trigger of 0017 fires only when 'organization' is newly added: it does not here.)
UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'region', 'cluster', 'location', 'recorder', 'camera'] WHERE area = 'cctv';
UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'region', 'cluster', 'location', 'recorder', 'asset'] WHERE area = 'it';
UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'region', 'cluster', 'location', 'asset'] WHERE area = 'wifi';
UPDATE public.capabilities SET scope_kinds = ARRAY['organization'] WHERE area = 'admin';

ALTER TABLE public.access_grants
  ADD COLUMN region_id uuid,
  ADD COLUMN cluster_id uuid,
  ADD COLUMN recorder_id uuid,
  ADD CONSTRAINT access_grants_region_fk FOREIGN KEY (region_id, org_id) REFERENCES public.regions (id, org_id) ON DELETE SET NULL (region_id),
  ADD CONSTRAINT access_grants_cluster_fk FOREIGN KEY (cluster_id, org_id) REFERENCES public.clusters (id, org_id) ON DELETE SET NULL (cluster_id),
  ADD CONSTRAINT access_grants_recorder_fk FOREIGN KEY (recorder_id, org_id) REFERENCES public.recorders (id, org_id) ON DELETE SET NULL (recorder_id);
CREATE INDEX access_grants_region_idx ON public.access_grants (region_id) WHERE region_id IS NOT NULL;
CREATE INDEX access_grants_cluster_idx ON public.access_grants (cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX access_grants_recorder_idx ON public.access_grants (recorder_id) WHERE recorder_id IS NOT NULL;
ALTER TABLE public.access_grants DROP CONSTRAINT access_grants_scope_kind_check;
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_scope_kind_check CHECK (
  scope_kind IN ('organization', 'region', 'cluster', 'location', 'recorder', 'camera', 'asset'));
-- Exactly the typed column of the grant's kind mirrors scope_id; it is NULL only after what it pointed at was purged (then revoked).
ALTER TABLE public.access_grants DROP CONSTRAINT access_grants_scope;
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_scope CHECK (
  (scope_kind = 'organization' AND scope_id IS NULL AND num_nonnulls(region_id, cluster_id, location_id, recorder_id, camera_id, asset_id) = 0)
  OR (scope_kind <> 'organization' AND scope_id IS NOT NULL
      AND num_nonnulls(region_id, cluster_id, location_id, recorder_id, camera_id, asset_id) <= 1
      AND CASE scope_kind
            WHEN 'region' THEN region_id IS NOT DISTINCT FROM scope_id OR (region_id IS NULL AND revoked_at IS NOT NULL)
            WHEN 'cluster' THEN cluster_id IS NOT DISTINCT FROM scope_id OR (cluster_id IS NULL AND revoked_at IS NOT NULL)
            WHEN 'location' THEN location_id IS NOT DISTINCT FROM scope_id OR (location_id IS NULL AND revoked_at IS NOT NULL)
            WHEN 'recorder' THEN recorder_id IS NOT DISTINCT FROM scope_id OR (recorder_id IS NULL AND revoked_at IS NOT NULL)
            WHEN 'camera' THEN camera_id IS NOT DISTINCT FROM scope_id OR (camera_id IS NULL AND revoked_at IS NOT NULL)
            WHEN 'asset' THEN asset_id IS NOT DISTINCT FROM scope_id OR (asset_id IS NULL AND revoked_at IS NOT NULL)
            ELSE false END
      AND CASE scope_kind
            WHEN 'region' THEN num_nonnulls(cluster_id, location_id, recorder_id, camera_id, asset_id) = 0
            WHEN 'cluster' THEN num_nonnulls(region_id, location_id, recorder_id, camera_id, asset_id) = 0
            WHEN 'location' THEN num_nonnulls(region_id, cluster_id, recorder_id, camera_id, asset_id) = 0
            WHEN 'recorder' THEN num_nonnulls(region_id, cluster_id, location_id, camera_id, asset_id) = 0
            WHEN 'camera' THEN num_nonnulls(region_id, cluster_id, location_id, recorder_id, asset_id) = 0
            WHEN 'asset' THEN num_nonnulls(region_id, cluster_id, location_id, recorder_id, camera_id) = 0
            ELSE false END));

CREATE OR REPLACE FUNCTION public.access_grants_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
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
  NEW.region_id := CASE WHEN NEW.scope_kind = 'region' THEN NEW.scope_id END;
  NEW.cluster_id := CASE WHEN NEW.scope_kind = 'cluster' THEN NEW.scope_id END;
  NEW.location_id := CASE WHEN NEW.scope_kind = 'location' THEN NEW.scope_id END;
  NEW.recorder_id := CASE WHEN NEW.scope_kind = 'recorder' THEN NEW.scope_id END;
  NEW.camera_id := CASE WHEN NEW.scope_kind = 'camera' THEN NEW.scope_id END;
  NEW.asset_id := CASE WHEN NEW.scope_kind = 'asset' THEN NEW.scope_id END;
  NEW.granted_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.access_grants_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
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
     OR (NEW.asset_id IS DISTINCT FROM OLD.asset_id AND NEW.asset_id IS NOT NULL)
     OR (NEW.region_id IS DISTINCT FROM OLD.region_id AND NEW.region_id IS NOT NULL)
     OR (NEW.cluster_id IS DISTINCT FROM OLD.cluster_id AND NEW.cluster_id IS NOT NULL)
     OR (NEW.recorder_id IS DISTINCT FROM OLD.recorder_id AND NEW.recorder_id IS NOT NULL) THEN
    RAISE EXCEPTION 'access grants are append-only' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at, NEW.revoked_by, NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by, OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked grant stays revoked' USING ERRCODE = '42501';
  END IF;
  IF (OLD.location_id IS NOT NULL AND NEW.location_id IS NULL) OR (OLD.camera_id IS NOT NULL AND NEW.camera_id IS NULL)
     OR (OLD.asset_id IS NOT NULL AND NEW.asset_id IS NULL) OR (OLD.region_id IS NOT NULL AND NEW.region_id IS NULL)
     OR (OLD.cluster_id IS NOT NULL AND NEW.cluster_id IS NULL) OR (OLD.recorder_id IS NOT NULL AND NEW.recorder_id IS NULL) THEN
    NEW.revoked_at := coalesce(NEW.revoked_at, now());
    NEW.revoke_reason := coalesce(NEW.revoke_reason, 'What the grant pointed at was deleted.');
  END IF;
  RETURN NEW;
END
$$;

-- ═══ 7. Hierarchy expansion and ancestry (one place for the scope rules; impact map 1.9) ═════════════════════════════════════
-- Locations covered whole by region / cluster / location lists. Archived nodes grant nothing and cut the path: an archived region or
-- cluster contributes no locations, an archived location is never returned. A location without a cluster is reached only by its own id.
CREATE FUNCTION public.access_location_expand(p_org uuid, p_regions uuid[], p_clusters uuid[], p_locations uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id FROM public.locations l
  WHERE l.org_id = p_org AND l.archived_at IS NULL AND l.id = ANY (p_locations)
  UNION
  SELECT l.id FROM public.locations l JOIN public.clusters c ON c.id = l.cluster_id AND c.archived_at IS NULL
  WHERE l.org_id = p_org AND l.archived_at IS NULL AND c.id = ANY (p_clusters)
  UNION
  SELECT l.id FROM public.locations l
  JOIN public.clusters c ON c.id = l.cluster_id AND c.archived_at IS NULL
  JOIN public.regions r ON r.id = c.region_id AND r.archived_at IS NULL
  WHERE l.org_id = p_org AND l.archived_at IS NULL AND r.id = ANY (p_regions)
$$;

-- The path of one target up the tree, with archived nodes cut out. No row: the target does not exist in the organisation or is
-- archived. A camera's recorder is its active mapping's recorder; an asset's recorder is itself (an NVR) or the NVR it is attached to.
CREATE FUNCTION public.access_ancestry(p_org uuid, p_kind text, p_id uuid)
RETURNS TABLE (region_id uuid, cluster_id uuid, location_id uuid, recorder_id uuid, camera_id uuid, asset_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_loc uuid;
  v_clu uuid;
  v_reg uuid;
  v_rec uuid;
  v_cam uuid;
  v_ast uuid;
BEGIN
  IF p_kind = 'region' THEN
    SELECT r.id INTO v_reg FROM public.regions r WHERE r.id = p_id AND r.org_id = p_org AND r.archived_at IS NULL;
    IF v_reg IS NULL THEN RETURN; END IF;
  ELSIF p_kind = 'cluster' THEN
    SELECT c.id INTO v_clu FROM public.clusters c WHERE c.id = p_id AND c.org_id = p_org AND c.archived_at IS NULL;
    IF v_clu IS NULL THEN RETURN; END IF;
  ELSIF p_kind = 'location' THEN
    SELECT l.id INTO v_loc FROM public.locations l WHERE l.id = p_id AND l.org_id = p_org AND l.archived_at IS NULL;
    IF v_loc IS NULL THEN RETURN; END IF;
  ELSIF p_kind = 'recorder' THEN
    SELECT r.id, r.location_id INTO v_rec, v_loc FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
    WHERE r.id = p_id AND r.org_id = p_org;
    IF v_rec IS NULL THEN RETURN; END IF;
  ELSIF p_kind = 'camera' THEN
    SELECT c.id, c.location_id, (SELECT a.id FROM public.assets a WHERE a.id = c.recorder_id AND a.archived_at IS NULL)
    INTO v_cam, v_loc, v_rec FROM public.cameras c WHERE c.id = p_id AND c.org_id = p_org AND c.archived_at IS NULL;
    IF v_cam IS NULL THEN RETURN; END IF;
  ELSIF p_kind = 'asset' THEN
    SELECT a.id, a.location_id,
           CASE WHEN a.is_recorder THEN a.id
                ELSE (SELECT ra.id FROM public.assets ra WHERE ra.id = a.attached_recorder_id AND ra.archived_at IS NULL) END
    INTO v_ast, v_loc, v_rec FROM public.assets a WHERE a.id = p_id AND a.org_id = p_org AND a.archived_at IS NULL;
    IF v_ast IS NULL THEN RETURN; END IF;
  ELSE
    RETURN;
  END IF;
  IF v_loc IS NOT NULL THEN
    SELECT l.cluster_id INTO v_clu FROM public.locations l WHERE l.id = v_loc AND l.archived_at IS NULL;
    IF NOT FOUND THEN RETURN; END IF; -- the target sits in an archived location
    SELECT c.id INTO v_clu FROM public.clusters c WHERE c.id = v_clu AND c.archived_at IS NULL;
  END IF;
  IF v_clu IS NOT NULL THEN
    SELECT r.id INTO v_reg FROM public.regions r JOIN public.clusters c ON c.region_id = r.id
    WHERE c.id = v_clu AND r.archived_at IS NULL;
  END IF;
  region_id := v_reg; cluster_id := v_clu; location_id := v_loc; recorder_id := v_rec; camera_id := v_cam; asset_id := v_ast;
  RETURN NEXT;
END
$$;

-- "A grant at (held kind, held id) covers the target": organization > region > cluster > location > recorder > camera / asset.
CREATE FUNCTION public.access_scope_covers(p_org uuid, p_held_kind text, p_held_id uuid, p_kind text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a record;
BEGIN
  IF p_held_kind = 'organization' THEN RETURN true; END IF;
  SELECT * INTO a FROM public.access_ancestry(p_org, p_kind, p_id);
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN coalesce(CASE p_held_kind
    WHEN 'region' THEN a.region_id = p_held_id
    WHEN 'cluster' THEN a.cluster_id = p_held_id
    WHEN 'location' THEN a.location_id = p_held_id
    WHEN 'recorder' THEN a.recorder_id = p_held_id
    WHEN 'camera' THEN p_kind = 'camera' AND a.camera_id = p_held_id
    WHEN 'asset' THEN p_kind = 'asset' AND a.asset_id = p_held_id
    ELSE false END, false);
END
$$;

-- The ancestry of several targets at once, for the access editor's explanations (service role; P2-3 rules in TypeScript).
CREATE FUNCTION public.access_target_ancestry(p_org uuid, p_targets jsonb)
RETURNS TABLE (kind text, id uuid, region_id uuid, cluster_id uuid, location_id uuid, recorder_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.value ->> 'kind', (t.value ->> 'id')::uuid, a.region_id, a.cluster_id, a.location_id, a.recorder_id
  FROM jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) AS t
  CROSS JOIN LATERAL public.access_ancestry(p_org, t.value ->> 'kind', (t.value ->> 'id')::uuid) AS a
$$;

-- ═══ 8. Effective sets (rewritten; the sets every check, policy, preview and report uses) ════════════════════════════════════
CREATE FUNCTION public.access_camera_set(p_org uuid, p_org_wide boolean, p_regions uuid[], p_clusters uuid[], p_locations uuid[],
                                         p_recorders uuid[], p_cameras uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id FROM public.cameras c
  JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
  WHERE c.org_id = p_org AND c.archived_at IS NULL
    AND (p_org_wide
         OR c.location_id IN (SELECT public.access_location_expand(p_org, p_regions, p_clusters, p_locations))
         OR c.id = ANY (p_cameras)
         OR (c.recorder_id = ANY (p_recorders)
             AND EXISTS (SELECT 1 FROM public.assets a WHERE a.id = c.recorder_id AND a.archived_at IS NULL)))
$$;

CREATE FUNCTION public.access_asset_set(p_org uuid, p_org_wide boolean, p_regions uuid[], p_clusters uuid[], p_locations uuid[],
                                        p_recorders uuid[], p_assets uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id FROM public.assets a
  LEFT JOIN public.locations l ON l.id = a.location_id
  WHERE a.org_id = p_org AND a.archived_at IS NULL AND (a.location_id IS NULL OR l.archived_at IS NULL)
    AND (p_org_wide
         OR a.location_id IN (SELECT public.access_location_expand(p_org, p_regions, p_clusters, p_locations))
         OR a.id = ANY (p_assets)
         OR (a.is_recorder AND a.id = ANY (p_recorders))
         OR (a.attached_recorder_id = ANY (p_recorders)
             AND EXISTS (SELECT 1 FROM public.assets ra WHERE ra.id = a.attached_recorder_id AND ra.archived_at IS NULL)))
$$;

-- Locations covered WHOLE (organisation, region, cluster, location); recorder, camera and asset scopes never make a location whole.
CREATE FUNCTION public.access_location_set(p_org uuid, p_org_wide boolean, p_regions uuid[], p_clusters uuid[], p_locations uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id FROM public.locations l WHERE p_org_wide AND l.org_id = p_org AND l.archived_at IS NULL
  UNION
  SELECT x FROM public.access_location_expand(p_org, p_regions, p_clusters, p_locations) AS x WHERE NOT p_org_wide
$$;

CREATE OR REPLACE FUNCTION public.access_cameras_for(p_user uuid, p_caps text[], p_at timestamptz, p_ignore_status boolean, p_aal2 boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_camera_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'region'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'cluster'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'recorder'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'camera')
  ) AS x
$$;

CREATE FUNCTION public.access_assets_for(p_user uuid, p_caps text[], p_at timestamptz, p_ignore_status boolean, p_aal2 boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_asset_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'region'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'cluster'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'recorder'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'asset')
  ) AS x
$$;

CREATE FUNCTION public.access_locations_for(p_user uuid, p_caps text[], p_at timestamptz, p_ignore_status boolean, p_aal2 boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_location_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'region'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'cluster'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location')
  ) AS x
$$;

-- ── Signed-in callers, about themselves ──────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.capability_camera_ids(p_cap text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;
CREATE FUNCTION public.capability_location_ids(p_cap text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_locations_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;
CREATE FUNCTION public.capability_asset_ids(p_cap text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_assets_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;
CREATE OR REPLACE FUNCTION public.any_cctv_camera_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for((SELECT auth.uid()), ARRAY['cctv.live', 'cctv.playback', 'cctv.export'], now(), false,
                                         public.access_caller_aal2()) AS x
$$;
CREATE FUNCTION public.it_view_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_locations_for((SELECT auth.uid()), ARRAY['it.inventory.view', 'it.monitoring.view'], now(), false,
                                           public.access_caller_aal2()) AS x
$$;
CREATE FUNCTION public.it_view_asset_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_assets_for((SELECT auth.uid()), ARRAY['it.inventory.view', 'it.monitoring.view'], now(), false,
                                        public.access_caller_aal2()) AS x
$$;
-- Recorders whose asset the caller may see with the IT view (their status, addresses, mappings).
CREATE FUNCTION public.it_view_recorder_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id FROM public.recorders r WHERE r.id IN (SELECT public.it_view_asset_ids())
$$;

-- Per resource: camera (any path), location / cluster / region / recorder (covered WHOLE), asset (any path).
CREATE OR REPLACE FUNCTION public.has_capability_for(p_cap text, p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE capability = p_cap
  ),
  a AS MATERIALIZED (
    SELECT * FROM public.access_ancestry((SELECT p.org_id FROM public.profiles p WHERE p.id = (SELECT auth.uid())), p_kind, p_id)
    WHERE p_kind IN ('camera', 'location', 'asset', 'recorder', 'cluster', 'region')
  )
  SELECT EXISTS (
    SELECT 1 FROM g, a
    WHERE g.scope_kind = 'organization'
       OR (g.scope_kind = 'region' AND g.scope_id = a.region_id)
       OR (g.scope_kind = 'cluster' AND g.scope_id = a.cluster_id)
       OR (g.scope_kind = 'location' AND g.scope_id = a.location_id)
       OR (g.scope_kind = 'recorder' AND g.scope_id = a.recorder_id)
       OR (g.scope_kind = 'camera' AND g.scope_id = a.camera_id)
       OR (g.scope_kind = 'asset' AND g.scope_id = a.asset_id)
  )
$$;

-- Batch check (up to the 1000 ids of one PostgREST answer): each camera's own path against the grants — no full expansion.
CREATE OR REPLACE FUNCTION public.cameras_with_capability(p_cap text, p_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE capability = p_cap
  )
  SELECT c.id FROM public.cameras c
  JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
  LEFT JOIN public.clusters cl ON cl.id = l.cluster_id AND cl.archived_at IS NULL
  LEFT JOIN public.regions r ON r.id = cl.region_id AND r.archived_at IS NULL
  LEFT JOIN public.assets ra ON ra.id = c.recorder_id AND ra.archived_at IS NULL
  WHERE c.id = ANY (p_ids) AND c.archived_at IS NULL
    AND EXISTS (SELECT 1 FROM g WHERE g.org_id = c.org_id
                AND (g.scope_kind = 'organization'
                     OR (g.scope_kind = 'region' AND g.scope_id = r.id)
                     OR (g.scope_kind = 'cluster' AND g.scope_id = cl.id)
                     OR (g.scope_kind = 'location' AND g.scope_id = l.id)
                     OR (g.scope_kind = 'recorder' AND g.scope_id = ra.id)
                     OR (g.scope_kind = 'camera' AND g.scope_id = c.id)))
$$;

-- Locations visible as rows because of any non-administrative grant: whole coverage, plus the location of a recorder, camera or
-- asset grant. Archived locations are never visible to signed-in people (administration reads them with the service role).
CREATE FUNCTION public.any_grant_location_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE area <> 'admin'
  )
  SELECT l.id FROM public.locations l JOIN g ON g.org_id = l.org_id AND g.scope_kind = 'organization' WHERE l.archived_at IS NULL
  UNION
  SELECT x FROM public.access_location_expand(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = (SELECT auth.uid())),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'region'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'cluster'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location')) AS x
  UNION
  SELECT r.location_id FROM public.recorders r
  JOIN g ON g.org_id = r.org_id AND g.scope_kind = 'recorder' AND g.scope_id = r.id
  JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  JOIN public.locations l ON l.id = r.location_id AND l.archived_at IS NULL
  UNION
  SELECT c.location_id FROM public.cameras c
  JOIN g ON g.org_id = c.org_id AND g.scope_kind = 'camera' AND g.scope_id = c.id
  JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
  WHERE c.archived_at IS NULL
  UNION
  SELECT a.location_id FROM public.assets a
  JOIN g ON g.org_id = a.org_id AND g.scope_kind = 'asset' AND g.scope_id = a.id
  JOIN public.locations l ON l.id = a.location_id AND l.archived_at IS NULL
  WHERE a.archived_at IS NULL
$$;

-- Navigation rows (names only): the clusters and regions above the visible locations, and granted / organisation-wide ones.
CREATE FUNCTION public.any_grant_cluster_ids() RETURNS SETOF uuid
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

CREATE FUNCTION public.any_grant_region_ids() RETURNS SETOF uuid
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

-- ── Reporting only (treat every session as MFA-verified, may ignore the person's status; never for authorisation) ──────────
CREATE OR REPLACE FUNCTION public.report_effective_camera_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;
CREATE FUNCTION public.report_effective_asset_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_assets_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;
COMMENT ON FUNCTION public.report_effective_asset_ids(uuid, text, timestamptz, boolean) IS 'REPORTING ONLY: treats every session as MFA-verified and can ignore the person''s status. Never use for authorisation.';

-- The caller's summary (P2-2), now with the region, cluster and recorder scopes and, so the app never recomputes the hierarchy,
-- the locations covered whole (covered_location_ids) and the cameras currently on granted recorders (recorder_camera_ids).
CREATE FUNCTION public.my_access_summary()
RETURNS TABLE (capability text, organization_wide boolean, location_ids uuid[], camera_ids uuid[], asset_ids uuid[],
               region_ids uuid[], cluster_ids uuid[], recorder_ids uuid[], covered_location_ids uuid[], recorder_camera_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2())
  ),
  s AS (
    SELECT g.capability, min(g.area) AS area, min(g.org_id::text)::uuid AS org_id,
           bool_or(g.scope_kind = 'organization') AS org_wide,
           coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'location'), '{}'::uuid[]) AS locs,
           coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'camera'), '{}'::uuid[]) AS cams,
           coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'asset'), '{}'::uuid[]) AS assets,
           coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'region'), '{}'::uuid[]) AS regions,
           coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'cluster'), '{}'::uuid[]) AS clusters,
           coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'recorder'), '{}'::uuid[]) AS recorders
    FROM g GROUP BY g.capability
  )
  SELECT s.capability, s.org_wide, s.locs, s.cams, s.assets, s.regions, s.clusters, s.recorders,
         CASE WHEN s.org_wide THEN '{}'::uuid[]
              ELSE ARRAY(SELECT x FROM public.access_location_expand(s.org_id, s.regions, s.clusters, s.locs) AS x ORDER BY 1) END,
         CASE WHEN s.org_wide OR s.area <> 'cctv' OR cardinality(s.recorders) = 0 THEN '{}'::uuid[]
              ELSE ARRAY(SELECT c.id FROM public.cameras c JOIN public.assets a ON a.id = c.recorder_id AND a.archived_at IS NULL
                         JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
                         WHERE c.recorder_id = ANY (s.recorders) AND c.archived_at IS NULL ORDER BY 1) END
  FROM s
  ORDER BY s.capability
$$;
COMMENT ON FUNCTION public.my_access_summary() IS 'The caller''s effective capabilities now, with their granted scopes and the covered locations (P2-2, P2-5a). For display decisions and page gates; per-resource checks use has_capability_for / cameras_with_capability.';

-- People list summary (P2-3), per kind.
CREATE FUNCTION public.access_grant_summary(p_org uuid)
RETURNS TABLE (user_id uuid, capability text, organization_wide boolean, locations integer, cameras integer, assets integer,
               next_expiry timestamptz, regions integer, clusters integer, recorders integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.user_id, g.capability,
         bool_or(g.scope_kind = 'organization'),
         (count(*) FILTER (WHERE g.scope_kind = 'location'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'camera'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'asset'))::integer,
         min(g.valid_until),
         (count(*) FILTER (WHERE g.scope_kind = 'region'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'cluster'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'recorder'))::integer
  FROM public.access_grants g
  WHERE g.org_id = p_org AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
  GROUP BY g.user_id, g.capability
  ORDER BY g.user_id, g.capability
$$;

-- ── Grant rules (0009 / 0017 bodies, extended) ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.access_check_spec(p_org uuid, p_spec jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
  -- The target must exist in the organisation and not be archived (an archived node grants nothing, so it cannot be granted).
  v_found := EXISTS (SELECT 1 FROM public.access_ancestry(p_org, v_kind, v_scope));
  IF NOT v_found THEN
    RAISE EXCEPTION 'scope outside organisation' USING ERRCODE = '22023';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.access_check_grantor(p_org uuid, p_actor uuid, p_user uuid, p_spec jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_until timestamptz := NULLIF(p_spec ->> 'valid_until', '')::timestamptz;
  v_role public.user_role;
  v_target public.user_role;
  v_c public.capabilities%ROWTYPE;
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
  -- Ruling C-1: a region or cluster scope (like any scope) only from somebody holding the right at an equal or wider scope:
  -- organization > region > cluster > location > recorder > camera / asset (access_scope_covers), now and for at least as long.
  IF NOT EXISTS (
    SELECT 1 FROM public.access_grants g
    WHERE g.user_id = p_actor AND g.org_id = p_org AND g.capability = v_cap AND g.revoked_at IS NULL
      AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
      AND (g.valid_until IS NULL OR (v_until IS NOT NULL AND g.valid_until >= v_until))
      AND (g.scope_kind = 'organization'
           OR (g.scope_kind = v_kind AND g.scope_id = v_scope)
           OR public.access_scope_covers(p_org, g.scope_kind, g.scope_id, v_kind, v_scope))
  ) THEN
    RAISE EXCEPTION '% at this scope or for this long is not held by the acting person', v_cap USING ERRCODE = '42501';
  END IF;
END
$$;

-- Labelled items a set of grant descriptions gives for one capability (feeds preview_access_change, whose body is unchanged).
CREATE OR REPLACE FUNCTION public.access_items(p_org uuid, p_cap text, p_specs jsonb, p_at timestamptz) RETURNS TABLE (item_id uuid, label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT e.value ->> 'scope_kind' AS kind, NULLIF(e.value ->> 'scope_id', '')::uuid AS sid
    FROM jsonb_array_elements(p_specs) AS e
    WHERE e.value ->> 'capability' = p_cap
      AND coalesce(NULLIF(e.value ->> 'valid_from', '')::timestamptz, '-infinity') <= p_at
      AND coalesce(NULLIF(e.value ->> 'valid_until', '')::timestamptz, 'infinity') > p_at
  ),
  a AS (SELECT c.area FROM public.capabilities c WHERE c.key = p_cap),
  org_wide AS (SELECT EXISTS (SELECT 1 FROM g WHERE g.kind = 'organization') AS yes)
  SELECT c.id, l.code || ' · ' || c.name
  FROM public.access_camera_set(p_org, (SELECT yes FROM org_wide), ARRAY(SELECT sid FROM g WHERE kind = 'region'),
         ARRAY(SELECT sid FROM g WHERE kind = 'cluster'), ARRAY(SELECT sid FROM g WHERE kind = 'location'),
         ARRAY(SELECT sid FROM g WHERE kind = 'recorder'), ARRAY(SELECT sid FROM g WHERE kind = 'camera')) AS x
  JOIN public.cameras c ON c.id = x JOIN public.locations l ON l.id = c.location_id
  WHERE (SELECT area FROM a) = 'cctv'
  UNION ALL
  SELECT d.id, d.name || coalesce(' · ' || l.code, '')
  FROM public.access_asset_set(p_org, (SELECT yes FROM org_wide), ARRAY(SELECT sid FROM g WHERE kind = 'region'),
         ARRAY(SELECT sid FROM g WHERE kind = 'cluster'), ARRAY(SELECT sid FROM g WHERE kind = 'location'),
         ARRAY(SELECT sid FROM g WHERE kind = 'recorder'), ARRAY(SELECT sid FROM g WHERE kind = 'asset')) AS x
  JOIN public.assets d ON d.id = x LEFT JOIN public.locations l ON l.id = d.location_id
  WHERE (SELECT area FROM a) = 'it'
  UNION ALL
  SELECT l.id, l.code || ' · ' || l.name
  FROM public.access_location_set(p_org, (SELECT yes FROM org_wide), ARRAY(SELECT sid FROM g WHERE kind = 'region'),
         ARRAY(SELECT sid FROM g WHERE kind = 'cluster'), ARRAY(SELECT sid FROM g WHERE kind = 'location')) AS x
  JOIN public.locations l ON l.id = x
  WHERE (SELECT area FROM a) = 'wifi'
  UNION ALL
  SELECT d.id, d.name FROM public.assets d
  WHERE (SELECT area FROM a) = 'wifi' AND d.org_id = p_org AND d.archived_at IS NULL AND d.id IN (SELECT sid FROM g WHERE kind = 'asset')
  UNION ALL
  SELECT o.id, 'Whole organisation' FROM public.organizations o
  WHERE (SELECT area FROM a) = 'admin' AND o.id = p_org AND (SELECT yes FROM org_wide)
$$;

-- ── Status reasons (0014), with the recorder branch ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.status_reasons(p_type text, p_ids uuid[]) RETURNS TABLE (target_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
$$;
COMMENT ON FUNCTION public.status_reasons(text, uuid[]) IS 'Why targets are offline, for the caller (P2-2 fix I-1): the checker''s text only with the IT view; camera-terms reasons otherwise.';

-- Cameras among p_ids the caller may see whose recorder has monitoring switched off (shown as "Switched off", never as offline).
CREATE FUNCTION public.cameras_monitoring_off(p_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id FROM public.cameras c JOIN public.recorders r ON r.id = c.recorder_id
  WHERE c.id = ANY (p_ids) AND NOT r.monitoring_enabled AND c.id IN (SELECT public.any_cctv_camera_ids())
$$;

-- ═══ 9. Legacy evaluators and the P2-1 migration (bodies of 0009/0012 with the new names; owner/test only) ═══════════════════
-- An archived row counts as deleted (the old model deleted what is now archived), so old and new sets stay comparable.
CREATE OR REPLACE FUNCTION public.access_legacy_store_grants(p_user uuid, p_ignore_status boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id FROM public.locations s
  JOIN public.profiles p ON p.id = p_user AND p.org_id = s.org_id AND (p_ignore_status OR (p.is_active AND NOT p.must_reset_password))
  WHERE s.archived_at IS NULL
    AND (s.id IN (SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = p_user)
         OR s.zone IN (SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = p_user)
         OR s.id = p.location_id)
$$;

CREATE OR REPLACE FUNCTION public.access_legacy_camera_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  , c AS (
    SELECT c.id, c.org_id, c.location_id FROM public.cameras c
    JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
    WHERE c.archived_at IS NULL
  )
  SELECT c.id FROM c JOIN p ON p.org_id = c.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT a.camera_id FROM public.user_camera_access a JOIN c ON c.id = a.camera_id JOIN p ON p.org_id = c.org_id
  WHERE a.user_id = p_user
  UNION
  SELECT c.id FROM c JOIN p ON p.org_id = c.org_id
  WHERE c.location_id IN (SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x)
    AND c.location_id NOT IN (SELECT c2.location_id FROM c AS c2 JOIN public.user_camera_access a ON a.camera_id = c2.id WHERE a.user_id = p_user)
$$;

-- The old devices: every asset except the NVR assets the location migration made (they were the store's NVR, not a device; an
-- adopted nvr device keeps counting, it was a device before).
CREATE OR REPLACE FUNCTION public.access_legacy_device_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  ),
  d AS (
    SELECT a.id, a.org_id, a.location_id FROM public.assets a
    LEFT JOIN public.locations l ON l.id = a.location_id
    WHERE a.archived_at IS NULL AND (a.location_id IS NULL OR l.archived_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = a.id AND r.created_asset)
  )
  SELECT d.id FROM d JOIN p ON p.org_id = d.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT d.id FROM d JOIN p ON p.org_id = d.org_id
  WHERE d.location_id IN (SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x)
$$;

CREATE OR REPLACE FUNCTION public.access_legacy_store_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  SELECT s.id FROM public.locations s JOIN p ON p.org_id = s.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner') AND s.archived_at IS NULL
  UNION
  SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x
  UNION
  SELECT c.location_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id AND c.archived_at IS NULL
  JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
  JOIN p ON p.org_id = c.org_id
  WHERE a.user_id = p_user
$$;

CREATE OR REPLACE FUNCTION public.access_migrate_legacy(p_run uuid, p_users uuid[] DEFAULT NULL, p_force boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
    SELECT p.id, p.org_id, p.role, p.location_id AS home, p.is_active, p.must_reset_password FROM public.profiles p
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
    v_cams := ARRAY(SELECT a.camera_id FROM public.user_camera_access a
                    JOIN public.cameras c ON c.id = a.camera_id AND c.org_id = v_person.org_id AND c.archived_at IS NULL
                    JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
                    WHERE a.user_id = v_person.id ORDER BY a.camera_id);
    v_narrowed := ARRAY(SELECT DISTINCT c.location_id FROM public.cameras c WHERE c.id = ANY (v_cams));

    FOR v_store IN
      SELECT s.id, s.code,
             CASE WHEN s.id = ANY (v_stores) THEN 'migrated:store' WHEN s.zone = ANY (v_zones) THEN 'migrated:zone' ELSE 'migrated:home' END AS source
      FROM public.locations s
      WHERE s.org_id = v_person.org_id AND s.archived_at IS NULL
        AND (s.id = ANY (v_stores) OR s.zone = ANY (v_zones) OR s.id = v_person.home)
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
        '{}'::uuid[], '{}'::uuid[],
        ARRAY(SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'location'),
        '{}'::uuid[],
        ARRAY(SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'camera')) AS x ORDER BY 1);
      v_old := ARRAY(SELECT x FROM public.access_legacy_camera_ids(v_person.id, true) AS x ORDER BY 1);
      IF v_new IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'P2-1 migration check failed: % cameras would change for person %', v_cap, v_person.id;
      END IF;
    END LOOP;
    v_new := ARRAY(
      SELECT s.id FROM public.locations s WHERE s.org_id = v_person.org_id
        AND EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'organization')
      UNION
      SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'location'
      UNION
      SELECT c.location_id FROM public.access_grants g JOIN public.cameras c ON c.id = g.scope_id
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

    IF v_person.home IS NOT NULL THEN
      SELECT s.code INTO v_home_code FROM public.locations s WHERE s.id = v_person.home;
      IF v_person.home = ANY (v_narrowed) THEN
        v_notes := v_notes || format('Home store %s had camera grants inside it, so only those cameras were kept (as before).', v_home_code);
      ELSIF NOT (v_person.home = ANY (v_stores))
            AND NOT EXISTS (SELECT 1 FROM public.locations s WHERE s.id = v_person.home AND s.zone = ANY (v_zones)) THEN
        v_notes := v_notes || format('Home store %s was a hidden grant: migrated as explicit live and playback grants, flagged for review (D-2a). The home store now grants nothing by itself (AC-7).', v_home_code);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_zones) AS z(zone)
               WHERE NOT EXISTS (SELECT 1 FROM public.locations s WHERE s.org_id = v_person.org_id AND s.zone = z.zone)) THEN
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
        'home_store_id', v_person.home, 'stores', to_jsonb(v_stores), 'zones', to_jsonb(v_zones), 'cameras', to_jsonb(v_cams),
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

-- ═══ 10. Archive guard, purge, endpoints, mappings, recorders (triggers and their functions) ═══════════════════════════════════
-- Hard delete is refused: archive instead (history is never erased). Only the purge of a test or demo organisation deletes.
CREATE FUNCTION public.inventory_refuse_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_setting('drishti.purge_org', true) = OLD.org_id::text THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% rows are archived, never deleted (history is kept)', TG_TABLE_NAME USING ERRCODE = 'DR003';
END
$$;
CREATE TRIGGER regions_keep BEFORE DELETE ON public.regions FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();
CREATE TRIGGER clusters_keep BEFORE DELETE ON public.clusters FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();
CREATE TRIGGER locations_keep BEFORE DELETE ON public.locations FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();
CREATE TRIGGER assets_keep BEFORE DELETE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();
CREATE TRIGGER recorders_keep BEFORE DELETE ON public.recorders FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();
CREATE TRIGGER cameras_keep BEFORE DELETE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();
CREATE TRIGGER camera_channel_mappings_keep BEFORE DELETE ON public.camera_channel_mappings FOR EACH ROW EXECUTE FUNCTION public.inventory_refuse_delete();

-- The organisation's global address space, made with the organisation.
CREATE FUNCTION public.organizations_global_space() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.address_spaces (org_id, name, kind) VALUES (NEW.id, 'Company network', 'global') ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
CREATE TRIGGER organizations_global_space AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.organizations_global_space();
INSERT INTO public.address_spaces (org_id, name, kind) SELECT o.id, 'Company network', 'global' FROM public.organizations o;

CREATE FUNCTION public.address_space_global(p_org uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id FROM public.address_spaces s WHERE s.org_id = p_org AND s.kind = 'global'
$$;

-- An asset's endpoints follow its address: the management endpoint (ip, tcp_port) and, for a recorder, its RTSP endpoint (ip,
-- rtsp_port), in the asset's address space (default: the organisation's global space). A clash raises 23505 (AL-6).
CREATE FUNCTION public.asset_sync_endpoints(p_asset uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a record;
  v_space uuid;
  v_rtsp integer;
  v_want record;
BEGIN
  SELECT x.id, x.org_id, x.ip, x.tcp_port, x.address_space_id, x.archived_at INTO a FROM public.assets x WHERE x.id = p_asset;
  IF NOT FOUND THEN RETURN; END IF;
  v_space := coalesce(a.address_space_id, public.address_space_global(a.org_id));
  SELECT r.rtsp_port INTO v_rtsp FROM public.recorders r WHERE r.id = p_asset;
  FOR v_want IN SELECT * FROM (VALUES ('management', a.tcp_port), ('rtsp', v_rtsp)) AS w(purpose, port) LOOP
    IF a.ip IS NULL OR a.archived_at IS NOT NULL OR (v_want.purpose = 'rtsp' AND v_rtsp IS NULL) THEN
      UPDATE public.asset_endpoints e SET retired_at = now() WHERE e.asset_id = p_asset AND e.purpose = v_want.purpose AND e.retired_at IS NULL;
    ELSIF EXISTS (SELECT 1 FROM public.asset_endpoints e WHERE e.asset_id = p_asset AND e.purpose = v_want.purpose AND e.retired_at IS NULL) THEN
      UPDATE public.asset_endpoints e SET host = a.ip, port = v_want.port, address_space_id = v_space
      WHERE e.asset_id = p_asset AND e.purpose = v_want.purpose AND e.retired_at IS NULL
        AND (e.host, e.port, e.address_space_id) IS DISTINCT FROM (a.ip, v_want.port, v_space);
    ELSE
      INSERT INTO public.asset_endpoints (org_id, asset_id, address_space_id, host, port, purpose)
      VALUES (a.org_id, p_asset, v_space, a.ip, v_want.port, v_want.purpose);
    END IF;
  END LOOP;
END
$$;

CREATE FUNCTION public.assets_after_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.asset_sync_endpoints(NEW.id);
  RETURN NULL;
END
$$;
CREATE TRIGGER assets_endpoints AFTER INSERT OR UPDATE OF ip, tcp_port, address_space_id, archived_at ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assets_after_write();

-- is_recorder is kept by the recorders triggers only; a recorder's asset stays of type nvr; an attached asset sits at its NVR's location.
CREATE FUNCTION public.assets_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.is_recorder IS DISTINCT FROM OLD.is_recorder AND coalesce(current_setting('drishti.recorder_sync', true), '') <> 'on' THEN
    RAISE EXCEPTION 'is_recorder follows the recorders table' USING ERRCODE = '42501';
  END IF;
  IF NEW.type IS DISTINCT FROM OLD.type AND EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = NEW.id) THEN
    RAISE EXCEPTION 'a recorder''s asset stays of type nvr' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assets_guard BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.assets_before_update();

CREATE FUNCTION public.assets_attached_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.attached_recorder_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.recorders r WHERE r.id = NEW.attached_recorder_id AND r.location_id IS NOT DISTINCT FROM NEW.location_id) THEN
    RAISE EXCEPTION 'an asset can only be attached to an NVR at its own location' USING ERRCODE = 'DR006';
  END IF;
  IF NEW.attached_recorder_id = NEW.id THEN RAISE EXCEPTION 'an NVR is not attached to itself' USING ERRCODE = '22023'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assets_attached BEFORE INSERT OR UPDATE OF attached_recorder_id, location_id ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assets_attached_check();

-- Switching an asset off stops its monitoring (device, and recorder for an NVR): open outages closed, current state forgotten.
CREATE FUNCTION public.monitor_stop_asset() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'device', ARRAY[NEW.id]);
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY[NEW.id]);
  RETURN NEW;
END
$$;
CREATE TRIGGER assets_stop AFTER UPDATE OF enabled ON public.assets FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled)
  EXECUTE FUNCTION public.monitor_stop_asset();

-- Switching a location off stops its recorders and cameras (and any leftover legacy 'nvr' row).
CREATE FUNCTION public.monitor_stop_location() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY(SELECT r.id FROM public.recorders r WHERE r.location_id = NEW.id));
  PERFORM public.monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT c.id FROM public.cameras c WHERE c.location_id = NEW.id));
  PERFORM public.monitor_stop_targets(NEW.org_id, 'nvr', ARRAY[NEW.id]);
  RETURN NEW;
END
$$;
CREATE TRIGGER locations_stop AFTER UPDATE OF is_active ON public.locations FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active)
  EXECUTE FUNCTION public.monitor_stop_location();

CREATE FUNCTION public.recorders_before_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assets a WHERE a.id = NEW.id AND a.type = 'nvr') THEN
    RAISE EXCEPTION 'a recorder is an asset of type nvr' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.location_id IS DISTINCT FROM OLD.location_id
     AND EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = NEW.id AND m.valid_to IS NULL) THEN
    RAISE EXCEPTION 'a recorder with cameras cannot move to another location' USING ERRCODE = 'DR006';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.secret_id IS DISTINCT FROM OLD.secret_id AND coalesce(current_setting('drishti.vault_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the recorder secret is set through recorder_store_credential only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.secret_id IS NOT NULL AND coalesce(current_setting('drishti.vault_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the recorder secret is set through recorder_store_credential only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER recorders_check BEFORE INSERT OR UPDATE ON public.recorders FOR EACH ROW EXECUTE FUNCTION public.recorders_before_write();

CREATE FUNCTION public.recorders_after_write() RETURNS trigger
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
CREATE TRIGGER recorders_after AFTER INSERT OR UPDATE OR DELETE ON public.recorders FOR EACH ROW EXECUTE FUNCTION public.recorders_after_write();

-- Monitoring switched off: the recorder and its cameras stop being monitored (outages closed, state forgotten), like deactivation.
CREATE FUNCTION public.recorder_monitoring_stop() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.monitor_stop_targets(NEW.org_id, 'recorder', ARRAY[NEW.id]);
  PERFORM public.monitor_stop_targets(NEW.org_id, 'camera', ARRAY(SELECT c.id FROM public.cameras c WHERE c.recorder_id = NEW.id));
  RETURN NEW;
END
$$;
CREATE TRIGGER recorders_monitoring_off AFTER UPDATE OF monitoring_enabled ON public.recorders FOR EACH ROW
  WHEN (OLD.monitoring_enabled AND NOT NEW.monitoring_enabled) EXECUTE FUNCTION public.recorder_monitoring_stop();

-- Mappings: append-only history (only valid_to may be set, once); the recorder must be at the camera's location; the camera's
-- cache columns (recorder_id, channel) always equal the active mapping.
CREATE FUNCTION public.mappings_before_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.org_id, NEW.camera_id, NEW.recorder_id, NEW.channel, NEW.valid_from, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.camera_id, OLD.recorder_id, OLD.channel, OLD.valid_from, OLD.created_by, OLD.created_at)
       OR OLD.valid_to IS NOT NULL THEN
      RAISE EXCEPTION 'a channel mapping is history: it can only be closed, once' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('drishti.mapping_sync', true), '') <> 'on' AND NOT EXISTS (
       SELECT 1 FROM public.cameras c JOIN public.recorders r ON r.id = NEW.recorder_id
       WHERE c.id = NEW.camera_id AND r.location_id = c.location_id) THEN
    RAISE EXCEPTION 'a camera can only be mapped to a recorder at its own location' USING ERRCODE = 'DR006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mappings_check BEFORE INSERT OR UPDATE ON public.camera_channel_mappings FOR EACH ROW EXECUTE FUNCTION public.mappings_before_write();

CREATE FUNCTION public.mappings_after_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  m record;
BEGIN
  IF coalesce(current_setting('drishti.mapping_sync', true), '') = 'on' THEN RETURN NULL; END IF;
  SELECT x.recorder_id, x.channel INTO m FROM public.camera_channel_mappings x WHERE x.camera_id = NEW.camera_id AND x.valid_to IS NULL;
  PERFORM set_config('drishti.mapping_sync', 'on', true);
  IF FOUND THEN
    UPDATE public.cameras SET recorder_id = m.recorder_id, channel = m.channel
    WHERE id = NEW.camera_id AND (recorder_id, channel) IS DISTINCT FROM (m.recorder_id, m.channel);
  ELSE
    UPDATE public.cameras SET recorder_id = NULL WHERE id = NEW.camera_id AND recorder_id IS NOT NULL;
  END IF;
  PERFORM set_config('drishti.mapping_sync', '', true);
  RETURN NULL;
END
$$;
CREATE TRIGGER mappings_sync AFTER INSERT OR UPDATE ON public.camera_channel_mappings FOR EACH ROW EXECUTE FUNCTION public.mappings_after_write();

-- The location's primary recorder: the first one created that is not archived (the legacy columns and nvr_* wrappers refer to it).
CREATE FUNCTION public.recorder_primary_of(p_location uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.location_id = p_location ORDER BY r.created_at, r.id LIMIT 1
$$;

-- A camera written with a location and a channel (the old way) is mapped to recorder_id, or else to the location's primary recorder.
CREATE FUNCTION public.cameras_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec uuid := coalesce(NEW.recorder_id, public.recorder_primary_of(NEW.location_id));
BEGIN
  IF v_rec IS NOT NULL AND NEW.archived_at IS NULL THEN
    INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
    VALUES (NEW.org_id, NEW.id, v_rec, NEW.channel, NEW.created_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER cameras_map AFTER INSERT ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.cameras_after_insert();

-- A direct change of a camera's recorder or channel is a remap (old mapping closed, new one opened); a location change must keep
-- the active recorder at the camera's location.
CREATE FUNCTION public.cameras_before_update() RETURNS trigger
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
CREATE TRIGGER cameras_remap BEFORE UPDATE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.cameras_before_update();

-- ═══ 11. Monitoring: recorder targets; history kept (the old delete triggers are gone) ═══════════════════════════════════════
ALTER TABLE public.check_state DROP CONSTRAINT check_state_target_type_check;
ALTER TABLE public.check_state ADD CONSTRAINT check_state_target_type_check CHECK (target_type IN ('camera', 'device', 'recorder', 'nvr'));
ALTER TABLE public.outages DROP CONSTRAINT outages_target_type_check;
ALTER TABLE public.outages ADD CONSTRAINT outages_target_type_check CHECK (target_type IN ('camera', 'device', 'recorder', 'nvr'));
COMMENT ON COLUMN public.check_state.target_type IS 'camera | device (an asset) | recorder (an NVR, id = recorders.id). ''nvr'' (a location id) only during the P2-5a seam; re-keyed by 20261021000021 and removed by the P2-5b contract migration.';

-- 0006 body with the gate per target type, search_path '' and the seam alias ('nvr' + location id → the primary recorder).
-- Signature unchanged (P2-7 appends the fencing token).
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

-- ═══ 12. Recorder credentials (vault name recorder:<id>) and the seam wrappers ══════════════════════════════════════════════
CREATE FUNCTION public.recorder_store_credential(p_recorder uuid, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN RAISE EXCEPTION 'empty secret' USING ERRCODE = '22023'; END IF;
  SELECT r.secret_id INTO v_existing FROM public.recorders r WHERE r.id = p_recorder FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown recorder' USING ERRCODE = 'P0002'; END IF;
  IF v_existing IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = v_existing) THEN
    v_existing := NULL; -- a dangling pointer: make a new secret
  END IF;
  PERFORM set_config('drishti.vault_write', 'on', true);
  IF v_existing IS NULL THEN
    DELETE FROM vault.secrets WHERE name = 'recorder:' || p_recorder::text;
    v_id := vault.create_secret(p_secret, 'recorder:' || p_recorder::text, 'Recorder login');
    UPDATE public.recorders SET secret_id = v_id WHERE id = p_recorder;
  ELSE
    PERFORM vault.update_secret(v_existing, p_secret);
    v_id := v_existing;
  END IF;
  PERFORM set_config('drishti.vault_write', '', true);
  RETURN v_id;
END
$$;

CREATE FUNCTION public.recorder_read_credential(p_recorder uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds
  WHERE ds.id = (SELECT r.secret_id FROM public.recorders r WHERE r.id = p_recorder)
$$;

CREATE FUNCTION public.recorder_delete_credential(p_recorder uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secret uuid;
BEGIN
  SELECT r.secret_id INTO v_secret FROM public.recorders r WHERE r.id = p_recorder FOR UPDATE;
  IF v_secret IS NOT NULL THEN
    PERFORM set_config('drishti.vault_write', 'on', true);
    UPDATE public.recorders SET secret_id = NULL WHERE id = p_recorder;
    PERFORM set_config('drishti.vault_write', '', true);
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;
END
$$;

-- Whether a login is saved, and under which vault name; never the value.
CREATE FUNCTION public.recorder_credential_status(p_org uuid, p_recorder uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('set', s.id IS NOT NULL, 'name', s.name)
  FROM public.recorders r LEFT JOIN vault.secrets s ON s.id = r.secret_id
  WHERE r.id = p_recorder AND r.org_id = p_org
$$;

-- Seam (D5-7): the location's legacy NVR columns → its primary recorder (created on first write; an nvr-typed asset at the same
-- address at this location, or without a location, is adopted instead of making a second identity for the same box). A clash with
-- an address already used in the global space moves the recorder into the location's own address space (D5-8; reported by M4).
CREATE FUNCTION public.recorder_ensure_primary(p_location uuid, OUT recorder_id uuid, OUT created boolean, OUT merged boolean, OUT conflict boolean)
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

CREATE FUNCTION public.locations_legacy_seam() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
$$;
CREATE TRIGGER locations_seam AFTER INSERT OR UPDATE OF nvr_ip, rtsp_port, http_port, nvr_username, expected_channels ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.locations_legacy_seam();

-- nvr_*_credential(p_store): thin wrappers over the recorder functions, keyed by the location's primary recorder (D5-7).
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

-- ═══ 13. Administration: mappings, archive/restore, moves, monitoring switch, purge, proposals ═════════════════════════════════
CREATE FUNCTION public.camera_remap(p_org uuid, p_camera uuid, p_recorder uuid, p_channel integer, p_at timestamptz DEFAULT now(), p_actor uuid DEFAULT NULL) RETURNS uuid
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

-- Archive (history kept, grants kept, access ends because archived nodes grant nothing) and restore.
-- camera: switched off, mapping closed. asset: switched off, endpoints retired; a recorder only when no camera is mapped to it (DR004).
-- location: its cameras, recorders and assets too. cluster / region: the node only (its children stay; the node's grants stop counting).
CREATE FUNCTION public.inventory_archive(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
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

CREATE FUNCTION public.inventory_restore(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
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

-- Hierarchy moves take effect at once (expansion is computed at read time). Everybody holding a region or cluster grant at the old or
-- the new parent gets their access version bumped (open editors must reload; P2-4 revalidation signal) and one audit row lists them.
CREATE FUNCTION public.inventory_hierarchy_moved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_clusters uuid[];
  v_regions uuid[];
  v_people uuid[];
  v_p uuid;
  v_kind text := CASE TG_TABLE_NAME WHEN 'locations' THEN 'location' ELSE 'cluster' END;
  v_from uuid;
  v_to uuid;
BEGIN
  IF TG_TABLE_NAME = 'locations' THEN
    v_from := OLD.cluster_id; v_to := NEW.cluster_id;
    v_clusters := array_remove(ARRAY[OLD.cluster_id, NEW.cluster_id], NULL);
    v_regions := ARRAY(SELECT c.region_id FROM public.clusters c WHERE c.id = ANY (v_clusters) AND c.region_id IS NOT NULL);
  ELSE
    v_from := OLD.region_id; v_to := NEW.region_id;
    v_clusters := '{}';
    v_regions := array_remove(ARRAY[OLD.region_id, NEW.region_id], NULL);
  END IF;
  v_people := ARRAY(
    SELECT DISTINCT g.user_id FROM public.access_grants g
    WHERE g.org_id = NEW.org_id AND g.revoked_at IS NULL AND (g.valid_until IS NULL OR g.valid_until > now())
      AND ((g.scope_kind = 'cluster' AND g.scope_id = ANY (v_clusters)) OR (g.scope_kind = 'region' AND g.scope_id = ANY (v_regions)))
    ORDER BY 1);
  FOREACH v_p IN ARRAY v_people LOOP PERFORM public.access_bump_version(v_p); END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (NEW.org_id, NULLIF(current_setting('drishti.actor', true), '')::uuid, 'hierarchy_moved', v_kind, NEW.id,
          jsonb_build_object('from', v_from, 'to', v_to, 'affected_people', to_jsonb(v_people), 'count', cardinality(v_people)));
  RETURN NULL;
END
$$;
CREATE TRIGGER locations_moved AFTER UPDATE OF cluster_id ON public.locations FOR EACH ROW
  WHEN (OLD.cluster_id IS DISTINCT FROM NEW.cluster_id) EXECUTE FUNCTION public.inventory_hierarchy_moved();
CREATE TRIGGER clusters_moved AFTER UPDATE OF region_id ON public.clusters FOR EACH ROW
  WHEN (OLD.region_id IS DISTINCT FROM NEW.region_id) EXECUTE FUNCTION public.inventory_hierarchy_moved();

-- Archiving or restoring a region or cluster changes its holders' access: bump their versions too.
CREATE FUNCTION public.inventory_node_archived() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_p uuid;
  v_kind text := CASE TG_TABLE_NAME WHEN 'regions' THEN 'region' ELSE 'cluster' END;
BEGIN
  FOR v_p IN SELECT DISTINCT g.user_id FROM public.access_grants g
             WHERE g.org_id = NEW.org_id AND g.revoked_at IS NULL AND g.scope_kind = v_kind AND g.scope_id = NEW.id LOOP
    PERFORM public.access_bump_version(v_p);
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER regions_archived AFTER UPDATE OF archived_at ON public.regions FOR EACH ROW
  WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at) EXECUTE FUNCTION public.inventory_node_archived();
CREATE TRIGGER clusters_archived AFTER UPDATE OF archived_at ON public.clusters FOR EACH ROW
  WHEN (OLD.archived_at IS DISTINCT FROM NEW.archived_at) EXECUTE FUNCTION public.inventory_node_archived();

CREATE FUNCTION public.inventory_move_location(p_org uuid, p_location uuid, p_cluster uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old uuid;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT l.cluster_id INTO v_old FROM public.locations l WHERE l.id = p_location AND l.org_id = p_org AND l.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
  IF p_cluster IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.id = p_cluster AND c.org_id = p_org AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  UPDATE public.locations SET cluster_id = p_cluster WHERE id = p_location;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('from', v_old, 'to', p_cluster);
END
$$;

CREATE FUNCTION public.inventory_move_cluster(p_org uuid, p_cluster uuid, p_region uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old uuid;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT c.region_id INTO v_old FROM public.clusters c WHERE c.id = p_cluster AND c.org_id = p_org AND c.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
  IF p_region IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id = p_region AND r.org_id = p_org AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'region not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  UPDATE public.clusters SET region_id = p_region WHERE id = p_cluster;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('from', v_old, 'to', p_region);
END
$$;

-- Before saving a move: per person holding a region or cluster grant at the old or new parent, and per CCTV capability, how many
-- cameras of the moved location(s) they see now and would see after (the same rules as access_camera_set). Writes nothing.
CREATE FUNCTION public.preview_hierarchy_change(p_org uuid, p_kind text, p_id uuid, p_new_parent uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_locs uuid[];
  v_old_cluster uuid;
  v_new_cluster uuid;
  v_old_region uuid;
  v_new_region uuid;
  v_person record;
  v_g record;
  v_now uuid[];
  v_before integer;
  v_after integer;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF p_kind = 'location' THEN
    SELECT l.cluster_id INTO v_old_cluster FROM public.locations l WHERE l.id = p_id AND l.org_id = p_org AND l.archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
    v_locs := ARRAY[p_id];
    v_new_cluster := (SELECT c.id FROM public.clusters c WHERE c.id = p_new_parent AND c.org_id = p_org AND c.archived_at IS NULL);
    v_old_region := (SELECT r.id FROM public.clusters c JOIN public.regions r ON r.id = c.region_id AND r.archived_at IS NULL WHERE c.id = v_old_cluster AND c.archived_at IS NULL);
    v_new_region := (SELECT r.id FROM public.clusters c JOIN public.regions r ON r.id = c.region_id AND r.archived_at IS NULL WHERE c.id = v_new_cluster);
  ELSIF p_kind = 'cluster' THEN
    SELECT c.region_id INTO v_old_region FROM public.clusters c WHERE c.id = p_id AND c.org_id = p_org AND c.archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
    v_locs := ARRAY(SELECT l.id FROM public.locations l WHERE l.cluster_id = p_id AND l.archived_at IS NULL);
    v_old_cluster := p_id;
    v_new_cluster := p_id;
    v_old_region := (SELECT r.id FROM public.regions r WHERE r.id = v_old_region AND r.archived_at IS NULL);
    v_new_region := (SELECT r.id FROM public.regions r WHERE r.id = p_new_parent AND r.org_id = p_org AND r.archived_at IS NULL);
  ELSE
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  FOR v_person IN
    SELECT DISTINCT g.user_id, g.capability FROM public.access_grants g JOIN public.capabilities c ON c.key = g.capability AND c.area = 'cctv'
    WHERE g.org_id = p_org AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
      AND ((g.scope_kind = 'cluster' AND g.scope_id IN (v_old_cluster, v_new_cluster))
           OR (g.scope_kind = 'region' AND g.scope_id IN (v_old_region, v_new_region)))
    ORDER BY 1, 2
  LOOP
    v_now := ARRAY(SELECT x FROM public.access_cameras_for(v_person.user_id, ARRAY[v_person.capability], now(), true, true) AS x);
    SELECT count(*) INTO v_before FROM public.cameras c WHERE c.location_id = ANY (v_locs) AND c.id = ANY (v_now);
    SELECT bool_or(g.scope_kind = 'organization') AS org_wide,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'location'), '{}') AS locs,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'cluster'), '{}') AS clusters,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'region'), '{}') AS regions,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'recorder'), '{}') AS recs,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'camera'), '{}') AS cams
    INTO v_g FROM public.access_grants_of(v_person.user_id, now(), true, true) g WHERE g.capability = v_person.capability;
    SELECT count(*) INTO v_after FROM public.cameras c
    JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
    LEFT JOIN public.assets ra ON ra.id = c.recorder_id AND ra.archived_at IS NULL
    WHERE c.location_id = ANY (v_locs) AND c.archived_at IS NULL
      AND (coalesce(v_g.org_wide, false) OR l.id = ANY (v_g.locs)
           OR (v_new_cluster IS NOT NULL AND v_new_cluster = ANY (v_g.clusters))
           OR (v_new_region IS NOT NULL AND v_new_region = ANY (v_g.regions))
           OR c.id = ANY (v_g.cams) OR ra.id = ANY (v_g.recs));
    v_out := v_out || jsonb_build_array(jsonb_build_object('user_id', v_person.user_id, 'capability', v_person.capability, 'before', v_before, 'after', v_after));
  END LOOP;
  RETURN jsonb_build_object('people', v_out, 'affected_count', (SELECT count(DISTINCT e.value ->> 'user_id') FROM jsonb_array_elements(v_out) AS e),
                            'locations', cardinality(v_locs));
END
$$;

-- Owner addition: switch monitoring of one NVR off or on. Only a super administrator, or an administrator holding admin.inventory
-- for the whole organisation (server tooling may pass no actor); always with a reason; audited.
CREATE FUNCTION public.recorder_set_monitoring(p_org uuid, p_recorder uuid, p_enabled boolean, p_reason text, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_old boolean;
BEGIN
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'on or off?' USING ERRCODE = '22023'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'a reason is required (3 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NOT NULL THEN
    SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
    IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
       OR (v_role <> 'platform_owner' AND NOT EXISTS (
             SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
             WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
      RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory may switch NVR monitoring' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT r.monitoring_enabled INTO v_old FROM public.recorders r WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.recorders SET monitoring_enabled = p_enabled,
         monitoring_disabled_reason = CASE WHEN p_enabled THEN NULL ELSE btrim(p_reason) END,
         monitoring_disabled_at = CASE WHEN p_enabled THEN NULL ELSE now() END,
         monitoring_disabled_by = CASE WHEN p_enabled THEN NULL ELSE p_actor END
  WHERE id = p_recorder;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, CASE WHEN p_enabled THEN 'recorder_monitoring_enabled' ELSE 'recorder_monitoring_disabled' END, 'recorder', p_recorder,
          jsonb_build_object('reason', btrim(p_reason), 'was_enabled', v_old));
  RETURN jsonb_build_object('recorder_id', p_recorder, 'monitoring_enabled', p_enabled, 'was_enabled', v_old);
END
$$;

-- The only way rows of the inventory are deleted: emptying a test or demo organisation (tests, demo reset). Vault secrets of its
-- recorders go too. Refuses every other organisation.
CREATE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
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
COMMENT ON FUNCTION public.inventory_purge_test_org(uuid) IS 'TEST/DEMO CLEAN-UP ONLY: organisations whose slug starts with "test-" or is "demo-sample-data".';

-- Zone/state → cluster/region proposal (ruling C-1: the administrator confirms; nothing is changed here).
CREATE FUNCTION public.inventory_propose_hierarchy(p_org uuid)
RETURNS TABLE (location_id uuid, code text, zone text, state text, proposed_cluster_code text, proposed_region_code text, existing_cluster_id uuid, existing_region_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id, l.code, l.zone, l.state,
         CASE WHEN NULLIF(btrim(l.zone), '') IS NULL THEN NULL ELSE upper(regexp_replace(btrim(l.zone), '[^A-Za-z0-9]+', '-', 'g')) END,
         CASE WHEN NULLIF(btrim(l.state), '') IS NULL THEN NULL ELSE upper(regexp_replace(btrim(l.state), '[^A-Za-z0-9]+', '-', 'g')) END,
         (SELECT c.id FROM public.clusters c WHERE c.org_id = p_org AND c.archived_at IS NULL
            AND c.code = upper(regexp_replace(btrim(coalesce(l.zone, '')), '[^A-Za-z0-9]+', '-', 'g'))),
         (SELECT r.id FROM public.regions r WHERE r.org_id = p_org AND r.archived_at IS NULL
            AND r.code = upper(regexp_replace(btrim(coalesce(l.state, '')), '[^A-Za-z0-9]+', '-', 'g')))
  FROM public.locations l
  WHERE l.org_id = p_org AND l.archived_at IS NULL AND l.cluster_id IS NULL
  ORDER BY l.code
$$;

-- For the migration tests and reports: every person's effective sets per capability (report rules: MFA assumed, status ignored).
CREATE FUNCTION public.inventory_effective_snapshot(p_org uuid, p_at timestamptz DEFAULT now())
RETURNS TABLE (user_id uuid, capability text, cameras uuid[], locations uuid[], assets uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, c.key,
         ARRAY(SELECT x FROM public.access_cameras_for(p.id, ARRAY[c.key], p_at, true, true) AS x ORDER BY 1),
         ARRAY(SELECT x FROM public.access_locations_for(p.id, ARRAY[c.key], p_at, true, true) AS x ORDER BY 1),
         ARRAY(SELECT x FROM public.access_assets_for(p.id, ARRAY[c.key], p_at, true, true) AS x ORDER BY 1)
  FROM public.profiles p CROSS JOIN public.capabilities c
  WHERE p.org_id = p_org
  ORDER BY p.id, c.key
$$;

-- ═══ 14. Row security ═══════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE POLICY locations_select ON public.locations FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.any_grant_location_ids()));
CREATE POLICY assets_select ON public.assets FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.it_view_asset_ids()));
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (
    (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids()))
    OR (target_type = 'device' AND target_id IN (SELECT public.it_view_asset_ids()))
    OR (target_type = 'recorder' AND target_id IN (SELECT public.it_view_recorder_ids()))
    OR (target_type = 'nvr' AND target_id IN (SELECT public.it_view_location_ids()))));
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (
    (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids()))
    OR (target_type = 'device' AND target_id IN (SELECT public.it_view_asset_ids()))
    OR (target_type = 'recorder' AND target_id IN (SELECT public.it_view_recorder_ids()))
    OR (target_type = 'nvr' AND target_id IN (SELECT public.it_view_location_ids()))));

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recorders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camera_channel_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.address_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY regions_select ON public.regions FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.any_grant_region_ids()));
CREATE POLICY clusters_select ON public.clusters FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.any_grant_cluster_ids()));
-- Recorders, mappings and endpoints: the IT view only (a CCTV viewer sees a location's cameras, never its recorders; ruling C-1).
CREATE POLICY recorders_select ON public.recorders FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.it_view_recorder_ids()));
CREATE POLICY camera_channel_mappings_select ON public.camera_channel_mappings FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND recorder_id IN (SELECT public.it_view_recorder_ids()));
CREATE POLICY asset_endpoints_select ON public.asset_endpoints FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND asset_id IN (SELECT public.it_view_asset_ids()));

-- ═══ 15. Views ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Per location (replaces store_status, D5-9). Owner rights with the visibility rules written out (cameras: any CCTV right; recorder
-- figures: the IT view), so no recorder column has to be readable by signed-in people. nvr_status = worst of the location's switched-on
-- recorders (down > not checked yet > unknown > up), nvr_down_since earliest, nvr_checked_at oldest, nvr_stale any stale.
CREATE VIEW public.location_status WITH (security_barrier = true) AS
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
COMMENT ON VIEW public.location_status IS 'Per location the caller may see: camera counts (any CCTV right) and recorder figures (IT view only). nvr_* = worst of the location''s recorders (seam, D5-9).';

CREATE VIEW public.recorder_status WITH (security_barrier = true) AS
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
COMMENT ON VIEW public.recorder_status IS 'Per recorder (IT view): status, or monitoring switched off. Never the vault pointer.';

-- Recorder addresses and login names for the IT view (replaces store_nvr_endpoints). Never the vault pointer.
CREATE VIEW public.recorder_endpoints WITH (security_barrier = true) AS
SELECT r.id AS recorder_id, r.org_id, r.location_id, a.ip AS host, r.http_port, r.rtsp_port, r.username, r.monitoring_enabled
FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
WHERE r.org_id = (SELECT public.current_org_id()) AND r.id IN (SELECT public.it_view_recorder_ids());
COMMENT ON VIEW public.recorder_endpoints IS 'NVR address and login name of the recorders the caller has an IT view of. Never the vault id.';

CREATE VIEW public.camera_endpoints WITH (security_barrier = true) AS
SELECT c.id AS camera_id, c.org_id, c.location_id, c.camera_ip
FROM public.cameras c
WHERE c.org_id = (SELECT public.current_org_id()) AND c.archived_at IS NULL
  AND (c.location_id IN (SELECT public.it_view_location_ids()) OR c.recorder_id IN (SELECT public.it_view_recorder_ids()));
COMMENT ON VIEW public.camera_endpoints IS 'Camera addresses of the locations (or recorders) the caller has an IT view of.';

-- The tree for navigation (C-1). Regions and clusters are optional (owner amendment to R-1): unassigned = "No cluster" in the UI,
-- not an error. Caller's rights (row security of the three tables).
CREATE VIEW public.location_hierarchy WITH (security_invoker = true) AS
SELECT l.id AS location_id, l.org_id, l.code, l.name, l.kind, l.cluster_id, c.code AS cluster_code, c.name AS cluster_name,
       c.region_id, r.code AS region_code, r.name AS region_name, (l.cluster_id IS NULL) AS unassigned
FROM public.locations l
LEFT JOIN public.clusters c ON c.id = l.cluster_id
LEFT JOIN public.regions r ON r.id = c.region_id;

-- ═══ 16. Privileges (default privileges are closed: everything explicit) ═════════════════════════════════════════════════
REVOKE ALL ON public.regions, public.clusters, public.recorders, public.camera_channel_mappings, public.address_spaces, public.asset_endpoints
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.regions, public.clusters, public.recorders, public.camera_channel_mappings,
  public.address_spaces, public.asset_endpoints TO service_role;
GRANT SELECT ON public.regions, public.clusters, public.camera_channel_mappings, public.asset_endpoints TO authenticated;
GRANT SELECT (id, org_id, location_id, http_port, rtsp_port, username, expected_channels, clock_offset_sec, clock_offset_source,
              vendor_capabilities, monitoring_enabled, monitoring_disabled_reason, monitoring_disabled_at, created_at, updated_at)
  ON public.recorders TO authenticated;
-- New location columns readable by signed-in people (never the nvr_* legacy columns, never archived_at: archived rows are invisible).
GRANT SELECT (kind, cluster_id, parent_location_id) ON public.locations TO authenticated;
-- Assets: the whole-table grant becomes a column list (credential_ref, the vault reference name, is not for signed-in people).
REVOKE SELECT ON public.assets FROM authenticated;
GRANT SELECT (id, org_id, location_id, type, name, ip, tcp_port, notes, enabled, created_at, updated_at, address_space_id, is_recorder,
              attached_recorder_id, serial, mac, vendor, model, firmware, role, owner, criticality, lifecycle_state, warranty_until,
              last_inventory_at, management_mode, capability_discovered_at, config_owner, assigned_profile_id)
  ON public.assets TO authenticated;

REVOKE ALL ON public.location_status, public.recorder_status, public.recorder_endpoints, public.camera_endpoints, public.location_hierarchy
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.location_status, public.recorder_status, public.recorder_endpoints, public.camera_endpoints, public.location_hierarchy
  TO authenticated, service_role;

-- Functions: nobody by default; signed-in people get their own questions; the server its tools; internals nobody.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.access_location_expand(uuid, uuid[], uuid[], uuid[])', 'public.access_ancestry(uuid, text, uuid)',
    'public.access_scope_covers(uuid, text, uuid, text, uuid)', 'public.access_target_ancestry(uuid, jsonb)',
    'public.access_camera_set(uuid, boolean, uuid[], uuid[], uuid[], uuid[], uuid[])', 'public.access_asset_set(uuid, boolean, uuid[], uuid[], uuid[], uuid[], uuid[])',
    'public.access_location_set(uuid, boolean, uuid[], uuid[], uuid[])', 'public.access_cameras_for(uuid, text[], timestamptz, boolean, boolean)',
    'public.access_assets_for(uuid, text[], timestamptz, boolean, boolean)', 'public.access_locations_for(uuid, text[], timestamptz, boolean, boolean)',
    'public.capability_camera_ids(text)', 'public.capability_location_ids(text)', 'public.capability_asset_ids(text)', 'public.any_cctv_camera_ids()',
    'public.it_view_location_ids()', 'public.it_view_asset_ids()', 'public.it_view_recorder_ids()', 'public.has_capability_for(text, text, uuid)',
    'public.cameras_with_capability(text, uuid[])', 'public.any_grant_location_ids()', 'public.any_grant_cluster_ids()', 'public.any_grant_region_ids()',
    'public.report_effective_camera_ids(uuid, text, timestamptz, boolean)', 'public.report_effective_asset_ids(uuid, text, timestamptz, boolean)',
    'public.my_access_summary()', 'public.access_grant_summary(uuid)', 'public.access_check_spec(uuid, jsonb)',
    'public.access_check_grantor(uuid, uuid, uuid, jsonb, text)', 'public.access_items(uuid, text, jsonb, timestamptz)',
    'public.status_reasons(text, uuid[])', 'public.cameras_monitoring_off(uuid[])', 'public.access_legacy_store_grants(uuid, boolean)',
    'public.access_legacy_camera_ids(uuid, boolean)', 'public.access_legacy_device_ids(uuid, boolean)', 'public.access_legacy_store_ids(uuid, boolean)',
    'public.access_migrate_legacy(uuid, uuid[], boolean)', 'public.access_grants_before_insert()', 'public.access_grants_before_update()',
    'public.inventory_refuse_delete()', 'public.organizations_global_space()', 'public.address_space_global(uuid)', 'public.asset_sync_endpoints(uuid)',
    'public.assets_after_write()', 'public.assets_before_update()', 'public.assets_attached_check()', 'public.monitor_stop_asset()',
    'public.monitor_stop_location()', 'public.recorders_before_write()', 'public.recorders_after_write()', 'public.recorder_monitoring_stop()',
    'public.mappings_before_write()', 'public.mappings_after_write()', 'public.recorder_primary_of(uuid)', 'public.cameras_after_insert()',
    'public.cameras_before_update()', 'public.monitor_apply_results(uuid, jsonb, integer)', 'public.recorder_store_credential(uuid, text)',
    'public.recorder_read_credential(uuid)', 'public.recorder_delete_credential(uuid)', 'public.recorder_credential_status(uuid, uuid)',
    'public.recorder_ensure_primary(uuid)', 'public.locations_legacy_seam()', 'public.nvr_store_credential(uuid, text)',
    'public.nvr_read_credential(uuid)', 'public.nvr_delete_credential(uuid)', 'public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid)',
    'public.inventory_archive(uuid, text, uuid, uuid)', 'public.inventory_restore(uuid, text, uuid, uuid)', 'public.inventory_hierarchy_moved()',
    'public.inventory_node_archived()', 'public.inventory_move_location(uuid, uuid, uuid, uuid)', 'public.inventory_move_cluster(uuid, uuid, uuid, uuid)',
    'public.preview_hierarchy_change(uuid, text, uuid, uuid)', 'public.recorder_set_monitoring(uuid, uuid, boolean, text, uuid)',
    'public.inventory_purge_test_org(uuid)', 'public.inventory_propose_hierarchy(uuid)', 'public.inventory_effective_snapshot(uuid, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END
$$;
GRANT EXECUTE ON FUNCTION public.capability_camera_ids(text), public.capability_location_ids(text), public.capability_asset_ids(text),
  public.any_cctv_camera_ids(), public.it_view_location_ids(), public.it_view_asset_ids(), public.it_view_recorder_ids(),
  public.has_capability_for(text, text, uuid), public.cameras_with_capability(text, uuid[]), public.any_grant_location_ids(),
  public.any_grant_cluster_ids(), public.any_grant_region_ids()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_access_summary(), public.status_reasons(text, uuid[]), public.cameras_monitoring_off(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_effective_camera_ids(uuid, text, timestamptz, boolean), public.report_effective_asset_ids(uuid, text, timestamptz, boolean),
  public.access_grant_summary(uuid), public.access_target_ancestry(uuid, jsonb), public.access_legacy_camera_ids(uuid, boolean),
  public.access_legacy_device_ids(uuid, boolean), public.access_legacy_store_ids(uuid, boolean), public.monitor_apply_results(uuid, jsonb, integer),
  public.recorder_store_credential(uuid, text), public.recorder_read_credential(uuid), public.recorder_delete_credential(uuid),
  public.recorder_credential_status(uuid, uuid), public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid),
  public.nvr_delete_credential(uuid), public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid), public.inventory_archive(uuid, text, uuid, uuid),
  public.inventory_restore(uuid, text, uuid, uuid), public.inventory_move_location(uuid, uuid, uuid, uuid), public.inventory_move_cluster(uuid, uuid, uuid, uuid),
  public.preview_hierarchy_change(uuid, text, uuid, uuid), public.recorder_set_monitoring(uuid, uuid, boolean, text, uuid),
  public.inventory_purge_test_org(uuid), public.inventory_propose_hierarchy(uuid), public.inventory_effective_snapshot(uuid, timestamptz),
  public.recorder_primary_of(uuid)
  TO service_role;

-- ═══ 17. Self-test in the same transaction (impact map 2.2 step 13) ═════════════════════════════════════════════════════════
DO $$
DECLARE
  v_bad text;
  v_org uuid;
  v_loc uuid;
  v_rec uuid;
  v_cam uuid;
  v_user uuid := gen_random_uuid();
BEGIN
  -- (a) no stale names in function bodies, except the listed legacy evaluators and the seam.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosrc ~ '(\mstores\M|store_id|\mdevices\M|nvr_secret_id|nvr_ip|cameras_store_channel|\mstore_status\M)'
    AND p.proname NOT IN ('access_legacy_store_grants', 'access_migrate_legacy', 'recorder_ensure_primary', 'locations_legacy_seam',
                          'inventory_purge_test_org');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'P2-5a self-test: stale names in %', v_bad; END IF;
  -- (b) every SECURITY DEFINER function written here has an empty search_path.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND p.proname IN ('access_ancestry', 'access_camera_set', 'has_capability_for', 'monitor_apply_results', 'recorder_store_credential',
                      'nvr_store_credential', 'inventory_purge_test_org', 'recorder_set_monitoring', 'my_access_summary')
    AND NOT ('search_path=""' = ANY (coalesce(p.proconfig, '{}')));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'P2-5a self-test: search_path not empty in %', v_bad; END IF;
  -- (c) privileges.
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5a self-test: privilege violations'; END IF;
  -- (d) a throw-away organisation through every main path; rolled back by the sentinel exception.
  BEGIN
    INSERT INTO public.organizations (name, slug) VALUES ('p25 self-test', 'test-p25-selftest-' || gen_random_uuid()) RETURNING id INTO v_org;
    INSERT INTO public.locations (org_id, code, name, nvr_ip, nvr_username) VALUES (v_org, 'ST1', 'ST1', '192.0.2.200', 'u') RETURNING id INTO v_loc;
    v_rec := public.recorder_primary_of(v_loc);
    IF v_rec IS NULL THEN RAISE EXCEPTION 'P2-5a self-test: seam made no recorder'; END IF;
    INSERT INTO public.cameras (org_id, location_id, channel, name) VALUES (v_org, v_loc, 1, 'c') RETURNING id INTO v_cam;
    IF (SELECT recorder_id FROM public.cameras WHERE id = v_cam) IS DISTINCT FROM v_rec THEN RAISE EXCEPTION 'P2-5a self-test: camera not mapped'; END IF;
    PERFORM public.monitor_apply_results(v_org, jsonb_build_array(jsonb_build_object('type', 'nvr', 'id', v_loc, 'ok', true, 'at', now())), 2);
    IF NOT EXISTS (SELECT 1 FROM public.check_state WHERE target_type = 'recorder' AND target_id = v_rec) THEN RAISE EXCEPTION 'P2-5a self-test: nvr alias'; END IF;
    PERFORM public.access_camera_set(v_org, true, '{}', '{}', '{}', '{}', '{}');
    PERFORM public.access_asset_set(v_org, true, '{}', '{}', '{}', '{}', '{}');
    PERFORM public.access_location_set(v_org, true, '{}', '{}', '{}');
    PERFORM public.access_cameras_for(v_user, ARRAY['cctv.live'], now(), true, true);
    PERFORM public.access_assets_for(v_user, ARRAY['it.inventory.view'], now(), true, true);
    PERFORM public.access_locations_for(v_user, ARRAY['cctv.live'], now(), true, true);
    PERFORM public.access_items(v_org, 'cctv.live', '[]'::jsonb, now());
    PERFORM public.access_scope_covers(v_org, 'location', v_loc, 'camera', v_cam);
    PERFORM * FROM public.inventory_effective_snapshot(v_org);
    PERFORM * FROM public.inventory_propose_hierarchy(v_org);
    PERFORM public.preview_hierarchy_change(v_org, 'location', v_loc, NULL);
    PERFORM public.access_legacy_camera_ids(v_user, true);
    PERFORM public.access_legacy_device_ids(v_user, true);
    PERFORM public.access_legacy_store_ids(v_user, true);
    PERFORM * FROM public.location_status;
    PERFORM public.camera_remap(v_org, v_cam, v_rec, 2);
    PERFORM public.inventory_archive(v_org, 'camera', v_cam);
    PERFORM public.inventory_restore(v_org, 'camera', v_cam);
    PERFORM public.recorder_set_monitoring(v_org, v_rec, false, 'self-test');
    PERFORM public.inventory_purge_test_org(v_org);
    RAISE EXCEPTION 'p25-selftest-ok' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'p25-selftest-ok' THEN RAISE; END IF;
  END;
END
$$;

NOTIFY pgrst, 'reload schema';
