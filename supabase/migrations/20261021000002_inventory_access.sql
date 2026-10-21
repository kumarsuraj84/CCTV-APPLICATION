-- Inventory (stores, cameras, devices), access grants, visibility functions, NVR credentials in Vault, admin audit log.
-- Rollback: supabase/rollback/20261021000002_inventory_access_rollback.sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

CREATE TYPE public.device_type AS ENUM ('nvr', 'server', 'attendance', 'footfall', 'other');

CREATE TABLE public.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  code text NOT NULL,
  name text NOT NULL,
  city text,
  zone text,
  state text,
  address text,
  is_active boolean NOT NULL DEFAULT true,
  nvr_ip text NOT NULL,
  rtsp_port integer NOT NULL DEFAULT 554 CHECK (rtsp_port BETWEEN 1 AND 65535),
  http_port integer NOT NULL DEFAULT 80 CHECK (http_port BETWEEN 1 AND 65535),
  nvr_username text NOT NULL,
  nvr_secret_id uuid,  -- the NVR password lives in Vault, never in this table
  expected_channels integer NOT NULL DEFAULT 0 CHECK (expected_channels >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_org_code_key UNIQUE (org_id, code),
  CONSTRAINT stores_id_org_key UNIQUE (id, org_id),  -- target of the same-organisation foreign keys below
  CONSTRAINT stores_code_upper CHECK (code = upper(code))
);
CREATE INDEX stores_org_zone_idx ON public.stores (org_id, zone);

-- Child rows must belong to the same organisation as the row they point at: every link is a composite key on (id, org_id).
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_org_key UNIQUE (id, org_id);
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_store_fk FOREIGN KEY (store_id, org_id) REFERENCES public.stores (id, org_id) ON DELETE SET NULL (store_id);

CREATE TABLE public.cameras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  store_id uuid NOT NULL,
  channel integer NOT NULL CHECK (channel > 0),
  name text NOT NULL,
  camera_ip text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cameras_store_channel_key UNIQUE (store_id, channel),
  CONSTRAINT cameras_id_org_key UNIQUE (id, org_id),
  CONSTRAINT cameras_store_fk FOREIGN KEY (store_id, org_id) REFERENCES public.stores (id, org_id) ON DELETE CASCADE
);
CREATE INDEX cameras_org_idx ON public.cameras (org_id);

CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  store_id uuid,
  type public.device_type NOT NULL,
  name text NOT NULL,
  ip text NOT NULL,
  tcp_port integer CHECK (tcp_port BETWEEN 1 AND 65535),
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_store_fk FOREIGN KEY (store_id, org_id) REFERENCES public.stores (id, org_id) ON DELETE SET NULL (store_id)
);
CREATE INDEX devices_org_idx ON public.devices (org_id);
CREATE INDEX devices_store_idx ON public.devices (store_id);

CREATE TABLE public.user_store_access (
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL,
  store_id uuid NOT NULL,
  PRIMARY KEY (user_id, store_id),
  FOREIGN KEY (user_id, org_id) REFERENCES public.profiles (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, org_id) REFERENCES public.stores (id, org_id) ON DELETE CASCADE
);
CREATE TABLE public.user_zone_access (
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL,
  zone text NOT NULL,
  PRIMARY KEY (user_id, zone),
  FOREIGN KEY (user_id, org_id) REFERENCES public.profiles (id, org_id) ON DELETE CASCADE
);
CREATE TABLE public.user_camera_access (
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  PRIMARY KEY (user_id, camera_id),
  FOREIGN KEY (user_id, org_id) REFERENCES public.profiles (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (camera_id, org_id) REFERENCES public.cameras (id, org_id) ON DELETE CASCADE
);

CREATE TABLE public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  actor_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_org_idx ON public.admin_audit_log (org_id, created_at DESC);

CREATE TRIGGER stores_updated BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER cameras_updated BEFORE UPDATE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER devices_updated BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Visibility rules ─────────────────────────────────────────────────────────
-- Staff who see everything (read-only for managers; admins and owners also write, but only through the server).
CREATE OR REPLACE FUNCTION public.is_staff_all() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.current_user_role() IN ('manager', 'admin', 'platform_owner'), false)
$$;

-- Stores the caller may see because of a store grant, a zone grant or their own store login.
CREATE OR REPLACE FUNCTION public.granted_store_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id FROM stores s
  WHERE s.org_id = public.current_org_id()
    AND (
      s.id IN (SELECT store_id FROM user_store_access WHERE user_id = auth.uid())
      OR s.zone IN (SELECT zone FROM user_zone_access WHERE user_id = auth.uid())
      OR s.id = (SELECT store_id FROM profiles WHERE id = auth.uid())
    )
$$;

CREATE OR REPLACE FUNCTION public.visible_store_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id FROM stores s WHERE s.org_id = public.current_org_id() AND public.is_staff_all()
  UNION
  SELECT public.granted_store_ids()
  UNION
  SELECT c.store_id FROM cameras c
  JOIN user_camera_access a ON a.camera_id = c.id
  WHERE a.user_id = auth.uid() AND c.org_id = public.current_org_id()
$$;

CREATE OR REPLACE FUNCTION public.visible_camera_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id FROM cameras c WHERE c.org_id = public.current_org_id() AND public.is_staff_all()
  UNION
  SELECT a.camera_id FROM user_camera_access a JOIN cameras c ON c.id = a.camera_id
  WHERE a.user_id = auth.uid() AND c.org_id = public.current_org_id()
  UNION
  -- Cameras of granted stores, except in a store where the caller has individual camera grants (then only those).
  SELECT c.id FROM cameras c
  WHERE c.org_id = public.current_org_id()
    AND c.store_id IN (SELECT public.granted_store_ids())
    AND c.store_id NOT IN (
      SELECT c2.store_id FROM cameras c2 JOIN user_camera_access a ON a.camera_id = c2.id WHERE a.user_id = auth.uid()
    )
$$;

CREATE OR REPLACE FUNCTION public.visible_device_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id FROM devices d WHERE d.org_id = public.current_org_id() AND public.is_staff_all()
  UNION
  SELECT d.id FROM devices d WHERE d.org_id = public.current_org_id() AND d.store_id IN (SELECT public.granted_store_ids())
$$;

REVOKE EXECUTE ON FUNCTION public.is_staff_all(), public.granted_store_ids(), public.visible_store_ids(),
  public.visible_camera_ids(), public.visible_device_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff_all(), public.granted_store_ids(), public.visible_store_ids(),
  public.visible_camera_ids(), public.visible_device_ids() TO authenticated, service_role;

-- ── Row-level security ───────────────────────────────────────────────────────
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_store_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_zone_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_camera_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- The visible_* functions are called through (SELECT ...) so they run once per query, not once per row.
CREATE POLICY stores_select ON public.stores FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.visible_store_ids()));
CREATE POLICY cameras_select ON public.cameras FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.visible_camera_ids()));
CREATE POLICY devices_select ON public.devices FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.visible_device_ids()));

CREATE POLICY user_store_access_select ON public.user_store_access FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = auth.uid() OR (SELECT public.current_user_role()) IN ('admin', 'platform_owner')));
CREATE POLICY user_zone_access_select ON public.user_zone_access FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = auth.uid() OR (SELECT public.current_user_role()) IN ('admin', 'platform_owner')));
CREATE POLICY user_camera_access_select ON public.user_camera_access FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = auth.uid() OR (SELECT public.current_user_role()) IN ('admin', 'platform_owner')));
CREATE POLICY admin_audit_log_select ON public.admin_audit_log FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.current_user_role()) IN ('admin', 'platform_owner'));

-- Signed-in users can only read. Every write goes through the server with the service role.
REVOKE ALL ON public.stores, public.cameras, public.devices, public.user_store_access, public.user_zone_access,
  public.user_camera_access, public.admin_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stores, public.cameras, public.devices, public.user_store_access, public.user_zone_access,
  public.user_camera_access, public.admin_audit_log TO authenticated;
GRANT ALL ON public.stores, public.cameras, public.devices, public.user_store_access, public.user_zone_access,
  public.user_camera_access, public.admin_audit_log TO service_role;

-- ── Server-only helpers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  SELECT nvr_secret_id INTO v_existing FROM stores WHERE id = p_store;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown store'; END IF;
  IF v_existing IS NULL THEN
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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds
  WHERE ds.id = (SELECT nvr_secret_id FROM public.stores WHERE id = p_store)
$$;

CREATE OR REPLACE FUNCTION public.nvr_delete_credential(p_store uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
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

-- Replaces all of one person's grants in one step. Refuses stores and cameras of another organisation.
CREATE OR REPLACE FUNCTION public.replace_user_access(p_user uuid, p_stores uuid[], p_zones text[], p_cameras uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM profiles WHERE id = p_user;
  IF v_org IS NULL THEN RAISE EXCEPTION 'unknown user'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_stores) AS s(id) WHERE NOT EXISTS (SELECT 1 FROM stores WHERE stores.id = s.id AND org_id = v_org)) THEN
    RAISE EXCEPTION 'store outside organisation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_cameras) AS c(id) WHERE NOT EXISTS (SELECT 1 FROM cameras WHERE cameras.id = c.id AND org_id = v_org)) THEN
    RAISE EXCEPTION 'camera outside organisation';
  END IF;
  DELETE FROM user_store_access WHERE user_id = p_user;
  DELETE FROM user_zone_access WHERE user_id = p_user;
  DELETE FROM user_camera_access WHERE user_id = p_user;
  INSERT INTO user_store_access (org_id, user_id, store_id) SELECT DISTINCT v_org, p_user, s.id FROM unnest(p_stores) AS s(id);
  INSERT INTO user_zone_access (org_id, user_id, zone) SELECT DISTINCT v_org, p_user, z.zone FROM unnest(p_zones) AS z(zone);
  INSERT INTO user_camera_access (org_id, user_id, camera_id) SELECT DISTINCT v_org, p_user, c.id FROM unnest(p_cameras) AS c(id);
END
$$;

REVOKE EXECUTE ON FUNCTION public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid),
  public.nvr_delete_credential(uuid), public.replace_user_access(uuid, uuid[], text[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid),
  public.nvr_delete_credential(uuid), public.replace_user_access(uuid, uuid[], text[], uuid[]) TO service_role;

COMMIT;
