-- Owner ruling P-1 (docs/drishti/DECISIONS.md): the platform owner ("Super administrator" on screen) holds EVERY catalogue capability
-- at organisation scope, as explicit grants (source manual, reason 'Platform owner: all capabilities'), so access stays explicit,
-- auditable and revocable. This keeps it so:
--   * grant_platform_owner_all(org, user): gives an active platform owner every capability they do not hold yet (monotonic, through
--     access_put_grant without an acting person, i.e. the database's own act). The admin UI calls it when it creates a platform owner.
--     Restoring a removed right later ("Full rights" in the access editor) is an ordinary grant by another super administrator.
--   * a trigger on the catalogue: a capability added later is granted at once to every active platform owner of every organisation;
--   * a trigger on profiles: when a person's role becomes platform_owner, or a platform owner is reactivated, the full set is given
--     (what was revoked meanwhile comes back: "full rights" is the definition of the role).
-- Not exempt: MFA (D-10), fresh authentication, audit and the recorded reason for high-risk grants given by people (20261021000015).
-- Demoting a platform owner keeps their grants (a role change never changes grants); an administrator removes them in the editor.
-- Rollback: supabase/rollback/20261021000016_platform_owner_full_rights_rollback.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.grant_platform_owner_all(p_org uuid, p_user uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text;
  v_put record;
  v_added integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org AND p.role = 'platform_owner' AND p.is_active) THEN
    RAISE EXCEPTION 'not an active platform owner of this organisation' USING ERRCODE = '42501';
  END IF;
  PERFORM public.access_lock_person(p_org, p_user, NULL);
  FOR v_cap IN SELECT c.key FROM public.capabilities c WHERE 'organization' = ANY (c.scope_kinds) ORDER BY c.key LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'),
      NULL, 'Platform owner: all capabilities', 'manual', false);
    IF v_put.added THEN v_added := v_added + 1; END IF;
  END LOOP;
  IF v_added > 0 THEN PERFORM public.access_bump_version(p_user); END IF;
  RETURN v_added;
END
$$;

-- A capability added to the catalogue is granted to every active platform owner.
CREATE OR REPLACE FUNCTION public.capabilities_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner record;
  v_put record;
BEGIN
  IF NOT ('organization' = ANY (NEW.scope_kinds)) THEN RETURN NULL; END IF;
  FOR v_owner IN SELECT p.id, p.org_id FROM public.profiles p WHERE p.role = 'platform_owner' AND p.is_active ORDER BY p.org_id, p.id LOOP
    PERFORM public.access_lock_person(v_owner.org_id, v_owner.id, NULL);
    SELECT * INTO v_put FROM public.access_put_grant(v_owner.org_id, v_owner.id, jsonb_build_object('capability', NEW.key, 'scope_kind', 'organization'),
      NULL, 'Platform owner: all capabilities', 'manual', false);
    IF v_put.added THEN PERFORM public.access_bump_version(v_owner.id); END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER capabilities_grant_platform_owners AFTER INSERT ON public.capabilities
  FOR EACH ROW EXECUTE FUNCTION public.capabilities_after_insert();

-- Becoming a platform owner, or being reactivated as one, gives the full set.
CREATE OR REPLACE FUNCTION public.profiles_platform_owner_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.grant_platform_owner_all(NEW.org_id, NEW.id);
  RETURN NULL;
END
$$;
CREATE TRIGGER profiles_platform_owner_full_rights AFTER UPDATE OF role, is_active ON public.profiles
  FOR EACH ROW
  WHEN (NEW.role = 'platform_owner' AND NEW.is_active AND (OLD.role IS DISTINCT FROM NEW.role OR NOT OLD.is_active))
  EXECUTE FUNCTION public.profiles_platform_owner_after_update();

-- TEST HELPER: proves the catalogue trigger without leaving a capability behind. It inserts a probe capability inside a block that is
-- always rolled back, and returns the people of the given test organisation (slug "test-…") who held it at that moment.
CREATE OR REPLACE FUNCTION public.access_catalogue_probe_test(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_holders jsonb := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'the probe only runs for test organisations' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)
    VALUES ('it.zz_catalogue_probe', 'it', 'Probe (test only, always rolled back)', 'low', false, ARRAY['organization', 'location', 'asset']);
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_holders
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe' AND g.revoked_at IS NULL AND g.scope_kind = 'organization';
    RAISE EXCEPTION 'probe rolled back' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- everything inside the block, the probe capability and its grants included, is undone
  END;
  RETURN v_holders;
END
$$;
COMMENT ON FUNCTION public.access_catalogue_probe_test(uuid) IS 'TEST HELPER ONLY: works only on organisations whose slug starts with "test-"; changes nothing.';

REVOKE EXECUTE ON FUNCTION public.grant_platform_owner_all(uuid, uuid), public.capabilities_after_insert(),
  public.profiles_platform_owner_after_update(), public.access_catalogue_probe_test(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.grant_platform_owner_all(uuid, uuid), public.access_catalogue_probe_test(uuid) TO service_role;

COMMIT;
