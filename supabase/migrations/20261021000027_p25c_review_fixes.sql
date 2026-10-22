-- P2-5c-1 review round 1 (.superpowers/sdd/drishti/p2-5c-1-review.md). New forward migration; 0026 is applied and is not edited.
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0026).
--
-- I-6  A group made only of rules is visible to its maker (and to admin.inventory) whether or not its rules match cameras the maker
--      cannot see: before, a name rule matching only invisible cameras hid the group from its maker (and so told them such names
--      exist). A group with static cameras keeps the AC-11 rule unchanged (hidden from everybody, its maker too, when none of its
--      members is visible: tests/integration/access-model.test.ts VA-13).
-- I-7  camera_group_rule_members is one indexed join per rule kind (UNION ALL) instead of every rule crossed with every camera;
--      group_rule_members resolves the rules ONCE (it used to resolve them a second time through cctv_visible_group_ids);
--      group_member_counts(cap) gives the group list its counts per group in one call (no member rows pulled into the page).
-- M-1  inventory_apply_proposals: the ticked zone → cluster proposals applied in ONE transaction (all or nothing).
-- M-4  camera_merge refuses to move the kept camera to another location when the duplicate is not linked to an NVR channel (DR012):
--      the kept camera would have ended up unlinked at the new location.
-- M-10 The rule uniqueness compares the trimmed, lower-case word, the same expression the resolver uses.

-- ═══ I-7: the resolver, one indexed join per kind ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.camera_group_rule_members(p_org uuid, p_groups uuid[] DEFAULT NULL) RETURNS TABLE (group_id uuid, camera_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH r AS MATERIALIZED (
    SELECT x.group_id, x.kind, x.ref_id, nullif(lower(btrim(x.name_contains)), '') AS word
    FROM public.camera_group_rules x
    WHERE x.org_id = p_org AND (p_groups IS NULL OR x.group_id = ANY (p_groups))
  ), hits AS (
    SELECT r.group_id, c.id, c.name, r.word FROM r
    JOIN public.cameras c ON c.location_id = r.ref_id AND c.org_id = p_org AND c.archived_at IS NULL
    WHERE r.kind = 'location'
    UNION ALL
    SELECT r.group_id, c.id, c.name, r.word FROM r
    JOIN public.cameras c ON c.recorder_id = r.ref_id AND c.org_id = p_org AND c.archived_at IS NULL
    WHERE r.kind = 'recorder'
    UNION ALL
    SELECT r.group_id, c.id, c.name, r.word FROM r
    JOIN public.clusters cl ON cl.id = r.ref_id AND cl.org_id = p_org AND cl.archived_at IS NULL
    JOIN public.locations l ON l.cluster_id = cl.id AND l.archived_at IS NULL
    JOIN public.cameras c ON c.location_id = l.id AND c.archived_at IS NULL
    WHERE r.kind = 'cluster'
    UNION ALL
    SELECT r.group_id, c.id, c.name, r.word FROM r
    JOIN public.regions rg ON rg.id = r.ref_id AND rg.org_id = p_org AND rg.archived_at IS NULL
    JOIN public.clusters cl ON cl.region_id = rg.id AND cl.archived_at IS NULL
    JOIN public.locations l ON l.cluster_id = cl.id AND l.archived_at IS NULL
    JOIN public.cameras c ON c.location_id = l.id AND c.archived_at IS NULL
    WHERE r.kind = 'region'
    UNION ALL
    SELECT r.group_id, c.id, c.name, r.word FROM r
    JOIN public.cameras c ON c.org_id = p_org AND c.archived_at IS NULL
    WHERE r.kind = 'name'
  )
  SELECT DISTINCT h.group_id, h.id FROM hits h
  WHERE h.word IS NULL OR strpos(lower(h.name), h.word) > 0
$$;

-- ═══ I-6: visibility of a group ══════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cctv_visible_group_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x),
       dyn AS MATERIALIZED (SELECT m.group_id, m.camera_id FROM public.camera_group_rule_members((SELECT public.current_org_id())) AS m)
  SELECT g.id FROM public.camera_groups g
  WHERE g.org_id = (SELECT public.current_org_id())
    AND (
      EXISTS (SELECT 1 FROM public.camera_group_items i JOIN mine ON mine.id = i.camera_id WHERE i.group_id = g.id)
      OR EXISTS (SELECT 1 FROM dyn JOIN mine ON mine.id = dyn.camera_id WHERE dyn.group_id = g.id)
      -- No static camera: visible to its maker and to admin.inventory, whatever its rules match (review I-6).
      OR (NOT EXISTS (SELECT 1 FROM public.camera_group_items i WHERE i.group_id = g.id)
          AND (g.created_by = (SELECT auth.uid()) OR public.has_capability('admin.inventory')))
    )
$$;

-- For signed-in people: the dynamic members of the groups they may see (one group, or all), only the cameras they may see. The rules
-- are resolved once; the visibility is the same rule as cctv_visible_group_ids.
CREATE OR REPLACE FUNCTION public.group_rule_members(p_group uuid DEFAULT NULL) RETURNS TABLE (group_id uuid, camera_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH org AS MATERIALIZED (SELECT public.current_org_id() AS id),
       mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x),
       dyn AS MATERIALIZED (
         SELECT m.group_id, m.camera_id
         FROM public.camera_group_rule_members((SELECT id FROM org), CASE WHEN p_group IS NULL THEN NULL ELSE ARRAY[p_group] END) AS m),
       vis AS MATERIALIZED (
         SELECT g.id FROM public.camera_groups g
         WHERE g.org_id = (SELECT id FROM org) AND (p_group IS NULL OR g.id = p_group)
           AND (EXISTS (SELECT 1 FROM public.camera_group_items i JOIN mine ON mine.id = i.camera_id WHERE i.group_id = g.id)
                OR EXISTS (SELECT 1 FROM dyn JOIN mine ON mine.id = dyn.camera_id WHERE dyn.group_id = g.id)
                OR (NOT EXISTS (SELECT 1 FROM public.camera_group_items i WHERE i.group_id = g.id)
                    AND (g.created_by = (SELECT auth.uid()) OR public.has_capability('admin.inventory')))))
  SELECT dyn.group_id, dyn.camera_id FROM dyn JOIN mine ON mine.id = dyn.camera_id JOIN vis ON vis.id = dyn.group_id
  ORDER BY 1, 2
$$;

-- The group list's counts: per group the caller may see, the working cameras (active, at an active location) in it — static and
-- dynamic, counted once — that the caller may see, and when p_cap is given only those the caller may use with that capability
-- (capability_camera_ids: the same rules as cameras_with_capability). Groups with nothing countable are listed with 0.
CREATE FUNCTION public.group_member_counts(p_cap text DEFAULT NULL) RETURNS TABLE (group_id uuid, cameras integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH org AS MATERIALIZED (SELECT public.current_org_id() AS id),
       mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x),
       usable AS MATERIALIZED (SELECT x AS id FROM public.capability_camera_ids(coalesce(p_cap, '')) AS x WHERE p_cap IS NOT NULL),
       dyn AS MATERIALIZED (SELECT m.group_id, m.camera_id FROM public.camera_group_rule_members((SELECT id FROM org)) AS m),
       vis AS MATERIALIZED (
         SELECT g.id FROM public.camera_groups g
         WHERE g.org_id = (SELECT id FROM org)
           AND (EXISTS (SELECT 1 FROM public.camera_group_items i JOIN mine ON mine.id = i.camera_id WHERE i.group_id = g.id)
                OR EXISTS (SELECT 1 FROM dyn JOIN mine ON mine.id = dyn.camera_id WHERE dyn.group_id = g.id)
                OR (NOT EXISTS (SELECT 1 FROM public.camera_group_items i WHERE i.group_id = g.id)
                    AND (g.created_by = (SELECT auth.uid()) OR public.has_capability('admin.inventory'))))),
       members AS (
         SELECT i.group_id, i.camera_id FROM public.camera_group_items i JOIN vis ON vis.id = i.group_id
         UNION
         SELECT dyn.group_id, dyn.camera_id FROM dyn JOIN vis ON vis.id = dyn.group_id),
       counted AS (
         SELECT m.group_id, count(*)::integer AS n FROM members m
         JOIN mine ON mine.id = m.camera_id
         JOIN public.cameras c ON c.id = m.camera_id AND c.is_active
         JOIN public.locations l ON l.id = c.location_id AND l.is_active
         WHERE p_cap IS NULL OR m.camera_id IN (SELECT id FROM usable)
         GROUP BY m.group_id)
  SELECT vis.id, coalesce(counted.n, 0) FROM vis LEFT JOIN counted ON counted.group_id = vis.id
  ORDER BY 1
$$;
COMMENT ON FUNCTION public.group_member_counts(text) IS
  'P2-5c-1 review I-7: per visible group, the working cameras the caller may see (and, with p_cap, may use with that capability).';
REVOKE ALL ON FUNCTION public.group_member_counts(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.group_member_counts(text) TO authenticated;

-- ═══ M-10: one expression for the rule word ═════════════════════════════════════════════════════════════════════════════════
DROP INDEX public.camera_group_rules_key;
CREATE UNIQUE INDEX camera_group_rules_key ON public.camera_group_rules
  (group_id, kind, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(coalesce(name_contains, ''))));

-- ═══ M-4: camera_merge across locations needs a linked duplicate ════════════════════════════════════════════════════════════
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
  PERFORM 1 FROM public.cameras x WHERE x.id IN (p_keep, p_duplicate) AND x.org_id = p_org ORDER BY x.id FOR UPDATE;
  SELECT * INTO k FROM public.cameras x WHERE x.id = p_keep AND x.org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO d FROM public.cameras x WHERE x.id = p_duplicate AND x.org_id = p_org;
  IF NOT FOUND OR d.archived_at IS NOT NULL THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  IF k.archived_at IS NOT NULL THEN RAISE EXCEPTION 'restore the camera to keep first' USING ERRCODE = 'DR011'; END IF;
  SELECT m.recorder_id, m.channel INTO v_rec, v_ch FROM public.camera_channel_mappings m WHERE m.camera_id = p_duplicate AND m.valid_to IS NULL;
  -- Review M-4: moving the kept camera to another location only makes sense onto the duplicate's NVR channel.
  IF k.location_id <> d.location_id AND v_rec IS NULL THEN
    RAISE EXCEPTION 'the duplicate at another location is not linked to an NVR channel' USING ERRCODE = 'DR012';
  END IF;
  v_people := public.inventory_affected_people(p_org, 'camera', p_keep);
  SELECT count(*) INTO v_grants FROM public.access_grants g
  WHERE g.org_id = p_org AND g.scope_kind = 'camera' AND g.scope_id = p_duplicate AND g.revoked_at IS NULL AND (g.valid_until IS NULL OR g.valid_until > now());
  PERFORM public.inventory_archive(p_org, 'camera', p_duplicate, p_actor);
  SELECT max(m.valid_to) INTO v_closed FROM public.camera_channel_mappings m WHERE m.camera_id = p_duplicate;
  IF k.location_id <> d.location_id THEN
    UPDATE public.cameras SET location_id = d.location_id, recorder_id = NULL WHERE id = p_keep;
  END IF;
  IF v_rec IS NOT NULL THEN
    PERFORM public.camera_remap(p_org, p_keep, v_rec, v_ch, coalesce(v_closed, now()), p_actor);
  END IF;
  UPDATE public.cameras SET camera_ip = coalesce(d.camera_ip, camera_ip) WHERE id = p_keep;
  INSERT INTO public.camera_group_items (org_id, group_id, camera_id)
  SELECT i.org_id, i.group_id, p_keep FROM public.camera_group_items i WHERE i.camera_id = p_duplicate AND i.org_id = p_org
  ON CONFLICT (group_id, camera_id) DO NOTHING;
  GET DIAGNOSTICS v_groups = ROW_COUNT;
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

-- ═══ M-1: zone → cluster proposals applied in one transaction ═══════════════════════════════════════════════════════════════
-- p_items: [{location_id, cluster_code, region_code?}], codes already normalised by the server (upper case). For each item the region
-- (when given) and the cluster are found by code or created (name = code; a new cluster gets the proposed region; an existing
-- cluster keeps its own region — the preview tells the administrator), then the location is moved with inventory_move_location
-- (immediate, access versions, audit). Any failure undoes everything. Server only.
CREATE FUNCTION public.inventory_apply_proposals(p_org uuid, p_items jsonb, p_actor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  it jsonb;
  v_loc uuid;
  v_cluster_code text;
  v_region_code text;
  v_region uuid;
  v_cluster uuid;
  v_moved integer := 0;
  v_regions integer := 0;
  v_clusters integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'nothing to apply' USING ERRCODE = '22023';
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_loc := (it ->> 'location_id')::uuid;
    v_cluster_code := it ->> 'cluster_code';
    v_region_code := nullif(it ->> 'region_code', '');
    IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v_loc AND l.org_id = p_org AND l.archived_at IS NULL) THEN
      RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002';
    END IF;
    v_region := NULL;
    IF v_region_code IS NOT NULL THEN
      SELECT r.id INTO v_region FROM public.regions r WHERE r.org_id = p_org AND r.code = v_region_code AND r.archived_at IS NULL;
      IF v_region IS NULL THEN
        INSERT INTO public.regions (org_id, code, name) VALUES (p_org, v_region_code, v_region_code) RETURNING id INTO v_region;
        v_regions := v_regions + 1;
      END IF;
    END IF;
    SELECT c.id INTO v_cluster FROM public.clusters c WHERE c.org_id = p_org AND c.code = v_cluster_code AND c.archived_at IS NULL;
    IF v_cluster IS NULL THEN
      INSERT INTO public.clusters (org_id, code, name, region_id) VALUES (p_org, v_cluster_code, v_cluster_code, v_region) RETURNING id INTO v_cluster;
      v_clusters := v_clusters + 1;
    END IF;
    PERFORM public.inventory_move_location(p_org, v_loc, v_cluster, p_actor);
    v_moved := v_moved + 1;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'hierarchy_proposals_applied', 'organization', p_org,
          jsonb_build_object('moved', v_moved, 'regions_created', v_regions, 'clusters_created', v_clusters));
  RETURN jsonb_build_object('moved', v_moved, 'regions_created', v_regions, 'clusters_created', v_clusters);
END
$$;
COMMENT ON FUNCTION public.inventory_apply_proposals(uuid, jsonb, uuid) IS
  'P2-5c-1 review M-1: the zone → cluster proposals an administrator ticked, applied in one transaction. Server only.';
REVOKE ALL ON FUNCTION public.inventory_apply_proposals(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_apply_proposals(uuid, jsonb, uuid) TO service_role;

-- ═══ Self-test ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5c-1 fixes self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-5c-1 fixes self-test: a function names a removed legacy column'; END IF;
  IF has_function_privilege('authenticated', 'public.inventory_apply_proposals(uuid, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.camera_merge(uuid, uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.camera_group_rule_members(uuid, uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.group_member_counts(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2-5c-1 fixes self-test: function privileges are not as intended';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
