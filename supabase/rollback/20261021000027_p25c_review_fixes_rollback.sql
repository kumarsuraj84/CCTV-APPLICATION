-- Rollback of 20261021000027_p25c_review_fixes.sql. Run before the rollback of 20261021000026.
-- Removes group_member_counts and inventory_apply_proposals and puts back the 0026 definitions of camera_group_rule_members,
-- cctv_visible_group_ids, group_rule_members and camera_merge (as in 20261021000026_p25c_admin.sql) and the 0026 rule index.
-- DATA: none is changed. Note: the 0026 rule index does not trim the word; two rules of one group whose words differ only by spaces
-- (allowed by neither the service nor 0027) would block it; the DO block below refuses with a plain message in that case.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.camera_group_rules GROUP BY group_id, kind, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(coalesce(name_contains, ''))
             HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'rollback of 0027: two rules of one group differ only by spaces; remove one first';
  END IF;
END
$$;
DROP FUNCTION public.group_member_counts(text);
DROP FUNCTION public.inventory_apply_proposals(uuid, jsonb, uuid);

DROP INDEX public.camera_group_rules_key;
CREATE UNIQUE INDEX camera_group_rules_key ON public.camera_group_rules
  (group_id, kind, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(coalesce(name_contains, '')));

CREATE OR REPLACE FUNCTION public.camera_group_rule_members(p_org uuid, p_groups uuid[] DEFAULT NULL) RETURNS TABLE (group_id uuid, camera_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT r.group_id, c.id
  FROM public.camera_group_rules r
  JOIN public.cameras c ON c.org_id = r.org_id AND c.archived_at IS NULL
  JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
  LEFT JOIN public.clusters cl ON cl.id = l.cluster_id AND cl.archived_at IS NULL
  LEFT JOIN public.regions rg ON rg.id = cl.region_id AND rg.archived_at IS NULL
  WHERE r.org_id = p_org AND (p_groups IS NULL OR r.group_id = ANY (p_groups))
    AND ((r.kind = 'location' AND c.location_id = r.ref_id)
      OR (r.kind = 'cluster' AND cl.id = r.ref_id)
      OR (r.kind = 'region' AND rg.id = r.ref_id)
      OR (r.kind = 'recorder' AND c.recorder_id = r.ref_id)
      OR r.kind = 'name')
    AND (r.name_contains IS NULL OR strpos(lower(c.name), lower(btrim(r.name_contains))) > 0)
$$;

CREATE OR REPLACE FUNCTION public.cctv_visible_group_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x),
       dyn AS MATERIALIZED (SELECT m.group_id, m.camera_id FROM public.camera_group_rule_members((SELECT public.current_org_id())) AS m)
  SELECT g.id FROM public.camera_groups g
  WHERE g.org_id = (SELECT public.current_org_id())
    AND (
      EXISTS (SELECT 1 FROM public.camera_group_items i JOIN mine ON mine.id = i.camera_id WHERE i.group_id = g.id)
      OR EXISTS (SELECT 1 FROM dyn JOIN mine ON mine.id = dyn.camera_id WHERE dyn.group_id = g.id)
      OR (NOT EXISTS (SELECT 1 FROM public.camera_group_items i WHERE i.group_id = g.id)
          AND NOT EXISTS (SELECT 1 FROM dyn WHERE dyn.group_id = g.id)
          AND (g.created_by = (SELECT auth.uid()) OR public.has_capability('admin.inventory')))
    )
$$;

CREATE OR REPLACE FUNCTION public.group_rule_members(p_group uuid DEFAULT NULL) RETURNS TABLE (group_id uuid, camera_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x),
       vis AS MATERIALIZED (SELECT x AS id FROM public.cctv_visible_group_ids() AS x)
  SELECT m.group_id, m.camera_id
  FROM public.camera_group_rule_members((SELECT public.current_org_id()), CASE WHEN p_group IS NULL THEN NULL ELSE ARRAY[p_group] END) AS m
  JOIN mine ON mine.id = m.camera_id
  JOIN vis ON vis.id = m.group_id
$$;

CREATE OR REPLACE FUNCTION public.camera_merge(p_org uuid, p_keep uuid, p_duplicate uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  k public.cameras%ROWTYPE;
  d public.cameras%ROWTYPE;
  v_rec uuid;
  v_ch integer;
  v_closed timestamptz;
  v_groups integer := 0;
  v_grants integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_keep IS NULL OR p_duplicate IS NULL OR p_keep = p_duplicate THEN
    RAISE EXCEPTION 'choose two different cameras' USING ERRCODE = '22023';
  END IF;
  -- Both rows locked in one order, so two merges cannot deadlock.
  PERFORM 1 FROM public.cameras x WHERE x.id IN (p_keep, p_duplicate) AND x.org_id = p_org ORDER BY x.id FOR UPDATE;
  SELECT * INTO k FROM public.cameras x WHERE x.id = p_keep AND x.org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO d FROM public.cameras x WHERE x.id = p_duplicate AND x.org_id = p_org;
  IF NOT FOUND OR d.archived_at IS NOT NULL THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  IF k.archived_at IS NOT NULL THEN RAISE EXCEPTION 'restore the camera to keep first' USING ERRCODE = 'DR011'; END IF;
  SELECT m.recorder_id, m.channel INTO v_rec, v_ch FROM public.camera_channel_mappings m WHERE m.camera_id = p_duplicate AND m.valid_to IS NULL;
  v_people := public.inventory_affected_people(p_org, 'camera', p_keep);
  SELECT count(*) INTO v_grants FROM public.access_grants g
  WHERE g.org_id = p_org AND g.scope_kind = 'camera' AND g.scope_id = p_duplicate AND g.revoked_at IS NULL AND (g.valid_until IS NULL OR g.valid_until > now());
  -- 1. The duplicate is archived (mapping closed, monitoring stopped, history kept, its holders' versions raised, audited).
  PERFORM public.inventory_archive(p_org, 'camera', p_duplicate, p_actor);
  SELECT max(m.valid_to) INTO v_closed FROM public.camera_channel_mappings m WHERE m.camera_id = p_duplicate;
  -- 2. The kept camera follows it to its location (the camera trigger closes its old mapping and raises both sides' versions).
  IF k.location_id <> d.location_id THEN
    UPDATE public.cameras SET location_id = d.location_id, recorder_id = NULL WHERE id = p_keep;
  END IF;
  -- 3. ... and takes over its channel, from the moment the duplicate's mapping ended (no overlap in the channel's history).
  IF v_rec IS NOT NULL THEN
    PERFORM public.camera_remap(p_org, p_keep, v_rec, v_ch, coalesce(v_closed, now()), p_actor);
  END IF;
  UPDATE public.cameras SET camera_ip = coalesce(d.camera_ip, camera_ip) WHERE id = p_keep;
  -- 4. Group memberships of the duplicate are added to the kept camera.
  INSERT INTO public.camera_group_items (org_id, group_id, camera_id)
  SELECT i.org_id, i.group_id, p_keep FROM public.camera_group_items i WHERE i.camera_id = p_duplicate AND i.org_id = p_org
  ON CONFLICT (group_id, camera_id) DO NOTHING;
  GET DIAGNOSTICS v_groups = ROW_COUNT;
  -- 5. What the reconciliation list said about either camera is settled.
  UPDATE public.discovery_findings SET resolved_at = now(), resolved_by = p_actor, resolution = 'merged'
  WHERE org_id = p_org AND resolved_at IS NULL AND (camera_id IN (p_keep, p_duplicate) OR other_camera_id IN (p_keep, p_duplicate));
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'camera_merged', 'camera', p_keep, jsonb_build_object(
    'duplicate', p_duplicate, 'recorder_id', v_rec, 'channel', v_ch, 'from_location', k.location_id, 'to_location', d.location_id,
    'groups_copied', v_groups, 'duplicate_camera_grants', v_grants));
  RETURN jsonb_build_object('kept', p_keep, 'duplicate', p_duplicate, 'recorder_id', v_rec, 'channel', v_ch, 'groups_copied', v_groups,
                            'duplicate_camera_grants', v_grants);
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0027: privilege_violations() is not empty'; END IF;
END
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
