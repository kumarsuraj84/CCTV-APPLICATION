-- Rollback of 20261021000030_p25c_proposal_preview.sql (P2-5c-1 fix round 2). Run before the rollback of 20261021000029 / 0028 / 0027.
-- Drops preview_hierarchy_proposals; no data is changed. The application's proposal preview needs it (lib/inventory/hierarchy.ts), so
-- roll the code back with it.
DROP FUNCTION public.preview_hierarchy_proposals(uuid, jsonb);
NOTIFY pgrst, 'reload schema';
