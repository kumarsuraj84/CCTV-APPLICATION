-- Rollback of 20261021000029_p24_media_sessions.sql (P2-4). Run before the 0028 rollback. Nothing to restore verbatim: 0029 only adds
-- objects (it changes no existing function, table or policy). The session rows are lost (they are short-lived connection records;
-- take a data-only backup first if they are wanted as evidence).
-- After the rollback the application code of P2-4 cannot open video (media_session_create is gone) and the gateway of P2-4 refuses
-- every socket (fail closed): roll the code back with it.
DROP TRIGGER IF EXISTS profiles_media_sessions ON public.profiles;
DROP FUNCTION IF EXISTS public.media_sessions_profile_changed();
DROP FUNCTION IF EXISTS public.media_sessions_prune(interval, interval, uuid);
DROP FUNCTION IF EXISTS public.media_sessions_revalidate(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.media_sessions_revoke_user(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.media_session_close(uuid);
DROP FUNCTION IF EXISTS public.media_sessions_still_valid(uuid[]);
DROP FUNCTION IF EXISTS public.media_session_open(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.media_session_create(uuid, uuid, text, uuid[], text[], boolean, integer, integer);
DROP FUNCTION IF EXISTS public.media_session_problem(public.media_sessions);
DROP FUNCTION IF EXISTS public.media_session_target_problem(uuid, uuid, text, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.has_capability_for_user(uuid, text, text, uuid, boolean);
DROP TABLE IF EXISTS public.media_sessions;
