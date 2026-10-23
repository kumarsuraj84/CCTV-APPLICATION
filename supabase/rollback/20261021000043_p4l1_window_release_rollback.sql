-- Rollback of 20261021000043_p4l1_window_release.sql (P4-L1 fix round 2). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back media_session_create_live as in 0040 (verbatim, without p_client) with its grants, drops media_sessions_release_live and
-- media_sessions.client_id. What is lost: which window made each live session (sessions themselves stay); a release then revokes the
-- person's unused tokens of those streams in every window again. Roll the code back with it (lib/streams/registry.ts passes p_client,
-- /api/live/release calls media_sessions_release_live).

BEGIN;

DROP FUNCTION IF EXISTS public.media_sessions_release_live(uuid, uuid, uuid[]);
DROP FUNCTION IF EXISTS public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[], uuid);

CREATE FUNCTION public.media_session_create_live(p_org uuid, p_user uuid, p_cameras uuid[], p_streams text[], p_max integer, p_release text[] DEFAULT NULL)
RETURNS TABLE(camera_id uuid, sid uuid, paused boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_max integer := least(greatest(coalesce(p_max, 25), 1), 100);
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
  IF p_release IS NOT NULL AND cardinality(p_release) > 0 THEN
    UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = 'released'
    WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'live' AND s.opened_at IS NULL AND s.revoked_at IS NULL
      AND s.stream = ANY (p_release) AND NOT (s.stream = ANY (p_streams));
  END IF;
  SELECT coalesce(array_agg(h), '{}') INTO v_held
  FROM public.media_sessions_held_live(p_org, p_user) AS h
  WHERE NOT (h = ANY (coalesce(p_release, '{}'::text[])));
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
      UPDATE public.media_sessions s SET stream_cap = v_max WHERE s.id = rec.sid;
      camera_id := rec.camera_id;
      sid := rec.sid;
      paused := false;
      RETURN NEXT;
    END LOOP;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[]) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[]) TO service_role, media_service;

ALTER TABLE public.media_sessions DROP COLUMN IF EXISTS client_id;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
