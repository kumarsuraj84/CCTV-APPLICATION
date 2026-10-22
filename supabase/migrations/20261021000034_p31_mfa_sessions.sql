-- P3-1 (WP-3.3, decision D-10, ruling D-10a, tracker SO-1 and LG-34): the multi-factor switch, the session facts the app's gate needs,
-- the durable sign-in audit and the single-session end used by "Confirm it's you".
--
--   * security_settings.mfa_enforced (per organisation, default false = the local development stack keeps working). Written only by the
--     database owner (psql, docs/drishti/runbook-tls.md "Switch multi-factor on"), never through the API, so a stolen administrator
--     session or a server key cannot switch it off. Tests use security_settings_set_mfa_test (test organisations only).
--   * mfa_enforced() reads it for the caller; mfa_enforced_for_user(p) for any person. access_grants_of (every access decision) now
--     uses the person's own organisation, so the media-session checks of the gateway (another caller) follow the same switch.
--     The rule itself is unchanged since P2-1: a capability with requires_mfa counts only in an aal2 session while the switch is on.
--   * my_session_status(): about the caller only — the switch, whether they are "privileged" (administrative role, or any live grant of
--     a capability that requires MFA), the session's level (aal2), whether they have a verified authenticator app, the session id, the
--     sign-in time (earliest amr timestamp) and the last authentication (latest amr timestamp: password or code). Read from the token
--     PostgREST verified, never from anything the browser says.
--   * auth_events + auth_event_record(): append-only audit of sign-ins, sign-outs, failed sign-ins, expired sessions, multi-factor
--     enrolment, codes, resets and confirmations. Never a password, code, secret or token; a typed e-mail address only as a hash.
--   * auth_session_end(user, session): ends exactly one sign-in of that person (its refresh tokens go with it).
-- Rollback: supabase/rollback/20261021000034_p31_mfa_sessions_rollback.sql (dry run: BEGIN; \i …; ROLLBACK;).

BEGIN;

-- ── 1. The switch ────────────────────────────────────────────────────────────
ALTER TABLE public.security_settings ADD COLUMN mfa_enforced boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.security_settings.mfa_enforced IS
  'P3-1: when true, administrators and holders of requires_mfa capabilities need an aal2 session for those capabilities (D-10). Database owner only.';

CREATE FUNCTION public.mfa_enforced_for_user(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.mfa_enforced FROM public.security_settings s JOIN public.profiles p ON p.org_id = s.org_id WHERE p.id = p_user), false)
$$;
REVOKE ALL ON FUNCTION public.mfa_enforced_for_user(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- The caller's organisation (signed-in people; false for the service roles, which have no person).
CREATE OR REPLACE FUNCTION public.mfa_enforced() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = '' AS $$ SELECT public.mfa_enforced_for_user((SELECT auth.uid())) $$;
REVOKE ALL ON FUNCTION public.mfa_enforced() FROM PUBLIC, anon, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_enforced() TO authenticated, service_role;

-- Same body as 20261021000012 except the switch: the person's own organisation instead of the caller's.
CREATE OR REPLACE FUNCTION public.access_grants_of(p_user uuid, p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS TABLE (org_id uuid, capability text, area text, scope_kind text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM public.access_grants_eval(p_user, p_at, p_ignore_status, p_aal2, public.mfa_enforced_for_user(p_user))
$$;

-- Tests only: the switch of a TEST organisation (inventory_require_test_org refuses every other one).
CREATE FUNCTION public.security_settings_set_mfa_test(p_org uuid, p_mfa_enforced boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.inventory_require_test_org(p_org);
  INSERT INTO public.security_settings (org_id, mfa_enforced, note) VALUES (p_org, p_mfa_enforced, 'test fixture')
  ON CONFLICT (org_id) DO UPDATE SET mfa_enforced = EXCLUDED.mfa_enforced, updated_at = now();
END
$$;
REVOKE ALL ON FUNCTION public.security_settings_set_mfa_test(uuid, boolean) FROM PUBLIC, anon, authenticated, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.security_settings_set_mfa_test(uuid, boolean) TO service_role;

-- ── 2. The caller's session ──────────────────────────────────────────────────
CREATE FUNCTION public.my_session_status()
RETURNS TABLE (mfa_enforced boolean, privileged boolean, aal2 boolean, has_factor boolean, session_id uuid, signed_in_at timestamptz, last_auth_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH me AS (SELECT (SELECT auth.uid()) AS id, (SELECT auth.jwt()) AS claims),
  amr AS (
    SELECT pg_catalog.to_timestamp((e ->> 'timestamp')::bigint) AS at
    FROM me CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      CASE WHEN pg_catalog.jsonb_typeof(me.claims -> 'amr') = 'array' THEN me.claims -> 'amr' ELSE '[]'::jsonb END) e
    WHERE (e ->> 'timestamp') ~ '^[0-9]{1,12}$'
  )
  SELECT
    public.mfa_enforced_for_user(me.id),
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = me.id AND p.is_active AND p.role IN ('admin', 'platform_owner'))
      OR EXISTS (SELECT 1 FROM public.access_grants_eval(me.id, now(), false, true, true) g
                 JOIN public.capabilities c ON c.key = g.capability WHERE c.requires_mfa),
    public.access_aal2_of(me.claims),
    EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = me.id AND f.status::text = 'verified'),
    CASE WHEN (me.claims ->> 'session_id') ~ '^[0-9a-fA-F-]{36}$' THEN (me.claims ->> 'session_id')::uuid END,
    (SELECT min(at) FROM amr),
    (SELECT max(at) FROM amr)
  FROM me
  WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.my_session_status() FROM PUBLIC, anon, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.my_session_status() TO authenticated;

-- ── 3. Sign-in audit ─────────────────────────────────────────────────────────
CREATE TABLE public.auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: a failed sign-in for an address that belongs to nobody (kept as a hash only).
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid,   -- no foreign key: the history outlives the person
  actor_id uuid,  -- somebody else who caused it (an administrator's "sign out everywhere" or factor reset)
  event text NOT NULL CHECK (event IN (
    'sign_in', 'sign_in_failed', 'sign_out', 'sign_out_everywhere', 'session_expired_idle', 'session_expired_absolute',
    'mfa_enrolled', 'mfa_verified', 'mfa_failed', 'mfa_removed', 'mfa_factor_reset', 'reauth', 'reauth_failed')),
  email_hash text CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$'),
  ip text CHECK (ip IS NULL OR length(ip) <= 64),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_org_at_idx ON public.auth_events (org_id, at DESC);
CREATE INDEX auth_events_user_at_idx ON public.auth_events (user_id, at DESC);
CREATE INDEX auth_events_hash_at_idx ON public.auth_events (email_hash, at DESC) WHERE email_hash IS NOT NULL;
ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_events FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.auth_events TO authenticated, service_role;
CREATE POLICY auth_events_select ON public.auth_events FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.audit.read')));

-- Append-only: nobody updates a row (no UPDATE/DELETE privilege for anyone either; only deleting the organisation removes them).
CREATE FUNCTION public.auth_events_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'sign-in events are append-only' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.auth_events_immutable() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER auth_events_no_update BEFORE UPDATE ON public.auth_events FOR EACH ROW EXECUTE FUNCTION public.auth_events_immutable();

CREATE FUNCTION public.auth_event_record(
  p_event text, p_user uuid, p_email text, p_email_hash text, p_actor uuid, p_ip text, p_user_agent text, p_detail jsonb
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := p_user;
  v_org uuid;
  v_id uuid;
BEGIN
  IF v_user IS NULL AND p_email IS NOT NULL THEN
    SELECT p.id INTO v_user FROM public.profiles p WHERE lower(p.email) = lower(p_email) ORDER BY p.created_at LIMIT 1;
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT p.org_id INTO v_org FROM public.profiles p WHERE p.id = v_user;
  END IF;
  IF v_org IS NULL AND p_actor IS NOT NULL THEN
    SELECT p.org_id INTO v_org FROM public.profiles p WHERE p.id = p_actor;
  END IF;
  INSERT INTO public.auth_events (org_id, user_id, actor_id, event, email_hash, ip, user_agent, detail)
  VALUES (v_org, v_user, p_actor, p_event, p_email_hash, left(p_ip, 64), left(p_user_agent, 200), coalesce(p_detail, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.auth_event_record(text, uuid, text, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.auth_event_record(text, uuid, text, text, uuid, text, text, jsonb) TO app_web, service_role;

-- ── 4. One sign-in ends ──────────────────────────────────────────────────────
CREATE FUNCTION public.auth_session_end(p_user uuid, p_session uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Its refresh tokens are removed with it (ON DELETE CASCADE).
  DELETE FROM auth.sessions s WHERE s.id = p_session AND s.user_id = p_user;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION public.auth_session_end(uuid, uuid) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.auth_session_end(uuid, uuid) TO app_web, service_role;

-- ── 5. Who has an authenticator app (the people screen) ──────────────────────
-- Server only (the web app's role, after requireAdministration('admin.users')): the people of ONE organisation with a verified
-- factor and how many. Nothing about the factor itself (no secret, no name).
CREATE FUNCTION public.mfa_factor_people(p_org uuid) RETURNS TABLE (user_id uuid, factors integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, count(*)::integer FROM public.profiles p JOIN auth.mfa_factors f ON f.user_id = p.id
  WHERE p.org_id = p_org AND f.status::text = 'verified' GROUP BY p.id
$$;
REVOKE ALL ON FUNCTION public.mfa_factor_people(uuid) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_factor_people(uuid) TO app_web, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
