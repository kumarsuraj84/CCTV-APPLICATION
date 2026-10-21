-- Hardening carried over from Plan 1: closed default privileges, foreign-key indexes, device uniqueness, safer vault helper.
-- Rollback: supabase/rollback/20261021000004_hardening_rollback.sql
BEGIN;

-- New tables, sequences and functions created by this role in `public` no longer start open to anon and authenticated.
-- Every migration must grant explicitly (SELECT to authenticated where people may read, everything to service_role).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
-- Functions are executable by PUBLIC by default; close that too (global default for this role).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- A check that fails when any public table can be written by signed-in users, is readable by anon, or when default access is open.
CREATE OR REPLACE FUNCTION public.privilege_violations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT format('%s: authenticated has %s', c.relname, a.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
    AND a.privilege_type <> 'SELECT'
  UNION ALL
  SELECT format('%s: anon has %s', c.relname, a.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
  UNION ALL
  SELECT format('default privileges still give %s access to new objects of kind %s', r.rolname, d.defaclobjtype)
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
    AND r.rolname IN ('anon', 'authenticated')
$$;

REVOKE EXECUTE ON FUNCTION public.privilege_violations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

-- Foreign-key columns without an index make deletes of stores and cameras scan these tables.
CREATE INDEX IF NOT EXISTS user_store_access_store_idx ON public.user_store_access (store_id);
CREATE INDEX IF NOT EXISTS user_camera_access_camera_idx ON public.user_camera_access (camera_id);
CREATE INDEX IF NOT EXISTS profiles_store_idx ON public.profiles (store_id);

-- One device per address and port; two devices with no port and the same address count as the same device (PostgreSQL 15+).
ALTER TABLE public.devices
  ADD CONSTRAINT devices_org_ip_port_key UNIQUE NULLS NOT DISTINCT (org_id, ip, tcp_port);

-- Safer vault helper: locks the store row, refuses an empty secret, and recovers from a pointer to a vault row that is gone.
CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_secret IS NULL OR btrim(p_secret) = '' THEN RAISE EXCEPTION 'empty secret'; END IF;
  SELECT nvr_secret_id INTO v_existing FROM stores WHERE id = p_store FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown store'; END IF;
  IF v_existing IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = v_existing) THEN
    v_existing := NULL;
  END IF;
  IF v_existing IS NULL THEN
    DELETE FROM vault.secrets WHERE name = 'nvr:' || p_store::text;
    v_id := vault.create_secret(p_secret, 'nvr:' || p_store::text, 'NVR login for a store');
    UPDATE stores SET nvr_secret_id = v_id WHERE id = p_store;
  ELSE
    PERFORM vault.update_secret(v_existing, p_secret);
    v_id := v_existing;
  END IF;
  RETURN v_id;
END
$$;

COMMIT;
