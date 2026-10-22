-- Rollback of 20261021000021_p25_inventory_migrate.sql. Puts every organisation back into the pre-migration shape of the seam
-- (inventory_unmigrate_org): recorders that carry a location's legacy NVR are removed, their Vault secret is renamed back to
-- nvr:<location> in place (same ciphertext) and pointed to by the location again, check_state / outages are re-keyed back to
-- ('nvr', location), mappings of those recorders are removed and the cameras unmapped. Then the migration functions and the report go.
-- WARNINGS: (1) recorders made by people after the migration (migrated_from_location_id IS NULL) are NOT removed here; the rollback of
-- 20261021000019 refuses while any are left. (2) An NVR asset that was adopted as a recorder (devices_merged) stays an asset.
-- (3) The migration report rows are lost.
BEGIN;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT o.id FROM public.organizations o ORDER BY o.created_at LOOP
    PERFORM public.inventory_unmigrate_org(r.id);
  END LOOP;
END
$$;
DROP FUNCTION IF EXISTS public.inventory_stale_name_scan();
DROP FUNCTION IF EXISTS public.inventory_secret_fingerprint_test(uuid);
DROP FUNCTION IF EXISTS public.inventory_unmigrate_org_test(uuid);
DROP FUNCTION IF EXISTS public.inventory_migrate_org_test(uuid, text);
DROP FUNCTION IF EXISTS public.inventory_require_test_org(uuid);
DROP FUNCTION IF EXISTS public.inventory_unmigrate_org(uuid);
DROP FUNCTION IF EXISTS public.inventory_migrate_org(uuid, text);
DROP TABLE IF EXISTS public.inventory_migration_report;
NOTIFY pgrst, 'reload schema';
COMMIT;
