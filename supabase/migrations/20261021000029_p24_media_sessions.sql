-- P2-4 (WP-2.2, decision D-3, directive AC-14 / CC-10; .superpowers/sdd/drishti/p2-4-brief.md and its addendum). New forward migration;
-- 0019..0028 are applied and not edited. Apply through `npx supabase migration up --local` (one transaction per file); no BEGIN/COMMIT
-- of its own on purpose (like 0019..0028).
--
-- The media session registry: every video connection (live, playback, fast playback, later export downloads and remote sessions) is
-- one row of media_sessions. The web app makes the row when it signs a stream token (the token carries its id, `sid`); the video gateway
-- asks media_session_open(sid, …) before it connects anything upstream, and media_sessions_still_valid(sids) every 15 seconds for all
-- of its open sockets, and closes the ones that are no longer allowed. The fast-playback route does the same inside its response.
--
-- What "allowed" means is evaluated by the SAME capability functions as everything else (access_grants_of, access_ancestry: organisation,
-- region, cluster, location, recorder, camera and asset scopes, expanded when evaluated, through the camera's ACTIVE mapping), for the
-- session's person instead of auth.uid(): has_capability_for_user is has_capability_for with the caller replaced by a parameter (a test
-- compares both on a matrix). Plus: the person is active and has chosen a password, and the camera can be streamed at all (active, at an
-- active location, mapped to an NVR whose monitoring is on): a switched-off NVR must not keep being contacted by an open stream.
--
-- Every change of a person's access raises profiles.access_version (grants, removals, hierarchy moves, remaps, merges, archives) or
-- changes their status, password flag or role. A DEFERRED constraint trigger on profiles re-checks that person's open sessions at commit
-- (when every part of the change is visible) and marks the ones that are no longer allowed: deactivated, password reset and role change
-- end all of them (decision D-3); any other change ends exactly those that lost access. The gateway sees the mark at its next check.
-- Grant expiry (valid_until passing) is caught by that periodic check, which re-evaluates the capability each time.
--
-- Everything here is for the service role only (D-14: the per-service roles of P2-6 will narrow it to the media service and the video
-- gateway). Signed-in people cannot read the table (it says who watches what).

-- ═══ 1. The table ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.media_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('live', 'playback', 'vod', 'export_download', 'remote_view', 'remote_control')),
  -- No foreign keys into the inventory (like discovery_findings): the test purge must not trip; the functions check the ids.
  camera_id uuid,
  asset_id uuid,
  capability text NOT NULL REFERENCES public.capabilities(key),
  -- The go2rtc stream name of a live or playback session (cam_<camera>_sub|main, pb_<camera>_<start>); the gateway's token must name it.
  stream text CHECK (stream IS NULL OR (length(stream) BETWEEN 1 AND 200 AND stream ~ '^[a-z0-9_-]+$')),
  -- Whether the session was made from an MFA-verified (aal2) sign-in. mfa_enforced() is off until P3, which must pass the verified value.
  aal2 boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  connect_by timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  last_validated_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 200),
  closed_at timestamptz,
  CONSTRAINT media_sessions_target CHECK (
    (kind IN ('live', 'playback', 'vod', 'export_download') AND camera_id IS NOT NULL AND asset_id IS NULL)
    OR (kind IN ('remote_view', 'remote_control') AND asset_id IS NOT NULL AND camera_id IS NULL)),
  CONSTRAINT media_sessions_stream CHECK (kind NOT IN ('live', 'playback') OR stream IS NOT NULL),
  CONSTRAINT media_sessions_capability CHECK (capability = CASE kind
    WHEN 'live' THEN 'cctv.live' WHEN 'playback' THEN 'cctv.playback' WHEN 'vod' THEN 'cctv.export' WHEN 'export_download' THEN 'cctv.export'
    WHEN 'remote_view' THEN 'it.remote.view' WHEN 'remote_control' THEN 'it.remote.control' END),
  CONSTRAINT media_sessions_times CHECK (connect_by >= created_at AND expires_at >= connect_by),
  CONSTRAINT media_sessions_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
COMMENT ON TABLE public.media_sessions IS
  'P2-4 (D-3): one row per video connection (stream token sid). Opened by the gateway (media_session_open), re-checked every 15 s '
  '(media_sessions_still_valid), revoked at once by access changes (trigger profiles_media_sessions). Service role only.';
-- The open sessions of a person (the trigger and revoke_user), the retention sweep and the monitoring count.
CREATE INDEX media_sessions_user_open_idx ON public.media_sessions (user_id) WHERE closed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX media_sessions_org_open_idx ON public.media_sessions (org_id) WHERE closed_at IS NULL AND revoked_at IS NULL AND opened_at IS NOT NULL;
CREATE INDEX media_sessions_expires_idx ON public.media_sessions (expires_at);
ALTER TABLE public.media_sessions ENABLE ROW LEVEL SECURITY; -- no policy: nobody signed in reads or writes it

-- ═══ 2. The capability check for a given person (the auth.uid() functions' twin) ══════════════════════════════════════════════
-- Exactly has_capability_for (20261021000019) with `(SELECT auth.uid())` replaced by p_user and `public.access_caller_aal2()` by p_aal2.
CREATE FUNCTION public.has_capability_for_user(p_user uuid, p_cap text, p_kind text, p_id uuid, p_aal2 boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS MATERIALIZED (
    SELECT * FROM public.access_grants_of(p_user, now(), false, p_aal2) WHERE capability = p_cap
  ),
  a AS MATERIALIZED (
    SELECT * FROM public.access_ancestry((SELECT p.org_id FROM public.profiles p WHERE p.id = p_user), p_kind, p_id)
    WHERE p_kind IN ('camera', 'location', 'asset', 'recorder', 'cluster', 'region')
  )
  SELECT EXISTS (
    SELECT 1 FROM g, a
    WHERE g.scope_kind = 'organization'
       OR (g.scope_kind = 'region' AND g.scope_id = a.region_id)
       OR (g.scope_kind = 'cluster' AND g.scope_id = a.cluster_id)
       OR (g.scope_kind = 'location' AND g.scope_id = a.location_id)
       OR (g.scope_kind = 'recorder' AND g.scope_id = a.recorder_id)
       OR (g.scope_kind = 'camera' AND g.scope_id = a.camera_id)
       OR (g.scope_kind = 'asset' AND g.scope_id = a.asset_id)
  )
$$;
COMMENT ON FUNCTION public.has_capability_for_user(uuid, text, text, uuid, boolean) IS
  'P2-4: has_capability_for for a given person (service role only: the registry re-checks a session''s person). Same SQL as the auth.uid() version.';

-- ═══ 3. What is wrong with a session (internal) ═══════════════════════════════════════════════════════════════════════════════
-- NULL when the person may use this target for this kind now, else a short reason: person_not_found, deactivated, password_reset,
-- not_available (camera switched off or archived, its location off or archived, no active mapping, NVR switched off or archived),
-- access_changed (the capability no longer covers the target), unknown_kind.
CREATE FUNCTION public.media_session_target_problem(p_org uuid, p_user uuid, p_kind text, p_camera uuid, p_asset uuid, p_aal2 boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_person record;
BEGIN
  SELECT p.org_id, p.is_active, p.must_reset_password INTO v_person FROM public.profiles p WHERE p.id = p_user;
  IF NOT FOUND OR v_person.org_id IS DISTINCT FROM p_org THEN RETURN 'person_not_found'; END IF;
  IF NOT v_person.is_active THEN RETURN 'deactivated'; END IF;
  IF v_person.must_reset_password THEN RETURN 'password_reset'; END IF;
  IF p_kind IN ('live', 'playback', 'vod', 'export_download') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cameras c
      JOIN public.locations l ON l.id = c.location_id AND l.is_active AND l.archived_at IS NULL
      JOIN public.recorders r ON r.id = c.recorder_id AND r.monitoring_enabled AND r.location_id = c.location_id
      JOIN public.assets ra ON ra.id = r.id AND ra.enabled AND ra.archived_at IS NULL
      WHERE c.id = p_camera AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL
    ) THEN
      RETURN 'not_available';
    END IF;
    IF NOT public.has_capability_for_user(p_user, CASE p_kind WHEN 'live' THEN 'cctv.live' WHEN 'playback' THEN 'cctv.playback' ELSE 'cctv.export' END,
                                          'camera', p_camera, p_aal2)
       -- Fast playback is a recording: cctv.export AND cctv.playback (P2-2 fix M-3). A later export download needs cctv.export (D-L1, E-1).
       OR (p_kind = 'vod' AND NOT public.has_capability_for_user(p_user, 'cctv.playback', 'camera', p_camera, p_aal2)) THEN
      RETURN 'access_changed';
    END IF;
  ELSIF p_kind IN ('remote_view', 'remote_control') THEN
    IF NOT EXISTS (SELECT 1 FROM public.assets a WHERE a.id = p_asset AND a.org_id = p_org AND a.enabled AND a.archived_at IS NULL) THEN
      RETURN 'not_available';
    END IF;
    IF NOT public.has_capability_for_user(p_user, CASE p_kind WHEN 'remote_view' THEN 'it.remote.view' ELSE 'it.remote.control' END, 'asset', p_asset, p_aal2) THEN
      RETURN 'access_changed';
    END IF;
  ELSE
    RETURN 'unknown_kind';
  END IF;
  RETURN NULL;
END
$$;

-- NULL for a session that may go on, else why not: closed, the revoke reason, expired, or the target problem above.
CREATE FUNCTION public.media_session_problem(m public.media_sessions) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN m.closed_at IS NOT NULL THEN 'closed'
    WHEN m.revoked_at IS NOT NULL THEN m.revoke_reason
    WHEN m.expires_at <= now() THEN 'expired'
    ELSE public.media_session_target_problem(m.org_id, m.user_id, m.kind, m.camera_id, m.asset_id, m.aal2)
  END
$$;

-- ═══ 4. The web app: make sessions when it signs tokens ══════════════════════════════════════════════════════════════════════
-- One session per camera the person may use for this kind now (checked again here, as the person — the app has already asked their own
-- client, this closes the gap between that question and the token). Cameras that may not be used are simply left out. The connect
-- window (default 90 s) is the token's lifetime; the session ends at the latest p_max_sec after it (the gateway's longest socket).
CREATE FUNCTION public.media_session_create(p_org uuid, p_user uuid, p_kind text, p_cameras uuid[], p_streams text[] DEFAULT NULL,
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

-- ═══ 5. The gateway: open, re-check, close ═══════════════════════════════════════════════════════════════════════════════════
-- When a socket arrives with a verified token. The session must be the token's: same person (u), camera (c), kind and stream name — a
-- forged sid of somebody else's session is refused and that session is left untouched. A session opens once (a copied token or a second
-- socket is refused), within its connect window, and only while it is still allowed; a session that is no longer allowed is marked.
CREATE FUNCTION public.media_session_open(p_sid uuid, p_user uuid, p_camera uuid, p_kind text, p_stream text)
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

-- Every 15 s, one call for all open sockets: the sessions that must end, with the reason (an id it does not know: not_found). Valid
-- ones are stamped (last_validated_at); invalid ones are marked revoked (so their token can never open again).
CREATE FUNCTION public.media_sessions_still_valid(p_sids uuid[]) RETURNS TABLE(sid uuid, reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_sids IS NULL OR cardinality(p_sids) = 0 THEN RETURN; END IF;
  IF cardinality(p_sids) > 5000 THEN RAISE EXCEPTION 'at most 5000 sessions per call' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH asked AS (SELECT DISTINCT x AS id FROM unnest(p_sids) AS x WHERE x IS NOT NULL),
  judged AS MATERIALIZED (
    SELECT a.id, m.id AS found, CASE WHEN m.id IS NULL THEN 'not_found' ELSE public.media_session_problem(m) END AS problem
    FROM asked a LEFT JOIN public.media_sessions m ON m.id = a.id
  ),
  stamped AS (
    UPDATE public.media_sessions s SET last_validated_at = now() FROM judged j WHERE s.id = j.found AND j.problem IS NULL RETURNING s.id
  ),
  marked AS (
    UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = j.problem
    FROM judged j WHERE s.id = j.found AND j.problem IS NOT NULL AND s.revoked_at IS NULL AND s.closed_at IS NULL RETURNING s.id
  )
  SELECT j.id, j.problem FROM judged j WHERE j.problem IS NOT NULL;
END
$$;

-- The socket (or the download) has ended. Idempotent: closing twice keeps the first time. False for an id it does not know.
CREATE FUNCTION public.media_session_close(p_sid uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.media_sessions s SET closed_at = now() WHERE s.id = p_sid AND s.closed_at IS NULL;
  RETURN EXISTS (SELECT 1 FROM public.media_sessions s WHERE s.id = p_sid);
END
$$;

-- ═══ 6. Revocation (admin actions, the trigger) ═══════════════════════════════════════════════════════════════════════════════
-- Every session of one person in the organisation that is not closed or revoked yet (made but not connected ones too: their tokens must
-- not open later). Returns how many.
CREATE FUNCTION public.media_sessions_revoke_user(p_org uuid, p_user uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n integer;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 200 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.media_sessions s SET revoked_at = now(), revoke_reason = p_reason
  WHERE s.org_id = p_org AND s.user_id = p_user AND s.closed_at IS NULL AND s.revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Re-checks every session of these people that is not closed or revoked, and revokes exactly those that are no longer allowed (with the
-- reason); the rest stay. Returns how many were revoked.
CREATE FUNCTION public.media_sessions_revalidate(p_org uuid, p_users uuid[]) RETURNS integer
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

-- The deferred trigger: at commit of any change of a person's access version, status, password flag, role or organisation.
-- Deactivation, a password reset and a role change end all of their sessions (D-3); any other change ends exactly the sessions that
-- lost access. It never makes the change itself fail: if it cannot run, the gateway's next 15-second check still catches the sessions.
CREATE FUNCTION public.media_sessions_profile_changed() RETURNS trigger
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
CREATE CONSTRAINT TRIGGER profiles_media_sessions
  AFTER UPDATE OF access_version, is_active, must_reset_password, role, org_id ON public.profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.access_version IS DISTINCT FROM NEW.access_version OR OLD.is_active IS DISTINCT FROM NEW.is_active
        OR OLD.must_reset_password IS DISTINCT FROM NEW.must_reset_password OR OLD.role IS DISTINCT FROM NEW.role
        OR OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION public.media_sessions_profile_changed();

-- ═══ 7. Retention (the worker calls it in P5) ═════════════════════════════════════════════════════════════════════════════════
-- Deletes sessions that ended (closed, revoked or expired) more than p_keep ago, and sessions that were never opened whose connect
-- window passed more than p_unopened_keep ago (the live wall renews its tokens every minute; most of those are never used). Optionally
-- for one organisation. Returns how many rows went.
CREATE FUNCTION public.media_sessions_prune(p_keep interval DEFAULT '30 days', p_unopened_keep interval DEFAULT '1 day', p_org uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n integer;
BEGIN
  IF p_keep IS NULL OR p_unopened_keep IS NULL OR p_keep < interval '0' OR p_unopened_keep < interval '0' THEN
    RAISE EXCEPTION 'retention must not be negative' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.media_sessions m
  WHERE (p_org IS NULL OR m.org_id = p_org)
    AND ((m.opened_at IS NULL AND m.connect_by < now() - p_unopened_keep)
         OR coalesce(m.closed_at, m.revoked_at, CASE WHEN m.expires_at <= now() THEN m.expires_at END) < now() - p_keep);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ═══ Privileges (default privileges are closed; explicit REVOKE / GRANT) ═════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.media_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.media_sessions TO service_role; -- writes only through the functions below
REVOKE ALL ON FUNCTION
  public.has_capability_for_user(uuid, text, text, uuid, boolean),
  public.media_session_target_problem(uuid, uuid, text, uuid, uuid, boolean),
  public.media_session_problem(public.media_sessions),
  public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.media_sessions_still_valid(uuid[]),
  public.media_session_close(uuid),
  public.media_sessions_revoke_user(uuid, uuid, text),
  public.media_sessions_revalidate(uuid, uuid[]),
  public.media_sessions_profile_changed(),
  public.media_sessions_prune(interval, interval, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.has_capability_for_user(uuid, text, text, uuid, boolean),
  public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.media_sessions_still_valid(uuid[]),
  public.media_session_close(uuid),
  public.media_sessions_revoke_user(uuid, uuid, text),
  public.media_sessions_revalidate(uuid, uuid[]),
  public.media_sessions_prune(interval, interval, uuid)
TO service_role;

-- ═══ Self-test ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-4 self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-4 self-test: a function names a removed object'; END IF;
  IF has_table_privilege('authenticated', 'public.media_sessions', 'SELECT') OR has_table_privilege('anon', 'public.media_sessions', 'SELECT')
     OR has_table_privilege('service_role', 'public.media_sessions', 'INSERT') OR has_table_privilege('service_role', 'public.media_sessions', 'UPDATE')
     OR has_function_privilege('authenticated', 'public.has_capability_for_user(uuid, text, text, uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_session_open(uuid, uuid, uuid, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_sessions_still_valid(uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.media_session_problem(public.media_sessions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2-4 self-test: a server-only object is reachable from outside';
  END IF;
  -- The twin must stay the twin: the same body as has_capability_for with the caller replaced.
  IF replace(replace(regexp_replace(pg_get_functiondef('public.has_capability_for(text, text, uuid)'::regprocedure), '^.*?AS \$function\$', '', 's'),
       '(SELECT auth.uid())', 'p_user'), 'public.access_caller_aal2()', 'p_aal2')
     <> regexp_replace(pg_get_functiondef('public.has_capability_for_user(uuid, text, text, uuid, boolean)'::regprocedure), '^.*?AS \$function\$', '', 's') THEN
    RAISE EXCEPTION 'P2-4 self-test: has_capability_for_user is not the twin of has_capability_for';
  END IF;
END
$$;
