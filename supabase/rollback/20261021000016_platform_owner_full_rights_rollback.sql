-- Rollback of 20261021000016_platform_owner_full_rights.sql. Grants already given to platform owners stay (they are ordinary grants,
-- revocable in the access editor); only the automatic granting stops.
BEGIN;
DROP TRIGGER IF EXISTS profiles_platform_owner_full_rights ON public.profiles;
DROP TRIGGER IF EXISTS capabilities_grant_platform_owners ON public.capabilities;
DROP FUNCTION IF EXISTS public.profiles_platform_owner_after_update();
DROP FUNCTION IF EXISTS public.capabilities_after_insert();
DROP FUNCTION IF EXISTS public.access_catalogue_probe_test(uuid);
DROP FUNCTION IF EXISTS public.grant_platform_owner_all(uuid, uuid);
COMMIT;
