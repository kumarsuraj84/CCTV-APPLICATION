-- P4-L1 fix round 2 (.superpowers/sdd/drishti/p4-l1-rereview.md).
--
-- N-6, a release belongs to the window that made the tokens: every live session now carries the id of the browser window (page load)
--   that asked for it (media_sessions.client_id, a random id the page makes; NULL for sessions made without one). A wall's release on
--   its next request (p_release) revokes only that window's own unused tokens, so a second window of the same person watching the same
--   camera keeps its token. A released stream stops counting against the cap only for that window: the same stream held by another
--   window still counts.
-- N-1, leaving a page: media_sessions_release_live, the release a page sends when it is left (pagehide, hidden, route change; best
--   effort). It names the media sessions of the tokens the page holds (the server reads them from the signed tokens, which are the
--   person's own), so it can reach neither another window's token nor a token handed out after the page was left (a next wall on
--   the same camera). Only unused tokens are revoked (reason 'released'); a socket that is open is never ended here and nothing is
--   opened; the sockets end when the page closes them (the gateway closes the session).
--   media_session_create_live    replaced (one new last parameter p_client uuid): sessions are stamped with p_client; the release and
--                                the "released streams do not count" rule apply to p_client's sessions only. Everything else is as in
--                                0040 (lock per person, renewals first, cap p_max, paused answers, stream_cap stamped).
--   media_sessions_release_live  new (service_role, media_service): under the same lock per person; returns how many were revoked.
-- Grants: explicit REVOKE ALL first; both functions to service_role and media_service only. SECURITY DEFINER, SET search_path = ''.
-- Rollback: supabase/rollback/20261021000043_p4l1_window_release_rollback.sql (dry run: psql -v drishti_dry_run=1 -f …).

BEGIN;

ALTER TABLE public.media_sessions ADD COLUMN client_id uuid;

DROP FUNCTION public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[]);

CREATE FUNCTION public.media_session_create_live(p_org uuid, p_user uuid, p_cameras uuid[], p_streams text[], p_max integer, p_release text[] DEFAULT NULL, p_client uuid DEFAULT NULL)
RETURNS TABLE(camera_id uuid, sid uuid, paused boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_max integer := least(greatest(coalesce(p_max, 25), 1), 100);
  v_release text[] := coalesce(p_release, '{}'::text[]);
  v_held text[];
  v_room integer;
  v_admit_c uuid[] := '{}';
  v_admit_s text[] := '{}';
  v_seen text[] := '{}';
  i integer;
  pass integer;
  rec record;
BEGIN
  IF p_cameras IS NULL OR p_streams IS NULL OR cardinality(p_cameras) = 0 OR cardinality(p_cameras) > 100 OR cardinality(p_streams) <> cardinality(p_cameras) THEN
    RAISE EXCEPTION 'between 1 and 100 cameras, one stream name each' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.live:' || p_user::text, 0));
  IF cardinality(v_release) > 0 THEN
    UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = 'released'
    WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'live' AND s.opened_at IS NULL AND s.revoked_at IS NULL
      AND s.client_id IS NOT DISTINCT FROM p_client
      AND s.stream = ANY (v_release) AND NOT (s.stream = ANY (p_streams));
  END IF;
  -- What the person holds (as media_sessions_held_live), except the streams this window let go of: its own sockets of those may still
  -- be closing (the gateway's open refuses a socket above the cap, so a false release gains nothing). Another window's hold counts.
  SELECT coalesce(array_agg(DISTINCT s.stream), '{}') INTO v_held
  FROM public.media_sessions s
  WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'live' AND s.stream IS NOT NULL AND s.revoked_at IS NULL
    AND (
      (s.opened_at IS NOT NULL AND s.closed_at IS NULL AND s.expires_at > now()
       AND greatest(s.opened_at, coalesce(s.last_validated_at, s.opened_at)) > now() - interval '60 seconds')
      OR (s.opened_at IS NULL AND s.closed_at IS NULL AND s.connect_by > now())
    )
    AND NOT (s.stream = ANY (v_release) AND s.client_id IS NOT DISTINCT FROM p_client);
  v_room := v_max - (SELECT count(*) FROM unnest(v_held) AS h WHERE NOT (h = ANY (p_streams)));
  -- First the streams already held (renewals: they count once), then new ones, each in the wall's order.
  FOR pass IN 1 .. 2 LOOP
    FOR i IN 1 .. cardinality(p_streams) LOOP
      CONTINUE WHEN p_streams[i] IS NULL OR p_cameras[i] IS NULL OR p_streams[i] = ANY (v_seen);
      CONTINUE WHEN (pass = 1) <> (p_streams[i] = ANY (v_held));
      v_seen := v_seen || p_streams[i];
      IF v_room > 0 THEN
        v_admit_c := v_admit_c || p_cameras[i];
        v_admit_s := v_admit_s || p_streams[i];
        v_room := v_room - 1;
      ELSE
        camera_id := p_cameras[i];
        sid := NULL;
        paused := true;
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  IF cardinality(v_admit_c) > 0 THEN
    FOR rec IN SELECT * FROM public.media_session_create(p_org, p_user, 'live', v_admit_c, v_admit_s) LOOP
      UPDATE public.media_sessions s SET stream_cap = v_max, client_id = p_client WHERE s.id = rec.sid;
      camera_id := rec.camera_id;
      sid := rec.sid;
      paused := false;
      RETURN NEXT;
    END LOOP;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[], uuid) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[], uuid) TO service_role, media_service;

CREATE FUNCTION public.media_sessions_release_live(p_org uuid, p_user uuid, p_sids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_sids IS NULL OR cardinality(p_sids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_sids) > 150 THEN
    RAISE EXCEPTION 'at most 150 sessions' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.live:' || p_user::text, 0));
  UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = 'released'
  WHERE s.id = ANY (p_sids) AND s.user_id = p_user AND s.org_id = p_org AND s.kind = 'live'
    AND s.opened_at IS NULL AND s.revoked_at IS NULL AND s.closed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.media_sessions_release_live(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_sessions_release_live(uuid, uuid, uuid[]) TO service_role, media_service;

NOTIFY pgrst, 'reload schema';

COMMIT;
