BEGIN;
DROP TABLE IF EXISTS public.profiles;
DROP TABLE IF EXISTS public.organizations;
DROP FUNCTION IF EXISTS public.current_user_role();
DROP FUNCTION IF EXISTS public.current_org_id();
DROP FUNCTION IF EXISTS public.set_updated_at();
DROP TYPE IF EXISTS public.user_role;
COMMIT;
