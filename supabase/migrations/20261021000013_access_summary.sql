-- P2-2 (WP-2.1b): the signed-in person's capability summary in one call.
-- The app needs, once per request, which capabilities count for the caller right now and at which scopes, to decide what to show
-- (navigation, page gates, buttons, lists). Doing that with has_capability() would be 28 calls, and reading access_grants rows would
-- copy the rules of access_grants_of (active, password chosen, not revoked, valid now, MFA when enforced) into the app. This function
-- uses access_grants_of itself, so the rules stay in one place. It returns the GRANTED scopes (not their expansion): the organisation
-- flag and the specific location / camera / asset ids. Decisions about one resource still use has_capability_for /
-- cameras_with_capability / capability_store_ids.
BEGIN;

CREATE OR REPLACE FUNCTION public.my_access_summary()
RETURNS TABLE (capability text, organization_wide boolean, location_ids uuid[], camera_ids uuid[], asset_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.capability,
         bool_or(g.scope_kind = 'organization'),
         coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'location'), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'camera'), '{}'::uuid[]),
         coalesce(array_agg(DISTINCT g.scope_id) FILTER (WHERE g.scope_kind = 'asset'), '{}'::uuid[])
  FROM public.access_grants_of((SELECT auth.uid()), now(), false, public.access_caller_aal2()) g
  GROUP BY g.capability
  ORDER BY g.capability
$$;

COMMENT ON FUNCTION public.my_access_summary() IS
  'The caller''s effective capabilities now, with their granted scopes (P2-2). For display decisions and page gates; per-resource checks use has_capability_for / cameras_with_capability.';

REVOKE EXECUTE ON FUNCTION public.my_access_summary() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_access_summary() TO authenticated;

COMMIT;
