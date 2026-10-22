-- Rollback of 20261021000038_p4l1_live_rollups.sql (P4-L1: roll-ups, stream opens with location and NVR, open live streams per person).
-- Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Drops status_rollups, media_sessions_live_open, the media_sessions BEFORE INSERT trigger and its function, and the two columns
-- media_sessions.location_id / recorder_id. What is lost: the location and NVR recorded on live, playback and download sessions made
-- since the migration (the sessions themselves, their person, camera, stream and times stay). Roll the code back with it (the Live
-- landing, the Home roll-up cards and openStreams' per-person cap call these functions).

BEGIN;

DROP FUNCTION IF EXISTS public.status_rollups(text);
DROP FUNCTION IF EXISTS public.media_sessions_live_open(uuid, uuid, integer);
DROP TRIGGER IF EXISTS media_sessions_before_insert ON public.media_sessions;
DROP FUNCTION IF EXISTS public.media_sessions_before_insert();
ALTER TABLE public.media_sessions DROP COLUMN IF EXISTS location_id, DROP COLUMN IF EXISTS recorder_id;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
