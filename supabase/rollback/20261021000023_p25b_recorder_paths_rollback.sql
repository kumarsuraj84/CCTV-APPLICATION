-- Rollback of 20261021000023_p25b_recorder_paths.sql. Run after the rollback of 20261021000024 and before the one of 20261021000022.
-- Puts back the previous definitions (verbatim from 20261021000019 / 20261021000006) and removes recorder_save.
-- NOT undone: the data fix (no recorder asset gets its 'device' state back); recorders made through recorder_save stay (they are
-- ordinary recorders; the 0019 rollback refuses while people-made recorders exist, as documented there).
BEGIN;
DROP FUNCTION public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid);
DROP FUNCTION public.inventory_refresh_statistics();

CREATE OR REPLACE FUNCTION public.cameras_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec uuid := coalesce(NEW.recorder_id, public.recorder_primary_of(NEW.location_id));
BEGIN
  IF v_rec IS NOT NULL AND NEW.archived_at IS NULL THEN
    INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from)
    VALUES (NEW.org_id, NEW.id, v_rec, NEW.channel, NEW.created_at);
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.monitor_stop_targets(p_org uuid, p_type text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE outages SET ended_at = greatest(now(), started_at)
  WHERE org_id = p_org AND target_type = p_type AND target_id = ANY (p_ids) AND ended_at IS NULL;
  DELETE FROM check_state WHERE org_id = p_org AND target_type = p_type AND target_id = ANY (p_ids);
END
$$;
CREATE OR REPLACE FUNCTION public.monitor_stop_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM monitor_stop_targets(NEW.org_id, TG_ARGV[0], ARRAY[NEW.id]);
  RETURN NEW;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
