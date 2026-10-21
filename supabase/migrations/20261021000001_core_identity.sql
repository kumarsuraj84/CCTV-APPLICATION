-- Core identity: organisations, profiles, role helpers. Rollback: supabase/rollback/20261021000001_core_identity_rollback.sql
BEGIN;

CREATE TYPE public.user_role AS ENUM ('user', 'agent', 'manager', 'admin', 'platform_owner');

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  is_owner boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role public.user_role NOT NULL DEFAULT 'user',
  is_active boolean NOT NULL DEFAULT true,
  -- A new or admin-reset account must choose its own password before anything else works.
  must_reset_password boolean NOT NULL DEFAULT true,
  store_id uuid,  -- foreign key to stores is added in the next migration
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_org_idx ON public.profiles (org_id);
CREATE UNIQUE INDEX profiles_org_email_idx ON public.profiles (org_id, lower(email));

CREATE TRIGGER organizations_updated BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Caller identity. A person who still has to choose a password, or who is deactivated, has no organisation and no role.
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid() AND is_active AND NOT coalesce(must_reset_password, false)
$$;

CREATE OR REPLACE FUNCTION public.current_user_role() RETURNS public.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE id = auth.uid() AND is_active AND NOT coalesce(must_reset_password, false)
$$;

REVOKE EXECUTE ON FUNCTION public.current_org_id(), public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_org_id(), public.current_user_role() TO authenticated, service_role;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_select ON public.organizations FOR SELECT TO authenticated
  USING (id = (SELECT public.current_org_id()));

-- Anyone may read their own profile (the app needs it to send them to the password page); staff read the whole organisation.
CREATE POLICY profiles_select_self ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.current_user_role()) IN ('manager', 'admin', 'platform_owner'));

REVOKE ALL ON public.organizations, public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organizations, public.profiles TO authenticated;
GRANT ALL ON public.organizations, public.profiles TO service_role;

COMMIT;
