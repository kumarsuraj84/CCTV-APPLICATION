-- Undoes 20261021000011_capability_access_rls.sql: row security reads the old grant tables again (the old model of 0002, 0005, 0007).
-- WARNING: this brings back the behaviours the directive forbids (manager sees everything, home store grants access, store grants show
-- IT devices, camera grants narrow store grants). Grants made in access_grants after the migration are NOT copied back, and access
-- that was REVOKED in access_grants after the migration COMES BACK, because the old tables still hold the pre-migration rows. Review
-- the migration report and the revocations before running this.
-- Order: 0011, 0010, 0009, 0008 rollbacks.
BEGIN;

DROP VIEW IF EXISTS public.camera_endpoints;
DROP VIEW IF EXISTS public.store_nvr_endpoints;

DROP POLICY IF EXISTS stores_select ON public.stores;
DROP POLICY IF EXISTS cameras_select ON public.cameras;
DROP POLICY IF EXISTS devices_select ON public.devices;
DROP POLICY IF EXISTS check_state_select ON public.check_state;
DROP POLICY IF EXISTS outages_select ON public.outages;
DROP POLICY IF EXISTS camera_groups_select ON public.camera_groups;
DROP POLICY IF EXISTS camera_group_items_select ON public.camera_group_items;
DROP POLICY IF EXISTS profiles_select_org ON public.profiles;
DROP POLICY IF EXISTS admin_audit_log_select ON public.admin_audit_log;
DROP POLICY IF EXISTS access_grants_select ON public.access_grants;

-- Old visibility functions (0002, verbatim).
CREATE OR REPLACE FUNCTION public.is_staff_all() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.current_user_role() IN ('manager', 'admin', 'platform_owner'), false)
$$;
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
REVOKE EXECUTE ON FUNCTION public.replace_user_access(uuid, uuid[], text[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_access(uuid, uuid[], text[], uuid[]) TO service_role;

-- Old policies (0001, 0002, 0005, 0007).
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.current_user_role()) IN ('manager', 'admin', 'platform_owner'));
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
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.visible_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.visible_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.visible_store_ids()))
    )
  );
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.visible_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.visible_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.visible_store_ids()))
    )
  );
CREATE POLICY camera_groups_select ON public.camera_groups FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (SELECT public.is_staff_all()) OR created_by = auth.uid() OR
      id IN (SELECT group_id FROM public.camera_group_items WHERE camera_id IN (SELECT public.visible_camera_ids()))
    )
  );
CREATE POLICY camera_group_items_select ON public.camera_group_items FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND camera_id IN (SELECT public.visible_camera_ids()));

-- Whole-table reads again.
GRANT SELECT ON public.stores, public.cameras, public.user_store_access, public.user_zone_access, public.user_camera_access TO authenticated;
COMMENT ON TABLE public.user_store_access IS NULL;
COMMENT ON TABLE public.user_zone_access IS NULL;
COMMENT ON TABLE public.user_camera_access IS NULL;

COMMIT;
