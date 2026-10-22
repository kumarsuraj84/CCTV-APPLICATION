-- P2-1 capability access model, part 1 of 3: catalogue, explicit grants, effective-access functions, write and preview RPCs, the
-- migration function and its report (decisions D-1, D-2, D-2a; directive AC-1..AC-9, AC-12). Nothing reads the new grants for row
-- security yet: that switch is 20261021000011. The data migration itself runs in 20261021000010.
-- Rules for everything below: grants only ADD access (union, no deny, no narrowing); no role gives data access by itself; every
-- SECURITY DEFINER function has SET search_path = '' and fully qualified names; default privileges are closed, so every object is
-- granted explicitly. docs/drishti/access-model.md explains the model.
-- Rollback: supabase/rollback/20261021000009_capability_access_rollback.sql
BEGIN;

-- ── Capability catalogue (read-only: changed only by migrations) ─────────────
CREATE TABLE public.capabilities (
  key text PRIMARY KEY CHECK (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  area text NOT NULL CHECK (area IN ('cctv', 'it', 'wifi', 'admin')),
  description text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  requires_mfa boolean NOT NULL,
  -- Where a grant of this capability may point. CCTV: organisation, location, camera. IT and Wi-Fi: organisation, location, asset.
  -- Administrative capabilities: organisation only.
  scope_kinds text[] NOT NULL CHECK (scope_kinds <@ ARRAY['organization', 'location', 'camera', 'asset'] AND cardinality(scope_kinds) > 0),
  CONSTRAINT capabilities_mfa_rule CHECK (requires_mfa = (risk = 'high' OR key = 'cctv.export'))
);

INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds) VALUES
  ('cctv.live',                  'cctv',  'Watch live video',                                                     'low',    false, ARRAY['organization', 'location', 'camera']),
  ('cctv.playback',              'cctv',  'Search recordings and play them back (calendar, timeline, 1x player)',  'medium', false, ARRAY['organization', 'location', 'camera']),
  ('cctv.export',                'cctv',  'Export or download recordings (includes fast playback, D-6a)',         'medium', true,  ARRAY['organization', 'location', 'camera']),
  ('it.inventory.view',          'it',    'See IT assets, their addresses and NVR addresses',                     'low',    false, ARRAY['organization', 'location', 'asset']),
  ('it.monitoring.view',         'it',    'See monitoring status, outages and uptime of IT assets and NVRs',      'low',    false, ARRAY['organization', 'location', 'asset']),
  ('it.monitoring.operate',      'it',    'Run checks now and set maintenance',                                   'medium', false, ARRAY['organization', 'location', 'asset']),
  ('it.remote.view',             'it',    'View a computer screen remotely',                                      'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.remote.control',          'it',    'Control a computer remotely',                                          'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.diagnostics',             'it',    'Run diagnostics on an asset',                                          'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.script.run',              'it',    'Run approved scripts',                                                 'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.software.manage',         'it',    'Install and remove software',                                          'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.config.deploy',           'it',    'Deploy configuration',                                                 'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.patch.manage',            'it',    'Manage patches',                                                       'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.credentials.admin',       'it',    'Manage device and recorder credentials',                               'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('it.os.deploy',               'it',    'Deploy operating systems',                                             'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('wifi.inventory.view',        'wifi',  'See Wi-Fi access points, routers and switches',                        'low',    false, ARRAY['organization', 'location', 'asset']),
  ('wifi.config.view_redacted',  'wifi',  'See Wi-Fi configuration with secrets hidden',                          'medium', false, ARRAY['organization', 'location', 'asset']),
  ('wifi.profile.edit',          'wifi',  'Edit Wi-Fi profiles',                                                  'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('wifi.deploy.approve',        'wifi',  'Approve a Wi-Fi rollout',                                              'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('wifi.deploy.execute',        'wifi',  'Run an approved Wi-Fi rollout',                                        'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('wifi.device.reboot_upgrade', 'wifi',  'Reboot or upgrade Wi-Fi devices',                                      'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('wifi.config.restore',        'wifi',  'Restore a saved Wi-Fi configuration',                                  'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('wifi.credentials.admin',     'wifi',  'Manage Wi-Fi passphrases and device credentials',                      'high',   true,  ARRAY['organization', 'location', 'asset']),
  ('admin.users',                'admin', 'Read and manage people',                                               'high',   true,  ARRAY['organization']),
  ('admin.access',               'admin', 'Read and change access grants',                                        'high',   true,  ARRAY['organization']),
  ('admin.inventory',            'admin', 'Manage locations, cameras, assets and camera groups of others',        'high',   true,  ARRAY['organization']),
  ('admin.alerts',               'admin', 'Manage alert rules and recipients',                                    'high',   true,  ARRAY['organization']),
  ('admin.audit.read',           'admin', 'Read the audit log',                                                   'high',   true,  ARRAY['organization']);

ALTER TABLE public.capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY capabilities_select ON public.capabilities FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.capabilities FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.capabilities TO authenticated, service_role;

-- ── Targets of the same-organisation foreign keys ────────────────────────────
ALTER TABLE public.devices ADD CONSTRAINT devices_id_org_key UNIQUE (id, org_id);

-- Bumped by every change of a person's grants, so an administrator's save can refuse to overwrite a change made meanwhile (AC-9).
ALTER TABLE public.profiles ADD COLUMN access_version bigint NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.profiles.store_id IS 'Home location: information only. It grants nothing (directive AC-7, P2-1).';

-- ── Grants: append-only history ──────────────────────────────────────────────
-- scope_id is the generic pointer (null only for organisation scope). location_id / camera_id / asset_id are the same value in a typed
-- column so that a composite same-organisation foreign key can check it; deleting the target revokes the grant (see the update trigger),
-- the row stays as history. Until P2-5 "location" means a row of stores (renaming stores to locations keeps the ids).
CREATE TABLE public.access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL,
  capability text NOT NULL REFERENCES public.capabilities (key),
  scope_kind text NOT NULL CHECK (scope_kind IN ('organization', 'location', 'camera', 'asset')),
  scope_id uuid,
  location_id uuid,
  camera_id uuid,
  asset_id uuid,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 500),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'migrated:store', 'migrated:zone', 'migrated:home', 'migrated:manager', 'migrated:camera', 'migrated:admin')),
  -- D-2a: home-store and manager-wide access was migrated as explicit grants that an administrator should review.
  needs_review boolean NOT NULL DEFAULT false,
  CONSTRAINT access_grants_validity CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT access_grants_scope CHECK (
    (scope_kind = 'organization' AND scope_id IS NULL AND location_id IS NULL AND camera_id IS NULL AND asset_id IS NULL) OR
    (scope_kind = 'location' AND scope_id IS NOT NULL AND camera_id IS NULL AND asset_id IS NULL
      AND (location_id = scope_id OR (location_id IS NULL AND revoked_at IS NOT NULL))) OR
    (scope_kind = 'camera' AND scope_id IS NOT NULL AND location_id IS NULL AND asset_id IS NULL
      AND (camera_id = scope_id OR (camera_id IS NULL AND revoked_at IS NOT NULL))) OR
    (scope_kind = 'asset' AND scope_id IS NOT NULL AND location_id IS NULL AND camera_id IS NULL
      AND (asset_id = scope_id OR (asset_id IS NULL AND revoked_at IS NOT NULL)))
  ),
  CONSTRAINT access_grants_user_fk FOREIGN KEY (user_id, org_id) REFERENCES public.profiles (id, org_id) ON DELETE CASCADE,
  CONSTRAINT access_grants_location_fk FOREIGN KEY (location_id, org_id) REFERENCES public.stores (id, org_id) ON DELETE SET NULL (location_id),
  CONSTRAINT access_grants_camera_fk FOREIGN KEY (camera_id, org_id) REFERENCES public.cameras (id, org_id) ON DELETE SET NULL (camera_id),
  CONSTRAINT access_grants_asset_fk FOREIGN KEY (asset_id, org_id) REFERENCES public.devices (id, org_id) ON DELETE SET NULL (asset_id)
);
-- One live (not revoked) row per person, capability and scope. Also serves as the (user_id, capability) WHERE revoked_at IS NULL index.
CREATE UNIQUE INDEX access_grants_active_key ON public.access_grants (user_id, capability, scope_kind, scope_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;
CREATE INDEX access_grants_org_idx ON public.access_grants (org_id);
CREATE INDEX access_grants_location_idx ON public.access_grants (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX access_grants_camera_idx ON public.access_grants (camera_id) WHERE camera_id IS NOT NULL;
CREATE INDEX access_grants_asset_idx ON public.access_grants (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX access_grants_expiry_idx ON public.access_grants (valid_until) WHERE revoked_at IS NULL AND valid_until IS NOT NULL;

-- New rows: the capability must allow the scope kind, the typed target column is filled in, and nothing starts revoked.
CREATE OR REPLACE FUNCTION public.access_grants_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_kinds text[];
BEGIN
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

-- Append-only: the only changes ever allowed are revoking a live grant once, and the database itself clearing a typed target column
-- when the target is deleted (ON DELETE SET NULL), which revokes the grant at the same moment.
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

CREATE TRIGGER access_grants_insert BEFORE INSERT ON public.access_grants FOR EACH ROW EXECUTE FUNCTION public.access_grants_before_insert();
CREATE TRIGGER access_grants_update BEFORE UPDATE ON public.access_grants FOR EACH ROW EXECUTE FUNCTION public.access_grants_before_update();

-- ── Migration report (written by access_migrate_legacy, read by administrators through the server) ─────
CREATE TABLE public.access_migration_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,  -- no foreign key: the report outlives the person
  old_model jsonb NOT NULL,
  new_grants jsonb NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_migration_report_run_idx ON public.access_migration_report (run_id);
CREATE INDEX access_migration_report_org_idx ON public.access_migration_report (org_id, created_at DESC);

ALTER TABLE public.access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_migration_report ENABLE ROW LEVEL SECURITY;

-- ── MFA switch ───────────────────────────────────────────────────────────────
-- Capabilities with requires_mfa need an aal2 session once this returns true. P3 turns it on; until then it is false everywhere.
CREATE OR REPLACE FUNCTION public.mfa_enforced() RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$ SELECT false $$;

-- The caller's session level (Supabase puts it in the JWT as "aal").
CREATE OR REPLACE FUNCTION public.access_caller_aal2() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT auth.jwt()) ->> 'aal', '') = 'aal2'
$$;

-- ── Effective access: the one place the rules live ───────────────────────────
-- The grants that count for a person at a moment: the person is active and has chosen their password (unless p_ignore_status, used
-- only by the migration checks and the preview), the grant belongs to their organisation, is not revoked, has started and not ended,
-- and (when MFA is enforced) a capability that needs MFA counts only in an aal2 session.
CREATE OR REPLACE FUNCTION public.access_grants_of(p_user uuid, p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS TABLE (org_id uuid, capability text, area text, scope_kind text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.org_id, g.capability, c.area, g.scope_kind, g.scope_id
  FROM public.access_grants g
  JOIN public.profiles p ON p.id = g.user_id AND p.org_id = g.org_id
  JOIN public.capabilities c ON c.key = g.capability
  WHERE g.user_id = p_user
    AND g.revoked_at IS NULL
    AND g.valid_from <= p_at AND (g.valid_until IS NULL OR g.valid_until > p_at)
    AND (p_ignore_status OR (p.is_active AND NOT p.must_reset_password))
    AND (NOT c.requires_mfa OR NOT public.mfa_enforced() OR p_aal2)
$$;

-- Expanders: what a set of scopes covers. A location covers every camera (asset) in it, also ones added later; a camera or asset scope
-- covers exactly that one; the organisation covers everything of the organisation.
CREATE OR REPLACE FUNCTION public.access_camera_set(p_org uuid, p_org_wide boolean, p_locations uuid[], p_cameras uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id FROM public.cameras c WHERE p_org_wide AND c.org_id = p_org
  UNION
  SELECT c.id FROM public.cameras c WHERE NOT p_org_wide AND c.org_id = p_org AND c.store_id = ANY (p_locations)
  UNION
  SELECT c.id FROM public.cameras c WHERE NOT p_org_wide AND c.org_id = p_org AND c.id = ANY (p_cameras)
$$;

CREATE OR REPLACE FUNCTION public.access_device_set(p_org uuid, p_org_wide boolean, p_locations uuid[], p_assets uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id FROM public.devices d WHERE p_org_wide AND d.org_id = p_org
  UNION
  SELECT d.id FROM public.devices d WHERE NOT p_org_wide AND d.org_id = p_org AND d.store_id = ANY (p_locations)
  UNION
  SELECT d.id FROM public.devices d WHERE NOT p_org_wide AND d.org_id = p_org AND d.id = ANY (p_assets)
$$;

-- Locations fully covered (organisation or location scope).
CREATE OR REPLACE FUNCTION public.access_store_set(p_org uuid, p_org_wide boolean, p_locations uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id FROM public.stores s WHERE p_org_wide AND s.org_id = p_org
  UNION
  SELECT s.id FROM public.stores s WHERE NOT p_org_wide AND s.org_id = p_org AND s.id = ANY (p_locations)
$$;

CREATE OR REPLACE FUNCTION public.access_cameras_for(p_user uuid, p_caps text[], p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

CREATE OR REPLACE FUNCTION public.access_devices_for(p_user uuid, p_caps text[], p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

CREATE OR REPLACE FUNCTION public.access_stores_for(p_user uuid, p_caps text[], p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, p_at, p_ignore_status, p_aal2) WHERE capability = ANY (p_caps)
  )
  SELECT x FROM public.access_store_set(
    (SELECT p.org_id FROM public.profiles p WHERE p.id = p_user),
    EXISTS (SELECT 1 FROM g WHERE g.scope_kind = 'organization'),
    ARRAY(SELECT g.scope_id FROM g WHERE g.scope_kind = 'location')
  ) AS x
$$;

-- ── The caller's own access (what row security and the app use) ──────────────
CREATE OR REPLACE FUNCTION public.has_capability(p_cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) g WHERE g.capability = p_cap
  )
$$;

-- Whether one camera, location or asset is covered for the caller. A location counts only when it is covered whole (organisation or
-- location scope); one camera grant does not make a location.
CREATE OR REPLACE FUNCTION public.has_capability_for(p_cap text, p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

CREATE OR REPLACE FUNCTION public.capability_camera_ids(p_cap text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;

-- Locations covered whole for the capability.
CREATE OR REPLACE FUNCTION public.capability_store_ids(p_cap text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_stores_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.capability_device_ids(p_cap text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_devices_for((SELECT auth.uid()), ARRAY[p_cap], now(), false, public.access_caller_aal2()) AS x
$$;

-- Cameras whose metadata (name, channel, status) the caller may see: any CCTV capability.
CREATE OR REPLACE FUNCTION public.any_cctv_camera_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for((SELECT auth.uid()), ARRAY['cctv.live', 'cctv.playback', 'cctv.export'], now(), false,
                                         public.access_caller_aal2()) AS x
$$;

-- The subset of p_ids the caller may use for the capability (for example the cameras of a live wall).
CREATE OR REPLACE FUNCTION public.cameras_with_capability(p_cap text, p_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) WHERE capability = p_cap
  )
  SELECT c.id FROM public.cameras c
  WHERE c.id = ANY (p_ids)
    AND EXISTS (SELECT 1 FROM g WHERE g.org_id = c.org_id
                AND (g.scope_kind = 'organization' OR (g.scope_kind = 'location' AND g.scope_id = c.store_id)
                     OR (g.scope_kind = 'camera' AND g.scope_id = c.id)))
$$;

-- Locations whose plain row (code, name, city…) the caller may see: they hold any CCTV, IT or Wi-Fi grant inside it.
-- Administrative capabilities do not show locations.
CREATE OR REPLACE FUNCTION public.any_grant_store_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

-- IT view of locations and assets: it.inventory.view or it.monitoring.view. Used for devices, NVR status and the address columns.
CREATE OR REPLACE FUNCTION public.it_view_store_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_stores_for((SELECT auth.uid()), ARRAY['it.inventory.view', 'it.monitoring.view'], now(), false,
                                        public.access_caller_aal2()) AS x
$$;

CREATE OR REPLACE FUNCTION public.it_view_device_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_devices_for((SELECT auth.uid()), ARRAY['it.inventory.view', 'it.monitoring.view'], now(), false,
                                         public.access_caller_aal2()) AS x
$$;

-- Camera groups the caller may see: at least one member is a camera they may see. A group with no members at all is seen only by its
-- creator and by holders of admin.inventory (it then holds nothing to leak). There is no creator exception once a group has members.
CREATE OR REPLACE FUNCTION public.cctv_visible_group_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x)
  SELECT g.id FROM public.camera_groups g
  WHERE g.org_id = (SELECT public.current_org_id())
    AND (
      EXISTS (SELECT 1 FROM public.camera_group_items i JOIN mine ON mine.id = i.camera_id WHERE i.group_id = g.id)
      OR (NOT EXISTS (SELECT 1 FROM public.camera_group_items i WHERE i.group_id = g.id)
          AND (g.created_by = (SELECT auth.uid()) OR public.has_capability('admin.inventory')))
    )
$$;

-- ── Server-only: any person's effective access (migration checks, tests, P2-2 services) ──────────────
CREATE OR REPLACE FUNCTION public.access_effective_camera_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;

CREATE OR REPLACE FUNCTION public.access_effective_device_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_devices_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;

-- Live grants that end within p_within (for the reminders of a later package). Revoked or already ended grants are not listed.
CREATE OR REPLACE FUNCTION public.access_expiring(p_within interval)
RETURNS TABLE (grant_id uuid, org_id uuid, user_id uuid, capability text, scope_kind text, scope_id uuid, valid_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.id, g.org_id, g.user_id, g.capability, g.scope_kind, g.scope_id, g.valid_until
  FROM public.access_grants g
  WHERE g.revoked_at IS NULL AND g.valid_until IS NOT NULL AND g.valid_until > now() AND g.valid_until <= now() + p_within
  ORDER BY g.valid_until, g.id
$$;

-- ── Writes (service role only; the Server Action checks the administrator first) ──────────────
-- Locks the person's row, checks the organisation and the expected version (lost-update guard), returns the current version.
CREATE OR REPLACE FUNCTION public.access_lock_person(p_org uuid, p_user uuid, p_expected bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
BEGIN
  SELECT p.access_version INTO v_version FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF p_expected IS NOT NULL AND p_expected <> v_version THEN
    RAISE EXCEPTION 'access changed meanwhile' USING ERRCODE = '40001';
  END IF;
  RETURN v_version;
END
$$;

CREATE OR REPLACE FUNCTION public.access_bump_version(p_user uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.profiles SET access_version = access_version + 1 WHERE id = p_user RETURNING access_version
$$;

-- Checks one grant description {capability, scope_kind, scope_id?, valid_from?, valid_until?} against the catalogue and the organisation.
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

-- Adds one grant unless an identical live one exists (same capability, scope and dates: then that one is returned unchanged).
-- A live grant for the same capability and scope with other dates is revoked and replaced. "valid_from" left out means "from now",
-- which an existing grant that has already started satisfies.
CREATE OR REPLACE FUNCTION public.access_put_grant(
  p_org uuid, p_user uuid, p_spec jsonb, p_actor uuid, p_reason text, p_source text, p_needs_review boolean,
  OUT grant_id uuid, OUT added boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_from timestamptz := NULLIF(p_spec ->> 'valid_from', '')::timestamptz;
  v_until timestamptz := NULLIF(p_spec ->> 'valid_until', '')::timestamptz;
  v_g public.access_grants%ROWTYPE;
BEGIN
  PERFORM public.access_check_spec(p_org, p_spec);
  SELECT * INTO v_g FROM public.access_grants g
  WHERE g.user_id = p_user AND g.capability = v_cap AND g.scope_kind = v_kind AND g.scope_id IS NOT DISTINCT FROM v_scope AND g.revoked_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    IF v_g.valid_until IS NOT DISTINCT FROM v_until AND ((v_from IS NULL AND v_g.valid_from <= now()) OR v_g.valid_from = v_from) THEN
      grant_id := v_g.id;
      added := false;
      RETURN;
    END IF;
    UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = 'Replaced by a grant with other dates.'
    WHERE id = v_g.id;
  END IF;
  INSERT INTO public.access_grants (org_id, user_id, capability, scope_kind, scope_id, valid_from, valid_until, granted_by, reason, source, needs_review)
  VALUES (p_org, p_user, v_cap, v_kind, v_scope, coalesce(v_from, now()), v_until, p_actor, p_reason, p_source, p_needs_review)
  RETURNING id INTO grant_id;
  added := true;
END
$$;

-- Adds grants. Returns {version, grant_ids (one per requested grant, in order), added, unchanged}.
CREATE OR REPLACE FUNCTION public.grant_access(
  p_org uuid, p_user uuid, p_grants jsonb, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_spec jsonb;
  v_put record;
  v_ids uuid[] := '{}';
  v_added integer := 0;
BEGIN
  IF jsonb_typeof(p_grants) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'grants must be a list' USING ERRCODE = '22023'; END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  FOR v_spec IN SELECT e.value FROM jsonb_array_elements(p_grants) AS e LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_spec, p_actor, p_reason, 'manual', false);
    v_ids := v_ids || v_put.grant_id;
    IF v_put.added THEN v_added := v_added + 1; END IF;
  END LOOP;
  IF v_added > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'grant_ids', to_jsonb(v_ids), 'added', v_added, 'unchanged', cardinality(v_ids) - v_added);
END
$$;

-- Revokes grants of one person. Ids that are not this person's grants in this organisation are refused (nothing changes).
CREATE OR REPLACE FUNCTION public.revoke_grant(
  p_org uuid, p_user uuid, p_grant_ids uuid[], p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_n integer;
BEGIN
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_grant_ids, '{}')) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = x.id AND g.user_id = p_user AND g.org_id = p_org)) THEN
    RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = coalesce(p_reason, 'Revoked.')
  WHERE id = ANY (coalesce(p_grant_ids, '{}')) AND user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'revoked', v_n);
END
$$;

-- Makes a person's live grants for the listed capabilities and scope kinds exactly p_grants: missing ones are added, others revoked,
-- identical ones kept as they are (so their source and review flag stay). Grants of other capabilities or scope kinds are not touched.
CREATE OR REPLACE FUNCTION public.replace_user_grants(
  p_org uuid, p_user uuid, p_capabilities text[], p_scope_kinds text[], p_grants jsonb,
  p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_spec jsonb;
  v_put record;
  v_added integer := 0;
  v_revoked integer := 0;
  v_kept integer := 0;
BEGIN
  IF jsonb_typeof(p_grants) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'grants must be a list' USING ERRCODE = '22023'; END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_grants) AS e
             WHERE NOT (e.value ->> 'capability' = ANY (p_capabilities)) OR NOT (e.value ->> 'scope_kind' = ANY (p_scope_kinds))) THEN
    RAISE EXCEPTION 'a grant is outside the capabilities or scope kinds being replaced' USING ERRCODE = '22023';
  END IF;
  WITH wanted AS (
    SELECT DISTINCT e.value ->> 'capability' AS cap, e.value ->> 'scope_kind' AS kind, NULLIF(e.value ->> 'scope_id', '')::uuid AS sid
    FROM jsonb_array_elements(p_grants) AS e
  )
  UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor, revoke_reason = coalesce(p_reason, 'Removed from the access list.')
  WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL
    AND g.capability = ANY (p_capabilities) AND g.scope_kind = ANY (p_scope_kinds)
    AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.cap = g.capability AND w.kind = g.scope_kind AND w.sid IS NOT DISTINCT FROM g.scope_id);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  FOR v_spec IN SELECT e.value FROM jsonb_array_elements(p_grants) AS e LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_spec, p_actor, p_reason, 'manual', false);
    IF v_put.added THEN v_added := v_added + 1; ELSE v_kept := v_kept + 1; END IF;
  END LOOP;
  IF v_added + v_revoked > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'added', v_added, 'revoked', v_revoked, 'unchanged', v_kept);
END
$$;

-- ── Effective-access preview (AC-9) ──────────────────────────────────────────
-- What a list of grant descriptions covers for one capability at one moment, with a label for each item.
-- Items: cameras for CCTV, assets for IT, covered locations and assets for Wi-Fi, the organisation for administrative capabilities.
CREATE OR REPLACE FUNCTION public.access_items(p_org uuid, p_cap text, p_specs jsonb, p_at timestamptz)
RETURNS TABLE (item_id uuid, label text)
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

-- p_changes: [{op: 'grant', capability, scope_kind, scope_id?, valid_from?, valid_until?} | {op: 'revoke', grant_id}].
-- Compares what the person covers now with what they would cover at p_at (default now) after the changes. Writes nothing.
-- Returns {version, at, person_active, capabilities: {<key>: {target, added_count, removed_count, sample_added[], sample_removed[]}}}.
-- Status (deactivated, must choose a password) is reported in person_active and not applied, so the preview shows the grants' effect.
CREATE OR REPLACE FUNCTION public.preview_access_change(p_user uuid, p_changes jsonb, p_at timestamptz DEFAULT now(), p_sample integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_version bigint;
  v_active boolean;
  v_before jsonb;
  v_after jsonb;
  v_change jsonb;
  v_revoke uuid[] := '{}';
  v_cap text;
  v_out jsonb := '{}'::jsonb;
  v_sample integer := least(greatest(coalesce(p_sample, 10), 0), 100);
BEGIN
  SELECT p.org_id, p.access_version, (p.is_active AND NOT p.must_reset_password) INTO v_org, v_version, v_active
  FROM public.profiles p WHERE p.id = p_user;
  IF v_org IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'changes must be a list' USING ERRCODE = '22023'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'capability', g.capability, 'scope_kind', g.scope_kind, 'scope_id', g.scope_id,
                                               'valid_from', g.valid_from, 'valid_until', g.valid_until)), '[]'::jsonb)
  INTO v_before
  FROM public.access_grants g WHERE g.user_id = p_user AND g.org_id = v_org AND g.revoked_at IS NULL;

  v_after := v_before;
  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e LOOP
    IF v_change ->> 'op' = 'revoke' THEN
      IF NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = NULLIF(v_change ->> 'grant_id', '')::uuid AND g.user_id = p_user) THEN
        RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
      END IF;
      v_revoke := v_revoke || (v_change ->> 'grant_id')::uuid;
    ELSIF v_change ->> 'op' = 'grant' THEN
      PERFORM public.access_check_spec(v_org, v_change - 'op');
      v_after := v_after || jsonb_build_array((v_change - 'op') || jsonb_build_object('valid_from', coalesce(NULLIF(v_change ->> 'valid_from', ''), now()::text)));
    ELSE
      RAISE EXCEPTION 'unknown change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_after FROM jsonb_array_elements(v_after) AS e
  WHERE e.value ->> 'id' IS NULL OR NOT ((e.value ->> 'id')::uuid = ANY (v_revoke));

  FOR v_cap IN
    SELECT DISTINCT e.value ->> 'capability' FROM jsonb_array_elements(v_before || v_after) AS e ORDER BY 1
  LOOP
    WITH b AS (SELECT * FROM public.access_items(v_org, v_cap, v_before, now())),
         a AS (SELECT * FROM public.access_items(v_org, v_cap, v_after, p_at)),
         added AS (SELECT a.item_id, a.label FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.item_id = a.item_id)),
         removed AS (SELECT b.item_id, b.label FROM b WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.item_id = b.item_id))
    SELECT v_out || jsonb_build_object(v_cap, jsonb_build_object(
      'target', (SELECT CASE c.area WHEN 'cctv' THEN 'camera' WHEN 'it' THEN 'asset' WHEN 'wifi' THEN 'location' ELSE 'organization' END
                 FROM public.capabilities c WHERE c.key = v_cap),
      'added_count', (SELECT count(*) FROM added),
      'removed_count', (SELECT count(*) FROM removed),
      'sample_added', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.item_id, 'label', s.label) ORDER BY s.label, s.item_id)
                                FROM (SELECT * FROM added ORDER BY label, item_id LIMIT v_sample) s), '[]'::jsonb),
      'sample_removed', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.item_id, 'label', s.label) ORDER BY s.label, s.item_id)
                                  FROM (SELECT * FROM removed ORDER BY label, item_id LIMIT v_sample) s), '[]'::jsonb)
    ))
    INTO v_out;
  END LOOP;
  RETURN jsonb_build_object('version', v_version, 'at', p_at, 'person_active', v_active, 'capabilities', v_out);
END
$$;

-- ── The old model, verbatim, for the migration and its checks only ───────────
-- These evaluate the retired tables (user_store_access, user_zone_access, user_camera_access, profiles.store_id, the manager role) with
-- exactly the rules of the dropped visible_camera_ids / visible_device_ids (migration 0002), for any person. Nothing uses them for
-- access: they are server-only and exist for the migration report, its equality checks and VA-18. They go when the tables go.
CREATE OR REPLACE FUNCTION public.access_legacy_store_grants(p_user uuid, p_ignore_status boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.id FROM public.stores s
  JOIN public.profiles p ON p.id = p_user AND p.org_id = s.org_id AND (p_ignore_status OR (p.is_active AND NOT p.must_reset_password))
  WHERE s.id IN (SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = p_user)
     OR s.zone IN (SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = p_user)
     OR s.id = p.store_id
$$;

CREATE OR REPLACE FUNCTION public.access_legacy_camera_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  SELECT d.id FROM public.devices d JOIN p ON p.org_id = d.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT d.id FROM public.devices d JOIN p ON p.org_id = d.org_id
  WHERE d.store_id IN (SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x)
$$;

-- ── The data migration (D-2 with D-2a) ───────────────────────────────────────
-- For each person (all, or p_users): turns the old rows into explicit grants and writes one report row. Returns the number of grants
-- added (0 when run again: identical grants are not added twice). Only ever ADDS grants.
--   store / zone / home grant, no camera grants in that store  → cctv.live + cctv.playback at location scope
--                                                                (source migrated:store, else migrated:zone, else migrated:home;
--                                                                 home-only is flagged needs_review)
--   camera grants (also inside a store/zone/home grant: that store was narrowed to them) → camera-scope live + playback (migrated:camera)
--   manager role   → organisation-scope cctv.live, cctv.playback, it.inventory.view, it.monitoring.view (migrated:manager, needs_review)
--   admin / owner  → organisation-scope administrative set (migrated:admin) so existing administrator flows keep working
--   IT devices seen through a store / zone / home grant → NOT migrated (directive AC-4); listed in the note
--   export → nobody except administrators (it did not exist; fast playback was administrators-only, D-6a)
--   high-risk IT capabilities → nobody
CREATE OR REPLACE FUNCTION public.access_migrate_legacy(p_run uuid, p_users uuid[] DEFAULT NULL) RETURNS integer
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
    v_added := 0;
    v_notes := '{}';
    v_stores := ARRAY(SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = v_person.id ORDER BY a.store_id);
    v_zones := ARRAY(SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = v_person.id ORDER BY z.zone);
    v_cams := ARRAY(SELECT a.camera_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id AND c.org_id = v_person.org_id
                    WHERE a.user_id = v_person.id ORDER BY a.camera_id);
    v_narrowed := ARRAY(SELECT DISTINCT c.store_id FROM public.cameras c WHERE c.id = ANY (v_cams));

    -- Whole locations.
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
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;

    -- Single cameras (also the ones that narrowed a store: exactly what the person saw there).
    FOREACH v_camera IN ARRAY v_cams LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'camera', 'scope_id', v_camera), NULL, v_reason, 'migrated:camera', false);
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;

    IF v_person.role = 'manager' THEN
      FOREACH v_cap IN ARRAY v_manager_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:manager', true);
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Manager role saw everything: migrated as organisation-wide live, playback, IT inventory and IT monitoring grants, flagged for review (D-2a).'::text;
    ELSIF v_person.role IN ('admin', 'platform_owner') THEN
      FOREACH v_cap IN ARRAY v_admin_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:admin', false);
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Administrator: organisation-wide administrative set granted so existing administrator work keeps working.'::text;
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

-- ── Introspection for the privilege test (VA-19) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.function_privileges()
RETURNS TABLE (name text, args text, security_definer boolean, search_path text, grantees text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.proname::text,
         pg_catalog.pg_get_function_identity_arguments(p.oid),
         p.prosecdef,
         (SELECT pg_catalog.replace(pg_catalog.substr(c, 13), '""', '') FROM pg_catalog.unnest(p.proconfig) AS c WHERE c LIKE 'search_path=%'),
         CASE WHEN p.proacl IS NULL THEN ARRAY['PUBLIC (default)']
              ELSE ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE (SELECT r.rolname::text FROM pg_catalog.pg_roles r WHERE r.oid = a.grantee) END
                         FROM pg_catalog.aclexplode(p.proacl) AS a
                         WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1) END
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
$$;

-- ── Grants (the defaults are closed) ─────────────────────────────────────────
REVOKE ALL ON public.access_grants, public.access_migration_report FROM PUBLIC, anon, authenticated, service_role;
-- People read their own grants (the policy is added with the rest of row security in 0011). Nobody writes through the data API:
-- every change goes through the functions above, and not even the service role may update or delete rows (append-only).
GRANT SELECT ON public.access_grants TO authenticated, service_role;
GRANT SELECT ON public.access_migration_report TO service_role;

REVOKE EXECUTE ON FUNCTION
  public.mfa_enforced(), public.access_caller_aal2(), public.access_grants_of(uuid, timestamptz, boolean, boolean),
  public.access_camera_set(uuid, boolean, uuid[], uuid[]), public.access_device_set(uuid, boolean, uuid[], uuid[]),
  public.access_store_set(uuid, boolean, uuid[]),
  public.access_cameras_for(uuid, text[], timestamptz, boolean, boolean), public.access_devices_for(uuid, text[], timestamptz, boolean, boolean),
  public.access_stores_for(uuid, text[], timestamptz, boolean, boolean),
  public.has_capability(text), public.has_capability_for(text, text, uuid), public.capability_camera_ids(text), public.capability_store_ids(text),
  public.capability_device_ids(text), public.any_cctv_camera_ids(), public.cameras_with_capability(text, uuid[]), public.any_grant_store_ids(),
  public.it_view_store_ids(), public.it_view_device_ids(), public.cctv_visible_group_ids(),
  public.access_effective_camera_ids(uuid, text, timestamptz, boolean), public.access_effective_device_ids(uuid, text, timestamptz, boolean),
  public.access_expiring(interval), public.access_lock_person(uuid, uuid, bigint), public.access_bump_version(uuid),
  public.access_check_spec(uuid, jsonb), public.access_put_grant(uuid, uuid, jsonb, uuid, text, text, boolean),
  public.grant_access(uuid, uuid, jsonb, uuid, text, bigint), public.revoke_grant(uuid, uuid, uuid[], uuid, text, bigint),
  public.replace_user_grants(uuid, uuid, text[], text[], jsonb, uuid, text, bigint),
  public.access_items(uuid, text, jsonb, timestamptz), public.preview_access_change(uuid, jsonb, timestamptz, integer),
  public.access_legacy_store_grants(uuid, boolean), public.access_legacy_camera_ids(uuid, boolean), public.access_legacy_device_ids(uuid, boolean),
  public.access_migrate_legacy(uuid, uuid[]), public.function_privileges(),
  public.access_grants_before_insert(), public.access_grants_before_update()
  FROM PUBLIC, anon, authenticated, service_role;

-- What row security and signed-in people use: about the caller only.
GRANT EXECUTE ON FUNCTION
  public.mfa_enforced(), public.has_capability(text), public.has_capability_for(text, text, uuid), public.capability_camera_ids(text),
  public.capability_store_ids(text), public.capability_device_ids(text), public.any_cctv_camera_ids(), public.cameras_with_capability(text, uuid[]),
  public.any_grant_store_ids(), public.it_view_store_ids(), public.it_view_device_ids(), public.cctv_visible_group_ids()
  TO authenticated, service_role;

-- Server only.
GRANT EXECUTE ON FUNCTION
  public.grant_access(uuid, uuid, jsonb, uuid, text, bigint), public.revoke_grant(uuid, uuid, uuid[], uuid, text, bigint),
  public.replace_user_grants(uuid, uuid, text[], text[], jsonb, uuid, text, bigint), public.preview_access_change(uuid, jsonb, timestamptz, integer),
  public.access_expiring(interval), public.access_effective_camera_ids(uuid, text, timestamptz, boolean),
  public.access_effective_device_ids(uuid, text, timestamptz, boolean), public.access_legacy_camera_ids(uuid, boolean),
  public.access_legacy_device_ids(uuid, boolean), public.access_migrate_legacy(uuid, uuid[]), public.function_privileges()
  TO service_role;

COMMIT;
