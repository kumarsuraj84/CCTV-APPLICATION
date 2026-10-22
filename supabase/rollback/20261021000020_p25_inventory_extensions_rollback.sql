-- Rollback of 20261021000020_p25_inventory_extensions.sql. Removes network definitions, asset dependencies and the device capability
-- matrix, and restores the 20261021000019 body of inventory_purge_test_org.
-- WARNING: every network definition and dependency row is lost (none are made by the migration; only by people and tests).
BEGIN;
DROP TABLE IF EXISTS public.asset_dependencies;
DROP TABLE IF EXISTS public.network_definitions;
DROP TABLE IF EXISTS public.device_capabilities;
DROP FUNCTION IF EXISTS public.asset_dependencies_no_cycle();
DROP FUNCTION IF EXISTS public.network_address_conflicts(uuid);
DROP FUNCTION IF EXISTS public.network_validate_address(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.network_definitions_check();

CREATE OR REPLACE FUNCTION public.inventory_purge_test_org(p_org uuid) RETURNS jsonb
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
REVOKE ALL ON FUNCTION public.inventory_purge_test_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_purge_test_org(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
