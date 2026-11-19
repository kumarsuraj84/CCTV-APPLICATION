-- Final fix X round 3 (pre-handover review I-1; ruling NB-12 as revised in docs/drishti/DECISIONS.md).
--
-- The gateway's fail-safe of round 2 counted any go2rtc failure before video (other than "wrong user/pass") twice within 10 minutes as
-- a refused login of the whole NVR. One dead camera channel (its tile reconnects every few seconds and fails the same way) or a dropped
-- branch WAN link was then enough to refuse all of that NVR's cameras for everybody, stop the worker's checks, escalate the back-off,
-- pause the NVR and list it under "NVR login problems". Now:
--   1. 'network' (a timeout, reset, unreachable host, DNS or TLS failure, a connection cut without a word): only noted
--      (last_network_at). It never opens a window, never raises the level, never adds to the 3-in-30-minutes pause and is never listed.
--   2. 'unexplained' (a text the gateway cannot read, as a sha256 hash): it is that camera's own failure ('camera') when the NVR's
--      current login was proven within the last 10 minutes or any of its cameras played video within the last 10 minutes; otherwise it
--      is counted per CAMERA: the same failure again from the same camera counts once. The same failure from TWO OR MORE DIFFERENT
--      cameras of the NVR within 10 minutes is the fail-safe: its own state, outcome 'refused' with last_refused_path
--      'gateway_unexplained' (every path waits for the window, so an unknown wording for a wrong password cannot keep go2rtc dialling),
--      NOT added to the refusal times of the pause; the Monitoring page lists it as "unexplained", with "Try again". Answers 'unexplained'.
--   3. 'video' (the gateway now reports it while a stream plays, at most once a minute per stream): clears the count, notes the time.
--   4. nvr_login_current (a new saved login) also clears the per-camera list; nvr_login_state_age_test ages the new times too.
-- Rollback: supabase/rollback/20261021000052_fx_nvr_login_failsafe_rollback.sql (dry run: -v drishti_dry_run=1).

BEGIN;

ALTER TABLE public.nvr_login_state
  ADD COLUMN unexplained_cameras uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(unexplained_cameras) <= 10),
  ADD COLUMN last_network_at timestamptz;
COMMENT ON COLUMN public.nvr_login_state.unexplained_cameras IS
  'Round 3 (NB-12): the camera of each entry of unexplained (same order): the fail-safe needs the same failure from two different cameras.';
COMMENT ON COLUMN public.nvr_login_state.last_network_at IS
  'Round 3 (NB-12): the last network failure the gateway reported for this NVR (noted only; never a login problem).';

-- As in 20261021000050, plus: a new login also clears the per-camera list of the unexplained failures.
CREATE OR REPLACE FUNCTION public.nvr_login_current(p_recorder uuid, p_org uuid, p_version text) RETURNS public.nvr_login_state
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  st public.nvr_login_state;
BEGIN
  INSERT INTO public.nvr_login_state (recorder_id, org_id, version) VALUES (p_recorder, p_org, p_version) ON CONFLICT (recorder_id) DO NOTHING;
  SELECT * INTO st FROM public.nvr_login_state s WHERE s.recorder_id = p_recorder FOR UPDATE;
  IF st.version IS DISTINCT FROM p_version THEN
    UPDATE public.nvr_login_state s
    SET version = p_version, outcome = NULL, level = 0, refused_until = NULL, attempt_until = NULL, attempt_path = NULL, last_ok_at = NULL,
        refusals = '{}', unexplained = '{}', unexplained_cameras = '{}', unexplained_hash = NULL, updated_at = now()
    WHERE s.recorder_id = p_recorder
    RETURNING * INTO st;
  END IF;
  RETURN st;
END
$$;

/**
 * The gateway's report about one open (or just closed) live or playback session's go2rtc source (see the header):
 * 'video' → 'cleared'; 'network' → 'network'; 'unexplained' (p_hash = sha256 hex of the text) → 'camera' (proven or playing lately),
 * 'counted', or 'unexplained' (the fail-safe). 'ignored': no such session, no NVR, no saved login, or the NVR already waits.
 */
CREATE OR REPLACE FUNCTION public.media_session_login_report(p_sid uuid, p_kind text, p_hash text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cam uuid;
  v_org uuid;
  v_rec uuid;
  v_ver text;
  st public.nvr_login_state;
  v_now constant timestamptz := now();
  v_fresh constant interval := interval '10 minutes';
  v_times timestamptz[];
  v_cams uuid[];
  v_level integer;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('video', 'network', 'unexplained') THEN RAISE EXCEPTION 'video, network or unexplained' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'unexplained' AND (p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'a sha256 hex hash' USING ERRCODE = '22023'; END IF;
  SELECT m.camera_id, m.org_id INTO v_cam, v_org FROM public.media_sessions m
  WHERE m.id = p_sid AND m.opened_at IS NOT NULL AND m.opened_at > v_now - interval '1 hour' AND m.kind IN ('live', 'playback');
  IF v_cam IS NULL THEN RETURN 'ignored'; END IF;
  v_rec := (SELECT mp.recorder_id FROM public.camera_channel_mappings mp WHERE mp.camera_id = v_cam AND mp.org_id = v_org AND mp.valid_to IS NULL);
  IF v_rec IS NULL THEN RETURN 'ignored'; END IF;
  v_ver := public.nvr_login_version(v_rec);
  IF v_ver IS NULL THEN RETURN 'ignored'; END IF;
  st := public.nvr_login_current(v_rec, v_org, v_ver);

  IF p_kind = 'video' THEN
    UPDATE public.nvr_login_state s SET unexplained = '{}', unexplained_cameras = '{}', unexplained_hash = NULL, last_video_at = v_now, updated_at = v_now
    WHERE s.recorder_id = v_rec;
    RETURN 'cleared';
  END IF;
  IF p_kind = 'network' THEN
    -- Noted only: no window, no level, no refusal time, not listed (the tile retries on its own back-off; MC-4).
    UPDATE public.nvr_login_state s SET last_network_at = v_now, updated_at = v_now WHERE s.recorder_id = v_rec;
    RETURN 'network';
  END IF;

  IF st.outcome = 'refused' AND st.refused_until > v_now THEN RETURN 'ignored'; END IF;
  -- A login proven, or video played, within the last 10 minutes: this failure is the camera's own, not the NVR's.
  IF st.last_ok_at > v_now - v_fresh OR st.last_video_at > v_now - v_fresh THEN RETURN 'camera'; END IF;

  -- The same failure within 10 minutes, one entry per camera (the newest), at most 10.
  SELECT coalesce(array_agg(q.t ORDER BY q.t), '{}'), coalesce(array_agg(q.c ORDER BY q.t), '{}') INTO v_times, v_cams
  FROM (
    SELECT DISTINCT ON (u.c) u.t, u.c
    FROM (
      SELECT x.t, x.c FROM unnest(st.unexplained, st.unexplained_cameras) AS x(t, c)
      WHERE st.unexplained_hash IS NOT DISTINCT FROM p_hash AND x.t > v_now - v_fresh AND x.c IS NOT NULL AND x.t IS NOT NULL
      UNION ALL SELECT v_now, v_cam
    ) u
    ORDER BY u.c, u.t DESC
  ) q;
  IF cardinality(v_times) > 10 THEN
    v_times := v_times[cardinality(v_times) - 9 : cardinality(v_times)];
    v_cams := v_cams[cardinality(v_cams) - 9 : cardinality(v_cams)];
  END IF;

  IF cardinality(v_cams) >= 2 THEN
    -- The fail-safe: every path waits for the window (as for a refused login, doubling while it repeats), but it is its own state:
    -- not a refusal time (no 3-in-30-minutes pause) and listed as "unexplained" (last_refused_path 'gateway_unexplained').
    v_level := (CASE WHEN st.outcome = 'refused' THEN st.level ELSE 0 END) + 1;
    UPDATE public.nvr_login_state s
    SET outcome = 'refused', level = v_level,
        refused_until = v_now + pg_catalog.make_interval(secs => least(21600::numeric, 900::numeric * pg_catalog.power(2::numeric, (least(v_level, 21) - 1)::numeric))::double precision),
        attempt_until = NULL, attempt_path = NULL, last_refused_at = v_now, last_refused_path = 'gateway_unexplained',
        unexplained = '{}', unexplained_cameras = '{}', unexplained_hash = NULL, updated_at = v_now
    WHERE s.recorder_id = v_rec;
    RETURN 'unexplained';
  END IF;
  UPDATE public.nvr_login_state s SET unexplained = v_times, unexplained_cameras = v_cams, unexplained_hash = p_hash, updated_at = v_now
  WHERE s.recorder_id = v_rec;
  RETURN 'counted';
END
$$;

-- As in 20261021000048, plus the times added since (video, network, the unexplained failures).
CREATE OR REPLACE FUNCTION public.nvr_login_state_age_test(p_recorder uuid, p_seconds integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  d interval;
BEGIN
  IF p_seconds IS NULL OR p_seconds < 0 OR p_seconds > 864000 THEN RAISE EXCEPTION 'from 0 to 10 days' USING ERRCODE = '22023'; END IF;
  v_org := (SELECT s.org_id FROM public.nvr_login_state s WHERE s.recorder_id = p_recorder);
  IF v_org IS NULL THEN RAISE EXCEPTION 'no state for this recorder' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.inventory_require_test_org(v_org);
  d := pg_catalog.make_interval(secs => p_seconds);
  UPDATE public.nvr_login_state s
  SET refused_until = s.refused_until - d, last_refused_at = s.last_refused_at - d, last_ok_at = s.last_ok_at - d, ever_ok_at = s.ever_ok_at - d,
      attempt_until = s.attempt_until - d, refusals = ARRAY(SELECT t - d FROM unnest(s.refusals) AS t ORDER BY 1),
      last_video_at = s.last_video_at - d, last_network_at = s.last_network_at - d,
      unexplained = ARRAY(SELECT t - d FROM unnest(s.unexplained) WITH ORDINALITY AS x(t, i) ORDER BY i)
  WHERE s.recorder_id = p_recorder;
END
$$;

-- ── privileges (explicit; the replaced functions keep exactly the grants they had) ──
REVOKE ALL ON FUNCTION
  public.nvr_login_current(uuid, uuid, text),
  public.media_session_login_report(uuid, text, text),
  public.nvr_login_state_age_test(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_login_report(uuid, text, text) TO service_role, media_service, video_gateway;
GRANT EXECUTE ON FUNCTION public.nvr_login_state_age_test(uuid, integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN
    RAISE EXCEPTION 'privilege_violations() is not empty after 0052: %', (SELECT string_agg(v, '; ') FROM public.privilege_violations() v);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
