-- P4-L1 (live wall, navigation by the hierarchy, roll-ups; LG-1..LG-7, LG-19, LG-21; directive monitoring overview).
--
--   status_rollups(p_cap)        signed-in people only. One row per region, cluster and location the caller may see something in:
--                                camera figures over the cameras the caller may see (any CCTV right; with p_cap exactly that CCTV
--                                capability, and then only rows that have such a camera — the Live tree) and recorder (NVR) figures
--                                over the NVRs the caller has the recorder-level IT view of (it_view_recorder_ids), NULL where they
--                                have none — the masking of status_reasons: a CCTV-only viewer learns nothing about NVRs, not even
--                                how many there are. A camera whose NVR is down (the checker's method 'nvr_down') counts as
--                                "recorder not reachable", never as offline (directive: unknown because a parent is unreachable);
--                                a camera on an NVR that is not monitored counts as switched off only (review M6, as location_status).
--                                Region and cluster rows only for nodes whose names the caller may see (any_grant_region_ids /
--                                any_grant_cluster_ids: impact map 1.9, review M15), and never through an archived node (an
--                                archived cluster or region cuts the path, like access_ancestry). Archived and switched-off
--                                locations and archived or switched-off cameras are not counted. Nothing of another organisation.
--   media_sessions.location_id   the camera's location and the recorder of its active mapping when the session was made (stream
--   media_sessions.recorder_id   opens recorded: who, camera, location, NVR, main/sub = the stream name, opened_at, closed_at),
--                                filled by a BEFORE INSERT trigger from the camera row, so media_session_create (P2-4) is unchanged.
--   media_sessions_live_open     the media path only (media_service, service_role): the distinct live stream names the person has
--                                open now — a socket the gateway opened, not closed or revoked, not expired, and opened or checked
--                                by the gateway within p_fresh_sec (default 60 s; the gateway checks every 15 s, so a socket of a
--                                gateway that stopped drops out within a minute). openStreams caps a new opening with it
--                                (LIVE_MAX_STREAMS_PER_USER, default 25).
-- Grants: explicit REVOKE ALL first; status_rollups to authenticated; media_sessions_live_open to service_role and media_service; the
-- trigger function to nobody. All SECURITY DEFINER with SET search_path = '' and fully qualified names.
-- Rollback: supabase/rollback/20261021000038_p4l1_live_rollups_rollback.sql (dry run: psql -v drishti_dry_run=1 -f …).

BEGIN;

-- ── 1. status_rollups ─────────────────────────────────────────────────────────
CREATE FUNCTION public.status_rollups(p_cap text DEFAULT NULL)
RETURNS TABLE(
  level text, node_id uuid,
  cameras_total integer, cameras_live integer, cameras_stale integer, cameras_offline integer, cameras_recorder_unreachable integer,
  cameras_not_checked integer, cameras_off integer,
  recorders_total integer, recorders_up integer, recorders_down integer, recorders_not_checked integer, recorders_stale integer, recorders_off integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH org AS MATERIALIZED (SELECT public.current_org_id() AS id),
       ok AS MATERIALIZED (SELECT (p_cap IS NULL OR p_cap IN ('cctv.live', 'cctv.playback', 'cctv.export')) AS yes),
       stale_after AS MATERIALIZED (SELECT make_interval(mins => public.monitor_stale_after_minutes()) AS v),
       seen AS MATERIALIZED (
         SELECT x AS id FROM public.any_cctv_camera_ids() AS x WHERE p_cap IS NULL
         UNION
         -- never called with anything but a CCTV capability (an unknown key must not become an error that says what exists)
         SELECT x FROM public.capability_camera_ids(CASE WHEN p_cap IN ('cctv.live', 'cctv.playback', 'cctv.export') THEN p_cap ELSE '' END) AS x
         WHERE p_cap IS NOT NULL AND (SELECT yes FROM ok)),
       it_recs AS MATERIALIZED (SELECT x AS id FROM public.it_view_recorder_ids() AS x),
       vis_regions AS MATERIALIZED (SELECT x AS id FROM public.any_grant_region_ids() AS x),
       vis_clusters AS MATERIALIZED (SELECT x AS id FROM public.any_grant_cluster_ids() AS x),
       loc AS MATERIALIZED (
         SELECT l.id, l.cluster_id FROM public.locations l
         WHERE l.org_id = (SELECT id FROM org) AND l.is_active AND l.archived_at IS NULL),
       clu AS MATERIALIZED (
         SELECT c.id, c.region_id FROM public.clusters c WHERE c.org_id = (SELECT id FROM org) AND c.archived_at IS NULL),
       reg AS MATERIALIZED (
         SELECT r.id FROM public.regions r WHERE r.org_id = (SELECT id FROM org) AND r.archived_at IS NULL),
       cam AS (
         SELECT c.location_id, cs.status, cs.method,
                coalesce(cs.last_checked_at >= now() - (SELECT v FROM stale_after), false) AS fresh,
                coalesce(r.monitoring_enabled AND ra.enabled, true) AS mon
         FROM public.cameras c
         JOIN seen ON seen.id = c.id
         JOIN loc ON loc.id = c.location_id
         LEFT JOIN public.check_state cs ON cs.org_id = c.org_id AND cs.target_type = 'camera' AND cs.target_id = c.id
         LEFT JOIN public.recorders r ON r.id = c.recorder_id
         LEFT JOIN public.assets ra ON ra.id = c.recorder_id
         WHERE c.org_id = (SELECT id FROM org) AND c.is_active AND c.archived_at IS NULL),
       cam_loc AS (
         SELECT location_id,
                count(*)::integer AS total,
                count(*) FILTER (WHERE mon AND status = 'up' AND fresh)::integer AS live,
                count(*) FILTER (WHERE mon AND status = 'up' AND NOT fresh)::integer AS stale,
                count(*) FILTER (WHERE mon AND status = 'down' AND method IS DISTINCT FROM 'nvr_down')::integer AS offline,
                count(*) FILTER (WHERE mon AND status = 'down' AND method = 'nvr_down')::integer AS unreachable,
                count(*) FILTER (WHERE mon AND (status IS NULL OR status NOT IN ('up', 'down')))::integer AS not_checked,
                count(*) FILTER (WHERE NOT mon)::integer AS off
         FROM cam GROUP BY location_id),
       rec AS (
         SELECT r.location_id, rs.status,
                coalesce(rs.last_checked_at >= now() - (SELECT v FROM stale_after), false) AS fresh,
                (r.monitoring_enabled AND a.enabled) AS mon
         FROM public.recorders r
         JOIN it_recs ON it_recs.id = r.id
         JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
         JOIN loc ON loc.id = r.location_id
         LEFT JOIN public.check_state rs ON rs.org_id = r.org_id AND rs.target_type = 'recorder' AND rs.target_id = r.id
         WHERE r.org_id = (SELECT id FROM org)),
       rec_loc AS (
         SELECT location_id,
                count(*)::integer AS total,
                count(*) FILTER (WHERE mon AND status = 'up' AND fresh)::integer AS up,
                count(*) FILTER (WHERE mon AND status = 'down')::integer AS down,
                count(*) FILTER (WHERE mon AND (status IS NULL OR status NOT IN ('up', 'down')))::integer AS not_checked,
                count(*) FILTER (WHERE mon AND status = 'up' AND NOT fresh)::integer AS stale,
                count(*) FILTER (WHERE NOT mon)::integer AS off
         FROM rec GROUP BY location_id),
       per_loc AS MATERIALIZED (
         SELECT loc.id AS location_id,
                CASE WHEN loc.cluster_id IN (SELECT id FROM clu) THEN loc.cluster_id END AS cluster_id,
                coalesce(cl.total, 0) AS c_total, coalesce(cl.live, 0) AS c_live, coalesce(cl.stale, 0) AS c_stale,
                coalesce(cl.offline, 0) AS c_offline, coalesce(cl.unreachable, 0) AS c_unreachable,
                coalesce(cl.not_checked, 0) AS c_not_checked, coalesce(cl.off, 0) AS c_off,
                rl.total AS r_total, rl.up AS r_up, rl.down AS r_down, rl.not_checked AS r_not_checked, rl.stale AS r_stale, rl.off AS r_off
         FROM loc
         LEFT JOIN cam_loc cl ON cl.location_id = loc.id
         LEFT JOIN rec_loc rl ON rl.location_id = loc.id
         WHERE (cl.location_id IS NOT NULL OR rl.location_id IS NOT NULL)
           AND (p_cap IS NULL OR coalesce(cl.total, 0) > 0)
           AND (SELECT yes FROM ok)),
       per_cluster AS (
         SELECT p.cluster_id AS node_id,
                sum(p.c_total)::integer AS c_total, sum(p.c_live)::integer AS c_live, sum(p.c_stale)::integer AS c_stale,
                sum(p.c_offline)::integer AS c_offline, sum(p.c_unreachable)::integer AS c_unreachable,
                sum(p.c_not_checked)::integer AS c_not_checked, sum(p.c_off)::integer AS c_off,
                sum(p.r_total)::integer AS r_total, sum(p.r_up)::integer AS r_up, sum(p.r_down)::integer AS r_down,
                sum(p.r_not_checked)::integer AS r_not_checked, sum(p.r_stale)::integer AS r_stale, sum(p.r_off)::integer AS r_off
         FROM per_loc p WHERE p.cluster_id IS NOT NULL GROUP BY p.cluster_id),
       per_region AS (
         SELECT clu.region_id AS node_id,
                sum(p.c_total)::integer AS c_total, sum(p.c_live)::integer AS c_live, sum(p.c_stale)::integer AS c_stale,
                sum(p.c_offline)::integer AS c_offline, sum(p.c_unreachable)::integer AS c_unreachable,
                sum(p.c_not_checked)::integer AS c_not_checked, sum(p.c_off)::integer AS c_off,
                sum(p.r_total)::integer AS r_total, sum(p.r_up)::integer AS r_up, sum(p.r_down)::integer AS r_down,
                sum(p.r_not_checked)::integer AS r_not_checked, sum(p.r_stale)::integer AS r_stale, sum(p.r_off)::integer AS r_off
         FROM per_loc p JOIN clu ON clu.id = p.cluster_id
         WHERE clu.region_id IN (SELECT id FROM reg)
         GROUP BY clu.region_id)
  SELECT 'location', p.location_id, p.c_total, p.c_live, p.c_stale, p.c_offline, p.c_unreachable, p.c_not_checked, p.c_off,
         p.r_total, p.r_up, p.r_down, p.r_not_checked, p.r_stale, p.r_off
  FROM per_loc p
  UNION ALL
  SELECT 'cluster', c.node_id, c.c_total, c.c_live, c.c_stale, c.c_offline, c.c_unreachable, c.c_not_checked, c.c_off,
         c.r_total, c.r_up, c.r_down, c.r_not_checked, c.r_stale, c.r_off
  FROM per_cluster c WHERE c.node_id IN (SELECT id FROM vis_clusters)
  UNION ALL
  SELECT 'region', g.node_id, g.c_total, g.c_live, g.c_stale, g.c_offline, g.c_unreachable, g.c_not_checked, g.c_off,
         g.r_total, g.r_up, g.r_down, g.r_not_checked, g.r_stale, g.r_off
  FROM per_region g WHERE g.node_id IN (SELECT id FROM vis_regions)
  ORDER BY 1, 2
$$;

REVOKE ALL ON FUNCTION public.status_rollups(text) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.status_rollups(text) TO authenticated;

-- ── 2. Stream opens recorded with their location and NVR ─────────────────────
ALTER TABLE public.media_sessions ADD COLUMN location_id uuid, ADD COLUMN recorder_id uuid;

CREATE FUNCTION public.media_sessions_before_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.location_id := NULL;
  NEW.recorder_id := NULL;
  IF NEW.camera_id IS NOT NULL THEN
    -- cameras.recorder_id is the cache of the camera's ACTIVE channel mapping (P2-5a triggers): the NVR at the time of the session.
    SELECT c.location_id, c.recorder_id INTO NEW.location_id, NEW.recorder_id
    FROM public.cameras c WHERE c.id = NEW.camera_id AND c.org_id = NEW.org_id;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.media_sessions_before_insert() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;

CREATE TRIGGER media_sessions_before_insert BEFORE INSERT ON public.media_sessions
  FOR EACH ROW EXECUTE FUNCTION public.media_sessions_before_insert();

-- ── 3. The person's open live streams (bounded concurrency) ───────────────────
CREATE FUNCTION public.media_sessions_live_open(p_org uuid, p_user uuid, p_fresh_sec integer DEFAULT 60)
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

REVOKE ALL ON FUNCTION public.media_sessions_live_open(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.media_sessions_live_open(uuid, uuid, integer) TO service_role, media_service;

NOTIFY pgrst, 'reload schema';

COMMIT;
