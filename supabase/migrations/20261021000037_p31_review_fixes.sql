-- P3-1 review round 1 (.superpowers/sdd/drishti/p3-1-review.md), the database half.
--
--   M-9  mfa_used_codes + mfa_code_claim(user, hash): a code of an authenticator app counts once per person. GoTrue 2.197 accepts the
--        same code again within its window (measured: a second session and the first one both accepted it), so the web app claims the
--        code (a hash of person and code) BEFORE asking the auth server; a second claim within three minutes is refused.
--   I-4  mfa_enrolment_events(org): when and from which address each person of the organisation last set up an authenticator app
--        (the latest mfa_enrolled event of auth_events), for the people screen.
--   M-4  auth_events: no DELETE and no TRUNCATE, not even by a role that is given the privilege later (deleting the organisation
--        still removes its rows: a cascade is let through). auth_events_guard_status() lets the tests see the guards.
--   M-5  every change of security_settings.mfa_enforced is written to admin_audit_log (old and new value, the database user).
-- Rollback: supabase/rollback/20261021000037_p31_review_fixes_rollback.sql (no BEGIN/COMMIT inside; dry run: BEGIN; \i …; ROLLBACK;).

BEGIN;

-- ── M-9: one use per code ─────────────────────────────────────────────────────
CREATE TABLE public.mfa_used_codes (
  user_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);
ALTER TABLE public.mfa_used_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mfa_used_codes FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.mfa_used_codes TO service_role;

-- True when this person had not used this code in the last three minutes (it is now recorded), false when it was used already.
CREATE FUNCTION public.mfa_code_claim(p_user uuid, p_hash text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_user IS NULL OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'a person and a code hash are needed' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.mfa_used_codes u WHERE u.user_id = p_user AND u.used_at < now() - interval '3 minutes';
  INSERT INTO public.mfa_used_codes (user_id, code_hash) VALUES (p_user, p_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$$;
REVOKE ALL ON FUNCTION public.mfa_code_claim(uuid, text) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_code_claim(uuid, text) TO app_web, service_role;

-- ── I-4: when and from where each person set up their app ─────────────────────
CREATE FUNCTION public.mfa_enrolment_events(p_org uuid) RETURNS TABLE (user_id uuid, enrolled_at timestamptz, enrolled_ip text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT ON (e.user_id) e.user_id, e.at, e.ip
  FROM public.auth_events e
  WHERE e.org_id = p_org AND e.event = 'mfa_enrolled' AND e.user_id IS NOT NULL
  ORDER BY e.user_id, e.at DESC
$$;
REVOKE ALL ON FUNCTION public.mfa_enrolment_events(uuid) FROM PUBLIC, anon, authenticated, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_enrolment_events(uuid) TO app_web, service_role;

-- ── M-4: no deletion of sign-in events ───────────────────────────────────────
-- A direct DELETE runs this trigger at depth 1; the cascade of an organisation's deletion runs it from inside the foreign key's own
-- trigger (depth 2) and is let through.
CREATE FUNCTION public.auth_events_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'sign-in events are append-only' USING ERRCODE = '42501';
END
$$;
REVOKE ALL ON FUNCTION public.auth_events_no_delete() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER auth_events_no_delete BEFORE DELETE ON public.auth_events FOR EACH ROW EXECUTE FUNCTION public.auth_events_no_delete();
CREATE TRIGGER auth_events_no_truncate BEFORE TRUNCATE ON public.auth_events FOR EACH STATEMENT EXECUTE FUNCTION public.auth_events_immutable();

CREATE FUNCTION public.auth_events_guard_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'update_blocked', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.auth_events'::regclass AND t.tgname = 'auth_events_no_update' AND t.tgenabled <> 'D'),
    'delete_blocked', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.auth_events'::regclass AND t.tgname = 'auth_events_no_delete' AND t.tgenabled <> 'D'),
    'truncate_blocked', EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.auth_events'::regclass AND t.tgname = 'auth_events_no_truncate' AND t.tgenabled <> 'D'))
$$;
REVOKE ALL ON FUNCTION public.auth_events_guard_status() FROM PUBLIC, anon, authenticated, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.auth_events_guard_status() TO service_role;

-- ── M-5: the switch is audited ───────────────────────────────────────────────
CREATE FUNCTION public.security_settings_audit_mfa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_from boolean := CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.mfa_enforced END;
BEGIN
  IF NEW.mfa_enforced IS DISTINCT FROM v_from THEN
    INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (NEW.org_id, NULL, 'mfa_enforced_changed', 'organization', NEW.org_id,
            pg_catalog.jsonb_build_object('from', v_from, 'to', NEW.mfa_enforced, 'db_user', session_user::text, 'note', NEW.note));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.security_settings_audit_mfa() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER security_settings_audit_mfa AFTER INSERT OR UPDATE OF mfa_enforced ON public.security_settings
  FOR EACH ROW EXECUTE FUNCTION public.security_settings_audit_mfa();

NOTIFY pgrst, 'reload schema';

COMMIT;
