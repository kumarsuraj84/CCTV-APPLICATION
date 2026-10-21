BEGIN;
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_org_ip_port_key;
DROP INDEX IF EXISTS public.profiles_store_idx;
DROP INDEX IF EXISTS public.user_camera_access_camera_idx;
DROP INDEX IF EXISTS public.user_store_access_store_idx;
DROP FUNCTION IF EXISTS public.privilege_violations();
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
-- nvr_store_credential keeps the safer version: restoring the older one is not worth losing the lock.
COMMIT;
