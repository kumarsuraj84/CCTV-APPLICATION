BEGIN;
DROP FUNCTION IF EXISTS public.replace_user_access(uuid, uuid[], text[], uuid[]);
DROP FUNCTION IF EXISTS public.nvr_delete_credential(uuid);
DROP FUNCTION IF EXISTS public.nvr_read_credential(uuid);
DROP FUNCTION IF EXISTS public.nvr_store_credential(uuid, text);
DROP TABLE IF EXISTS public.admin_audit_log, public.user_camera_access, public.user_zone_access, public.user_store_access,
  public.devices, public.cameras;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_store_fk;
DROP TABLE IF EXISTS public.stores;
DROP FUNCTION IF EXISTS public.visible_device_ids();
DROP FUNCTION IF EXISTS public.visible_camera_ids();
DROP FUNCTION IF EXISTS public.visible_store_ids();
DROP FUNCTION IF EXISTS public.granted_store_ids();
DROP FUNCTION IF EXISTS public.is_staff_all();
DROP TYPE IF EXISTS public.device_type;
COMMIT;
