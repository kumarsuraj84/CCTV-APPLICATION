-- Rollback of 20261021000032_p24_review_fixes.sql (P2-4 review round 1). Run before the 0029 rollback. Puts back the five functions
-- verbatim from 0029 (the commit-time re-check then again covers never-opened sessions, without the once-per-person rule or the budget,
-- and closed sessions no longer reopen), and drops the twin check, the test helper, the budget, the two indexes and open_count.
-- No session row is changed (open_count is dropped; reopened sessions keep their times).
DROP FUNCTION IF EXISTS public.access_twin_violations();
DROP FUNCTION IF EXISTS public.media_sessions_age_test(uuid, integer);
DROP INDEX IF EXISTS public.media_sessions_user_live_idx;
DROP INDEX IF EXISTS public.media_sessions_user_unopened_idx;

CREATE OR REPLACE FUNCTION public.media_session_problem(m public.media_sessions) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN m.closed_at IS NOT NULL THEN 'closed'
    WHEN m.revoked_at IS NOT NULL THEN m.revoke_reason
    WHEN m.expires_at <= now() THEN 'expired'
    ELSE public.media_session_target_problem(m.org_id, m.user_id, m.kind, m.camera_id, m.asset_id, m.aal2)
  END
$$;

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
  IF m.opened_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'already_opened'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  v_problem := public.media_session_problem(m);
  IF v_problem IS NULL AND now() > m.connect_by THEN v_problem := 'connect_window_passed'; END IF;
  IF v_problem IS NOT NULL THEN
    UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = v_problem WHERE s.id = p_sid AND s.revoked_at IS NULL AND s.closed_at IS NULL;
    RETURN QUERY SELECT false, v_problem, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE public.media_sessions s SET opened_at = now(), last_validated_at = now() WHERE s.id = p_sid;
  RETURN QUERY SELECT true, NULL::text, m.kind, m.stream, m.expires_at;
END
$$;

CREATE OR REPLACE FUNCTION public.media_sessions_revalidate(p_org uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n integer;
BEGIN
  IF p_users IS NULL OR cardinality(p_users) = 0 THEN RETURN 0; END IF;
  WITH judged AS MATERIALIZED (
    SELECT m.id, public.media_session_problem(m) AS problem FROM public.media_sessions m
    WHERE m.org_id = p_org AND m.user_id = ANY (p_users) AND m.closed_at IS NULL AND m.revoked_at IS NULL
  )
  UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = j.problem FROM judged j WHERE s.id = j.id AND j.problem IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE OR REPLACE FUNCTION public.media_sessions_profile_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v record;
  v_reason text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.media_sessions m WHERE m.user_id = NEW.id AND m.closed_at IS NULL AND m.revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  BEGIN
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
      PERFORM public.media_sessions_revalidate(v.org_id, ARRAY[NEW.id]);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'media session re-check after an access change failed (%); the gateway check will catch it', SQLSTATE;
  END;
  RETURN NULL;
END
$$;

DROP FUNCTION IF EXISTS public.media_sessions_recheck_budget();
ALTER TABLE public.media_sessions DROP COLUMN IF EXISTS open_count;

REVOKE ALL ON FUNCTION
  public.media_session_problem(public.media_sessions),
  public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.media_sessions_revalidate(uuid, uuid[]),
  public.media_sessions_profile_changed()
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.media_sessions_revalidate(uuid, uuid[])
TO service_role;
