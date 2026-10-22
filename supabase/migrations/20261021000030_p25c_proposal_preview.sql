-- P2-5c-1 fix round 2 (Part A of .superpowers/sdd/drishti/p2-5c-2-review.md, M-1 "partly fixed"): the effect of ticked zone → cluster
-- proposals on access, in ONE database call for any number of rows (the screen made one call per location and per region holder),
-- exact for a new cluster in an existing region (the screen counted that region's holders as gaining every camera), and with ended,
-- future and revoked grants counting for nothing (the screen's holder query ignored valid_until).
--
-- preview_hierarchy_proposals(p_org, p_items): p_items is a JSON array of {location_id, cluster_id, region_id}:
--   cluster_id  an existing cluster the location would join, or null for a cluster that would be created;
--   region_id   for a cluster that would be created: the existing region it would be created in (or null). Ignored when cluster_id is
--               given (an existing cluster keeps its own region).
-- Returns {people: [{user_id, capability, before, after}], affected_count, locations}, summed over all rows per person and CCTV right,
-- with the same rule as preview_hierarchy_change (P2-5a): before = the cameras of those locations the person sees now; after = those
-- they would see through an organisation, location, new cluster, new region, NVR or camera grant. Writes nothing. Server only.
--
-- Rollback: supabase/rollback/20261021000030_p25c_proposal_preview_rollback.sql (drops the function; no data).

CREATE FUNCTION public.preview_hierarchy_proposals(p_org uuid, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rows jsonb;
  v_locs uuid[];
  v_person record;
  v_g record;
  v_now uuid[];
  v_before integer;
  v_after integer;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' OR jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'nothing to preview' USING ERRCODE = '22023';
  END IF;
  -- One row per location: where it is now and where it would be.
  WITH items AS (
    SELECT (e ->> 'location_id')::uuid AS location_id, nullif(e ->> 'cluster_id', '')::uuid AS cluster_id, nullif(e ->> 'region_id', '')::uuid AS region_id
    FROM jsonb_array_elements(p_items) AS e
  ), t AS (
    SELECT i.location_id,
           oc.id AS old_cluster,
           orr.id AS old_region,
           nc.id AS new_cluster,
           CASE WHEN i.cluster_id IS NOT NULL THEN nr.id ELSE hr.id END AS new_region
    FROM items i
    JOIN public.locations l ON l.id = i.location_id AND l.org_id = p_org AND l.archived_at IS NULL
    LEFT JOIN public.clusters oc ON oc.id = l.cluster_id AND oc.archived_at IS NULL
    LEFT JOIN public.regions orr ON orr.id = oc.region_id AND orr.archived_at IS NULL
    LEFT JOIN public.clusters nc ON nc.id = i.cluster_id AND nc.org_id = p_org AND nc.archived_at IS NULL
    LEFT JOIN public.regions nr ON nr.id = nc.region_id AND nr.archived_at IS NULL
    LEFT JOIN public.regions hr ON hr.id = i.region_id AND hr.org_id = p_org AND hr.archived_at IS NULL
  )
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb), coalesce(array_agg(t.location_id), '{}') INTO v_rows, v_locs FROM t;
  IF cardinality(v_locs) <> (SELECT count(DISTINCT (e ->> 'location_id')) FROM jsonb_array_elements(p_items) AS e)
     OR cardinality(v_locs) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS e WHERE nullif(e ->> 'cluster_id', '') IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.id = (e ->> 'cluster_id')::uuid AND c.org_id = p_org AND c.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_person IN
    SELECT DISTINCT g.user_id, g.capability FROM public.access_grants g JOIN public.capabilities c ON c.key = g.capability AND c.area = 'cctv'
    WHERE g.org_id = p_org AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
      AND ((g.scope_kind = 'cluster' AND g.scope_id IN (SELECT (r ->> 'old_cluster')::uuid FROM jsonb_array_elements(v_rows) r
                                                         UNION SELECT (r ->> 'new_cluster')::uuid FROM jsonb_array_elements(v_rows) r))
        OR (g.scope_kind = 'region' AND g.scope_id IN (SELECT (r ->> 'old_region')::uuid FROM jsonb_array_elements(v_rows) r
                                                        UNION SELECT (r ->> 'new_region')::uuid FROM jsonb_array_elements(v_rows) r)))
    ORDER BY 1, 2
  LOOP
    v_now := ARRAY(SELECT x FROM public.access_cameras_for(v_person.user_id, ARRAY[v_person.capability], now(), true, true) AS x);
    SELECT count(*) INTO v_before FROM public.cameras c WHERE c.location_id = ANY (v_locs) AND c.id = ANY (v_now);
    SELECT bool_or(g.scope_kind = 'organization') AS org_wide,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'location'), '{}') AS locs,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'cluster'), '{}') AS clusters,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'region'), '{}') AS regions,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'recorder'), '{}') AS recs,
           coalesce(array_agg(g.scope_id) FILTER (WHERE g.scope_kind = 'camera'), '{}') AS cams
    INTO v_g FROM public.access_grants_of(v_person.user_id, now(), true, true) g WHERE g.capability = v_person.capability;
    SELECT count(*) INTO v_after FROM public.cameras c
    JOIN jsonb_array_elements(v_rows) r ON (r ->> 'location_id')::uuid = c.location_id
    JOIN public.locations l ON l.id = c.location_id AND l.archived_at IS NULL
    LEFT JOIN public.assets ra ON ra.id = c.recorder_id AND ra.archived_at IS NULL
    WHERE c.archived_at IS NULL
      AND (coalesce(v_g.org_wide, false) OR l.id = ANY (v_g.locs)
           OR ((r ->> 'new_cluster') IS NOT NULL AND (r ->> 'new_cluster')::uuid = ANY (v_g.clusters))
           OR ((r ->> 'new_region') IS NOT NULL AND (r ->> 'new_region')::uuid = ANY (v_g.regions))
           OR c.id = ANY (v_g.cams) OR ra.id = ANY (v_g.recs));
    v_out := v_out || jsonb_build_array(jsonb_build_object('user_id', v_person.user_id, 'capability', v_person.capability, 'before', v_before, 'after', v_after));
  END LOOP;
  RETURN jsonb_build_object('people', v_out, 'affected_count', (SELECT count(DISTINCT e.value ->> 'user_id') FROM jsonb_array_elements(v_out) AS e),
                            'locations', cardinality(v_locs));
END
$$;
COMMENT ON FUNCTION public.preview_hierarchy_proposals(uuid, jsonb) IS
  'P2-5c-1 fix round 2 (M-1): the effect on CCTV access of ticked zone → cluster proposals, all rows in one call. Writes nothing. Server only.';
REVOKE ALL ON FUNCTION public.preview_hierarchy_proposals(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_hierarchy_proposals(uuid, jsonb) TO service_role;

-- ═══ Self-test ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5c-1 fix round 2 self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-5c-1 fix round 2 self-test: a function names a removed legacy column'; END IF;
  IF has_function_privilege('authenticated', 'public.preview_hierarchy_proposals(uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_hierarchy_proposals(uuid, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.preview_hierarchy_proposals(uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2-5c-1 fix round 2 self-test: function privileges are not as intended';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
