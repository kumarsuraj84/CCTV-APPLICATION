-- Undoes 20261021000013_access_summary.sql. The app of P2-2 needs this function (lib/auth/capabilities.ts): after this rollback every
-- signed-in person's summary reads as "failed" and shows nothing, so roll the app back to P2-1 first. Run before the rollback of 0012.
BEGIN;

DROP FUNCTION IF EXISTS public.my_access_summary();

COMMIT;
