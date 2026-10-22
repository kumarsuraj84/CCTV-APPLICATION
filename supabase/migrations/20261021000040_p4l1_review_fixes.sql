-- P4-L1 review round 1 (.superpowers/sdd/drishti/p4-l1-review.md).
--
-- I-1, the per-person live stream cap, enforced by the database (race-free: one advisory lock per person):
--   media_sessions.stream_cap        the cap a live session was handed out under (NULL: made without one; the default 25 then applies
--                                    at the gateway's open).
--   media_sessions_held_live         internal: the distinct live streams a person HOLDS now — a socket the gateway opened and still
--                                    checks (opened or validated within 60 s, not closed, revoked or expired) OR a token handed out
--                                    that can still connect (never opened, not revoked or closed, connect window not passed).
--   media_session_create_live        the video path's live opening and token renewal (service_role, media_service): under the person's
--                                    lock, first revokes the person's own UNUSED live sessions of the streams the wall let go of
--                                    (`p_release`, reason 'released'; never a requested one), then admits the requested streams in the
--                                    wall's order — streams already held first (renewals, they count once), new ones while the person's
--                                    distinct held streams stay within `p_max` — makes their sessions through media_session_create
--                                    (unchanged: it checks the person, the capability and the camera) with stream_cap = p_max, and
--                                    answers the others as paused (no session).
--   media_session_open               (gateway) for a live session, under the same lock: refused with reason 'limit' — the session is
--                                    not used up and may try again — when the person already has stream_cap (default 25) OTHER
--                                    distinct live streams open. So a false "release", a copied token or many windows at once cannot
--                                    put more sockets through the gateway than the cap. Everything else is verbatim from 0033.
--   media_sessions_live_open         now also counts tokens that can still connect (as media_sessions_held_live).
-- I-3 (MC-4), one rule on every screen: location_status.cameras_down no longer counts a camera that is down only because its NVR
--   cannot be reached (check_state.method 'nvr_down'); the new last column cameras_recorder_unreachable counts those. The camera
--   figures still need a CCTV right per camera (any_cctv_camera_ids), the recorder figures the recorder-level IT view, as before; the
--   method stays unreadable by signed-in people (column privileges) — the view, owned by postgres with security_barrier, reads it.
--   The worker's writes are unchanged.
-- Grants: explicit REVOKE ALL first; media_session_create_live to service_role and media_service; media_sessions_held_live to nobody.
-- Every function SECURITY DEFINER with SET search_path = ''.
-- Rollback: supabase/rollback/20261021000040_p4l1_review_fixes_rollback.sql (dry run: psql -v drishti_dry_run=1 -f …).

BEGIN;

ALTER TABLE public.media_sessions ADD COLUMN stream_cap integer CHECK (stream_cap IS NULL OR stream_cap BETWEEN 1 AND 100);

-- ── 1. What a person holds ────────────────────────────────────────────────────
CREATE FUNCTION public.media_sessions_held_live(p_org uuid, p_user uuid, p_fresh_sec integer DEFAULT 60)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT s.stream
  FROM public.media_sessions s
  WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'live' AND s.stream IS NOT NULL AND s.revoked_at IS NULL
    AND (
      (s.opened_at IS NOT NULL AND s.closed_at IS NULL AND s.expires_at > now()
       AND greatest(s.opened_at, coalesce(s.last_validated_at, s.opened_at)) > now() - make_interval(secs => least(greatest(coalesce(p_fresh_sec, 60), 1), 3600)))
      OR (s.opened_at IS NULL AND s.closed_at IS NULL AND s.connect_by > now())
    )
$$;

REVOKE ALL ON FUNCTION public.media_sessions_held_live(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE OR REPLACE FUNCTION public.media_sessions_live_open(p_org uuid, p_user uuid, p_fresh_sec integer DEFAULT 60)
RETURNS TABLE(stream text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h FROM public.media_sessions_held_live(p_org, p_user, p_fresh_sec) AS h ORDER BY 1
$$;

-- ── 2. Live opening and renewal with the cap ──────────────────────────────────
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

-- ── 3. The gateway's open: the cap is the database's last word ────────────────
CREATE OR REPLACE FUNCTION public.media_session_open(p_sid uuid, p_user uuid, p_camera uuid, p_kind text, p_stream text)
 RETURNS TABLE(ok boolean, reason text, kind text, stream text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  m public.media_sessions;
  v_problem text;
BEGIN
  -- P4-L1 review I-1: live opens of one person are serialised (the same lock as media_session_create_live), taken before the row.
  IF p_kind = 'live' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.live:' || p_user::text, 0));
  END IF;
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
  -- P4-L1 review I-1: a live socket above the person's cap is refused; the session is not used up (it may try again later).
  IF m.kind = 'live' AND (
    SELECT count(DISTINCT s.stream) FROM public.media_sessions s
    WHERE s.user_id = m.user_id AND s.org_id = m.org_id AND s.kind = 'live' AND s.id <> m.id AND s.stream IS DISTINCT FROM m.stream
      AND s.opened_at IS NOT NULL AND s.closed_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
      AND greatest(s.opened_at, coalesce(s.last_validated_at, s.opened_at)) > now() - interval '60 seconds'
  ) >= coalesce(m.stream_cap, 25) THEN
    RETURN QUERY SELECT false, 'limit'::text, NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  UPDATE public.media_sessions s
  SET opened_at = coalesce(s.opened_at, now()), closed_at = NULL, open_count = s.open_count + 1, last_validated_at = now()
  WHERE s.id = p_sid;
  RETURN QUERY SELECT true, NULL::text, m.kind, m.stream, m.expires_at;
END
$function$;

-- ── 4. location_status: recorder not reachable is not down ────────────────────
CREATE OR REPLACE VIEW public.location_status WITH (security_barrier = true) AS
 SELECT l.id AS location_id,
    l.org_id,
    COALESCE(cam.total, 0) AS cameras_total,
    COALESCE(cam.live, 0) AS cameras_live,
    COALESCE(cam.down, 0) AS cameras_down,
    COALESCE(cam.unknown, 0) AS cameras_unknown,
    rec.status AS nvr_status,
    rec.down_since AS nvr_down_since,
    rec.checked_at AS nvr_checked_at,
    COALESCE(cam.stale, 0) AS cameras_stale,
    COALESCE(rec.stale, false) AS nvr_stale,
    COALESCE(rec.total, 0) AS recorders_total,
    COALESCE(rec.up, 0) AS recorders_up,
    COALESCE(rec.down, 0) AS recorders_down,
    COALESCE(rec.unknown, 0) AS recorders_unknown,
    COALESCE(rec.off, 0) AS recorders_monitoring_off,
    COALESCE(cam.off, 0) AS cameras_monitoring_off,
    COALESCE(cam.unreachable, 0) AS cameras_recorder_unreachable
   FROM public.locations l
     LEFT JOIN ( SELECT x.location_id,
            count(*)::integer AS total,
            count(*) FILTER (WHERE x.mon AND x.status = 'up'::text AND x.fresh)::integer AS live,
            count(*) FILTER (WHERE x.mon AND x.status = 'down'::text AND x.method IS DISTINCT FROM 'nvr_down'::text)::integer AS down,
            count(*) FILTER (WHERE x.mon AND (x.status IS NULL OR x.status = 'unknown'::text))::integer AS unknown,
            count(*) FILTER (WHERE x.mon AND x.status = 'up'::text AND NOT x.fresh)::integer AS stale,
            count(*) FILTER (WHERE NOT x.mon)::integer AS off,
            count(*) FILTER (WHERE x.mon AND x.status = 'down'::text AND x.method = 'nvr_down'::text)::integer AS unreachable
           FROM ( SELECT c.location_id,
                    cs.status,
                    cs.method,
                    COALESCE(cs.last_checked_at >= (now() - make_interval(mins => public.monitor_stale_after_minutes())), false) AS fresh,
                    COALESCE(r.monitoring_enabled AND ra.enabled, true) AS mon
                   FROM public.cameras c
                     LEFT JOIN public.check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera'::text AND cs.target_id = c.id
                     LEFT JOIN public.recorders r ON r.id = c.recorder_id
                     LEFT JOIN public.assets ra ON ra.id = c.recorder_id
                  WHERE c.org_id = (( SELECT public.current_org_id() AS current_org_id)) AND c.is_active AND c.archived_at IS NULL AND (c.id IN ( SELECT public.any_cctv_camera_ids() AS any_cctv_camera_ids))) x
          GROUP BY x.location_id) cam ON cam.location_id = l.id
     LEFT JOIN ( SELECT y.location_id,
            count(*)::integer AS total,
            count(*) FILTER (WHERE y.mon AND y.status = 'up'::text)::integer AS up,
            count(*) FILTER (WHERE y.mon AND y.status = 'down'::text)::integer AS down,
            count(*) FILTER (WHERE y.mon AND (y.status IS NULL OR y.status = 'unknown'::text))::integer AS unknown,
            count(*) FILTER (WHERE NOT y.mon)::integer AS off,
                CASE
                    WHEN bool_or(y.mon AND y.status = 'down'::text) THEN 'down'::text
                    WHEN bool_or(y.mon AND y.status IS NULL) THEN NULL::text
                    WHEN bool_or(y.mon AND y.status = 'unknown'::text) THEN 'unknown'::text
                    WHEN bool_or(y.mon AND y.status = 'up'::text) THEN 'up'::text
                    ELSE NULL::text
                END AS status,
            min(y.down_since) FILTER (WHERE y.mon AND y.status = 'down'::text) AS down_since,
            min(y.last_checked_at) FILTER (WHERE y.mon) AS checked_at,
            bool_or(y.mon AND y.status = 'up'::text AND NOT y.fresh) AS stale
           FROM ( SELECT r.location_id,
                    rs.status,
                    rs.down_since,
                    rs.last_checked_at,
                    COALESCE(rs.last_checked_at >= (now() - make_interval(mins => public.monitor_stale_after_minutes())), false) AS fresh,
                    r.monitoring_enabled AND a.enabled AS mon
                   FROM public.recorders r
                     JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
                     LEFT JOIN public.check_state rs ON rs.org_id = r.org_id AND rs.target_type = 'recorder'::text AND rs.target_id = r.id
                  WHERE r.org_id = (( SELECT public.current_org_id() AS current_org_id)) AND (r.id IN ( SELECT public.it_view_recorder_ids() AS it_view_recorder_ids))) y
          GROUP BY y.location_id) rec ON rec.location_id = l.id
  WHERE l.org_id = (( SELECT public.current_org_id() AS current_org_id)) AND l.is_active AND l.archived_at IS NULL AND (l.id IN ( SELECT public.any_grant_location_ids() AS any_grant_location_ids));

NOTIFY pgrst, 'reload schema';

COMMIT;
