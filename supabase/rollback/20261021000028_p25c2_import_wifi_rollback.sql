-- Rollback of 20261021000028_p25c2_import_wifi.sql (P2-5c-2). Run before the 0027 rollback. Nothing to restore verbatim: 0028 only
-- adds objects. Data written by imports (locations, NVRs, vault logins, cameras, archives) stays: it is ordinary inventory data, made
-- through the same paths as the screens (take a data-only backup first if you need the state before an import).
-- device_capabilities becomes server-only again, as P2-5a left it.
DROP FUNCTION IF EXISTS public.inventory_import_apply(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.inventory_ensure_placeholders(uuid, uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.recorder_credentials_match(uuid, jsonb);
DROP FUNCTION IF EXISTS public.wifi_inventory();
DROP POLICY IF EXISTS device_capabilities_select ON public.device_capabilities;
REVOKE ALL ON public.device_capabilities FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.device_capabilities TO service_role;
