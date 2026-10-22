-- Rollback of 20261021000034_p31_mfa_sessions.sql (P3-1). Dry run first: BEGIN; \i supabase/rollback/20261021000034_p31_mfa_sessions_rollback.sql; ROLLBACK;
-- Puts back mfa_enforced() = false and access_grants_of with the caller's switch (bodies of 20261021000012), and removes the switch
-- column, the session status, the sign-in audit (its rows are lost: export them first if they are needed) and the single-session end.
-- Before running it, take the app back to the P2-6 code (the P3-1 app calls my_session_status and auth_event_record).
-- No BEGIN/COMMIT inside (like the other rollbacks): run it as `BEGIN; \i …; COMMIT;` for real.

DROP FUNCTION public.mfa_factor_people(uuid);
DROP FUNCTION public.auth_session_end(uuid, uuid);
DROP FUNCTION public.auth_event_record(text, uuid, text, text, uuid, text, text, jsonb);
DROP TABLE public.auth_events;
DROP FUNCTION public.auth_events_immutable();
DROP FUNCTION public.my_session_status();
DROP FUNCTION public.security_settings_set_mfa_test(uuid, boolean);

CREATE OR REPLACE FUNCTION public.access_grants_of(p_user uuid, p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS TABLE (org_id uuid, capability text, area text, scope_kind text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM public.access_grants_eval(p_user, p_at, p_ignore_status, p_aal2, public.mfa_enforced())
$$;

-- CREATE OR REPLACE cannot drop SECURITY DEFINER; the old function was SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.mfa_enforced() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER SET search_path = '' AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION public.mfa_enforced() FROM PUBLIC, anon, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.mfa_enforced() TO authenticated, service_role;

DROP FUNCTION public.mfa_enforced_for_user(uuid);
ALTER TABLE public.security_settings DROP COLUMN mfa_enforced;

NOTIFY pgrst, 'reload schema';
