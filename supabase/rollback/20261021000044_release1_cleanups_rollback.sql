-- Rollback of 20261021000044_release1_cleanups.sql (Release 1 clean-up package). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back, verbatim as the database had them before 0044 (pg_get_functiondef of 0032 / 0035 / 0039 / 0040), media_sessions_profile_changed,
-- monitor_apply_results, worker_rows_guard, sign_in_finish, media_session_open and privilege_violations with their grants; drops the
-- security_settings delete audit and truncate guard, the organisations' test-namespace guard and organizations.created_as_test, and
-- public.test_fixture_switch. What is lost: which organisations were made by the tests (the slug is trusted again), and the switch (the
-- fixtures' header is honoured again on every database). Audit rows written by 0044 (security_settings_deleted) stay.

BEGIN;

-- 1. The organisations' test namespace.
DROP TRIGGER IF EXISTS organizations_test_namespace ON public.organizations;
DROP FUNCTION IF EXISTS public.organizations_test_namespace();
ALTER TABLE public.organizations DROP COLUMN IF EXISTS created_as_test;

-- 2. The security settings row.
DROP TRIGGER IF EXISTS security_settings_no_truncate ON public.security_settings;
DROP TRIGGER IF EXISTS security_settings_audit_delete ON public.security_settings;
DROP FUNCTION IF EXISTS public.security_settings_no_truncate();
DROP FUNCTION IF EXISTS public.security_settings_audit_delete();

-- 3. The replaced functions, as before 0044.

CREATE OR REPLACE FUNCTION public.media_sessions_profile_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v record;
  v_reason text;
  v_done text;
  v_used integer;
  v_open integer;
  v_lock text;
BEGIN
  -- Only sessions with a socket matter here; a never-opened one is checked when it is opened.
  IF NOT EXISTS (SELECT 1 FROM public.media_sessions m WHERE m.user_id = NEW.id AND m.opened_at IS NOT NULL AND m.closed_at IS NULL AND m.revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  v_lock := current_setting('lock_timeout');
  BEGIN
    PERFORM set_config('lock_timeout', '2s', true);
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
      -- Once per person per transaction: at COMMIT every part of the change is visible, so a second re-check finds nothing new.
      v_done := coalesce(current_setting('drishti.media_rechecked', true), '');
      IF position(NEW.id::text IN v_done) = 0 THEN
        v_used := coalesce(nullif(current_setting('drishti.media_recheck_used', true), '')::integer, 0);
        SELECT count(*) INTO v_open FROM public.media_sessions m
        WHERE m.user_id = NEW.id AND m.opened_at IS NOT NULL AND m.closed_at IS NULL AND m.revoked_at IS NULL;
        PERFORM set_config('drishti.media_rechecked', v_done || NEW.id::text || ',', true);
        IF v_used + v_open <= public.media_sessions_recheck_budget() THEN
          PERFORM set_config('drishti.media_recheck_used', (v_used + v_open)::text, true);
          PERFORM public.media_sessions_revalidate(v.org_id, ARRAY[NEW.id]);
        ELSE
          RAISE WARNING 'media session re-check budget reached in this transaction; the gateway check ends the remaining sessions';
        END IF;
      END IF;
    END IF;
    PERFORM set_config('lock_timeout', v_lock, true);
  EXCEPTION WHEN OTHERS THEN
    -- query_canceled (a statement timeout or a cancel) is not caught by WHEN OTHERS and is never swallowed.
    PERFORM set_config('lock_timeout', v_lock, true);
    RAISE WARNING 'media session re-check after an access change failed (%); the gateway check will catch it', SQLSTATE;
  END;
  RETURN NULL;
END
$function$
;

CREATE OR REPLACE FUNCTION public.monitor_apply_results(p_org uuid, p_results jsonb, p_threshold integer, p_lease text, p_fencing_token bigint)
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
  v_latest constant timestamptz := now() + interval '30 seconds';
  s public.check_state%ROWTYPE;
BEGIN
  PERFORM public.worker_fence_org(p_lease, p_fencing_token, p_org);
  FOR r IN SELECT * FROM jsonb_array_elements(p_results) LOOP
    v_type := r ->> 'type';
    v_id := (r ->> 'id')::uuid;
    v_ok := (r ->> 'ok')::boolean;
    v_at := (r ->> 'at')::timestamptz;
    v_method := r ->> 'method';
    v_error := left(r ->> 'error', 300);
    v_cause := r ->> 'cause';
    -- I-1: a result dated more than 30 s ahead of the database clock comes from a worker clock running ahead: it is dated now().
    IF v_at > v_latest THEN v_at := now(); END IF;

    -- Never trust ids from outside: the target must exist, be switched on, not be archived, belong to this organisation; a camera
    -- must be mapped to THE recorder that produced the result, and the result must name it; a recorder (and so its cameras) must have
    -- monitoring switched on and its asset enabled.
    IF NOT (
      (v_type = 'camera' AND r ? 'recorder' AND jsonb_typeof(r -> 'recorder') = 'string' AND EXISTS (
        SELECT 1 FROM public.cameras c JOIN public.locations l ON l.id = c.location_id
        JOIN public.recorders rr ON rr.id = c.recorder_id JOIN public.assets ra ON ra.id = rr.id
        WHERE c.id = v_id AND c.org_id = p_org AND c.is_active AND c.archived_at IS NULL AND l.is_active AND l.archived_at IS NULL
          AND rr.monitoring_enabled AND ra.enabled AND ra.archived_at IS NULL
          AND c.recorder_id::text = lower(r ->> 'recorder'))) OR
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
    VALUES (p_org, v_type, v_id, LEAST(v_at, now()))
    ON CONFLICT (org_id, target_type, target_id) DO NOTHING;

    SELECT * INTO s FROM public.check_state WHERE org_id = p_org AND target_type = v_type AND target_id = v_id FOR UPDATE;

    -- P2-7 (D-8), scoped by review round 1 (I-1): a result older than the last one applied is late only when it comes from the SAME
    -- lease and the same or an older epoch. A newer epoch always applies: the fence guarantees no older epoch writes after a takeover,
    -- and the new holder's clock may be behind the old one's.
    IF s.last_checked_at IS NOT NULL AND v_at < s.last_checked_at
       AND s.applied_lease IS NOT DISTINCT FROM p_lease AND s.applied_fencing_token IS NOT NULL AND p_fencing_token <= s.applied_fencing_token THEN
      CONTINUE;
    END IF;

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
        consecutive_failures = s.consecutive_failures, method = s.method, error = s.error,
        applied_lease = p_lease, applied_fencing_token = p_fencing_token
    WHERE id = s.id;
  END LOOP;
END
$function$
;

CREATE OR REPLACE FUNCTION public.worker_rows_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_headers text := pg_catalog.current_setting('request.headers', true);
  v_fixture text;
BEGIN
  IF current_user = 'service_role' THEN
    BEGIN
      v_fixture := (nullif(v_headers, '')::jsonb) ->> 'x-drishti-test-fixture';
    EXCEPTION WHEN others THEN
      v_fixture := NULL;
    END;
    IF v_fixture IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'drishti: % is written only by the worker''s fenced functions (an old worker? stop it and start the current one)', TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.sign_in_finish(p_key text, p_outcome text, p_ip_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 200 OR p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'not_counted') THEN
    RAISE EXCEPTION 'bad sign-in finish request' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'succeeded' THEN
    DELETE FROM public.sign_in_attempts WHERE key = p_key;
  ELSE
    UPDATE public.sign_in_attempts SET failures = GREATEST(0, failures - 1) WHERE key = p_key OR (p_ip_key IS NOT NULL AND key = p_ip_key);
  END IF;
END
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.privilege_violations()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'media_sessions', 'worker_state', 'monitor_gaps', 'worker_leases')
    AND x.grantee = (SELECT oid FROM r WHERE rolname = 'authenticated')
  UNION ALL
  SELECT pg_catalog.format('%s: %s may %s (written by the database only)', x.relname, (SELECT rolname FROM r WHERE r.oid = x.grantee), x.privilege_type)
  FROM relacl x WHERE x.relname IN ('vault_reads', 'rate_limit_hits', 'sign_in_attempts', 'security_settings', 'worker_leases') AND x.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
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
  SELECT pg_catalog.format('%s: video_gateway has %s (it may only call its three functions)', x.relname, x.privilege_type)
  FROM relacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('%s (column): video_gateway has %s', x.relname, x.privilege_type) FROM colacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
  UNION ALL
  SELECT pg_catalog.format('function %s: PUBLIC may execute', x.proname) FROM fnacl x WHERE x.grantee = 0
  UNION ALL
  SELECT pg_catalog.format('function %s: anon may execute', x.proname) FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'anon')
  UNION ALL
  SELECT pg_catalog.format('function %s: video_gateway may execute (only media_session_open, media_sessions_still_valid, media_session_close)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'video_gateway')
    AND x.proname NOT IN ('media_session_open', 'media_sessions_still_valid', 'media_session_close')
  UNION ALL
  SELECT pg_catalog.format('function %s: media_service may execute (only the web app counts sign-ins and limits)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'media_service')
    AND x.proname IN ('rate_limit_hit', 'rate_limit_state', 'rate_limit_clear', 'sign_in_gate', 'sign_in_finish')
  UNION ALL
  SELECT pg_catalog.format('function %s: monitor_worker may execute it without a fencing token (every worker write takes p_fencing_token)', x.proname)
  FROM fnacl x WHERE x.grantee = (SELECT oid FROM r WHERE rolname = 'monitor_worker')
    AND NOT ('p_fencing_token' = ANY (coalesce(x.proargnames, '{}'::text[])))
    AND x.proname NOT IN ('worker_acquire_lease', 'recorder_credential_read', 'media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune')
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
$function$
;

-- 4. The switch (worker_rows_guard above no longer reads it).
DROP TABLE IF EXISTS public.test_fixture_switch;

-- 5. Grants as before 0044 (CREATE OR REPLACE kept them; stated again explicitly).
REVOKE ALL ON FUNCTION
  public.media_sessions_profile_changed(),
  public.monitor_apply_results(uuid, jsonb, integer, text, bigint),
  public.worker_rows_guard(),
  public.sign_in_finish(text, text, text),
  public.media_session_open(uuid, uuid, uuid, text, text),
  public.privilege_violations()
FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.monitor_apply_results(uuid, jsonb, integer, text, bigint) TO service_role, monitor_worker;
GRANT EXECUTE ON FUNCTION public.sign_in_finish(text, text, text) TO service_role, app_web;
GRANT EXECUTE ON FUNCTION public.media_session_open(uuid, uuid, uuid, text, text) TO service_role, media_service, video_gateway;
GRANT EXECUTE ON FUNCTION public.privilege_violations() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0044: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
