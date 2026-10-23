-- P4-L2 review round 1 (owner ruling on I-1: playback-only people must not be able to dump recordings). Fast playback 2x-16x is a
-- `playback` media session with the stream name fpb_<camera>_<start>_<end> (lib/streams/fast-token.ts). This migration:
--   media_sessions.fast_media_sec        the seconds of recording a fast stream really released (set when it ends).
--   media_session_create_fast(...)       one fast playback for a person, under one advisory lock per person (race-free across tabs and
--                                        app instances): the person's budget of recording minutes in the last hour and the last 24 hours
--                                        (a finished stream counts what it released; a pending or running one its whole span; one never
--                                        opened whose window passed, or revoked before it opened, nothing), then the person's other fast
--                                        sessions are revoked ('superseded': one fast playback per person at a time; a running one stops
--                                        within the 15 s check), then the session itself through media_session_create (unchanged: it checks
--                                        the person, cctv.playback and the camera again). Refused: no session, the reason and the minutes used.
--   media_session_finish(sid, media_sec) closes a fast session for good: it records what was released and revokes it ('finished'), so its
--                                        token can never be replayed to start the clip again (media_session_open refuses a revoked one).
-- Grants: explicit REVOKE ALL first; both functions to service_role and media_service only. SECURITY DEFINER with SET search_path = ''.
-- Rollback: supabase/rollback/20261021000042_p4l2_fast_budget_rollback.sql (dry run: -v drishti_dry_run=1).

BEGIN;

ALTER TABLE public.media_sessions ADD COLUMN fast_media_sec integer CHECK (fast_media_sec IS NULL OR fast_media_sec BETWEEN 0 AND 86400);
COMMENT ON COLUMN public.media_sessions.fast_media_sec IS
  'P4-L2 review I-1: seconds of recording a fast playback stream (kind playback, stream fpb_...) released; NULL while it runs or for other kinds.';

-- The span of a fast session in seconds, from its signed stream name (fpb_<camera>_<start>_<end>); 0 for anything else.
CREATE FUNCTION public.media_session_fast_span(p_stream text) RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_stream ~ '^fpb_[0-9a-f-]{36}_[0-9]{1,12}_[0-9]{1,12}$'
    THEN greatest(0, least(86400, (split_part(p_stream, '_', 4))::bigint - (split_part(p_stream, '_', 3))::bigint))::integer
    ELSE 0 END
$$;
REVOKE ALL ON FUNCTION public.media_session_fast_span(text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

-- What one fast session counts against the budget, in seconds of recording.
CREATE FUNCTION public.media_session_fast_charge(m public.media_sessions) RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN m.fast_media_sec IS NOT NULL THEN m.fast_media_sec
    WHEN m.opened_at IS NULL AND (m.revoked_at IS NOT NULL OR m.connect_by < now()) THEN 0
    ELSE public.media_session_fast_span(m.stream)
  END
$$;
REVOKE ALL ON FUNCTION public.media_session_fast_charge(public.media_sessions) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE FUNCTION public.media_session_create_fast(p_org uuid, p_user uuid, p_camera uuid, p_stream text, p_hour_min integer, p_day_min integer, p_max_sec integer DEFAULT 1860)
RETURNS TABLE(sid uuid, refused text, used_hour_min integer, used_day_min integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_span integer := public.media_session_fast_span(p_stream);
  v_hour integer;
  v_day integer;
  v_sid uuid;
BEGIN
  IF p_org IS NULL OR p_user IS NULL OR p_camera IS NULL OR v_span <= 0 OR v_span > 1800
     OR p_hour_min IS NULL OR p_hour_min NOT BETWEEN 1 AND 1440 OR p_day_min IS NULL OR p_day_min NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'a fast playback stream name and budgets of 1 to 1440 minutes' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.fast:' || p_user::text, 0));
  SELECT coalesce(sum(public.media_session_fast_charge(s)) FILTER (WHERE s.created_at > now() - interval '1 hour'), 0),
         coalesce(sum(public.media_session_fast_charge(s)), 0)
    INTO v_hour, v_day
  FROM public.media_sessions s
  WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'playback' AND s.stream LIKE 'fpb\_%' AND s.created_at > now() - interval '24 hours';
  IF v_hour + v_span > p_hour_min * 60 THEN
    RETURN QUERY SELECT NULL::uuid, 'budget_hour'::text, ceil(v_hour / 60.0)::integer, ceil(v_day / 60.0)::integer;
    RETURN;
  END IF;
  IF v_day + v_span > p_day_min * 60 THEN
    RETURN QUERY SELECT NULL::uuid, 'budget_day'::text, ceil(v_hour / 60.0)::integer, ceil(v_day / 60.0)::integer;
    RETURN;
  END IF;
  -- One fast playback per person at a time: the others end (a running one is stopped by its 15 s check).
  UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = 'superseded'
  WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'playback' AND s.stream LIKE 'fpb\_%'
    AND s.revoked_at IS NULL AND s.closed_at IS NULL AND s.expires_at > now();
  SELECT c.sid INTO v_sid FROM public.media_session_create(p_org, p_user, 'playback', ARRAY[p_camera], ARRAY[p_stream], false, 90, least(greatest(coalesce(p_max_sec, 1860), 60), 7200)) AS c;
  IF v_sid IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 'not_allowed'::text, ceil(v_hour / 60.0)::integer, ceil(v_day / 60.0)::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_sid, NULL::text, ceil((v_hour + v_span) / 60.0)::integer, ceil((v_day + v_span) / 60.0)::integer;
END
$$;
REVOKE ALL ON FUNCTION public.media_session_create_fast(uuid, uuid, uuid, text, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_create_fast(uuid, uuid, uuid, text, integer, integer, integer) TO service_role, media_service;

CREATE FUNCTION public.media_session_finish(p_sid uuid, p_media_sec integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.media_sessions s
  SET fast_media_sec = least(greatest(coalesce(p_media_sec, 0), 0), public.media_session_fast_span(s.stream)),
      closed_at = coalesce(s.closed_at, now()),
      revoked_at = coalesce(s.revoked_at, now()),
      revoke_reason = coalesce(s.revoke_reason, 'finished')
  WHERE s.id = p_sid AND s.kind = 'playback' AND s.stream LIKE 'fpb\_%' AND s.fast_media_sec IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END
$$;
REVOKE ALL ON FUNCTION public.media_session_finish(uuid, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_finish(uuid, integer) TO service_role, media_service;

-- Self-test: no privilege violations, and the helpers are callable by nobody signed in.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P4-L2 fix round 1: privilege violations'; END IF;
  IF public.media_session_fast_span('fpb_0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111_1000_1600') <> 600 THEN RAISE EXCEPTION 'P4-L2: span'; END IF;
  IF public.media_session_fast_span('pb_0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111_1000') <> 0 THEN RAISE EXCEPTION 'P4-L2: span of another kind'; END IF;
  IF has_function_privilege('authenticated', 'public.media_session_create_fast(uuid, uuid, uuid, text, integer, integer, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_session_finish(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('video_gateway', 'public.media_session_finish(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P4-L2: a fast playback function is callable by the wrong role';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
