-- Rollback of 20261021000040_p4l1_review_fixes.sql (P4-L1 review round 1). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim (from the database before 0040): media_session_open (0033), media_sessions_live_open (0038) and location_status
-- (0038; dropped and made again because a column cannot be removed in place, with its grants and security_barrier). Drops
-- media_session_create_live, media_sessions_held_live and media_sessions.stream_cap. What is lost: the cap each live session was
-- handed out under (sessions themselves stay). Roll the code back with it (openStreams / renewStreams call media_session_create_live;
-- the screens read location_status.cameras_recorder_unreachable).

BEGIN;

DROP FUNCTION IF EXISTS public.media_session_create_live(uuid, uuid, uuid[], text[], integer, text[]);

CREATE OR REPLACE FUNCTION public.media_sessions_live_open(p_org uuid, p_user uuid, p_fresh_sec integer DEFAULT 60)
RETURNS TABLE(stream text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT s.stream
  FROM public.media_sessions s
  WHERE s.user_id = p_user AND s.org_id = p_org AND s.kind = 'live' AND s.stream IS NOT NULL
    AND s.opened_at IS NOT NULL AND s.closed_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
    AND greatest(s.opened_at, coalesce(s.last_validated_at, s.opened_at)) > now() - make_interval(secs => least(greatest(coalesce(p_fresh_sec, 60), 1), 3600))
  ORDER BY 1
$$;

DROP FUNCTION IF EXISTS public.media_sessions_held_live(uuid, uuid, integer);

-- media_session_open as before 0040, verbatim.
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
$function$

;

DROP VIEW public.location_status;
CREATE VIEW public.location_status WITH (security_barrier = true) AS
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
    COALESCE(cam.off, 0) AS cameras_monitoring_off
   FROM locations l
     LEFT JOIN ( SELECT x.location_id,
            count(*)::integer AS total,
            count(*) FILTER (WHERE x.mon AND x.status = 'up'::text AND x.fresh)::integer AS live,
            count(*) FILTER (WHERE x.mon AND x.status = 'down'::text)::integer AS down,
            count(*) FILTER (WHERE x.mon AND (x.status IS NULL OR x.status = 'unknown'::text))::integer AS unknown,
            count(*) FILTER (WHERE x.mon AND x.status = 'up'::text AND NOT x.fresh)::integer AS stale,
            count(*) FILTER (WHERE NOT x.mon)::integer AS off
           FROM ( SELECT c.location_id,
                    cs.status,
                    COALESCE(cs.last_checked_at >= (now() - make_interval(mins => monitor_stale_after_minutes())), false) AS fresh,
                    COALESCE(r.monitoring_enabled AND ra.enabled, true) AS mon
                   FROM cameras c
                     LEFT JOIN check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera'::text AND cs.target_id = c.id
                     LEFT JOIN recorders r ON r.id = c.recorder_id
                     LEFT JOIN assets ra ON ra.id = c.recorder_id
                  WHERE c.org_id = (( SELECT current_org_id() AS current_org_id)) AND c.is_active AND c.archived_at IS NULL AND (c.id IN ( SELECT any_cctv_camera_ids() AS any_cctv_camera_ids))) x
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
                    COALESCE(rs.last_checked_at >= (now() - make_interval(mins => monitor_stale_after_minutes())), false) AS fresh,
                    r.monitoring_enabled AND a.enabled AS mon
                   FROM recorders r
                     JOIN assets a ON a.id = r.id AND a.archived_at IS NULL
                     LEFT JOIN check_state rs ON rs.org_id = r.org_id AND rs.target_type = 'recorder'::text AND rs.target_id = r.id
                  WHERE r.org_id = (( SELECT current_org_id() AS current_org_id)) AND (r.id IN ( SELECT it_view_recorder_ids() AS it_view_recorder_ids))) y
          GROUP BY y.location_id) rec ON rec.location_id = l.id
  WHERE l.org_id = (( SELECT current_org_id() AS current_org_id)) AND l.is_active AND l.archived_at IS NULL AND (l.id IN ( SELECT any_grant_location_ids() AS any_grant_location_ids));

REVOKE ALL ON public.location_status FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.location_status TO authenticated, service_role, app_web;

ALTER TABLE public.media_sessions DROP COLUMN IF EXISTS stream_cap;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
