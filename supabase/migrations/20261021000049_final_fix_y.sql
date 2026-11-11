-- Release 1 final fix round, builder Y (.superpowers/sdd/drishti/final-review-A.md, final-review-B.md, final-review-C.md).
--
--  1. Two-step sign-in may not depend on a remembered manual step (A I-1, B I-1). security_settings gets an explicit, audited opt-out
--     (mfa_off_reason / mfa_off_by / mfa_off_at); security_set_mfa(org, actor, on/off, reason) is the owner-only switch (a super
--     administrator through the web app, or the database owner / service key with no person); turning it off needs a reason of 10 to 500
--     characters; every change, also one made by hand in psql, is written to admin_audit_log with the actor and the reason. On a database
--     marked as a production one (test_fixture_switch.production, set by deploy/windows/update.ps1) an organisation without a settings row
--     and a new settings row are ENFORCED by default (mfa_default_enforced()); the local stack stays off by default.
--     security_mfa_overview() (web app, service key) lists every active organisation; ops_health_status() gets a 'mfa' block of counts.
--     The web start-up and the Health page refuse / fail in production while an active organisation has it off without an opt-out.
--  2. Code guessing has a ceiling (B I-2): mfa_code_failures counts consecutive failed codes per person. mfa_code_attempt_begin counts a
--     try BEFORE the code is checked (row lock: concurrent tries never pass the limit) and refuses while locked; mfa_code_attempt_end
--     resets on a correct code, gives back a try the auth server could not judge, and records a new lock once. 10 in a row lock the code
--     step for 15 minutes, each further 10 double it (at most 24 hours); 100 in a row lock it until a super administrator clears it
--     (mfa_code_lock_clear, with a reason; auth_events and admin_audit_log). mfa_code_locks(org) for the people screen. Web app only.
--  3. A plain administrator resets a password only when the person holds nothing the administrator does not hold (A M-1):
--     access_check_password_reset(org, actor, person).
--  4. The inventory functions check the actor's right in SQL (A M-2): inventory_check_admin (super administrator, or administrator with
--     admin.inventory for the whole organisation, the import's rule); a missing actor only for the service key and the database owner.
--     inventory_restore refuses an item under an archived parent (C I-9, SQLSTATE DR040).
--  5. E-1 / rule 7 on every path (A M-3): access_grants_before_insert refuses admin.* and cctv.export for a non-administrator; an AFTER
--     UPDATE OF role trigger on profiles takes them (and the owner-only rights when leaving super administrator) away whoever changes the
--     role; change_person_role revokes first, so it still reports what it took. The row security that hangs on admin.* also needs an
--     administrative role.
--  6. Access and people changes of one organisation are serialised (A M-4): access_check_manager and access_check_people_admin take one
--     transaction advisory lock per organisation before they read the actor's own rights.
--  7. recorder_store_credential(org, recorder, secret, actor) and revoke_user_sessions(org, person) for the web app; the forms without
--     the organisation are for the service key only (A M-6). The NVR password audit row is written inside.
--  8. create_person(org, actor, person, e-mail, name, role, location): the role checked in SQL; app_web loses INSERT on profiles (A M-7).
--  9. inventory_devices_import(org, actor, rows, apply): the device CSV import in one transaction, a check without writing, empty cells
--     keep saved values (explicit clear flags), never another kind of equipment changed, messages without cell values (C I-8).
--
-- SECURITY DEFINER functions use SET search_path = '' with qualified names; explicit REVOKE / GRANT on every new or replaced function.
-- Rollback: supabase/rollback/20261021000049_final_fix_y_rollback.sql (dry run: -v drishti_dry_run=1). Comes after 0048 (final fix X),
-- whose discovery_apply body it keeps.

BEGIN;

-- ── 1. Two-step sign-in requirement ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.mfa_default_enforced() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT t.production FROM public.test_fixture_switch t WHERE t.id), false)
$$;
REVOKE ALL ON FUNCTION public.mfa_default_enforced() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

ALTER TABLE public.security_settings
  ADD COLUMN mfa_off_reason text,
  ADD COLUMN mfa_off_by uuid,
  ADD COLUMN mfa_off_at timestamptz,
  ALTER COLUMN mfa_enforced SET DEFAULT public.mfa_default_enforced();
ALTER TABLE public.security_settings ADD CONSTRAINT security_settings_mfa_off_check CHECK (
  mfa_off_reason IS NULL OR (NOT mfa_enforced AND length(btrim(mfa_off_reason)) BETWEEN 10 AND 500 AND mfa_off_at IS NOT NULL));
COMMENT ON COLUMN public.security_settings.mfa_off_reason IS
  'Final fix Y (A I-1): the audited reason two-step sign-in is switched off on purpose (security_set_mfa). Without it, a production web app refuses to start and the Health page fails while the requirement is off.';

-- On: the opt-out goes with it. A new or changed reason is stamped now.
CREATE FUNCTION public.security_settings_mfa_normalise() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.mfa_enforced THEN
    NEW.mfa_off_reason := NULL;
    NEW.mfa_off_by := NULL;
    NEW.mfa_off_at := NULL;
  ELSIF NEW.mfa_off_reason IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.mfa_off_reason IS DISTINCT FROM OLD.mfa_off_reason OR OLD.mfa_enforced OR NEW.mfa_off_at IS NULL) THEN
    NEW.mfa_off_at := now();
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.security_settings_mfa_normalise() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER security_settings_mfa_normalise BEFORE INSERT OR UPDATE ON public.security_settings
  FOR EACH ROW EXECUTE FUNCTION public.security_settings_mfa_normalise();

-- Every change of the requirement or of its reason is audited, with the acting person when the change came through security_set_mfa.
CREATE OR REPLACE FUNCTION public.security_settings_audit_mfa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_from boolean := CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.mfa_enforced END;
  v_reason_before text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.mfa_off_reason END;
  v_actor uuid;
BEGIN
  IF NEW.mfa_enforced IS DISTINCT FROM v_from OR NEW.mfa_off_reason IS DISTINCT FROM v_reason_before THEN
    BEGIN
      v_actor := nullif(pg_catalog.current_setting('drishti.actor', true), '')::uuid;
    EXCEPTION WHEN others THEN
      v_actor := NULL;
    END;
    INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (NEW.org_id, v_actor, 'mfa_enforced_changed', 'organization', NEW.org_id,
            pg_catalog.jsonb_build_object('from', v_from, 'to', NEW.mfa_enforced, 'reason', NEW.mfa_off_reason, 'db_user', session_user::text, 'note', NEW.note));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.security_settings_audit_mfa() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
DROP TRIGGER security_settings_audit_mfa ON public.security_settings;
CREATE TRIGGER security_settings_audit_mfa AFTER INSERT OR UPDATE OF mfa_enforced, mfa_off_reason ON public.security_settings
  FOR EACH ROW EXECUTE FUNCTION public.security_settings_audit_mfa();

-- A person whose organisation has no settings row: the database's default (enforced on a production database).
CREATE OR REPLACE FUNCTION public.mfa_enforced_for_user(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.mfa_enforced FROM public.security_settings s JOIN public.profiles p ON p.org_id = s.org_id WHERE p.id = p_user),
                  public.mfa_default_enforced())
$$;
REVOKE ALL ON FUNCTION public.mfa_enforced_for_user(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- Every active organisation: required or not, and whether "off" is an audited opt-out.
CREATE FUNCTION public.security_mfa_overview()
RETURNS TABLE (org_id uuid, enforced boolean, opted_out boolean, reason text, off_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id,
         coalesce(s.mfa_enforced, public.mfa_default_enforced()),
         NOT coalesce(s.mfa_enforced, public.mfa_default_enforced()) AND s.mfa_off_reason IS NOT NULL,
         s.mfa_off_reason, s.mfa_off_at
  FROM public.organizations o LEFT JOIN public.security_settings s ON s.org_id = o.id
  WHERE o.status IN ('trial', 'active')
  ORDER BY o.id
$$;
REVOKE ALL ON FUNCTION public.security_mfa_overview() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.security_mfa_overview() TO app_web, service_role;

-- The owner-only switch. A person: an active super administrator of the organisation. No person: the service key or the database owner.
CREATE FUNCTION public.security_set_mfa(p_org uuid, p_actor uuid, p_enforced boolean, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_enforced IS NULL THEN RAISE EXCEPTION 'on or off?' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org) THEN RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF p_actor IS NULL THEN
    IF public.service_caller_role() NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'only a super administrator may change the two-step sign-in requirement' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password
                    AND p.role = 'platform_owner') THEN
    RAISE EXCEPTION 'only a super administrator may change the two-step sign-in requirement' USING ERRCODE = '42501';
  END IF;
  IF NOT p_enforced AND (v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 500) THEN
    RAISE EXCEPTION 'switching two-step sign-in off needs a reason of 10 to 500 characters' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  INSERT INTO public.security_settings (org_id, mfa_enforced, mfa_off_reason, mfa_off_by)
  VALUES (p_org, p_enforced, CASE WHEN p_enforced THEN NULL ELSE v_reason END, CASE WHEN p_enforced THEN NULL ELSE p_actor END)
  ON CONFLICT (org_id) DO UPDATE SET mfa_enforced = EXCLUDED.mfa_enforced, mfa_off_reason = EXCLUDED.mfa_off_reason,
    mfa_off_by = EXCLUDED.mfa_off_by, updated_at = now();
  PERFORM pg_catalog.set_config('drishti.actor', '', true);
  RETURN pg_catalog.jsonb_build_object('org_id', p_org, 'enforced', p_enforced);
END
$$;
REVOKE ALL ON FUNCTION public.security_set_mfa(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.security_set_mfa(uuid, uuid, boolean, text) TO app_web, service_role;

-- ── 2. Consecutive failed codes ───────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.mfa_code_failures (
  user_id uuid PRIMARY KEY REFERENCES public.profiles (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  lockouts integer NOT NULL DEFAULT 0 CHECK (lockouts >= 0),
  locked_until timestamptz,
  locked_for_good boolean NOT NULL DEFAULT false,
  lock_recorded boolean NOT NULL DEFAULT false,
  last_failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_code_failures_org_idx ON public.mfa_code_failures (org_id);
ALTER TABLE public.mfa_code_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mfa_code_failures FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON TABLE public.mfa_code_failures TO service_role;
COMMENT ON TABLE public.mfa_code_failures IS
  'Final fix Y (B I-2): consecutive failed two-step codes per person. Written only by mfa_code_attempt_begin / _end and mfa_code_lock_clear.';

ALTER TABLE public.auth_events DROP CONSTRAINT auth_events_event_check;
ALTER TABLE public.auth_events ADD CONSTRAINT auth_events_event_check CHECK (event = ANY (ARRAY[
  'sign_in', 'sign_in_failed', 'sign_out', 'sign_out_everywhere', 'session_expired_idle', 'session_expired_absolute', 'mfa_enrolled',
  'mfa_verified', 'mfa_failed', 'mfa_removed', 'mfa_factor_reset', 'reauth', 'reauth_failed',
  'mfa_locked', 'mfa_locked_for_good', 'mfa_lock_cleared']));

-- 15 minutes for the first lock-out, doubling, at most 24 hours.
CREATE FUNCTION public.mfa_code_lock_minutes(p_lockouts integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT least(1440::numeric, 15 * pg_catalog.power(2::numeric, least(greatest(coalesce(p_lockouts, 1) - 1, 0), 20)))::integer
$$;
REVOKE ALL ON FUNCTION public.mfa_code_lock_minutes(integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- The auth_events row of a lock (written once per lock).
CREATE FUNCTION public.mfa_code_lock_record(p_user uuid, p_org uuid, p_failures integer, p_lockouts integer, p_for_good boolean) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.auth_events (org_id, user_id, event, detail)
  VALUES (p_org, p_user, CASE WHEN p_for_good THEN 'mfa_locked_for_good' ELSE 'mfa_locked' END,
          CASE WHEN p_for_good THEN pg_catalog.jsonb_build_object('failures', p_failures)
               ELSE pg_catalog.jsonb_build_object('failures', p_failures, 'minutes', public.mfa_code_lock_minutes(p_lockouts)) END)
$$;
REVOKE ALL ON FUNCTION public.mfa_code_lock_record(uuid, uuid, integer, integer, boolean) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- Before a code is checked. The try counts as a failure from now on (until mfa_code_attempt_end says it was right), so tries made at
-- the same moment queue on the row and never pass the limit. Refused while locked. An unknown person: the plain "go ahead" answer and
-- nothing stored (the web app asks only for the signed-in person's own id; the answer says nothing about factors).
CREATE FUNCTION public.mfa_code_attempt_begin(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  r public.mfa_code_failures%ROWTYPE;
  v_n integer;
  v_locks boolean := false;
BEGIN
  IF p_user IS NULL THEN RAISE EXCEPTION 'a person is needed' USING ERRCODE = '22023'; END IF;
  SELECT p.org_id INTO v_org FROM public.profiles p WHERE p.id = p_user;
  IF v_org IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('allowed', true, 'locked_until', NULL, 'for_good', false, 'locks_if_wrong', false);
  END IF;
  INSERT INTO public.mfa_code_failures (user_id, org_id) VALUES (p_user, v_org) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO r FROM public.mfa_code_failures f WHERE f.user_id = p_user FOR UPDATE;
  IF r.locked_for_good OR (r.locked_until IS NOT NULL AND r.locked_until > now()) THEN
    IF NOT r.lock_recorded THEN
      PERFORM public.mfa_code_lock_record(p_user, r.org_id, r.failures, r.lockouts, r.locked_for_good);
      UPDATE public.mfa_code_failures SET lock_recorded = true, updated_at = now() WHERE user_id = p_user;
    END IF;
    RETURN pg_catalog.jsonb_build_object('allowed', false, 'locked_until', CASE WHEN r.locked_for_good THEN NULL ELSE r.locked_until END,
                                         'for_good', r.locked_for_good, 'locks_if_wrong', false);
  END IF;
  v_n := r.failures + 1;
  IF v_n >= 100 THEN
    UPDATE public.mfa_code_failures SET failures = v_n, locked_for_good = true, locked_until = NULL, lock_recorded = false, updated_at = now()
    WHERE user_id = p_user;
    v_locks := true;
  ELSIF v_n % 10 = 0 THEN
    UPDATE public.mfa_code_failures SET failures = v_n, lockouts = r.lockouts + 1,
           locked_until = now() + pg_catalog.make_interval(mins => public.mfa_code_lock_minutes(r.lockouts + 1)), lock_recorded = false, updated_at = now()
    WHERE user_id = p_user;
    v_locks := true;
  ELSE
    UPDATE public.mfa_code_failures SET failures = v_n, updated_at = now() WHERE user_id = p_user;
  END IF;
  RETURN pg_catalog.jsonb_build_object('allowed', true, 'locked_until', NULL, 'for_good', false, 'locks_if_wrong', v_locks);
END
$$;
REVOKE ALL ON FUNCTION public.mfa_code_attempt_begin(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_code_attempt_begin(uuid) TO app_web, service_role;

-- After the auth server answered: 'correct' resets everything; 'not_counted' (the auth server could not judge the code) gives the try
-- back unless it set a lock (a lock stays: fail closed); 'wrong' records a lock it caused, once.
CREATE FUNCTION public.mfa_code_attempt_end(p_user uuid, p_outcome text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.mfa_code_failures%ROWTYPE;
  v_locked boolean;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('correct', 'wrong', 'not_counted') THEN RAISE EXCEPTION 'unknown outcome' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.mfa_code_failures f WHERE f.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_locked := r.locked_for_good OR (r.locked_until IS NOT NULL AND r.locked_until > now());
  IF p_outcome = 'correct' THEN
    UPDATE public.mfa_code_failures SET failures = 0, lockouts = 0, locked_until = NULL, locked_for_good = false, lock_recorded = false, updated_at = now()
    WHERE user_id = p_user;
  ELSIF p_outcome = 'not_counted' THEN
    IF NOT v_locked AND r.failures > 0 THEN
      UPDATE public.mfa_code_failures SET failures = r.failures - 1, updated_at = now() WHERE user_id = p_user;
    END IF;
  ELSE
    UPDATE public.mfa_code_failures SET last_failed_at = now(), updated_at = now() WHERE user_id = p_user;
    IF v_locked AND NOT r.lock_recorded THEN
      PERFORM public.mfa_code_lock_record(p_user, r.org_id, r.failures, r.lockouts, r.locked_for_good);
      UPDATE public.mfa_code_failures SET lock_recorded = true WHERE user_id = p_user;
    END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.mfa_code_attempt_end(uuid, text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_code_attempt_end(uuid, text) TO app_web, service_role;

-- The people screen: who of this organisation has failed codes or a locked code step.
CREATE FUNCTION public.mfa_code_locks(p_org uuid)
RETURNS TABLE (user_id uuid, failures integer, locked_until timestamptz, for_good boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.user_id, f.failures, CASE WHEN f.locked_until > now() THEN f.locked_until END, f.locked_for_good
  FROM public.mfa_code_failures f
  WHERE f.org_id = p_org AND (f.failures > 0 OR f.locked_for_good)
  ORDER BY f.user_id
$$;
REVOKE ALL ON FUNCTION public.mfa_code_locks(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_code_locks(uuid) TO app_web, service_role;

-- A super administrator clears a person's count and lock (never their own), with a reason; audited twice (sign-in events, actions).
CREATE FUNCTION public.mfa_code_lock_clear(p_org uuid, p_actor uuid, p_user uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  r public.mfa_code_failures%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active
                                    AND NOT p.must_reset_password AND p.role = 'platform_owner') THEN
    RAISE EXCEPTION 'only a super administrator may clear a locked code step' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'nobody clears their own locked code step' USING ERRCODE = '42501'; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'a reason of 3 to 500 characters is needed' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org) THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO r FROM public.mfa_code_failures f WHERE f.user_id = p_user FOR UPDATE;
  UPDATE public.mfa_code_failures SET failures = 0, lockouts = 0, locked_until = NULL, locked_for_good = false, lock_recorded = false, updated_at = now()
  WHERE user_id = p_user;
  INSERT INTO public.auth_events (org_id, user_id, actor_id, event, detail)
  VALUES (p_org, p_user, p_actor, 'mfa_lock_cleared', pg_catalog.jsonb_build_object('reason', left(v_reason, 200)));
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'mfa_code_lock_cleared', 'profile', p_user, pg_catalog.jsonb_build_object(
    'reason', v_reason, 'failures', coalesce(r.failures, 0), 'locked_for_good', coalesce(r.locked_for_good, false)));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.mfa_code_lock_clear(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_code_lock_clear(uuid, uuid, uuid, text) TO app_web, service_role;

-- ── 3. Password resets ────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.access_check_password_reset(p_org uuid, p_actor uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
  v_missing text;
BEGIN
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                    WHERE g.org_id = p_org AND g.capability = 'admin.users' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person may not change people (admin.users)' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'nobody resets their own password here' USING ERRCODE = '42501'; END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'platform_owner' THEN RETURN; END IF;
  IF v_target NOT IN ('user', 'operator', 'manager') THEN
    RAISE EXCEPTION 'the acting person may not manage this person' USING ERRCODE = '42501';
  END IF;
  -- Every live or future grant of the person must be held by the administrator: the same capability, at an equal or wider scope, now
  -- and for at least as long (the rule of giving a grant, access_check_grantor).
  SELECT g.capability INTO v_missing FROM public.access_grants g
  WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL AND (g.valid_until IS NULL OR g.valid_until > now())
    AND NOT EXISTS (
      SELECT 1 FROM public.access_grants a
      WHERE a.user_id = p_actor AND a.org_id = p_org AND a.capability = g.capability AND a.revoked_at IS NULL
        AND a.valid_from <= now() AND (a.valid_until IS NULL OR a.valid_until > now())
        AND (a.valid_until IS NULL OR (g.valid_until IS NOT NULL AND a.valid_until >= g.valid_until))
        AND (a.scope_kind = 'organization'
             OR (a.scope_kind = g.scope_kind AND a.scope_id = g.scope_id)
             OR public.access_scope_covers(p_org, a.scope_kind, a.scope_id, g.scope_kind, g.scope_id)))
  ORDER BY g.capability LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'this person holds % where the acting person does not: only a super administrator may reset this password', v_missing USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.access_check_password_reset(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.access_check_password_reset(uuid, uuid, uuid) TO app_web, service_role;

-- ── 4. Inventory rights in SQL ────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.inventory_check_admin(p_org uuid, p_actor uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
BEGIN
  IF p_actor IS NULL THEN
    IF public.service_caller_role() IN ('service_role', 'postgres', 'supabase_admin') THEN RETURN; END IF;
    RAISE EXCEPTION 'an acting person is required to change the inventory' USING ERRCODE = '42501';
  END IF;
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR (v_role <> 'platform_owner' AND NOT EXISTS (
           SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
           WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
    RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory for the whole organisation may change the inventory' USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.inventory_check_admin(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.camera_merge(p_org uuid, p_keep uuid, p_duplicate uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  k public.cameras%ROWTYPE;
  d public.cameras%ROWTYPE;
  v_rec uuid;
  v_ch integer;
  v_closed timestamptz;
  v_groups integer := 0;
  v_grants integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF p_keep IS NULL OR p_duplicate IS NULL OR p_keep = p_duplicate THEN
    RAISE EXCEPTION 'choose two different cameras' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.cameras x WHERE x.id IN (p_keep, p_duplicate) AND x.org_id = p_org ORDER BY x.id FOR UPDATE;
  SELECT * INTO k FROM public.cameras x WHERE x.id = p_keep AND x.org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO d FROM public.cameras x WHERE x.id = p_duplicate AND x.org_id = p_org;
  IF NOT FOUND OR d.archived_at IS NOT NULL THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  IF k.archived_at IS NOT NULL THEN RAISE EXCEPTION 'restore the camera to keep first' USING ERRCODE = 'DR011'; END IF;
  SELECT m.recorder_id, m.channel INTO v_rec, v_ch FROM public.camera_channel_mappings m WHERE m.camera_id = p_duplicate AND m.valid_to IS NULL;
  -- Review M-4: moving the kept camera to another location only makes sense onto the duplicate's NVR channel.
  IF k.location_id <> d.location_id AND v_rec IS NULL THEN
    RAISE EXCEPTION 'the duplicate at another location is not linked to an NVR channel' USING ERRCODE = 'DR012';
  END IF;
  v_people := public.inventory_affected_people(p_org, 'camera', p_keep);
  SELECT count(*) INTO v_grants FROM public.access_grants g
  WHERE g.org_id = p_org AND g.scope_kind = 'camera' AND g.scope_id = p_duplicate AND g.revoked_at IS NULL AND (g.valid_until IS NULL OR g.valid_until > now());
  PERFORM public.inventory_archive(p_org, 'camera', p_duplicate, p_actor);
  SELECT max(m.valid_to) INTO v_closed FROM public.camera_channel_mappings m WHERE m.camera_id = p_duplicate;
  IF k.location_id <> d.location_id THEN
    UPDATE public.cameras SET location_id = d.location_id, recorder_id = NULL WHERE id = p_keep;
  END IF;
  IF v_rec IS NOT NULL THEN
    PERFORM public.camera_remap(p_org, p_keep, v_rec, v_ch, coalesce(v_closed, now()), p_actor);
  END IF;
  UPDATE public.cameras SET camera_ip = coalesce(d.camera_ip, camera_ip) WHERE id = p_keep;
  INSERT INTO public.camera_group_items (org_id, group_id, camera_id)
  SELECT i.org_id, i.group_id, p_keep FROM public.camera_group_items i WHERE i.camera_id = p_duplicate AND i.org_id = p_org
  ON CONFLICT (group_id, camera_id) DO NOTHING;
  GET DIAGNOSTICS v_groups = ROW_COUNT;
  UPDATE public.discovery_findings SET resolved_at = now(), resolved_by = p_actor, resolution = 'merged'
  WHERE org_id = p_org AND resolved_at IS NULL AND (camera_id IN (p_keep, p_duplicate) OR other_camera_id IN (p_keep, p_duplicate));
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'camera_merged', 'camera', p_keep, jsonb_build_object(
    'duplicate', p_duplicate, 'recorder_id', v_rec, 'channel', v_ch, 'from_location', k.location_id, 'to_location', d.location_id,
    'groups_copied', v_groups, 'duplicate_camera_grants', v_grants));
  RETURN jsonb_build_object('kept', p_keep, 'duplicate', p_duplicate, 'recorder_id', v_rec, 'channel', v_ch, 'groups_copied', v_groups,
                            'duplicate_camera_grants', v_grants);
END
$function$;

CREATE OR REPLACE FUNCTION public.camera_remap(p_org uuid, p_camera uuid, p_recorder uuid, p_channel integer, p_at timestamp with time zone DEFAULT now(), p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c public.cameras%ROWTYPE;
  v_id uuid;
  v_at timestamptz;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  SELECT * INTO c FROM public.cameras x WHERE x.id = p_camera AND x.org_id = p_org FOR UPDATE;
  IF NOT FOUND OR c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  IF p_channel IS NULL OR p_channel < 1 THEN RAISE EXCEPTION 'a channel number is needed' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
                 WHERE r.id = p_recorder AND r.org_id = p_org AND r.location_id = c.location_id) THEN
    RAISE EXCEPTION 'a camera can only be mapped to a recorder at its own location' USING ERRCODE = 'DR006';
  END IF;
  -- The switch moment; never before the current mapping began (a mapping made earlier in the same transaction).
  v_at := greatest(p_at, coalesce((SELECT m.valid_from + interval '1 microsecond' FROM public.camera_channel_mappings m
                                   WHERE m.camera_id = p_camera AND m.valid_to IS NULL), p_at));
  PERFORM set_config('drishti.mapping_sync', 'on', true);
  UPDATE public.camera_channel_mappings SET valid_to = v_at WHERE camera_id = p_camera AND valid_to IS NULL;
  INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from, created_by)
  VALUES (p_org, p_camera, p_recorder, p_channel, v_at, p_actor) RETURNING id INTO v_id;
  UPDATE public.cameras SET recorder_id = p_recorder, channel = p_channel WHERE id = p_camera;
  PERFORM set_config('drishti.mapping_sync', '', true);
  PERFORM public.inventory_remap_effects(p_org, p_camera, c.recorder_id, p_recorder);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'camera_remapped', 'camera', p_camera, jsonb_build_object('from_recorder', c.recorder_id, 'from_channel', c.channel,
          'to_recorder', p_recorder, 'to_channel', p_channel, 'mapping_id', v_id));
  RETURN v_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL::uuid, p_findings jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_loc uuid;
  v_live boolean;
  o jsonb;
  f jsonb;
  v_op text;
  v_cam uuid;
  v_other uuid;
  v_n integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_mapped integer := 0;
  v_moved integer := 0;
  v_found integer := 0;
BEGIN
  -- Body as in 20261021000048 (final fix X, M-29: nothing saved for an NVR switched off meanwhile), with the inventory right in SQL.
  PERFORM public.inventory_check_admin(p_org, p_actor);
  SELECT r.location_id, (r.monitoring_enabled AND a.enabled AND l.is_active AND l.archived_at IS NULL) INTO v_loc, v_live
  FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL JOIN public.locations l ON l.id = r.location_id
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT v_live THEN RAISE EXCEPTION 'this NVR was switched off (or its location) while it was asked; nothing was saved' USING ERRCODE = '55000'; END IF;
  IF jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_ops must be an array' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(coalesce(p_findings, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_findings must be an array' USING ERRCODE = '22023'; END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) LOOP
    v_op := o ->> 'op';
    IF v_op = 'insert' THEN
      INSERT INTO public.cameras (org_id, location_id, recorder_id, channel, name, camera_ip)
      VALUES (p_org, v_loc, p_recorder, (o ->> 'channel')::integer, o ->> 'name', o ->> 'ip');
      v_created := v_created + 1;
    ELSIF v_op IN ('update', 'map', 'remap') THEN
      v_cam := (o ->> 'id')::uuid;
      IF v_op = 'map' THEN
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip', recorder_id = p_recorder, channel = (o ->> 'channel')::integer
        WHERE id = v_cam AND org_id = p_org AND location_id = v_loc AND archived_at IS NULL AND recorder_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_mapped := v_mapped + 1;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc
                       AND c.archived_at IS NULL AND c.recorder_id = p_recorder) THEN
          RAISE EXCEPTION 'camera % is not on this recorder', v_cam USING ERRCODE = '22023';
        END IF;
        IF v_op = 'remap' THEN
          PERFORM public.camera_remap(p_org, v_cam, p_recorder, (o ->> 'channel')::integer, now(), p_actor);
          v_moved := v_moved + 1;
        ELSE
          v_updated := v_updated + 1;
        END IF;
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip' WHERE id = v_cam AND org_id = p_org;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 0 THEN RAISE EXCEPTION 'camera % cannot be changed by discovery', v_cam USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'unknown discovery change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- The reconciliation list: this discovery's findings replace the open ones of the same NVR.
  UPDATE public.discovery_findings SET resolved_at = now(), resolved_by = p_actor, resolution = 'superseded'
  WHERE org_id = p_org AND recorder_id = p_recorder AND resolved_at IS NULL;
  FOR f IN SELECT * FROM jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) LOOP
    v_cam := (f ->> 'camera_id')::uuid;
    v_other := NULLIF(f ->> 'other_camera_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc)
       OR (v_other IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_other AND c.org_id = p_org AND c.location_id = v_loc)) THEN
      RAISE EXCEPTION 'a finding names a camera of another location' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.discovery_findings (org_id, recorder_id, location_id, kind, channel, camera_id, other_camera_id, reported_name, because, found_by)
    VALUES (p_org, p_recorder, v_loc, f ->> 'kind', NULLIF(f ->> 'channel', '')::integer, v_cam, v_other, left(f ->> 'reported_name', 200), f ->> 'because', p_actor);
    v_found := v_found + 1;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'cameras_discovered', 'store', v_loc, jsonb_build_object(
    'capability', 'admin.inventory', 'locationIds', jsonb_build_array(v_loc), 'count', 1, 'recorder_id', p_recorder,
    'created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'to_reconcile', coalesce(p_to_reconcile, 0), 'findings', v_found));
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'findings', v_found);
END
$function$;

CREATE OR REPLACE FUNCTION public.inventory_apply_proposals(p_org uuid, p_items jsonb, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  it jsonb;
  v_loc uuid;
  v_cluster_code text;
  v_region_code text;
  v_region uuid;
  v_cluster uuid;
  v_moved integer := 0;
  v_regions integer := 0;
  v_clusters integer := 0;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'nothing to apply' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_loc := (it ->> 'location_id')::uuid;
    v_cluster_code := it ->> 'cluster_code';
    v_region_code := nullif(it ->> 'region_code', '');
    IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v_loc AND l.org_id = p_org AND l.archived_at IS NULL) THEN
      RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002';
    END IF;
    v_region := NULL;
    IF v_region_code IS NOT NULL THEN
      SELECT r.id INTO v_region FROM public.regions r WHERE r.org_id = p_org AND r.code = v_region_code AND r.archived_at IS NULL;
      IF v_region IS NULL THEN
        INSERT INTO public.regions (org_id, code, name) VALUES (p_org, v_region_code, v_region_code) RETURNING id INTO v_region;
        v_regions := v_regions + 1;
      END IF;
    END IF;
    SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_cluster_code AND c.archived_at IS NULL;
    IF v_cluster IS NULL THEN
      INSERT INTO public.clusters (org_id, code, name, region_id) VALUES (p_org, v_cluster_code, v_cluster_code, v_region) RETURNING id INTO v_cluster;
      v_clusters := v_clusters + 1;
    END IF;
    PERFORM public.inventory_move_location(p_org, v_loc, v_cluster, p_actor);
    v_moved := v_moved + 1;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'hierarchy_proposals_applied', 'organization', p_org,
          jsonb_build_object('moved', v_moved, 'regions_created', v_regions, 'clusters_created', v_clusters));
  RETURN jsonb_build_object('moved', v_moved, 'regions_created', v_regions, 'clusters_created', v_clusters);
END
$function$;

CREATE OR REPLACE FUNCTION public.inventory_archive(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_at timestamptz := now();
  v_n integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF p_kind NOT IN ('camera', 'asset', 'recorder', 'location', 'cluster', 'region') THEN
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  v_people := public.inventory_affected_people(p_org, p_kind, p_id);
  IF p_kind = 'camera' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings SET valid_to = greatest(v_at, valid_from + interval '1 microsecond')
    WHERE camera_id = p_id AND org_id = p_org AND valid_to IS NULL;
    UPDATE public.cameras SET archived_was_active = is_active, is_active = false, archived_at = v_at, recorder_id = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    PERFORM set_config('drishti.mapping_sync', '', true);
  ELSIF p_kind IN ('asset', 'recorder') THEN
    IF p_kind = 'recorder' AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = p_id AND r.org_id = p_org) THEN
      RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = p_id AND m.valid_to IS NULL) THEN
      RAISE EXCEPTION 'move or archive the cameras of this NVR first' USING ERRCODE = 'DR004';
    END IF;
    UPDATE public.assets SET archived_was_enabled = enabled, enabled = false, archived_at = v_at
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings m SET valid_to = greatest(v_at, m.valid_from + interval '1 microsecond')
    FROM public.cameras c WHERE m.camera_id = c.id AND c.location_id = p_id AND c.org_id = p_org AND m.valid_to IS NULL;
    UPDATE public.cameras SET archived_was_active = is_active, is_active = false, archived_at = v_at, recorder_id = NULL
    WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    PERFORM set_config('drishti.mapping_sync', '', true);
    UPDATE public.assets SET archived_was_enabled = enabled, enabled = false, archived_at = v_at
    WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    UPDATE public.locations SET archived_was_active = is_active, is_active = false, archived_at = v_at
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'cluster' THEN
    IF EXISTS (SELECT 1 FROM public.locations l WHERE l.cluster_id = p_id AND l.org_id = p_org AND l.archived_at IS NULL) THEN
      RAISE EXCEPTION 'the cluster still has locations: move or archive them first' USING ERRCODE = 'DR007';
    END IF;
    UPDATE public.clusters SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    IF EXISTS (SELECT 1 FROM public.clusters c WHERE c.region_id = p_id AND c.org_id = p_org AND c.archived_at IS NULL) THEN
      RAISE EXCEPTION 'the region still has clusters: move or archive them first' USING ERRCODE = 'DR007';
    END IF;
    UPDATE public.regions SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_archived', p_kind, p_id, jsonb_build_object('archived_at', v_at, 'affected_people', cardinality(v_people)));
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id, 'archived_at', v_at);
END
$function$;

CREATE OR REPLACE FUNCTION public.inventory_move_cluster(p_org uuid, p_cluster uuid, p_region uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old uuid;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  SELECT c.region_id INTO v_old FROM public.clusters c WHERE c.id = p_cluster AND c.org_id = p_org AND c.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
  IF p_region IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id = p_region AND r.org_id = p_org AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'region not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  UPDATE public.clusters SET region_id = p_region WHERE id = p_cluster;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('from', v_old, 'to', p_region);
END
$function$;

CREATE OR REPLACE FUNCTION public.inventory_move_location(p_org uuid, p_location uuid, p_cluster uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old uuid;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  SELECT l.cluster_id INTO v_old FROM public.locations l WHERE l.id = p_location AND l.org_id = p_org AND l.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
  IF p_cluster IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.id = p_cluster AND c.org_id = p_org AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  UPDATE public.locations SET cluster_id = p_cluster WHERE id = p_location;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('from', v_old, 'to', p_cluster);
END
$function$;

-- C I-9: an item comes back only under a live parent (DR040): a camera or device at a live location, a location in a live cluster (or
-- none), a cluster in a live region (or none).
CREATE OR REPLACE FUNCTION public.inventory_restore(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_at timestamptz;
  v_n integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF p_kind = 'camera' THEN
    IF EXISTS (SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
               WHERE c.id = p_id AND c.org_id = p_org AND c.archived_at IS NOT NULL AND l.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'its location is archived: restore the location first' USING ERRCODE = 'DR040';
    END IF;
    UPDATE public.cameras SET archived_at = NULL, is_active = coalesce(archived_was_active, true), archived_was_active = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind IN ('asset', 'recorder') THEN
    IF EXISTS (SELECT 1 FROM public.assets a JOIN public.locations l ON l.id = a.location_id
               WHERE a.id = p_id AND a.org_id = p_org AND a.archived_at IS NOT NULL AND l.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'its location is archived: restore the location first' USING ERRCODE = 'DR040';
    END IF;
    UPDATE public.assets SET archived_at = NULL, enabled = coalesce(archived_was_enabled, true), archived_was_enabled = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    IF EXISTS (SELECT 1 FROM public.locations l JOIN public.clusters c ON c.id = l.cluster_id
               WHERE l.id = p_id AND l.org_id = p_org AND l.archived_at IS NOT NULL AND c.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'its cluster is archived: restore the cluster first' USING ERRCODE = 'DR040';
    END IF;
    SELECT l.archived_at INTO v_at FROM public.locations l WHERE l.id = p_id AND l.org_id = p_org AND l.archived_at IS NOT NULL;
    IF v_at IS NOT NULL THEN
      UPDATE public.locations SET archived_at = NULL, is_active = coalesce(archived_was_active, true), archived_was_active = NULL WHERE id = p_id;
      v_n := 1;
      -- What was archived with it comes back with it, in the state it had.
      UPDATE public.assets SET archived_at = NULL, enabled = coalesce(archived_was_enabled, true), archived_was_enabled = NULL
      WHERE location_id = p_id AND archived_at = v_at;
      UPDATE public.cameras SET archived_at = NULL, is_active = coalesce(archived_was_active, true), archived_was_active = NULL
      WHERE location_id = p_id AND archived_at = v_at;
    END IF;
  ELSIF p_kind = 'cluster' THEN
    IF EXISTS (SELECT 1 FROM public.clusters c JOIN public.regions r ON r.id = c.region_id
               WHERE c.id = p_id AND c.org_id = p_org AND c.archived_at IS NOT NULL AND r.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'its region is archived: restore the region first' USING ERRCODE = 'DR040';
    END IF;
    UPDATE public.clusters SET archived_at = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'region' THEN
    UPDATE public.regions SET archived_at = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  v_people := public.inventory_affected_people(p_org, p_kind, p_id);
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_restored', p_kind, p_id, jsonb_build_object('affected_people', cardinality(v_people)));
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.recorder_save(p_org uuid, p_location uuid, p_recorder uuid, p_host text, p_http_port integer, p_rtsp_port integer, p_username text, p_expected_channels integer DEFAULT 0, p_name text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  l public.locations%ROWTYPE;
  v_id uuid := p_recorder;
  v_space uuid;
  v_try integer;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_created boolean := false;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF p_host IS NULL OR btrim(p_host) = '' OR length(p_host) > 253 THEN RAISE EXCEPTION 'an NVR address is needed' USING ERRCODE = '22023'; END IF;
  IF p_http_port IS NULL OR p_http_port NOT BETWEEN 1 AND 65535 OR p_rtsp_port IS NULL OR p_rtsp_port NOT BETWEEN 1 AND 65535 THEN
    RAISE EXCEPTION 'a port must be from 1 to 65535' USING ERRCODE = '22023';
  END IF;
  IF p_expected_channels IS NOT NULL AND p_expected_channels NOT BETWEEN 0 AND 999 THEN
    RAISE EXCEPTION 'the number of cameras must be from 0 to 999' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 200 THEN RAISE EXCEPTION 'the NVR name is too long' USING ERRCODE = '22023'; END IF;
  SELECT * INTO l FROM public.locations x WHERE x.id = p_location AND x.org_id = p_org AND x.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
  IF v_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
       WHERE r.id = v_id AND r.org_id = p_org AND r.location_id = p_location) THEN
    RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
  END IF;
  -- M-2: two NVRs of one location at the same address and web port are one box typed twice.
  IF EXISTS (
       SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
       WHERE r.location_id = p_location AND r.id IS DISTINCT FROM v_id AND a.ip = btrim(p_host) AND r.http_port = p_http_port) THEN
    RAISE EXCEPTION 'another NVR of this location already has this address' USING ERRCODE = 'DR010';
  END IF;
  FOR v_try IN 1..2 LOOP
    BEGIN
      IF v_id IS NULL THEN
        -- I-4: switched on (before: switched on only when the location was active, and never switched on again).
        INSERT INTO public.assets (org_id, location_id, type, name, ip, tcp_port, enabled, address_space_id)
        VALUES (p_org, p_location, 'nvr', coalesce(v_name, 'NVR'), btrim(p_host), p_http_port, true, v_space)
        RETURNING id INTO v_id;
        INSERT INTO public.recorders (id, org_id, location_id, http_port, rtsp_port, username, expected_channels, created_asset)
        VALUES (v_id, p_org, p_location, p_http_port, p_rtsp_port, nullif(btrim(coalesce(p_username, '')), ''), coalesce(p_expected_channels, 0), true);
        v_created := true;
      ELSE
        UPDATE public.assets SET ip = btrim(p_host), tcp_port = p_http_port, name = coalesce(v_name, name),
               address_space_id = coalesce(v_space, address_space_id), enabled = true
        WHERE id = v_id AND (ip, tcp_port, name, address_space_id, enabled) IS DISTINCT FROM (btrim(p_host), p_http_port, coalesce(v_name, name), coalesce(v_space, address_space_id), true);
        UPDATE public.recorders SET http_port = p_http_port, rtsp_port = p_rtsp_port, username = nullif(btrim(coalesce(p_username, '')), ''),
               expected_channels = coalesce(p_expected_channels, expected_channels)
        WHERE id = v_id;
      END IF;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try = 2 THEN RAISE; END IF;
      -- The address is taken in the company network: this location gets (or reuses) its own address space (D5-8).
      IF p_recorder IS NULL THEN v_id := NULL; v_created := false; END IF;
      SELECT s.id INTO v_space FROM public.address_spaces s WHERE s.location_id = l.id AND s.kind = 'location_nat';
      IF v_space IS NULL THEN
        INSERT INTO public.address_spaces (org_id, name, kind, location_id, notes)
        VALUES (l.org_id, 'Location ' || l.code || ' (own addresses)', 'location_nat', l.id,
                'Made because an NVR address of this location is also used elsewhere (SD-WAN addressing unknown, D5-8).')
        RETURNING id INTO v_space;
      END IF;
    END;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, CASE WHEN v_created THEN 'recorder_created' ELSE 'recorder_updated' END, 'recorder', v_id,
          jsonb_build_object('location_id', p_location, 'own_address_space', v_space IS NOT NULL));
  RETURN v_id;
END
$function$;

-- The grants of the nine replaced functions, restated (unchanged: the service key and the web app).
REVOKE ALL ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid), public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid),
  public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb), public.inventory_apply_proposals(uuid, jsonb, uuid),
  public.inventory_archive(uuid, text, uuid, uuid), public.inventory_move_cluster(uuid, uuid, uuid, uuid),
  public.inventory_move_location(uuid, uuid, uuid, uuid), public.inventory_restore(uuid, text, uuid, uuid),
  public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid), public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid),
  public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb), public.inventory_apply_proposals(uuid, jsonb, uuid),
  public.inventory_archive(uuid, text, uuid, uuid), public.inventory_move_cluster(uuid, uuid, uuid, uuid),
  public.inventory_move_location(uuid, uuid, uuid, uuid), public.inventory_restore(uuid, text, uuid, uuid),
  public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid)
  TO service_role, app_web;

-- ── 5. E-1 / rule 7 on every path ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.access_grants_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_kinds text[];
  v_area text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'the person is not in this organisation' USING ERRCODE = '23503';
  END IF;
  SELECT c.scope_kinds, c.area INTO v_kinds, v_area FROM public.capabilities c WHERE c.key = NEW.capability;
  IF v_kinds IS NULL THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF NOT (NEW.scope_kind = ANY (v_kinds)) THEN
    RAISE EXCEPTION 'a % grant cannot have % scope', NEW.capability, NEW.scope_kind USING ERRCODE = '22023';
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a grant cannot start revoked' USING ERRCODE = '22023';
  END IF;
  -- Final fix Y (A M-3, ruling E-1 / rule 7): administration rights and downloads only for administrators, whoever writes the grant.
  IF (v_area = 'admin' OR NEW.capability = 'cctv.export')
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.role IN ('admin', 'platform_owner')) THEN
    RAISE EXCEPTION 'administration and download rights only for administrators (%)', NEW.capability USING ERRCODE = '42501';
  END IF;
  NEW.region_id := CASE WHEN NEW.scope_kind = 'region' THEN NEW.scope_id END;
  NEW.cluster_id := CASE WHEN NEW.scope_kind = 'cluster' THEN NEW.scope_id END;
  NEW.location_id := CASE WHEN NEW.scope_kind = 'location' THEN NEW.scope_id END;
  NEW.recorder_id := CASE WHEN NEW.scope_kind = 'recorder' THEN NEW.scope_id END;
  NEW.camera_id := CASE WHEN NEW.scope_kind = 'camera' THEN NEW.scope_id END;
  NEW.asset_id := CASE WHEN NEW.scope_kind = 'asset' THEN NEW.scope_id END;
  NEW.granted_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.access_grants_before_insert() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- A role change made anywhere (the screens, the service key, psql) takes away what the new role may not hold. change_person_role
-- revokes first (and reports it); this catches every other path, with an audit row.
CREATE FUNCTION public.profiles_role_rights() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid;
  v_n integer := 0;
  v_m integer := 0;
BEGIN
  BEGIN
    v_actor := nullif(pg_catalog.current_setting('drishti.actor', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  IF OLD.role IN ('admin', 'platform_owner') AND NEW.role NOT IN ('admin', 'platform_owner') THEN
    UPDATE public.access_grants g SET revoked_at = now(), revoked_by = v_actor,
      revoke_reason = CASE WHEN g.capability = 'cctv.export' THEN 'Role changed: download rights removed' ELSE 'Role changed: administration rights removed' END
    WHERE g.user_id = NEW.id AND g.org_id = NEW.org_id AND g.revoked_at IS NULL
      AND (g.capability = 'cctv.export' OR EXISTS (SELECT 1 FROM public.capabilities c WHERE c.key = g.capability AND c.area = 'admin'));
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  IF OLD.role = 'platform_owner' AND NEW.role <> 'platform_owner' THEN
    UPDATE public.access_grants g SET revoked_at = now(), revoked_by = v_actor,
      revoke_reason = 'Role changed: rights only a super administrator may hold were removed'
    WHERE g.user_id = NEW.id AND g.org_id = NEW.org_id AND g.revoked_at IS NULL AND g.capability = ANY (public.access_owner_only());
    GET DIAGNOSTICS v_m = ROW_COUNT;
  END IF;
  IF v_n + v_m > 0 THEN
    PERFORM public.access_bump_version(NEW.id);
    INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (NEW.org_id, v_actor, 'access_revoked', 'profile', NEW.id, pg_catalog.jsonb_build_object(
      'reason', 'Role changed: rights the new role may not hold were removed', 'from_role', OLD.role, 'to_role', NEW.role,
      'grants', v_n + v_m, 'path', 'database', 'db_user', session_user::text));
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.profiles_role_rights() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
CREATE TRIGGER profiles_role_rights AFTER UPDATE OF role ON public.profiles
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role) EXECUTE FUNCTION public.profiles_role_rights();

-- change_person_role: the revocations come BEFORE the role update (the trigger then finds nothing left), so it still returns them.
CREATE OR REPLACE FUNCTION public.change_person_role(p_org uuid, p_actor uuid, p_user uuid, p_role public.user_role, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old public.user_role;
  v_version bigint;
  v_revoked jsonb := '[]'::jsonb;
  v_part jsonb;
BEGIN
  PERFORM public.access_check_people_admin(p_org, p_actor, p_user, p_role);
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  SELECT p.role INTO v_old FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_old = p_role THEN
    RETURN jsonb_build_object('old_role', v_old, 'new_role', p_role, 'version', v_version, 'revoked', v_revoked);
  END IF;
  PERFORM set_config('drishti.actor', p_actor::text, true);
  IF v_old IN ('admin', 'platform_owner') AND p_role NOT IN ('admin', 'platform_owner') THEN
    WITH r AS (
      UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor,
        revoke_reason = CASE WHEN g.capability = 'cctv.export' THEN 'Role changed: download rights removed' ELSE 'Role changed: administration rights removed' END
      WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL
        AND (g.capability = 'cctv.export' OR EXISTS (SELECT 1 FROM public.capabilities c WHERE c.key = g.capability AND c.area = 'admin'))
      RETURNING g.id, g.capability, g.scope_kind, g.scope_id, g.valid_until, g.revoke_reason
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'capability', r.capability, 'scope_kind', r.scope_kind, 'scope_id', r.scope_id,
                                                  'valid_until', r.valid_until, 'reason', r.revoke_reason)), '[]'::jsonb) INTO v_part FROM r;
    v_revoked := v_revoked || v_part;
  END IF;
  IF v_old = 'platform_owner' AND p_role <> 'platform_owner' THEN
    WITH r AS (
      UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor, revoke_reason = 'Role changed: rights only a super administrator may hold were removed'
      WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL AND g.capability = ANY (public.access_owner_only())
      RETURNING g.id, g.capability, g.scope_kind, g.scope_id, g.valid_until, g.revoke_reason
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'capability', r.capability, 'scope_kind', r.scope_kind, 'scope_id', r.scope_id,
                                                  'valid_until', r.valid_until, 'reason', r.revoke_reason)), '[]'::jsonb) INTO v_part FROM r;
    v_revoked := v_revoked || v_part;
  END IF;
  UPDATE public.profiles SET role = p_role WHERE id = p_user AND org_id = p_org;
  IF jsonb_array_length(v_revoked) > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  SELECT p.access_version INTO v_version FROM public.profiles p WHERE p.id = p_user;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('old_role', v_old, 'new_role', p_role, 'version', v_version, 'revoked', v_revoked);
END
$function$;
REVOKE ALL ON FUNCTION public.change_person_role(uuid, uuid, uuid, public.user_role, bigint) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.change_person_role(uuid, uuid, uuid, public.user_role, bigint) TO service_role, app_web;

-- Row security that hangs on admin.*: also an administrative role (a stray admin.* grant alone reads nothing).
DROP POLICY profiles_select_org ON public.profiles;
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.users'))
         AND (SELECT public.current_user_role()) IN ('admin'::public.user_role, 'platform_owner'::public.user_role));
DROP POLICY access_grants_select ON public.access_grants;
CREATE POLICY access_grants_select ON public.access_grants FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = (SELECT auth.uid())
         OR ((SELECT public.has_capability('admin.access')) AND (SELECT public.current_user_role()) IN ('admin'::public.user_role, 'platform_owner'::public.user_role))));
DROP POLICY admin_audit_log_select ON public.admin_audit_log;
CREATE POLICY admin_audit_log_select ON public.admin_audit_log FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.audit.read'))
         AND (SELECT public.current_user_role()) IN ('admin'::public.user_role, 'platform_owner'::public.user_role));
DROP POLICY auth_events_select ON public.auth_events;
CREATE POLICY auth_events_select ON public.auth_events FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.audit.read'))
         AND (SELECT public.current_user_role()) IN ('admin'::public.user_role, 'platform_owner'::public.user_role));

-- ── 6. Access and people changes of one organisation, one at a time ──────────────────────────────────────────────────────────────
CREATE FUNCTION public.access_admin_lock(p_org uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.access_admin:' || p_org::text, 0))
$$;
REVOKE ALL ON FUNCTION public.access_admin_lock(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.access_check_manager(p_org uuid, p_actor uuid, p_user uuid)
 RETURNS public.user_role
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
BEGIN
  -- Final fix Y (A M-4): one change of access or people per organisation at a time; the actor's own rights are read after the lock.
  PERFORM public.access_admin_lock(p_org);
  SELECT p.role INTO v_role FROM public.profiles p
  WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner') THEN
    RAISE EXCEPTION 'the acting person is not an administrator with admin.access' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                 WHERE g.org_id = p_org AND g.capability = 'admin.access' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person is not an administrator with admin.access' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN
    RAISE EXCEPTION 'nobody changes their own access' USING ERRCODE = '42501';
  END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org FOR UPDATE;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'admin' AND v_target NOT IN ('user', 'operator', 'manager') THEN
    RAISE EXCEPTION 'the acting person may not manage this person' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END
$function$;
REVOKE ALL ON FUNCTION public.access_check_manager(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.access_check_people_admin(p_org uuid, p_actor uuid, p_user uuid, p_new_role public.user_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
  manages boolean;
BEGIN
  PERFORM public.access_admin_lock(p_org);
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                    WHERE g.org_id = p_org AND g.capability = 'admin.users' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person may not change people (admin.users)' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'nobody changes their own role or status' USING ERRCODE = '42501'; END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org FOR UPDATE;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  manages := v_role = 'platform_owner' OR (v_target IN ('user', 'operator', 'manager') AND (p_new_role IS NULL OR p_new_role IN ('user', 'operator', 'manager')));
  IF NOT manages THEN RAISE EXCEPTION 'the acting person may not manage this person or give that role' USING ERRCODE = '42501'; END IF;
END
$function$;
REVOKE ALL ON FUNCTION public.access_check_people_admin(uuid, uuid, uuid, public.user_role) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- ── 7. The web app's credential and sign-out functions name the organisation ──────────────────────────────────────────────────────
CREATE FUNCTION public.recorder_store_credential(p_org uuid, p_recorder uuid, p_secret text, p_actor uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = p_recorder AND r.org_id = p_org) THEN
    RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
  END IF;
  v_id := public.recorder_store_credential(p_recorder, p_secret);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'recorder_password_set', 'recorder', p_recorder, '{}'::jsonb);
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.recorder_store_credential(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.recorder_store_credential(uuid, uuid, text, uuid) TO app_web, service_role;
REVOKE ALL ON FUNCTION public.recorder_store_credential(uuid, text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.recorder_store_credential(uuid, text) TO service_role;

CREATE FUNCTION public.revoke_user_sessions(p_org uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org) THEN
    RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.revoke_user_sessions(p_user);
END
$$;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid, uuid) TO app_web, service_role;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role;

-- ── 8. Creating a person ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.create_person(p_org uuid, p_actor uuid, p_user uuid, p_email text, p_full_name text, p_role public.user_role, p_location uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_name text := btrim(coalesce(p_full_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  PERFORM public.access_admin_lock(p_org);
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                    WHERE g.org_id = p_org AND g.capability = 'admin.users' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person may not add people (admin.users)' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL THEN RAISE EXCEPTION 'a role is needed' USING ERRCODE = '22023'; END IF;
  IF v_role <> 'platform_owner' AND p_role NOT IN ('user', 'operator', 'manager') THEN
    RAISE EXCEPTION 'the acting person may not give that role' USING ERRCODE = '42501';
  END IF;
  IF p_user IS NULL OR v_email = '' OR length(v_email) > 320 OR v_name = '' OR length(v_name) > 100 THEN
    RAISE EXCEPTION 'a person, an e-mail address and a name (up to 100 characters) are needed' USING ERRCODE = '22023';
  END IF;
  IF p_location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location AND l.org_id = p_org AND l.archived_at IS NULL) THEN
    RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.profiles (id, org_id, email, full_name, role, must_reset_password, is_active, location_id)
  VALUES (p_user, p_org, v_email, v_name, p_role, true, true, p_location);
  RETURN p_user;
END
$$;
REVOKE ALL ON FUNCTION public.create_person(uuid, uuid, uuid, text, text, public.user_role, uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.create_person(uuid, uuid, uuid, text, text, public.user_role, uuid) TO app_web, service_role;
REVOKE INSERT ON TABLE public.profiles FROM app_web;

-- ── 9. The device import ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- p_rows: [{ line, name, type, location_code (null: keep), clear_location, ip, tcp_port, notes (null: keep), clear_notes }], already
-- read by lib/import/devices-csv.ts (strict reader). A device is matched by address and port among the organisation's devices (the
-- five device types, not NVRs); another kind of equipment at that address is never changed. p_apply false: a check (everything is
-- tried and rolled back). Any row error: nothing is saved. Messages name the column, never a value.
CREATE FUNCTION public.inventory_devices_import(p_org uuid, p_actor uuid, p_rows jsonb, p_apply boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_types text[] := ARRAY['nvr', 'server', 'attendance', 'footfall', 'other'];
  r jsonb;
  v_line integer;
  v_name text;
  v_type text;
  v_ip text;
  v_port integer;
  v_code text;
  v_loc uuid;
  v_notes text;
  v_match uuid;
  v_devices integer;
  v_nvrs integer;
  v_others integer;
  v_errors jsonb := '[]'::jsonb;
  v_created integer := 0;
  v_updated integer := 0;
  v_applied boolean := false;
BEGIN
  PERFORM public.inventory_check_admin(p_org, p_actor);
  IF jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_rows must be a list' USING ERRCODE = '22023'; END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN RAISE EXCEPTION 'at most 5000 rows' USING ERRCODE = '22023'; END IF;
  -- One import of an organisation at a time (final review C M-30).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.import:' || p_org::text, 0));
  BEGIN
    FOR r IN SELECT e.value FROM jsonb_array_elements(p_rows) AS e LOOP
      v_line := coalesce((r ->> 'line')::integer, 0);
      v_name := btrim(coalesce(r ->> 'name', ''));
      v_type := lower(btrim(coalesce(r ->> 'type', '')));
      v_ip := btrim(coalesce(r ->> 'ip', ''));
      v_port := NULLIF(r ->> 'tcp_port', '')::integer;
      v_notes := NULLIF(btrim(coalesce(r ->> 'notes', '')), '');
      IF v_name = '' OR length(v_name) > 200 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'name', 'message', 'Give the device name (at most 200 characters).');
        CONTINUE;
      END IF;
      IF NOT (v_type = ANY (v_types)) THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'type', 'message', 'Not a device type: use nvr, server, attendance, footfall or other.');
        CONTINUE;
      END IF;
      IF v_ip = '' OR length(v_ip) > 253 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'ip', 'message', 'Give the device''s IP address.');
        CONTINUE;
      END IF;
      IF v_port IS NOT NULL AND v_port NOT BETWEEN 1 AND 65535 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'port', 'message', 'The port must be a number from 1 to 65535.');
        CONTINUE;
      END IF;
      IF v_notes IS NOT NULL AND length(v_notes) > 500 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'notes', 'message', 'The notes are too long (at most 500 characters).');
        CONTINUE;
      END IF;
      v_code := NULLIF(upper(btrim(coalesce(r ->> 'location_code', ''))), '');
      v_loc := NULL;
      IF v_code IS NOT NULL THEN
        SELECT l.id INTO v_loc FROM public.locations l WHERE l.org_id = p_org AND l.code = v_code AND l.archived_at IS NULL;
        IF v_loc IS NULL THEN
          v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'location_code', 'message', 'No location has this code (or it is archived).');
          CONTINUE;
        END IF;
      END IF;
      SELECT count(*) FILTER (WHERE NOT a.is_recorder AND a.type::text = ANY (v_types)),
             count(*) FILTER (WHERE a.is_recorder),
             count(*) FILTER (WHERE NOT a.is_recorder AND NOT (a.type::text = ANY (v_types))),
             min(a.id::text) FILTER (WHERE NOT a.is_recorder AND a.type::text = ANY (v_types))::uuid
      INTO v_devices, v_nvrs, v_others, v_match
      FROM public.assets a
      WHERE a.org_id = p_org AND a.archived_at IS NULL AND a.ip = v_ip AND a.tcp_port IS NOT DISTINCT FROM v_port;
      IF v_nvrs > 0 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'ip', 'message', 'An NVR has this address and port: change it under Locations and NVRs.');
        CONTINUE;
      END IF;
      IF v_others > 0 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'ip', 'message', 'Another kind of equipment (an access point, switch, router or similar) has this address and port: change it under Assets.');
        CONTINUE;
      END IF;
      IF v_devices > 1 THEN
        v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'ip', 'message', 'More than one device has this address and port: change them on the device page first.');
        CONTINUE;
      END IF;
      BEGIN
        IF v_match IS NOT NULL THEN
          UPDATE public.assets SET name = v_name, type = v_type::public.device_type,
                 location_id = CASE WHEN v_loc IS NOT NULL THEN v_loc WHEN coalesce((r ->> 'clear_location')::boolean, false) THEN NULL ELSE location_id END,
                 notes = CASE WHEN v_notes IS NOT NULL THEN v_notes WHEN coalesce((r ->> 'clear_notes')::boolean, false) THEN NULL ELSE notes END
          WHERE id = v_match;
          v_updated := v_updated + 1;
        ELSE
          INSERT INTO public.assets (org_id, location_id, type, name, ip, tcp_port, notes)
          VALUES (p_org, v_loc, v_type::public.device_type, v_name, v_ip, v_port, v_notes);
          v_created := v_created + 1;
        END IF;
      EXCEPTION
        WHEN unique_violation OR exclusion_violation THEN
          v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'ip', 'message', 'This address and port are already used by another device or NVR: check the address.');
        WHEN invalid_text_representation OR check_violation THEN
          v_errors := v_errors || jsonb_build_object('line', v_line, 'column', 'ip', 'message', 'Not a valid IP address.');
      END;
    END LOOP;
    IF jsonb_array_length(v_errors) > 0 OR NOT coalesce(p_apply, false) THEN
      RAISE EXCEPTION 'not applied' USING ERRCODE = 'DR042';
    END IF;
    v_applied := true;
  EXCEPTION WHEN SQLSTATE 'DR042' THEN
    v_applied := false;
  END;
  IF v_applied THEN
    INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (p_org, p_actor, 'import_devices', 'organization', p_org,
            jsonb_build_object('created', v_created, 'updated', v_updated, 'rows', jsonb_array_length(p_rows)));
  END IF;
  SELECT coalesce(jsonb_agg(e.value ORDER BY (e.value ->> 'line')::integer), '[]'::jsonb) INTO v_errors FROM jsonb_array_elements(v_errors) AS e;
  RETURN jsonb_build_object(
    'created', CASE WHEN jsonb_array_length(v_errors) > 0 THEN 0 ELSE v_created END,
    'updated', CASE WHEN jsonb_array_length(v_errors) > 0 THEN 0 ELSE v_updated END,
    'errors', v_errors, 'applied', v_applied);
END
$$;
REVOKE ALL ON FUNCTION public.inventory_devices_import(uuid, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.inventory_devices_import(uuid, uuid, jsonb, boolean) TO app_web, service_role;

-- ── 10. The Health page: the two-step requirement of every active organisation (counts only) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_health_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_level text;
  v_applied integer := 0;
  v_vault boolean := false;
  v_hk jsonb;
  v_mfa jsonb;
BEGIN
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(version)::text, count(*)::integer FROM supabase_migrations.schema_migrations' INTO v_level, v_applied;
  END IF;
  BEGIN
    SELECT ds.decrypted_secret = 'drishti-vault-canary-v1' INTO v_vault FROM vault.decrypted_secrets ds WHERE ds.name = 'drishti_vault_canary';
    v_vault := coalesce(v_vault, false);
  EXCEPTION WHEN OTHERS THEN
    v_vault := false;
  END;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'task', h.task, 'last_run_at', h.last_run_at, 'removed', h.last_removed, 'db_role', h.db_role) ORDER BY h.task), '[]'::jsonb)
  INTO v_hk FROM public.housekeeping_runs h;
  SELECT pg_catalog.jsonb_build_object('active', count(*), 'enforced', count(*) FILTER (WHERE m.enforced),
           'off', count(*) FILTER (WHERE NOT m.enforced AND NOT m.opted_out), 'opted_out', count(*) FILTER (WHERE m.opted_out))
  INTO v_mfa FROM public.security_mfa_overview() m;
  RETURN pg_catalog.jsonb_build_object(
    'db_time', now(),
    'migration', pg_catalog.jsonb_build_object('level', v_level, 'applied', v_applied),
    'vault', pg_catalog.jsonb_build_object('ok', v_vault),
    'housekeeping', v_hk,
    'test_fixtures', pg_catalog.jsonb_build_object(
      'on', public.test_fixtures_enabled(),
      'production', coalesce((SELECT t.production FROM public.test_fixture_switch t WHERE t.id), false)),
    'mfa', v_mfa);
END
$$;
REVOKE ALL ON FUNCTION public.ops_health_status() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.ops_health_status() TO app_web, service_role;

COMMIT;
