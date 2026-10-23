-- Rollback of 20261021000042_p4l2_fast_budget.sql (P4-L2 review round 1). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Drops media_session_create_fast, media_session_finish, the two helpers and media_sessions.fast_media_sec. What is lost: how much recording
-- each fast stream released (the sessions themselves stay). Roll the code back with it (openFastPlayback calls media_session_create_fast,
-- serveFastStream calls media_session_finish).

BEGIN;

DROP FUNCTION IF EXISTS public.media_session_create_fast(uuid, uuid, uuid, text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.media_session_finish(uuid, integer);
DROP FUNCTION IF EXISTS public.media_session_fast_charge(public.media_sessions);
DROP FUNCTION IF EXISTS public.media_session_fast_span(text);
ALTER TABLE public.media_sessions DROP COLUMN IF EXISTS fast_media_sec;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
