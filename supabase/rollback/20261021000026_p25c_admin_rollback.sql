-- Rollback of 20261021000026_p25c_admin.sql. Run before the rollback of 20261021000025.
-- Removes camera_merge, the dynamic camera-group rules (table, check trigger, resolvers) and the reconciliation list (discovery_findings),
-- and puts back discovery_apply (five arguments) and cctv_visible_group_ids verbatim from 0025 / 0009 (pg_get_functiondef of the database
-- before 0026 was applied).
-- DATA: the rows of camera_group_rules (dynamic group rules) and discovery_findings (the reconciliation list) are DROPPED with their
-- tables; groups keep their static cameras. Merges already made stay made (the kept camera keeps its new channel; the duplicate stays
-- archived and can be restored). Take a data-only backup first if those rows matter.
BEGIN;
DROP FUNCTION public.group_rule_members(uuid);

CREATE OR REPLACE FUNCTION public.cctv_visible_group_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x)
  SELECT g.id FROM public.camera_groups g
  WHERE g.org_id = (SELECT public.current_org_id())
    AND (
      EXISTS (SELECT 1 FROM public.camera_group_items i JOIN mine ON mine.id = i.camera_id WHERE i.group_id = g.id)
      OR (NOT EXISTS (SELECT 1 FROM public.camera_group_items i WHERE i.group_id = g.id)
          AND (g.created_by = (SELECT auth.uid()) OR public.has_capability('admin.inventory')))
    )
$function$;

DROP FUNCTION public.camera_group_rule_members(uuid, uuid[]);
DROP TRIGGER camera_group_rules_check ON public.camera_group_rules;
DROP FUNCTION public.camera_group_rules_check();
DROP TABLE public.camera_group_rules;
DROP FUNCTION public.camera_merge(uuid, uuid, uuid, uuid);

DROP FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb);
CREATE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_loc uuid;
  o jsonb;
  v_op text;
  v_cam uuid;
  v_n integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_mapped integer := 0;
  v_moved integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT r.location_id INTO v_loc FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_ops must be an array' USING ERRCODE = '22023'; END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) LOOP
    v_op := o ->> 'op';
    IF v_op = 'insert' THEN
      INSERT INTO public.cameras (org_id, location_id, recorder_id, channel, name, camera_ip)
      VALUES (p_org, v_loc, p_recorder, (o ->> 'channel')::integer, o ->> 'name', o ->> 'ip');
      v_created := v_created + 1;
    ELSIF v_op IN ('update', 'map', 'remap') THEN
      v_cam := (o ->> 'id')::uuid;
      IF v_op = 'map' THEN
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip', recorder_id = p_recorder, channel = (o ->> 'channel')::integer
        WHERE id = v_cam AND org_id = p_org AND location_id = v_loc AND archived_at IS NULL AND recorder_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_mapped := v_mapped + 1;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc
                       AND c.archived_at IS NULL AND c.recorder_id = p_recorder) THEN
          RAISE EXCEPTION 'camera % is not on this recorder', v_cam USING ERRCODE = '22023';
        END IF;
        IF v_op = 'remap' THEN
          PERFORM public.camera_remap(p_org, v_cam, p_recorder, (o ->> 'channel')::integer, now(), p_actor);
          v_moved := v_moved + 1;
        ELSE
          v_updated := v_updated + 1;
        END IF;
        UPDATE public.cameras SET name = o ->> 'name', camera_ip = o ->> 'ip' WHERE id = v_cam AND org_id = p_org;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 0 THEN RAISE EXCEPTION 'camera % cannot be changed by discovery', v_cam USING ERRCODE = '22023'; END IF;
    ELSE
      RAISE EXCEPTION 'unknown discovery change' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'cameras_discovered', 'store', v_loc, jsonb_build_object(
    'capability', 'admin.inventory', 'locationIds', jsonb_build_array(v_loc), 'count', 1, 'recorder_id', p_recorder,
    'created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'to_reconcile', coalesce(p_to_reconcile, 0)));
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved);
END
$function$;
COMMENT ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid) IS
  'P2-5b review M-8: everything one camera discovery of one NVR saves, and its audit row, in one transaction. Server only.';
REVOKE ALL ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid) TO service_role;

DROP TABLE public.discovery_findings;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0026: privilege_violations() is not empty'; END IF;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
