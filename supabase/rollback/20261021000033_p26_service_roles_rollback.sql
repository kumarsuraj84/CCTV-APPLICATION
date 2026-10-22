-- Rollback of 20261021000033_p26_service_roles.sql (P2-6). Dry run first: BEGIN; \i this file; ROLLBACK;
-- Puts back verbatim the functions the migration replaced (recorder_read_credential STABLE without logging, inventory_import_apply with
-- its inline comparison, monitor_apply_results with the optional recorder, monitor_request_check / revoke_user_sessions /
-- targets_uptime with their old search_path, the old privilege_violations), drops the new functions and tables (the credential-read
-- log, the rate limiter, the security settings) and the four service roles with every privilege they hold.
-- BEFORE running it: every process must be back on SUPABASE_SERVICE_ROLE_KEY (remove the SUPABASE_*_KEY service keys from the
-- environment and restart the web app, gateway and worker), or their requests fail with "role does not exist".
-- What is lost: the credential-read log (vault_reads) and the rate-limit counts. NVR passwords, inventory and grants are untouched.

DROP FUNCTION IF EXISTS public.privilege_violations_selftest();
DROP FUNCTION IF EXISTS public.rate_limit_prune(interval);
DROP FUNCTION IF EXISTS public.rate_limit_clear(text);
DROP FUNCTION IF EXISTS public.rate_limit_state(text, integer);
DROP FUNCTION IF EXISTS public.rate_limit_hit(text, integer, integer);
DROP FUNCTION IF EXISTS public.rate_limit_window_start(integer, timestamptz);
DROP TABLE IF EXISTS public.rate_limit_hits;

CREATE OR REPLACE FUNCTION public.recorder_read_credential(p_recorder uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_secret uuid;
  v_on boolean;
  v text;
BEGIN
  SELECT r.secret_id, r.monitoring_enabled INTO v_secret, v_on FROM public.recorders r WHERE r.id = p_recorder;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT v_on THEN
    RAISE EXCEPTION 'monitoring is switched off for this NVR: its login is not read' USING ERRCODE = '55000';
  END IF;
  SELECT ds.decrypted_secret INTO v FROM vault.decrypted_secrets ds WHERE ds.id = v_secret;
  RETURN v;
END
$$;

CREATE OR REPLACE FUNCTION public.inventory_import_apply(p_org uuid, p_actor uuid, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role public.user_role;
  v_item jsonb;
  v_rec jsonb;
  v_fields jsonb;
  v_line integer;
  v_state text;
  v_msg text;
  v_region uuid;
  v_cluster uuid;
  v_loc uuid;
  v_recorder uuid;
  v_id uuid;
  v_cam uuid;
  v_ph jsonb;
  v_on boolean;
  v_was boolean;
  v_channels integer;
  c_regions integer := 0;
  c_clusters integer := 0;
  c_loc_created integer := 0;
  c_loc_updated integer := 0;
  c_rec_created integer := 0;
  c_rec_updated integer := 0;
  c_passwords integer := 0;
  c_given integer := 0;
  c_cameras integer := 0;
  c_relinked integer := 0;
  a_locations integer := 0;
  a_recorders integer := 0;
  a_cameras integer := 0;
  v_dropped uuid[] := '{}';
BEGIN
  -- The acting person, as recorder_set_monitoring asks: active, password chosen, a super administrator, or an administrator holding
  -- admin.inventory for the whole organisation. The application has asked the same from the person's own summary first.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR (v_role <> 'platform_owner' AND NOT EXISTS (
           SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
           WHERE g.org_id = p_org AND g.capability = 'admin.inventory' AND g.scope_kind = 'organization')) THEN
    RAISE EXCEPTION 'only a super administrator or an administrator with admin.inventory may import' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'the plan must be an object' USING ERRCODE = '22023'; END IF;

  -- Regions and clusters the file needs (by code; created with the code as name, renamed later on their page).
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'regions', '[]'::jsonb)) AS e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.org_id = p_org AND r.code = v_item->>'code' AND r.archived_at IS NULL) THEN
      INSERT INTO public.regions (org_id, code, name) VALUES (p_org, v_item->>'code', coalesce(nullif(v_item->>'name', ''), v_item->>'code'));
      c_regions := c_regions + 1;
    END IF;
  END LOOP;
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'clusters', '[]'::jsonb)) AS e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'code' AND c.archived_at IS NULL) THEN
      v_region := NULL;
      IF v_item->>'region_code' IS NOT NULL THEN
        SELECT r.id INTO v_region FROM public.regions r WHERE r.org_id = p_org AND r.code = v_item->>'region_code' AND r.archived_at IS NULL;
        IF v_region IS NULL THEN RAISE EXCEPTION 'region not found' USING ERRCODE = 'P0002'; END IF;
      END IF;
      INSERT INTO public.clusters (org_id, code, name, region_id) VALUES (p_org, v_item->>'code', coalesce(nullif(v_item->>'name', ''), v_item->>'code'), v_region);
      c_clusters := c_clusters + 1;
    END IF;
  END LOOP;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'locations', '[]'::jsonb)) AS e LOOP
    v_line := (v_item->>'line')::integer;
    BEGIN
      v_fields := coalesce(v_item->'fields', '{}'::jsonb);
      IF v_item->>'action' = 'create' THEN
        v_cluster := NULL;
        IF v_item->>'cluster' IS NOT NULL THEN
          SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'cluster' AND c.archived_at IS NULL;
          IF v_cluster IS NULL THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
        END IF;
        INSERT INTO public.locations (org_id, code, name, kind, city, zone, state, address, cluster_id)
        VALUES (p_org, v_item->>'code', v_fields->>'name', coalesce(v_fields->>'kind', 'store'), v_fields->>'city', v_fields->>'zone',
                v_fields->>'state', v_fields->>'address', v_cluster)
        RETURNING id INTO v_loc;
        c_loc_created := c_loc_created + 1;
        INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
        VALUES (p_org, p_actor, 'location_created', 'location', v_loc, jsonb_build_object('code', v_item->>'code', 'kind', coalesce(v_fields->>'kind', 'store'), 'imported', true));
      ELSE
        v_loc := (v_item->>'id')::uuid;
        PERFORM 1 FROM public.locations l WHERE l.id = v_loc AND l.org_id = p_org AND l.archived_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
        IF v_fields <> '{}'::jsonb THEN
          UPDATE public.locations SET
            name = CASE WHEN v_fields ? 'name' THEN v_fields->>'name' ELSE name END,
            kind = CASE WHEN v_fields ? 'kind' THEN v_fields->>'kind' ELSE kind END,
            city = CASE WHEN v_fields ? 'city' THEN v_fields->>'city' ELSE city END,
            zone = CASE WHEN v_fields ? 'zone' THEN v_fields->>'zone' ELSE zone END,
            state = CASE WHEN v_fields ? 'state' THEN v_fields->>'state' ELSE state END,
            address = CASE WHEN v_fields ? 'address' THEN v_fields->>'address' ELSE address END
          WHERE id = v_loc;
          INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
          VALUES (p_org, p_actor, 'location_updated', 'location', v_loc, jsonb_build_object('changed', (SELECT jsonb_agg(k) FROM jsonb_object_keys(v_fields) AS k), 'imported', true));
        END IF;
        -- A location without a cluster joins the one of the file like any move (access versions, audit); one in a cluster stays.
        IF v_item->>'join_cluster' IS NOT NULL THEN
          SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_item->>'join_cluster' AND c.archived_at IS NULL;
          IF v_cluster IS NULL THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
          IF (SELECT l.cluster_id FROM public.locations l WHERE l.id = v_loc) IS NULL THEN
            PERFORM public.inventory_move_location(p_org, v_loc, v_cluster, p_actor);
          END IF;
        END IF;
        IF v_item->>'action' = 'update' THEN c_loc_updated := c_loc_updated + 1; END IF;
      END IF;

      FOR v_rec IN SELECT e.value FROM jsonb_array_elements(coalesce(v_item->'recorders', '[]'::jsonb)) AS e LOOP
        v_line := (v_rec->>'line')::integer;
        v_channels := (v_rec->>'channels')::integer;
        IF v_rec->>'action' = 'unchanged' AND coalesce((v_rec->>'placeholders')::integer, 0) = 0 AND NOT (v_rec ? 'password') THEN CONTINUE; END IF;
        IF v_rec->>'action' IN ('create', 'update') THEN
          v_recorder := public.recorder_save(p_org, v_loc, CASE WHEN v_rec->>'action' = 'create' THEN NULL ELSE (v_rec->>'id')::uuid END,
            v_rec->>'host', (v_rec->>'http_port')::integer, (v_rec->>'rtsp_port')::integer, v_rec->>'username', v_channels,
            nullif(v_rec->>'name', ''), p_actor);
          IF v_rec->>'action' = 'create' THEN c_rec_created := c_rec_created + 1; ELSE c_rec_updated := c_rec_updated + 1; END IF;
          IF v_rec ? 'monitoring' THEN
            v_on := (v_rec->>'monitoring')::boolean;
            SELECT r.monitoring_enabled INTO v_was FROM public.recorders r WHERE r.id = v_recorder;
            IF v_was IS DISTINCT FROM v_on THEN
              PERFORM public.recorder_set_monitoring(p_org, v_recorder, v_on,
                CASE WHEN v_on THEN 'Switched on by the CSV import.' ELSE 'Switched off by the CSV import.' END, p_actor);
            END IF;
          END IF;
        ELSE
          -- An NVR the plan does not otherwise change: it must be a live NVR of this organisation and location.
          v_recorder := (v_rec->>'id')::uuid;
          PERFORM 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
          WHERE r.id = v_recorder AND r.org_id = p_org AND r.location_id = v_loc;
          IF NOT FOUND THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
        END IF;
        -- B-I3: a password the file gives is written (and audited, without the value) only when it differs from the saved one.
        IF v_rec ? 'password' THEN
          c_given := c_given + 1;
          IF NOT EXISTS (SELECT 1 FROM public.recorders r JOIN vault.decrypted_secrets ds ON ds.id = r.secret_id
                         WHERE r.id = v_recorder AND ds.decrypted_secret = v_rec->>'password') THEN
            PERFORM public.recorder_store_credential(v_recorder, v_rec->>'password');
            c_passwords := c_passwords + 1;
            INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
            VALUES (p_org, p_actor, 'recorder_password_set', 'recorder', v_recorder, jsonb_build_object('imported', true));
          END IF;
        END IF;
        IF coalesce(v_channels, 0) > 0 AND (v_rec->>'action' <> 'unchanged' OR coalesce((v_rec->>'placeholders')::integer, 0) > 0) THEN
          v_ph := public.inventory_ensure_placeholders(p_org, v_loc, v_recorder, v_channels);
          c_cameras := c_cameras + (v_ph->>'created')::integer;
          c_relinked := c_relinked + (v_ph->>'relinked')::integer;
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      RAISE EXCEPTION USING ERRCODE = v_state, MESSAGE = v_msg, DETAIL = 'import_line:' || coalesce(v_line::text, '?');
    END;
  END LOOP;

  -- What the person confirmed to archive (never deleted; history, grants and vault logins are kept; restorable).
  FOR v_item IN SELECT e.value FROM jsonb_array_elements(coalesce(p_plan->'archive', '[]'::jsonb)) AS e LOOP
    v_id := (v_item->>'id')::uuid;
    IF v_item->>'kind' = 'camera' THEN
      IF EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_id AND c.org_id = p_org AND c.archived_at IS NULL) THEN
        PERFORM public.inventory_archive(p_org, 'camera', v_id, p_actor);
        a_cameras := a_cameras + 1;
        v_dropped := v_dropped || v_id;
      END IF;
    ELSIF v_item->>'kind' = 'recorder' THEN
      FOR v_cam IN SELECT m.camera_id FROM public.camera_channel_mappings m WHERE m.recorder_id = v_id AND m.org_id = p_org AND m.valid_to IS NULL LOOP
        PERFORM public.inventory_archive(p_org, 'camera', v_cam, p_actor);
        v_dropped := v_dropped || v_cam;
      END LOOP;
      PERFORM public.inventory_archive(p_org, 'recorder', v_id, p_actor);
      a_recorders := a_recorders + 1;
    ELSIF v_item->>'kind' = 'location' THEN
      v_dropped := v_dropped || ARRAY(SELECT c.id FROM public.cameras c WHERE c.location_id = v_id AND c.org_id = p_org AND c.archived_at IS NULL);
      PERFORM public.inventory_archive(p_org, 'location', v_id, p_actor);
      a_locations := a_locations + 1;
    ELSE
      RAISE EXCEPTION 'unknown kind to archive' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'locations_imported', 'organization', p_org, jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_given', c_given, 'passwords_written', c_passwords, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked,
    'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras));
  RETURN jsonb_build_object(
    'locations_created', c_loc_created, 'locations_updated', c_loc_updated, 'recorders_created', c_rec_created, 'recorders_updated', c_rec_updated,
    'passwords_given', c_given, 'cameras_created', c_cameras, 'cameras_relinked', c_relinked, 'regions_created', c_regions, 'clusters_created', c_clusters,
    'archived_locations', a_locations, 'archived_recorders', a_recorders, 'archived_cameras', a_cameras, 'dropped_camera_ids', to_jsonb(v_dropped));
END
$function$;

CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer DEFAULT 2)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r jsonb;
  v_type text;
  v_id uuid;
  v_ok boolean;
  v_at timestamptz;
  v_method text;
  v_error text;
  v_cause text;
  v_prev_checked timestamptz;
  s public.check_state%ROWTYPE;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation; a camera
    -- must be mapped to a recorder — to THE recorder that produced the result, when the result names it (review M-3: a late result
    -- of the camera's previous NVR is ignored); a recorder (and so its cameras) must have monitoring switched on and its asset enabled.
    IF NOT (
      (v_type = 'camera' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        JOIN public.recorders rr ON rr.id = c.recorder_id JOIN public.assets ra ON ra.id = rr.id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND rr.monitoring_enabled AND ra.enabled AND ra.archived_at IS NULL
          AND (NOT (r ? 'recorder') OR c.recorder_id::text = lower(r ->> 'recorder')))) OR
      (v_type = 'device' AND EXISTS (
        SELECT 1 FROM public.assets a WHERE a.id = v_id AND a.org_id = p_org AND a.enabled AND a.archived_at IS NULL AND NOT a.is_recorder)) OR
      (v_type = 'recorder' AND EXISTS (
        SELECT 1 FROM public.recorders rr JOIN public.assets a ON a.id = rr.id JOIN public.locations l ON l.id = rr.location_id
        WHERE rr.id = v_id AND rr.org_id = p_org AND rr.monitoring_enabled AND a.enabled AND a.archived_at IS NULL
          AND l.is_active AND l.archived_at IS NULL))
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.check_state (org_id, target_type, target_id, created_at)
    VALUES (p_org, v_type, v_id, v_at)
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM public.check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

    v_prev_checked := s.last_checked_at;
    s.last_checked_at := v_at;
    s.method := v_method;
    IF v_ok THEN
      s.status := 'up';
      s.consecutive_failures := 0;
      s.last_up_at := v_at;
      s.first_failure_at := NULL;
      s.down_since := NULL;
      s.error := NULL;
      UPDATE public.outages SET ended_at = greatest(v_at, started_at)
      WHERE org_id = p_org AND target_type = v_type AND target_id = v_id AND ended_at IS NULL;
    ELSE
      s.error := v_error;
      -- A run of failures that began before the worker was stopped is not continued: nobody knows what happened during the stop.
      IF s.consecutive_failures > 0 AND s.status <> 'down' AND v_prev_checked IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.monitor_gaps g WHERE g.ended_at > v_prev_checked AND g.started_at < v_at) THEN
        s.consecutive_failures := 0;
        s.first_failure_at := NULL;
      END IF;
      IF s.consecutive_failures = 0 THEN s.first_failure_at := v_at; END IF;
      s.consecutive_failures := s.consecutive_failures + 1;
      IF s.consecutive_failures >= p_threshold AND s.status <> 'down' THEN
        s.status := 'down';
        s.down_since := coalesce(s.first_failure_at, v_at);
        INSERT INTO public.outages (org_id, target_type, target_id, started_at, cause)
        VALUES (p_org, v_type, v_id, s.down_since, v_cause)
        ON CONFLICT (org_id, target_type, target_id) WHERE ended_at IS NULL DO NOTHING;
      END IF;
    END IF;

    UPDATE public.check_state
    SET status = s.status, last_checked_at = s.last_checked_at, last_up_at = s.last_up_at,
        first_failure_at = s.first_failure_at, down_since = s.down_since,
        consecutive_failures = s.consecutive_failures, method = s.method, error = s.error
    WHERE id = s.id;
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION public.monitor_request_check() RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE worker_state SET check_requested_at = now() WHERE id = 1 RETURNING check_requested_at
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  DELETE FROM auth.sessions WHERE user_id = p_user;
  -- Refresh tokens are removed with their session (ON DELETE CASCADE); this also removes any left over.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;
END
$$;

CREATE OR REPLACE FUNCTION public.targets_uptime(p_org uuid, p_type text, p_ids uuid[], p_window interval, p_now timestamptz DEFAULT now())
RETURNS TABLE(target_id uuid, uptime_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT cs.target_id AS tid, greatest(p_now - p_window, cs.created_at) AS ws
    FROM check_state cs
    WHERE cs.org_id = p_org AND cs.target_type = p_type AND cs.target_id = ANY (p_ids)
  ),
  obs AS (
    SELECT b.tid, b.ws,
           extract(epoch FROM (p_now - b.ws))
           - coalesce((SELECT sum(extract(epoch FROM (least(g.ended_at, p_now) - greatest(g.started_at, b.ws))))
                       FROM monitor_gaps g WHERE g.ended_at > b.ws AND g.started_at < p_now), 0) AS observed
    FROM base b
    WHERE b.ws < p_now
  ),
  dn AS (
    SELECT o.tid,
           sum(
             extract(epoch FROM (least(coalesce(ou.ended_at, p_now), p_now) - greatest(ou.started_at, o.ws)))
             - coalesce((SELECT sum(greatest(0, extract(epoch FROM (
                           least(coalesce(ou.ended_at, p_now), g.ended_at, p_now) - greatest(ou.started_at, g.started_at, o.ws)))))
                         FROM monitor_gaps g
                         WHERE g.ended_at > greatest(ou.started_at, o.ws) AND g.started_at < least(coalesce(ou.ended_at, p_now), p_now)), 0)
           ) AS down
    FROM obs o
    JOIN outages ou ON ou.org_id = p_org AND ou.target_type = p_type AND ou.target_id = o.tid
                   AND ou.started_at < p_now AND coalesce(ou.ended_at, p_now) > o.ws
    GROUP BY o.tid
  )
  SELECT o.tid,
         CASE WHEN o.observed <= 0 THEN NULL
              ELSE round(100 * greatest(0, least(o.observed, o.observed - coalesce(d.down, 0))) / o.observed, 2) END
  FROM obs o LEFT JOIN dn d ON d.tid = o.tid
$$;

CREATE OR REPLACE FUNCTION public.privilege_violations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT format('%s: authenticated has %s', c.relname, a.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
    AND a.privilege_type <> 'SELECT'
  UNION ALL
  SELECT format('%s: anon has %s', c.relname, a.privilege_type)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
  UNION ALL
  SELECT format('default privileges still give %s access to new objects of kind %s', r.rolname, d.defaclobjtype)
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
    AND r.rolname IN ('anon', 'authenticated')
$$;

DROP FUNCTION IF EXISTS public.vault_reads_prune(interval);
DROP FUNCTION IF EXISTS public.recorder_secret_equals(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.recorder_credential_read(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.credential_purpose_allowed(text, text);
DROP FUNCTION IF EXISTS public.service_caller_role();
DROP TABLE IF EXISTS public.vault_reads;
DROP FUNCTION IF EXISTS public.security_settings_set_test(uuid, boolean);
DROP FUNCTION IF EXISTS public.service_role_may_read_credentials(uuid);
DROP TABLE IF EXISTS public.security_settings;

-- The roles: every privilege in this database first (DROP OWNED also removes default privileges), then membership, then the roles.
-- Roles are cluster-wide: if another database of this cluster granted them anything, DROP ROLE says so and they stay (harmless).
DROP OWNED BY app_web, media_service, monitor_worker, video_gateway;
REVOKE app_web, media_service, monitor_worker, video_gateway FROM authenticator;
DROP ROLE IF EXISTS app_web;
DROP ROLE IF EXISTS media_service;
DROP ROLE IF EXISTS monitor_worker;
DROP ROLE IF EXISTS video_gateway;

NOTIFY pgrst, 'reload schema';
