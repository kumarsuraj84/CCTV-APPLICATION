-- P2-1 capability access model, part 3 of 3: row security reads only explicit grants from now on, the old model is removed.
--   * cameras: any CCTV capability (any_cctv_camera_ids); devices: it.inventory.view or it.monitoring.view only (AC-4);
--   * locations (stores): visible with any CCTV, IT or Wi-Fi grant inside; NVR address and login columns, camera addresses: only through
--     store_nvr_endpoints / camera_endpoints, for people with an IT view of that location (the vault id is never exposed);
--   * status and outages per target type: cameras with CCTV, devices and NVRs with the IT view;
--   * camera groups: only with a visible member (an empty group: its creator and admin.inventory);
--   * profiles: own row; the whole organisation for admin / platform_owner (administrative authority) or with admin.users;
--   * audit log: admin.audit.read. No role gives data access by itself (AC-8); the home store grants nothing (AC-7).
-- The old grant tables are retired: nothing reads them for access, signed-in people cannot read them, and they stay one release
-- for the migration report and its test (VA-18). Writes to grants go through grant_access / revoke_grant / replace_user_grants.
-- Rollback: supabase/rollback/20261021000011_capability_access_rls_rollback.sql
BEGIN;

-- ── Policies that read the new model ─────────────────────────────────────────
DROP POLICY stores_select ON public.stores;
DROP POLICY cameras_select ON public.cameras;
DROP POLICY devices_select ON public.devices;
DROP POLICY check_state_select ON public.check_state;
DROP POLICY outages_select ON public.outages;
DROP POLICY camera_groups_select ON public.camera_groups;
DROP POLICY camera_group_items_select ON public.camera_group_items;
DROP POLICY profiles_select_org ON public.profiles;
DROP POLICY admin_audit_log_select ON public.admin_audit_log;
DROP POLICY user_store_access_select ON public.user_store_access;
DROP POLICY user_zone_access_select ON public.user_zone_access;
DROP POLICY user_camera_access_select ON public.user_camera_access;

-- The functions are called through (SELECT ...) so they run once per query, not once per row.
CREATE POLICY stores_select ON public.stores FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.any_grant_store_ids()));
CREATE POLICY cameras_select ON public.cameras FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.any_cctv_camera_ids()));
CREATE POLICY devices_select ON public.devices FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.it_view_device_ids()));

-- A CCTV viewer sees the availability of the cameras they may view; NVR and device status needs the IT view.
CREATE POLICY check_state_select ON public.check_state FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.it_view_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.it_view_store_ids()))
    )
  );
CREATE POLICY outages_select ON public.outages FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id()) AND (
      (target_type = 'camera' AND target_id IN (SELECT public.any_cctv_camera_ids())) OR
      (target_type = 'device' AND target_id IN (SELECT public.it_view_device_ids())) OR
      (target_type = 'nvr' AND target_id IN (SELECT public.it_view_store_ids()))
    )
  );

CREATE POLICY camera_groups_select ON public.camera_groups FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.cctv_visible_group_ids()));
CREATE POLICY camera_group_items_select ON public.camera_group_items FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND camera_id IN (SELECT public.any_cctv_camera_ids()));

-- Administrative reads: administrators by their role (authority to manage people), anyone else only with admin.users.
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id())
    AND ((SELECT public.current_user_role()) IN ('admin', 'platform_owner') OR (SELECT public.has_capability('admin.users')))
  );
CREATE POLICY admin_audit_log_select ON public.admin_audit_log FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.audit.read')));

-- Own grants; the organisation's grants with admin.access.
CREATE POLICY access_grants_select ON public.access_grants FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id())
    AND (user_id = (SELECT auth.uid()) OR (SELECT public.has_capability('admin.access')))
  );

-- ── Address and login columns ────────────────────────────────────────────────
-- Column privileges are per database role, not per person, so the plain columns stay readable (row security still decides which rows)
-- and the address columns are readable only through the two views below, which add the per-person check.
REVOKE SELECT ON public.stores FROM authenticated;
GRANT SELECT (id, org_id, code, name, city, zone, state, address, is_active, expected_channels, created_at, updated_at)
  ON public.stores TO authenticated;
REVOKE SELECT ON public.cameras FROM authenticated;
GRANT SELECT (id, org_id, store_id, channel, name, is_active, created_at, updated_at) ON public.cameras TO authenticated;
-- devices keep all columns: a device row is visible only with the IT view of it, which is exactly who may see its address.

-- These views run with their owner's rights (they are not security_invoker), so they do their own filtering: the caller's
-- organisation and the IT view of the location. security_barrier keeps the filter ahead of anything the caller adds.
CREATE VIEW public.store_nvr_endpoints WITH (security_barrier = true) AS
SELECT s.id AS store_id, s.org_id, s.nvr_ip, s.rtsp_port, s.http_port, s.nvr_username
FROM public.stores s
WHERE s.org_id = (SELECT public.current_org_id()) AND s.id IN (SELECT public.it_view_store_ids());

CREATE VIEW public.camera_endpoints WITH (security_barrier = true) AS
SELECT c.id AS camera_id, c.org_id, c.store_id, c.camera_ip
FROM public.cameras c
WHERE c.org_id = (SELECT public.current_org_id()) AND c.store_id IN (SELECT public.it_view_store_ids());

COMMENT ON VIEW public.store_nvr_endpoints IS 'NVR address and login of the locations the caller has an IT view of (it.inventory.view or it.monitoring.view). Never the vault id.';
COMMENT ON VIEW public.camera_endpoints IS 'Camera addresses of the locations the caller has an IT view of.';

REVOKE ALL ON public.store_nvr_endpoints, public.camera_endpoints FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.store_nvr_endpoints, public.camera_endpoints TO authenticated, service_role;

-- ── The old model goes ───────────────────────────────────────────────────────
DROP FUNCTION public.replace_user_access(uuid, uuid[], text[], uuid[]);
DROP FUNCTION public.visible_device_ids();
DROP FUNCTION public.visible_camera_ids();
DROP FUNCTION public.visible_store_ids();
DROP FUNCTION public.granted_store_ids();
DROP FUNCTION public.is_staff_all();

-- Retired grant tables: no policy, no access for signed-in people, read by no access rule. Kept for one release (rollback, the migration
-- report and VA-18), then dropped together with the access_legacy_* functions.
REVOKE ALL ON public.user_store_access, public.user_zone_access, public.user_camera_access FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.user_store_access IS 'RETIRED in P2-1: grants nothing. Access comes only from access_grants. Drop in the next release.';
COMMENT ON TABLE public.user_zone_access IS 'RETIRED in P2-1: grants nothing. Access comes only from access_grants. Drop in the next release.';
COMMENT ON TABLE public.user_camera_access IS 'RETIRED in P2-1: grants nothing. Access comes only from access_grants. Drop in the next release.';

COMMIT;
