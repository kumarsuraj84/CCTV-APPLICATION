-- Rollback of 20261021000052_fx_nvr_login_failsafe.sql (final fix X round 3). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim media_session_login_report and nvr_login_current of 0050 and nvr_login_state_age_test of 0048, and removes the
-- two new columns. WARNING: the round-2 fail-safe comes back (one dead camera channel can refuse a whole NVR, pre-handover review I-1),
-- and the round-3 gateway's 'network' reports are then refused as bad requests (best effort: a failed report changes nothing else).
-- An NVR in the round-3 state "unexplained" keeps its window; the Monitoring page then lists it as a refused login.

BEGIN;

CREATE OR REPLACE FUNCTION public.media_session_login_report(p_sid uuid, p_kind text, p_hash text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cam uuid;
  v_org uuid;
  v_rec uuid;
  v_ver text;
  st public.nvr_login_state;
  v_now constant timestamptz := now();
  v_list timestamptz[];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('video', 'unexplained') THEN RAISE EXCEPTION 'video or unexplained' USING ERRCODE = '22023'; END IF;
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
    UPDATE public.nvr_login_state s SET unexplained = '{}', unexplained_hash = NULL, last_video_at = v_now, updated_at = v_now WHERE s.recorder_id = v_rec;
    RETURN 'cleared';
  END IF;
  IF st.outcome = 'refused' THEN RETURN 'ignored'; END IF;
  v_list := CASE WHEN st.unexplained_hash IS NOT DISTINCT FROM p_hash
                 THEN ARRAY(SELECT t FROM unnest(st.unexplained) AS t WHERE t > v_now - interval '10 minutes' ORDER BY t)
                 ELSE '{}'::timestamptz[] END;
  v_list := (ARRAY(SELECT t FROM unnest(v_list || v_now) AS t ORDER BY t DESC LIMIT 10))::timestamptz[];
  UPDATE public.nvr_login_state s SET unexplained = v_list, unexplained_hash = p_hash, updated_at = v_now WHERE s.recorder_id = v_rec;
  IF cardinality(v_list) >= 2 THEN
    PERFORM public.nvr_login_report(v_rec, v_ver, 'refused', 'gateway');
    UPDATE public.nvr_login_state s SET unexplained = '{}', unexplained_hash = NULL WHERE s.recorder_id = v_rec;
    RETURN 'refused';
  END IF;
  RETURN 'counted';
END
$$;

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
        refusals = '{}', unexplained = '{}', unexplained_hash = NULL, updated_at = now()
    WHERE s.recorder_id = p_recorder
    RETURNING * INTO st;
  END IF;
  RETURN st;
END
$$;

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
      attempt_until = s.attempt_until - d, refusals = ARRAY(SELECT t - d FROM unnest(s.refusals) AS t ORDER BY 1)
  WHERE s.recorder_id = p_recorder;
END
$$;

ALTER TABLE public.nvr_login_state DROP COLUMN unexplained_cameras, DROP COLUMN last_network_at;

REVOKE ALL ON FUNCTION
  public.nvr_login_current(uuid, uuid, text),
  public.media_session_login_report(uuid, text, text),
  public.nvr_login_state_age_test(uuid, integer)
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_login_report(uuid, text, text) TO service_role, media_service, video_gateway;
GRANT EXECUTE ON FUNCTION public.nvr_login_state_age_test(uuid, integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0052: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
