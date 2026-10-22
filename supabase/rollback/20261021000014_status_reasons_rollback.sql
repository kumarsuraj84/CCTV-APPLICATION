-- Undoes 20261021000014_status_reasons.sql: check_state readable as a whole again (the checker's text reaches CCTV-only viewers
-- again), status_reasons gone (the P2-2 app then shows no reasons), the profile policy names the administrator roles again.
-- Run before the rollback of 0013.
BEGIN;

DROP POLICY profiles_select_org ON public.profiles;
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (
    org_id = (SELECT public.current_org_id())
    AND ((SELECT public.current_user_role()) IN ('admin', 'platform_owner') OR (SELECT public.has_capability('admin.users')))
  );

DROP FUNCTION IF EXISTS public.status_reasons(text, uuid[]);

REVOKE SELECT ON public.check_state FROM authenticated;
GRANT SELECT ON public.check_state TO authenticated;

COMMIT;
