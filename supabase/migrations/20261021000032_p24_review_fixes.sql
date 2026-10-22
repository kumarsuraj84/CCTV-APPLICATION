-- P2-4 review round 1 (.superpowers/sdd/drishti/p2-4-review.md). New forward migration; 0029 is applied and not edited. Apply through
-- `npx supabase migration up --local` (one transaction per file); no BEGIN/COMMIT of its own on purpose.
--
-- I-1 (the cost of the re-check at commit). Measured before this migration on the shape of the estate import (one transaction archives
-- 216 locations while 25 administrators each have 36 open sessions and 108 never-opened ones): the statements took 0.4 s, the deferred
-- re-checks at COMMIT 205 s — long enough for a statement timeout to cancel the commit and roll the access change back. Now:
--   a. only OPENED sessions are re-checked at commit (a never-opened one is fully checked when it is opened), and a never-opened session
--      whose connect window has passed counts as ended (`connect_window_passed`);
--   b. a person is re-checked once per transaction (the trigger is deferred to COMMIT, so the first re-check already sees the final
--      state); deactivation / password reset / role change still revoke on every event (one indexed UPDATE);
--   c. at most 1,000 session re-checks per transaction (`media_sessions_recheck_budget`); beyond it the gateway's 15-second check, which
--      evaluates every open socket anyway, ends them — so the commit stays bounded and the guarantee stays ≤ 20 s;
--   d. the trigger waits at most 2 s for a row lock (`lock_timeout`, restored afterwards); a lock it cannot get is an ordinary error that
--      its handler turns into a WARNING (the gateway's check then covers it). It does NOT catch query_canceled (a statement timeout or a
--      cancel is never swallowed); with (a)-(c) its work no longer comes near a timeout;
--   e. making sessions removes the person's own never-opened sessions whose window ended more than 5 minutes ago (the backlog the
--      one-minute wall renewal leaves until the P5 retention job runs).
-- m-1 (tile reconnect). A CLOSED, not revoked, session may be opened again within its 90 s connect window, one socket at a time, at
--      most 3 opens in all; it is re-checked fully each time. A revoked session, a copy of a token whose socket is still open, and a
--      session past its window are refused as before.
-- m-4 (the twin). `access_twin_violations()` compares has_capability_for and has_capability_for_user on every test run, not only when
--      0029 applied.
-- Test helper `media_sessions_age_test(sid, seconds)` (test organisations only): moves a session's times back.

-- ═══ Columns and indexes ════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.media_sessions ADD COLUMN open_count integer NOT NULL DEFAULT 0 CHECK (open_count BETWEEN 0 AND 3);
UPDATE public.media_sessions SET open_count = 1 WHERE opened_at IS NOT NULL;
-- The opened, still running sessions of a person (the commit-time re-check), and a person's never-opened ones (the clean-up).
CREATE INDEX media_sessions_user_live_idx ON public.media_sessions (user_id) WHERE opened_at IS NOT NULL AND closed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX media_sessions_user_unopened_idx ON public.media_sessions (user_id, connect_by) WHERE opened_at IS NULL;

-- ═══ What is wrong with a session (internal): a never-opened session past its window has ended ═════════════════════════════
CREATE OR REPLACE FUNCTION public.media_session_problem(m public.media_sessions) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN m.closed_at IS NOT NULL THEN 'closed'
    WHEN m.revoked_at IS NOT NULL THEN m.revoke_reason
    WHEN m.opened_at IS NULL AND m.connect_by < now() THEN 'connect_window_passed'
    WHEN m.expires_at <= now() THEN 'expired'
    ELSE public.media_session_target_problem(m.org_id, m.user_id, m.kind, m.camera_id, m.asset_id, m.aal2)
  END
$$;

-- ═══ Making sessions: also clears the person's own stale never-opened ones ═══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.media_session_create(p_org uuid, p_user uuid, p_kind text, p_cameras uuid[], p_streams text[] DEFAULT NULL,
  p_aal2 boolean DEFAULT false, p_connect_sec integer DEFAULT 90, p_max_sec integer DEFAULT 1800)
RETURNS TABLE(camera_id uuid, sid uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  i integer;
  v_cam uuid;
  v_sid uuid;
  v_cap text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('live', 'playback', 'vod', 'export_download') THEN
    RAISE EXCEPTION 'media_session_create makes camera sessions only' USING ERRCODE = '22023';
  END IF;
  IF p_cameras IS NULL OR cardinality(p_cameras) = 0 OR cardinality(p_cameras) > 100 THEN
    RAISE EXCEPTION 'between 1 and 100 cameras' USING ERRCODE = '22023';
  END IF;
  IF p_streams IS NOT NULL AND cardinality(p_streams) <> cardinality(p_cameras) THEN
    RAISE EXCEPTION 'one stream name per camera' USING ERRCODE = '22023';
  END IF;
  IF p_connect_sec IS NULL OR p_connect_sec NOT BETWEEN 1 AND 300 OR p_max_sec IS NULL OR p_max_sec NOT BETWEEN 1 AND 7200 THEN
    RAISE EXCEPTION 'connect window 1..300 s, length 1..7200 s' USING ERRCODE = '22023';
  END IF;
  -- I-1 e: the person's never-opened sessions whose window ended over 5 minutes ago are of no use to anybody.
  DELETE FROM public.media_sessions s WHERE s.user_id = p_user AND s.opened_at IS NULL AND s.connect_by < now() - interval '5 minutes';
  v_cap := CASE p_kind WHEN 'live' THEN 'cctv.live' WHEN 'playback' THEN 'cctv.playback' ELSE 'cctv.export' END;
  FOR i IN 1 .. cardinality(p_cameras) LOOP
    v_cam := p_cameras[i];
    CONTINUE WHEN v_cam IS NULL;
    CONTINUE WHEN public.media_session_target_problem(p_org, p_user, p_kind, v_cam, NULL, coalesce(p_aal2, false)) IS NOT NULL;
    INSERT INTO public.media_sessions (org_id, user_id, kind, camera_id, capability, stream, aal2, connect_by, expires_at)
    VALUES (p_org, p_user, p_kind, v_cam, v_cap, CASE WHEN p_streams IS NULL THEN NULL ELSE p_streams[i] END, coalesce(p_aal2, false),
            now() + make_interval(secs => p_connect_sec), now() + make_interval(secs => p_connect_sec + p_max_sec))
    RETURNING id INTO v_sid;
    camera_id := v_cam;
    sid := v_sid;
    RETURN NEXT;
  END LOOP;
END
$$;

-- ═══ Opening: once at a time; a closed (not revoked) session reopens within its window, at most 3 opens ═════════════════════
CREATE OR REPLACE FUNCTION public.media_session_open(p_sid uuid, p_user uuid, p_camera uuid, p_kind text, p_stream text)
RETURNS TABLE(ok boolean, reason text, kind text, stream text, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  m public.media_sessions;
  v_problem text;
BEGIN
  SELECT * INTO m FROM public.media_sessions s WHERE s.id = p_sid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF m.user_id IS DISTINCT FROM p_user OR m.camera_id IS DISTINCT FROM p_camera OR m.kind IS DISTINCT FROM p_kind OR m.stream IS DISTINCT FROM p_stream THEN
    RETURN QUERY SELECT false, 'mismatch'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF m.revoked_at IS NOT NULL THEN
    -- Revoked never opens again (brief 6b).
    RETURN QUERY SELECT false, m.revoke_reason, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF m.opened_at IS NOT NULL THEN
    IF m.closed_at IS NULL THEN
      -- Its socket is still open: a copied token or a second socket.
      RETURN QUERY SELECT false, 'already_opened'::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    IF now() > m.connect_by OR m.open_count >= 3 THEN
      RETURN QUERY SELECT false, 'closed'::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    m.closed_at := NULL; -- review m-1: the tile reconnects with the same token; checked like a first open
  END IF;
  v_problem := public.media_session_problem(m);
  IF v_problem IS NULL AND now() > m.connect_by THEN v_problem := 'connect_window_passed'; END IF;
  IF v_problem IS NOT NULL THEN
    UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = v_problem WHERE s.id = p_sid AND s.revoked_at IS NULL;
    RETURN QUERY SELECT false, v_problem, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE public.media_sessions s
  SET opened_at = coalesce(s.opened_at, now()), closed_at = NULL, open_count = s.open_count + 1, last_validated_at = now()
  WHERE s.id = p_sid;
  RETURN QUERY SELECT true, NULL::text, m.kind, m.stream, m.expires_at;
END
$$;

-- ═══ Re-checking people: opened sessions only (I-1 a) ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.media_sessions_revalidate(p_org uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n integer;
BEGIN
  IF p_users IS NULL OR cardinality(p_users) = 0 THEN RETURN 0; END IF;
  WITH judged AS MATERIALIZED (
    SELECT m.id, public.media_session_problem(m) AS problem FROM public.media_sessions m
    WHERE m.org_id = p_org AND m.user_id = ANY (p_users) AND m.opened_at IS NOT NULL AND m.closed_at IS NULL AND m.revoked_at IS NULL
  )
  UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = j.problem FROM judged j WHERE s.id = j.id AND j.problem IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- The most session re-checks one transaction does at commit (I-1 c); the gateway's periodic check covers the rest.
CREATE FUNCTION public.media_sessions_recheck_budget() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 1000 $$;

-- ═══ The deferred trigger: bounded (I-1 a-d) ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.media_sessions_profile_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v record;
  v_reason text;
  v_done text;
  v_used integer;
  v_open integer;
  v_lock text;
BEGIN
  -- Only sessions with a socket matter here; a never-opened one is checked when it is opened.
  IF NOT EXISTS (SELECT 1 FROM public.media_sessions m WHERE m.user_id = NEW.id AND m.opened_at IS NOT NULL AND m.closed_at IS NULL AND m.revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  v_lock := current_setting('lock_timeout');
  BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
    SELECT p.org_id, p.is_active, p.must_reset_password INTO v FROM public.profiles p WHERE p.id = NEW.id;
    v_reason := CASE
      WHEN NOT FOUND THEN 'person_not_found'
      WHEN NOT v.is_active THEN 'deactivated'
      WHEN v.must_reset_password THEN 'password_reset'
      WHEN OLD.role IS DISTINCT FROM NEW.role THEN 'role_changed'
      WHEN OLD.org_id IS DISTINCT FROM NEW.org_id THEN 'person_not_found'
    END;
    IF v_reason IS NOT NULL THEN
      UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = v_reason
      WHERE s.user_id = NEW.id AND s.closed_at IS NULL AND s.revoked_at IS NULL;
    ELSE
      -- Once per person per transaction: at COMMIT every part of the change is visible, so a second re-check finds nothing new.
      v_done := coalesce(current_setting('drishti.media_rechecked', true), '');
      IF position(NEW.id::text IN v_done) = 0 THEN
        v_used := coalesce(nullif(current_setting('drishti.media_recheck_used', true), '')::integer, 0);
        SELECT count(*) INTO v_open FROM public.media_sessions m
        WHERE m.user_id = NEW.id AND m.opened_at IS NOT NULL AND m.closed_at IS NULL AND m.revoked_at IS NULL;
        PERFORM set_config('drishti.media_rechecked', v_done || NEW.id::text || ',', true);
        IF v_used + v_open <= public.media_sessions_recheck_budget() THEN
          PERFORM set_config('drishti.media_recheck_used', (v_used + v_open)::text, true);
          PERFORM public.media_sessions_revalidate(v.org_id, ARRAY[NEW.id]);
        ELSE
          RAISE WARNING 'media session re-check budget reached in this transaction; the gateway check ends the remaining sessions';
        END IF;
      END IF;
    END IF;
    PERFORM set_config('lock_timeout', v_lock, true);
  EXCEPTION WHEN OTHERS THEN
    -- query_canceled (a statement timeout or a cancel) is not caught by WHEN OTHERS and is never swallowed.
    PERFORM set_config('lock_timeout', v_lock, true);
    RAISE WARNING 'media session re-check after an access change failed (%); the gateway check will catch it', SQLSTATE;
  END;
  RETURN NULL;
END
$$;

-- ═══ m-4: the twin, checked on every run ════════════════════════════════════════════════════════════════════════════════════
-- The twins whose bodies differ (after replacing the caller by the parameter); empty is correct.
CREATE FUNCTION public.access_twin_violations() RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_self text;
  v_twin text;
BEGIN
  v_self := replace(replace(regexp_replace(pg_catalog.pg_get_functiondef('public.has_capability_for(text, text, uuid)'::regprocedure), '^.*?AS \$function\$', '', 's'),
    '(SELECT auth.uid())', 'p_user'), 'public.access_caller_aal2()', 'p_aal2');
  v_twin := regexp_replace(pg_catalog.pg_get_functiondef('public.has_capability_for_user(uuid, text, text, uuid, boolean)'::regprocedure), '^.*?AS \$function\$', '', 's');
  IF v_self IS DISTINCT FROM v_twin THEN RETURN NEXT 'has_capability_for_user differs from has_capability_for'; END IF;
  RETURN;
END
$$;

-- ═══ Test helper (test organisations only) ══════════════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.media_sessions_age_test(p_sid uuid, p_seconds integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'seconds 1..86400' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.media_sessions m JOIN public.organizations o ON o.id = m.org_id WHERE m.id = p_sid AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'only sessions of test organisations' USING ERRCODE = '42501';
  END IF;
  UPDATE public.media_sessions s SET created_at = s.created_at - make_interval(secs => p_seconds), connect_by = s.connect_by - make_interval(secs => p_seconds),
    expires_at = s.expires_at - make_interval(secs => p_seconds) WHERE s.id = p_sid;
END
$$;

-- ═══ Privileges (default privileges are closed; explicit REVOKE / GRANT) ═════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION
  public.media_session_problem(public.media_sessions),
  public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.media_sessions_revalidate(uuid, uuid[]),
  public.media_sessions_recheck_budget(),
  public.media_sessions_profile_changed(),
  public.access_twin_violations(),
  public.media_sessions_age_test(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.media_sessions_revalidate(uuid, uuid[]),
  public.access_twin_violations(),
  public.media_sessions_age_test(uuid, integer)
TO service_role;

-- ═══ Self-test ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-4 r1 self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-4 r1 self-test: a function names a removed object'; END IF;
  IF EXISTS (SELECT 1 FROM public.access_twin_violations()) THEN RAISE EXCEPTION 'P2-4 r1 self-test: the twin differs'; END IF;
  IF has_function_privilege('authenticated', 'public.media_session_open(uuid, uuid, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.access_twin_violations()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_sessions_age_test(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.media_sessions_profile_changed()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.media_session_problem(public.media_sessions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2-4 r1 self-test: a server-only object is reachable from outside';
  END IF;
END
$$;
