-- Final fix X (release 1 review C: I-1, I-2, I-3, I-4 and the monitoring minors M-1, M-2, M-29): protect the real NVRs from failed-login
-- storms, and roll monitoring out safely. Rulings NB-1..NB-6 in docs/drishti/DECISIONS.md.
--
--   1. nvr_login_state: ONE login state per recorder (NVR), in the database, shared by the worker, the web server (discovery, the
--      connection test, live video, playback, fast playback, the downloads) and the video gateway. It replaces the two in-memory tables
--      (the worker's per-epoch WeakMap and the web server's per-process map), so it survives restarts and lease changes. Rules: see
--      lib/nvr/login-policy.ts (the same rules in TypeScript; tests/integration/nvr-login-state-db.test.ts runs them against both).
--   2. nvr_login_gate / nvr_login_report: what a caller may do now (go, probe = the one allowed attempt, wait, refused, paused,
--      no_password) and what its login did (ok, refused, unknown). nvr_login_try_again: an administrator ends a back-off (audited).
--   3. media_session_login_check / media_session_login_refused: the gateway's two questions, by session id only (it may not name a
--      recorder): may this open session's camera be dialled (no while its NVR's login stands refused), and "go2rtc said wrong user/pass".
--   4. recorder_set_monitoring_bulk: the monitoring rollout — switch monitoring on or off for every NVR of the organisation, a region,
--      a cluster or a location, with a reason, each NVR audited through recorder_set_monitoring.
--   5. M-1: monitor_run_started / monitor_run_finished store the DATABASE's time (as monitor_request_check does), so a worker clock that
--      is behind cannot make "check now" repeat whole runs.
--   6. M-2: an index on vault_reads (at) for its prune.
--   7. M-29: discovery_apply re-checks under its lock that the NVR is still monitored, enabled and at an active location.
--   8. privilege_violations(): the gateway's two new functions; the worker's two login functions take no fencing token (the login
--      state is not monitoring state and is shared with the web server, which holds no lease).
-- Rollback: supabase/rollback/20261021000048_fx_nvr_login_rollout_rollback.sql (dry run: -v drishti_dry_run=1).

BEGIN;

-- ── 1. The state ─────────────────────────────────────────────────────────────
CREATE TABLE public.nvr_login_state (
  recorder_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  -- The saved login this state is about: a hash of the vault secret's id and stored (encrypted) value, the address, the ports and the
  -- user name (nvr_login_version). Never the password; equal hashes only say "the same saved login".
  version text NOT NULL CHECK (length(version) = 32),
  outcome text CHECK (outcome IN ('ok', 'refused')),
  level integer NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 1000),
  refused_until timestamptz,
  last_refused_at timestamptz,
  last_refused_path text,
  last_ok_at timestamptz,
  ever_ok_at timestamptz,
  attempt_until timestamptz,
  attempt_path text,
  refusals timestamptz[] NOT NULL DEFAULT '{}' CHECK (cardinality(refusals) <= 10),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nvr_login_state_recorder_fk FOREIGN KEY (recorder_id, org_id) REFERENCES public.recorders (id, org_id) ON DELETE CASCADE
);
CREATE INDEX nvr_login_state_org_idx ON public.nvr_login_state (org_id);
ALTER TABLE public.nvr_login_state ENABLE ROW LEVEL SECURITY;
-- Written only by the functions below. Readable by the web app (the Monitoring page's list) and the service role (tests, tooling).
REVOKE ALL ON public.nvr_login_state FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT SELECT ON public.nvr_login_state TO app_web, service_role;
COMMENT ON TABLE public.nvr_login_state IS
  'Final fix X (NB-1): the shared NVR login back-off, one row per recorder. Written only by nvr_login_gate / nvr_login_report / nvr_login_try_again / media_session_login_refused.';

CREATE FUNCTION public.nvr_login_path_ok(p_path text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_path IS NOT NULL AND p_path IN ('monitoring', 'discovery', 'connection_test', 'live', 'playback', 'vod', 'export', 'gateway')
$$;

-- The current saved login of a recorder (see the column comment), or NULL when no password is saved (never contacted).
CREATE FUNCTION public.nvr_login_version(p_recorder uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pg_catalog.md5(pg_catalog.concat_ws('|', s.id::text, s.secret, coalesce(a.ip, ''), r.http_port::text, r.rtsp_port::text, coalesce(r.username, '')))
  FROM public.recorders r JOIN public.assets a ON a.id = r.id JOIN vault.secrets s ON s.id = r.secret_id
  WHERE r.id = p_recorder
$$;

-- The row of a recorder for its current login, locked (made when missing; a new login starts again: no outcome, no level, no window,
-- no attempt; whether it ever worked and the refusal times stay).
CREATE FUNCTION public.nvr_login_current(p_recorder uuid, p_org uuid, p_version text) RETURNS public.nvr_login_state
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  st public.nvr_login_state;
BEGIN
  INSERT INTO public.nvr_login_state (recorder_id, org_id, version) VALUES (p_recorder, p_org, p_version) ON CONFLICT (recorder_id) DO NOTHING;
  SELECT * INTO st FROM public.nvr_login_state s WHERE s.recorder_id = p_recorder FOR UPDATE;
  IF st.version IS DISTINCT FROM p_version THEN
    UPDATE public.nvr_login_state s
    SET version = p_version, outcome = NULL, level = 0, refused_until = NULL, attempt_until = NULL, attempt_path = NULL, last_ok_at = NULL, updated_at = now()
    WHERE s.recorder_id = p_recorder
    RETURNING * INTO st;
  END IF;
  RETURN st;
END
$$;

-- ── 2. Gate, report, "Try again" ─────────────────────────────────────────────
/**
 * What each caller may do now, per recorder (lib/nvr/login-policy.ts decideLogin): go | probe | wait | refused | paused | no_password.
 * p_claim: take the one attempt when a try is needed (then `claimed`, and the caller must report). p_fresh_sec: a proven login older
 * than this needs a new proof (NULL: any proven login will do). Recorders are handled in id order (no two callers lock in another order).
 */
CREATE FUNCTION public.nvr_login_gate(p_recorders uuid[], p_path text, p_claim boolean DEFAULT true, p_fresh_sec integer DEFAULT NULL)
RETURNS TABLE(recorder_id uuid, decision text, version text, until timestamptz, baselined boolean, level integer, claimed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_id uuid;
  v_org uuid;
  v_ver text;
  st public.nvr_login_state;
  v_now constant timestamptz := now();
  v_recent timestamptz[];
  v_n integer;
BEGIN
  IF NOT public.nvr_login_path_ok(p_path) THEN RAISE EXCEPTION 'unknown login path' USING ERRCODE = '22023'; END IF;
  IF p_recorders IS NULL OR cardinality(p_recorders) > 2000 THEN RAISE EXCEPTION 'between 0 and 2000 recorders' USING ERRCODE = '22023'; END IF;
  IF p_fresh_sec IS NOT NULL AND (p_fresh_sec < 10 OR p_fresh_sec > 2592000) THEN RAISE EXCEPTION 'freshness between 10 seconds and 30 days' USING ERRCODE = '22023'; END IF;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_recorders) AS x WHERE x IS NOT NULL ORDER BY 1 LOOP
    v_org := (SELECT r.org_id FROM public.recorders r WHERE r.id = v_id);
    CONTINUE WHEN v_org IS NULL;
    v_ver := public.nvr_login_version(v_id);
    IF v_ver IS NULL THEN
      RETURN QUERY SELECT v_id, 'no_password'::text, NULL::text, NULL::timestamptz,
        coalesce((SELECT s.ever_ok_at IS NOT NULL FROM public.nvr_login_state s WHERE s.recorder_id = v_id), false), 0, false;
      CONTINUE;
    END IF;
    st := public.nvr_login_current(v_id, v_org, v_ver);
    v_recent := ARRAY(SELECT t FROM unnest(st.refusals) AS t WHERE t > v_now - interval '1800 seconds' ORDER BY t);
    v_n := cardinality(v_recent);
    IF v_n >= 3 THEN
      RETURN QUERY SELECT v_id, 'paused'::text, v_ver, v_recent[v_n - 2] + interval '1800 seconds', st.ever_ok_at IS NOT NULL, st.level, false;
    ELSIF st.outcome = 'refused' AND st.refused_until > v_now THEN
      RETURN QUERY SELECT v_id, 'refused'::text, v_ver, st.refused_until, st.ever_ok_at IS NOT NULL, st.level, false;
    ELSIF st.outcome = 'ok' AND (p_fresh_sec IS NULL OR st.last_ok_at > v_now - pg_catalog.make_interval(secs => p_fresh_sec)) THEN
      RETURN QUERY SELECT v_id, 'go'::text, v_ver, NULL::timestamptz, st.ever_ok_at IS NOT NULL, st.level, false;
    ELSIF st.attempt_until > v_now THEN
      RETURN QUERY SELECT v_id, 'wait'::text, v_ver, st.attempt_until, st.ever_ok_at IS NOT NULL, st.level, false;
    ELSIF p_claim THEN
      UPDATE public.nvr_login_state s SET attempt_until = v_now + interval '60 seconds', attempt_path = p_path, updated_at = v_now WHERE s.recorder_id = v_id;
      RETURN QUERY SELECT v_id, 'probe'::text, v_ver, NULL::timestamptz, st.ever_ok_at IS NOT NULL, st.level, true;
    ELSE
      RETURN QUERY SELECT v_id, 'probe'::text, v_ver, NULL::timestamptz, st.ever_ok_at IS NOT NULL, st.level, false;
    END IF;
  END LOOP;
END
$$;

/**
 * What a login did (lib/nvr/login-policy.ts reportLogin): ok | refused | unknown (a timeout or no answer: the attempt is given back).
 * A report for another login than the current one changes nothing (`applied` false). The window after the n-th refusal in a row is
 * p_base_sec doubled n-1 times, at most p_max_sec.
 */
CREATE FUNCTION public.nvr_login_report(p_recorder uuid, p_version text, p_outcome text, p_path text, p_base_sec integer DEFAULT 900, p_max_sec integer DEFAULT 21600)
RETURNS TABLE(applied boolean, outcome text, level integer, until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_org uuid;
  v_ver text;
  st public.nvr_login_state;
  v_now constant timestamptz := now();
  v_refusals timestamptz[];
  v_level integer;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('ok', 'refused', 'unknown') THEN RAISE EXCEPTION 'ok, refused or unknown' USING ERRCODE = '22023'; END IF;
  IF NOT public.nvr_login_path_ok(p_path) THEN RAISE EXCEPTION 'unknown login path' USING ERRCODE = '22023'; END IF;
  IF p_base_sec IS NULL OR p_max_sec IS NULL OR p_base_sec < 60 OR p_base_sec > 86400 OR p_max_sec < p_base_sec OR p_max_sec > 86400 THEN
    RAISE EXCEPTION 'a back-off from 60 seconds to a day' USING ERRCODE = '22023';
  END IF;
  v_org := (SELECT r.org_id FROM public.recorders r WHERE r.id = p_recorder);
  v_ver := public.nvr_login_version(p_recorder);
  IF v_org IS NULL OR v_ver IS NULL OR v_ver IS DISTINCT FROM p_version THEN
    RETURN QUERY SELECT false, NULL::text, 0, NULL::timestamptz;
    RETURN;
  END IF;
  st := public.nvr_login_current(p_recorder, v_org, v_ver);
  IF p_outcome = 'ok' THEN
    UPDATE public.nvr_login_state s
    SET outcome = 'ok', level = 0, refused_until = NULL, last_ok_at = v_now, ever_ok_at = coalesce(s.ever_ok_at, v_now), attempt_until = NULL, attempt_path = NULL, updated_at = v_now
    WHERE s.recorder_id = p_recorder RETURNING * INTO st;
  ELSIF p_outcome = 'unknown' THEN
    UPDATE public.nvr_login_state s SET attempt_until = NULL, attempt_path = NULL, updated_at = v_now WHERE s.recorder_id = p_recorder RETURNING * INTO st;
  ELSE
    v_refusals := ARRAY(SELECT t FROM (SELECT t FROM unnest(st.refusals || v_now) AS t WHERE t > v_now - interval '1800 seconds' ORDER BY t DESC LIMIT 10) q ORDER BY t);
    IF st.outcome = 'refused' AND st.refused_until > v_now THEN
      -- An attempt that was already on its way when the first refusal came: counted, but the window is not doubled again.
      UPDATE public.nvr_login_state s SET refusals = v_refusals, attempt_until = NULL, attempt_path = NULL, last_refused_at = v_now, last_refused_path = p_path, updated_at = v_now
      WHERE s.recorder_id = p_recorder RETURNING * INTO st;
    ELSE
      v_level := (CASE WHEN st.outcome = 'refused' THEN st.level ELSE 0 END) + 1;
      UPDATE public.nvr_login_state s
      SET outcome = 'refused', level = v_level,
          refused_until = v_now + pg_catalog.make_interval(secs => least(p_max_sec::numeric, p_base_sec::numeric * pg_catalog.power(2::numeric, (least(v_level, 21) - 1)::numeric))::double precision),
          refusals = v_refusals, attempt_until = NULL, attempt_path = NULL, last_refused_at = v_now, last_refused_path = p_path, updated_at = v_now
      WHERE s.recorder_id = p_recorder RETURNING * INTO st;
    END IF;
  END IF;
  RETURN QUERY SELECT true, st.outcome, st.level, st.refused_until;
END
$$;

-- An administrator's "Try again" (NB-3): the window and its level end; the refusal times stay (three in 30 minutes still pause the NVR).
-- Only a super administrator, or an administrator holding admin.inventory for the whole organisation (as recorder_set_monitoring).
CREATE FUNCTION public.nvr_login_try_again(p_org uuid, p_recorder uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_was text;
BEGIN
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR (v_role <> 'platform_owner' AND NOT EXISTS (
           SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
           WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
    RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory may do this' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.recorders r WHERE r.id = p_recorder AND r.org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  SELECT s.outcome INTO v_was FROM public.nvr_login_state s WHERE s.recorder_id = p_recorder AND s.org_id = p_org FOR UPDATE;
  UPDATE public.nvr_login_state s SET outcome = NULL, level = 0, refused_until = NULL, attempt_until = NULL, attempt_path = NULL, updated_at = now()
  WHERE s.recorder_id = p_recorder AND s.org_id = p_org;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'nvr_login_try_again', 'recorder', p_recorder, jsonb_build_object('was', v_was));
  RETURN jsonb_build_object('recorder_id', p_recorder, 'was', v_was);
END
$$;

-- Tests only: moves every time of a TEST organisation's recorder state back by p_seconds (as if that much time had passed).
CREATE FUNCTION public.nvr_login_state_age_test(p_recorder uuid, p_seconds integer) RETURNS void
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

-- ── 3. The gateway's two questions (by session id only) ──────────────────────
-- The camera of an OPEN live or playback session, through its active channel mapping, to its recorder. 'refused' while the NVR's
-- current login stands refused (in or after its window: only a probe by the worker or the web server may prove it again) or paused;
-- 'go' otherwise (also for a camera without a mapping or an NVR without a saved password: no source is registered for those).
CREATE FUNCTION public.media_session_login_check(p_sid uuid) RETURNS TABLE(decision text, until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_cam uuid;
  v_org uuid;
  v_kind text;
  v_rec uuid;
  v_ver text;
  st public.nvr_login_state;
  v_recent timestamptz[];
  v_n integer;
BEGIN
  SELECT m.camera_id, m.org_id, m.kind INTO v_cam, v_org, v_kind FROM public.media_sessions m
  WHERE m.id = p_sid AND m.opened_at IS NOT NULL AND m.closed_at IS NULL AND m.revoked_at IS NULL;
  IF v_cam IS NULL THEN RETURN QUERY SELECT 'no_session'::text, NULL::timestamptz; RETURN; END IF;
  IF v_kind NOT IN ('live', 'playback') THEN RETURN QUERY SELECT 'go'::text, NULL::timestamptz; RETURN; END IF;
  v_rec := (SELECT mp.recorder_id FROM public.camera_channel_mappings mp WHERE mp.camera_id = v_cam AND mp.org_id = v_org AND mp.valid_to IS NULL);
  v_ver := CASE WHEN v_rec IS NULL THEN NULL ELSE public.nvr_login_version(v_rec) END;
  SELECT * INTO st FROM public.nvr_login_state s WHERE s.recorder_id = v_rec;
  IF v_ver IS NULL OR st.recorder_id IS NULL THEN RETURN QUERY SELECT 'go'::text, NULL::timestamptz; RETURN; END IF;
  v_recent := ARRAY(SELECT t FROM unnest(st.refusals) AS t WHERE t > now() - interval '1800 seconds' ORDER BY t);
  v_n := cardinality(v_recent);
  IF v_n >= 3 THEN RETURN QUERY SELECT 'refused'::text, v_recent[v_n - 2] + interval '1800 seconds'; RETURN; END IF;
  IF st.version = v_ver AND st.outcome = 'refused' THEN RETURN QUERY SELECT 'refused'::text, st.refused_until; RETURN; END IF;
  RETURN QUERY SELECT 'go'::text, NULL::timestamptz;
END
$$;

-- go2rtc told the gateway that the NVR refused the login ("wrong user/pass") on this session's stream: a refused login for its recorder.
CREATE FUNCTION public.media_session_login_refused(p_sid uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cam uuid;
  v_org uuid;
  v_rec uuid;
  v_ver text;
  v_applied boolean;
BEGIN
  -- Only a session the gateway opened within the last hour (a session id is the only thing the gateway knows).
  SELECT m.camera_id, m.org_id INTO v_cam, v_org FROM public.media_sessions m
  WHERE m.id = p_sid AND m.opened_at IS NOT NULL AND m.opened_at > now() - interval '1 hour' AND m.kind IN ('live', 'playback');
  IF v_cam IS NULL THEN RETURN false; END IF;
  v_rec := (SELECT mp.recorder_id FROM public.camera_channel_mappings mp WHERE mp.camera_id = v_cam AND mp.org_id = v_org AND mp.valid_to IS NULL);
  IF v_rec IS NULL THEN RETURN false; END IF;
  v_ver := public.nvr_login_version(v_rec);
  IF v_ver IS NULL THEN RETURN false; END IF;
  SELECT r.applied INTO v_applied FROM public.nvr_login_report(v_rec, v_ver, 'refused', 'gateway') r;
  RETURN coalesce(v_applied, false);
END
$$;

-- ── 4. The monitoring rollout: NVRs switched on or off together (NB-4) ──────
-- Every non-archived NVR of the organisation, a region, a cluster or a location, through recorder_set_monitoring (which checks the
-- administrator and audits each NVR), plus one summary row. Returns how many matched and how many changed.
CREATE FUNCTION public.recorder_set_monitoring_bulk(p_org uuid, p_scope text, p_scope_id uuid, p_enabled boolean, p_reason text, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec record;
  v_matched integer := 0;
  v_changed integer := 0;
  v_role public.user_role;
BEGIN
  -- The same rule as recorder_set_monitoring, checked first (also when nothing matches), and the same reason rule.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF p_actor IS NULL OR v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR (v_role <> 'platform_owner' AND NOT EXISTS (
           SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
           WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
    RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory may switch NVR monitoring' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'a reason is required (3 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'on or off?' USING ERRCODE = '22023'; END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('organization', 'region', 'cluster', 'location') THEN RAISE EXCEPTION 'organization, region, cluster or location' USING ERRCODE = '22023'; END IF;
  IF (p_scope = 'organization') <> (p_scope_id IS NULL) THEN RAISE EXCEPTION 'a region, cluster or location needs its id' USING ERRCODE = '22023'; END IF;
  IF p_scope = 'region' AND NOT EXISTS (SELECT 1 FROM public.regions g WHERE g.id = p_scope_id AND g.org_id = p_org AND g.archived_at IS NULL)
     OR p_scope = 'cluster' AND NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.id = p_scope_id AND c.org_id = p_org AND c.archived_at IS NULL)
     OR p_scope = 'location' AND NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_scope_id AND l.org_id = p_org AND l.archived_at IS NULL) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;
  FOR v_rec IN
    SELECT r.id, r.monitoring_enabled FROM public.recorders r
    JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
    JOIN public.locations l ON l.id = r.location_id AND l.org_id = p_org AND l.archived_at IS NULL
    LEFT JOIN public.clusters c ON c.id = l.cluster_id
    WHERE r.org_id = p_org
      AND (p_scope = 'organization' OR (p_scope = 'location' AND l.id = p_scope_id) OR (p_scope = 'cluster' AND l.cluster_id = p_scope_id)
           OR (p_scope = 'region' AND c.region_id = p_scope_id))
    ORDER BY r.id
  LOOP
    v_matched := v_matched + 1;
    IF v_rec.monitoring_enabled IS DISTINCT FROM p_enabled THEN
      PERFORM public.recorder_set_monitoring(p_org, v_rec.id, p_enabled, p_reason, p_actor);
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, CASE WHEN p_enabled THEN 'recorders_monitoring_enabled' ELSE 'recorders_monitoring_disabled' END,
          CASE WHEN p_scope = 'organization' THEN 'organization' ELSE p_scope END, coalesce(p_scope_id, p_org),
          jsonb_build_object('reason', btrim(p_reason), 'matched', v_matched, 'changed', v_changed));
  RETURN jsonb_build_object('matched', v_matched, 'changed', v_changed);
END
$$;

-- ── 5. M-1: the run times are the database's ────────────────────────────────
-- p_at is kept in the signature (the worker sends it) but the stored time is the database's now(), like monitor_request_check's.
CREATE OR REPLACE FUNCTION public.monitor_run_started(p_lease text, p_fencing_token bigint, p_at timestamptz, p_total integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence_global(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.worker_state SET run_started_at = now(), run_finished_at = NULL, progress_done = 0, progress_total = GREATEST(0, coalesce(p_total, 0))
  WHERE id = 1;
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_run_finished(p_lease text, p_fencing_token bigint, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.worker_fence_global(p_lease, p_fencing_token);
  IF p_at IS NULL THEN RAISE EXCEPTION 'a time is required' USING ERRCODE = '22023'; END IF;
  -- clock_timestamp(): a run started and finished in one transaction (tests) still finishes after it started.
  UPDATE public.worker_state SET run_finished_at = GREATEST(clock_timestamp(), coalesce(run_started_at, clock_timestamp())) WHERE id = 1;
END
$$;

-- ── 6. M-2: the prune of the credential-read log uses an index ──────────────
CREATE INDEX vault_reads_at_idx ON public.vault_reads (at);

-- ── 7. M-29: discovery saves nothing for an NVR that was switched off meanwhile ──
-- As in 20261021000026, plus: under the lock the NVR must still be monitored, its asset enabled and its location active (SQLSTATE 55000).
CREATE OR REPLACE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL, p_findings jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_loc uuid;
  v_live boolean;
  o jsonb;
  f jsonb;
  v_op text;
  v_cam uuid;
  v_other uuid;
  v_n integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_mapped integer := 0;
  v_moved integer := 0;
  v_found integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT r.location_id, (r.monitoring_enabled AND a.enabled AND l.is_active AND l.archived_at IS NULL) INTO v_loc, v_live
  FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL JOIN public.locations l ON l.id = r.location_id
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT v_live THEN RAISE EXCEPTION 'this NVR was switched off (or its location) while it was asked; nothing was saved' USING ERRCODE = '55000'; END IF;
  IF jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_ops must be an array' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(coalesce(p_findings, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_findings must be an array' USING ERRCODE = '22023'; END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) LOOP
    v_op := o ->> 'op';
    IF v_op = 'insert' THEN
      INSERT INTO public.cameras (org_id, location_id, recorder_id, channel, name, camera_ip)
      VALUES (p_org, v_loc, p_recorder, (o ->> 'channel')::integer, o ->> 'name', o ->> 'ip');
      v_created := v_created + 1;
    ELSIF v_op IN ('update', 'map', 'remap') THEN
      v_cam := (o ->> 'id')::uuid;
      IF v_op = 'map' THEN
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip', recorder_id = p_recorder, channel = (o ->> 'channel')::integer
        WHERE id = v_cam AND org_id = p_org AND location_id = v_loc AND archived_at IS NULL AND recorder_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_mapped := v_mapped + 1;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc
                       AND c.archived_at IS NULL AND c.recorder_id = p_recorder) THEN
          RAISE EXCEPTION 'camera % is not on this recorder', v_cam USING ERRCODE = '22023';
        END IF;
        IF v_op = 'remap' THEN
          PERFORM public.camera_remap(p_org, v_cam, p_recorder, (o ->> 'channel')::integer, now(), p_actor);
          v_moved := v_moved + 1;
        ELSE
          v_updated := v_updated + 1;
        END IF;
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip' WHERE id = v_cam AND org_id = p_org;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 0 THEN RAISE EXCEPTION 'camera % cannot be changed by discovery', v_cam USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'unknown discovery change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- The reconciliation list: this discovery's findings replace the open ones of the same NVR.
  UPDATE public.discovery_findings SET resolved_at = now(), resolved_by = p_actor, resolution = 'superseded'
  WHERE org_id = p_org AND recorder_id = p_recorder AND resolved_at IS NULL;
  FOR f IN SELECT * FROM jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) LOOP
    v_cam := (f ->> 'camera_id')::uuid;
    v_other := NULLIF(f ->> 'other_camera_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc)
       OR (v_other IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_other AND c.org_id = p_org AND c.location_id = v_loc)) THEN
      RAISE EXCEPTION 'a finding names a camera of another location' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.discovery_findings (org_id, recorder_id, location_id, kind, channel, camera_id, other_camera_id, reported_name, because, found_by)
    VALUES (p_org, p_recorder, v_loc, f ->> 'kind', NULLIF(f ->> 'channel', '')::integer, v_cam, v_other, left(f ->> 'reported_name', 200), f ->> 'because', p_actor);
    v_found := v_found + 1;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'cameras_discovered', 'store', v_loc, jsonb_build_object(
    'capability', 'admin.inventory', 'locationIds', jsonb_build_array(v_loc), 'count', 1, 'recorder_id', p_recorder,
    'created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'to_reconcile', coalesce(p_to_reconcile, 0), 'findings', v_found));
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'findings', v_found);
END
$$;

-- ── 8. privilege_violations(): as in 20261021000044, with the gateway's two login questions and the worker's two login functions ──
CREATE OR REPLACE FUNCTION public.privilege_violations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ), relacl AS (
    SELECT rel.relname, rel.relkind, a.grantee, a.privilege_type FROM rel CROSS JOIN LATERAL pg_catalog.aclexplode(rel.relacl) a
  ), colacl AS (
    SELECT c.relname, a.grantee, a.privilege_type FROM pg_catalog.pg_attribute at JOIN pg_catalog.pg_class c ON c.oid = at.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) a
    WHERE n.nspname = 'public' AND at.attacl IS NOT NULL
  ), fn AS (
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl, p.proowner, p.proargnames, p.prosrc FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  ), fnacl AS (
    SELECT fn.proname, fn.proargnames, fn.prosrc, fn.proowner, a.grantee FROM fn CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(fn.proacl, pg_catalog.acldefault('f', fn.proowner))) a
    WHERE a.privilege_type = 'EXECUTE'
  ), r AS (
    SELECT rolname, oid FROM pg_catalog.pg_roles
  )
  SELECT pg_catalog.format('%s: authenticated has %s', x.relname, x.privilege_type) FROM relacl x
  WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated') AND x.privilege_type <> 'SELECT'
  UNION ALL
  SELECT pg_catalog.format('%s: anon has %s', x.relname, x.privilege_type) FROM relacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'anon')
  UNION ALL
  SELECT pg_catalog.format('%s: PUBLIC has %s', x.relname, x.privilege_type) FROM relacl x WHERE x.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('%s (column): %s has %s', x.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM r WHERE r.oid = x.grantee) END, x.privilege_type)
  FROM colacl x WHERE x.grantee IN (0, (SELECT oid FROM r WHERE rolname = 'anon'))
     OR (x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated') AND x.privilege_type <> 'SELECT')
  UNION ALL
  SELECT pg_catalog.format('sequence %s: %s has %s', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relkind = 'S' AND x.grantee IN (SELECT oid FROM r WHERE rolname IN ('authenticated', 'app_web', 'media_service', 'monitor_worker', 'video_gateway'))
  UNION ALL
  SELECT pg_catalog.format('%s: %s has %s (server-only table)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps', 'worker_leases', 'test_fixture_switch', 'nvr_login_state')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'worker_leases', 'test_fixture_switch', 'nvr_login_state') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = x.relname)
  UNION ALL
  SELECT pg_catalog.format('%s: app_web may %s (observations are written by the worker)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.relname IN ('check_state', 'outages', 'worker_state', 'monitor_gaps', 'media_sessions') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
  UNION ALL
  SELECT pg_catalog.format('%s: app_web may UPDATE every column (column grants only; the rest goes through the audited functions)', x.relname)
  FROM relacl x WHERE x.relname IN ('recorders', 'profiles') AND x.privilege_type = 'UPDATE' AND x.grantee = (SELECT oid FROM r WHERE rolname = 'app_web')
  UNION ALL
  SELECT pg_catalog.format('%s: monitor_worker may %s (the worker writes only through fenced functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') AND x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
  UNION ALL
  SELECT pg_catalog.format('%s (column): monitor_worker may %s (the worker writes only through fenced functions)', x.relname, x.privilege_type)
  FROM colacl x WHERE x.privilege_type IN ('INSERT', 'UPDATE') AND x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
  UNION ALL
  SELECT pg_catalog.format('%s: video_gateway has %s (it may only call its functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('%s (column): video_gateway has %s', x.relname, x.privilege_type) FROM colacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('function %s: PUBLIC may execute', x.proname) FROM fnacl x WHERE x.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('function %s: anon may execute', x.proname) FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'anon')
  UNION ALL
  SELECT pg_catalog.format('function %s: video_gateway may execute (only media_session_open, media_sessions_still_valid, media_session_close, media_session_login_check, media_session_login_refused)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
    AND x.proname NOT IN ('media_session_open', 'media_sessions_still_valid', 'media_session_close', 'media_session_login_check', 'media_session_login_refused')
  UNION ALL
  SELECT pg_catalog.format('function %s: media_service may execute (only the web app counts sign-ins and limits)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'media_service')
    AND x.proname IN ('rate_limit_hit', 'rate_limit_state', 'rate_limit_clear', 'sign_in_gate', 'sign_in_finish')
  UNION ALL
  SELECT pg_catalog.format('function %s: monitor_worker may execute it without a fencing token (every worker write takes p_fencing_token)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
    AND NOT ('p_fencing_token' = ANY (coalesce(x.proargnames, '{}'::text[])))
    AND x.proname NOT IN ('worker_acquire_lease', 'recorder_credential_read', 'media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune', 'nvr_login_gate', 'nvr_login_report')
  UNION ALL
  SELECT pg_catalog.format('function %s: monitor_worker may execute it, and it takes p_fencing_token but never calls the fence', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
    AND 'p_fencing_token' = ANY (coalesce(x.proargnames, '{}'::text[]))
    AND pg_catalog.strpos(coalesce(x.prosrc, ''), 'worker_fence') = 0
    AND x.proname NOT IN ('worker_renew_lease', 'worker_release_lease')
  UNION ALL
  SELECT pg_catalog.format('function %s: %s may execute it (internal; only the fenced functions call it)', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname IN ('worker_fence', 'worker_fence_global', 'worker_fence_org', 'worker_rows_guard') AND x.grantee <> x.proowner
  UNION ALL
  SELECT pg_catalog.format('function %s: %s may execute it (internal; only the login functions call it)', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname IN ('nvr_login_version', 'nvr_login_current', 'nvr_login_path_ok') AND x.grantee <> x.proowner
  UNION ALL
  SELECT pg_catalog.format('function %s reads NVR logins: %s may execute it', x.proname, (SELECT rolname FROM r WHERE r.oid = x.grantee))
  FROM fnacl x WHERE x.proname IN ('recorder_credential_read', 'recorder_read_credential', 'recorder_secret_equals')
    AND x.grantee NOT IN (SELECT oid FROM r WHERE rolname IN ('service_role', 'media_service', 'monitor_worker', 'postgres'))
  UNION ALL
  SELECT pg_catalog.format('function %s: SECURITY DEFINER without search_path = ''''', f.proname) FROM fn f
  WHERE f.prosecdef AND NOT coalesce('search_path=""' = ANY (f.proconfig), false)
  UNION ALL
  SELECT 'default privileges: new functions are executable by PUBLIC (no global default for postgres revokes it)'
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = (SELECT oid FROM r WHERE rolname = 'postgres')
                    AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f')
  UNION ALL
  SELECT 'default privileges: the global default for postgres still gives PUBLIC EXECUTE on new functions'
  FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
  WHERE d.defaclrole = (SELECT oid FROM r WHERE rolname = 'postgres') AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f' AND a.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('default privileges still give %s access to new objects of kind %s', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM r WHERE r.oid = a.grantee) END, d.defaclobjtype)
  FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
  WHERE n.nspname = 'public' AND d.defaclrole = (SELECT oid FROM r WHERE rolname = 'postgres')
    AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM r WHERE rolname IN ('anon', 'authenticated', 'app_web', 'media_service', 'monitor_worker', 'video_gateway')))
  UNION ALL
  SELECT pg_catalog.format('schema vault: %s has USAGE', rolname) FROM r
  WHERE rolname IN ('anon', 'authenticated', 'app_web', 'media_service', 'monitor_worker', 'video_gateway')
    AND pg_catalog.has_schema_privilege(r.oid, 'vault', 'USAGE')
  UNION ALL
  SELECT pg_catalog.format('auth.users: %s sign-in account(s) carry the role %s (PostgREST would switch their sessions to it)', pg_catalog.count(*), u.role)
  FROM auth.users u WHERE u.role IS NOT NULL AND u.role NOT IN ('', 'authenticated') GROUP BY u.role
  UNION ALL
  SELECT 'auth.users: the trigger drishti_users_role_check (no service role on a sign-in account) is missing'
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'drishti_users_role_check' AND t.tgenabled <> 'D')
$$;

-- ── 9. Privileges (explicit; the replaced functions get back exactly the grants they had) ──
REVOKE ALL ON FUNCTION
  public.nvr_login_path_ok(text),
  public.nvr_login_version(uuid),
  public.nvr_login_current(uuid, uuid, text),
  public.nvr_login_gate(uuid[], text, boolean, integer),
  public.nvr_login_report(uuid, text, text, text, integer, integer),
  public.nvr_login_try_again(uuid, uuid, uuid),
  public.nvr_login_state_age_test(uuid, integer),
  public.media_session_login_check(uuid),
  public.media_session_login_refused(uuid),
  public.recorder_set_monitoring_bulk(uuid, text, uuid, boolean, text, uuid),
  public.monitor_run_started(text, bigint, timestamptz, integer),
  public.monitor_run_finished(text, bigint, timestamptz),
  public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb),
  public.privilege_violations()
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.nvr_login_gate(uuid[], text, boolean, integer), public.nvr_login_report(uuid, text, text, text, integer, integer)
  TO service_role, media_service, monitor_worker;
GRANT EXECUTE ON FUNCTION public.nvr_login_try_again(uuid, uuid, uuid), public.recorder_set_monitoring_bulk(uuid, text, uuid, boolean, text, uuid) TO service_role, app_web;
GRANT EXECUTE ON FUNCTION public.media_session_login_check(uuid), public.media_session_login_refused(uuid) TO service_role, media_service, video_gateway;
GRANT EXECUTE ON FUNCTION public.nvr_login_state_age_test(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.monitor_run_started(text, bigint, timestamptz, integer), public.monitor_run_finished(text, bigint, timestamptz) TO service_role, monitor_worker;
GRANT EXECUTE ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb) TO service_role, app_web;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

-- ── 10. Self-test ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN
    RAISE EXCEPTION 'privilege_violations() is not empty after 0048: %', (SELECT string_agg(v, '; ') FROM public.privilege_violations() v);
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
