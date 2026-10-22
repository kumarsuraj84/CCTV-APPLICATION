-- P2-2 fix round 1 (review I-1, M-2).
-- I-1: check_state.error and check_state.method hold the checker's own words about recorders (refused logins, saved addresses and
-- passwords, login methods). Row security showed them to everybody who may see the camera. Signed-in people now read every column of
-- check_state except those two; the reasons come through status_reasons(), which gives the checker's text only with the IT view and
-- otherwise, for a camera, the camera-terms reason. Checked for the same class of leak (see the P2-2 report, fix round 1): outages.cause
-- is limited to 'nvr_down' by its constraint (camera availability, the same as "Recorder not reachable"); store_status (security
-- invoker) uses only status and time columns; devices (address, notes), store_nvr_endpoints and camera_endpoints already need the IT
-- view; stores and cameras have no address columns for signed-in people (P2-1).
-- M-2: the organisation-wide profile read no longer names a role: admin.users (organisation scope only) decides.
BEGIN;

REVOKE SELECT ON public.check_state FROM authenticated;
GRANT SELECT (id, org_id, target_type, target_id, status, last_checked_at, last_up_at, first_failure_at, down_since, consecutive_failures,
              created_at, updated_at)
  ON public.check_state TO authenticated;

-- The reason a target is offline, for the caller. Rows only for targets the caller may see: a camera with any CCTV capability, a device
-- with the IT view of it, an NVR (its store) with the IT view of the store. A camera's reason is the checker's text only with the IT
-- view of its location; otherwise 'Recorder not reachable.' when its NVR is down (method nvr_down), else 'The camera is not responding.'.
CREATE OR REPLACE FUNCTION public.status_reasons(p_type text, p_ids uuid[])
RETURNS TABLE (target_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
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

COMMENT ON FUNCTION public.status_reasons(text, uuid[]) IS
  'Why targets are offline, for the caller (P2-2 fix I-1): the checker''s text only with the IT view; camera-terms reasons otherwise.';

REVOKE EXECUTE ON FUNCTION public.status_reasons(text, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.status_reasons(text, uuid[]) TO authenticated;

DROP POLICY profiles_select_org ON public.profiles;
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.users')));

COMMIT;
