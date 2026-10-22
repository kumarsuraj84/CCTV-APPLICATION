-- P2-5c-1: what the administration screens need from the database (.superpowers/sdd/drishti/p2-5c-brief.md "P2-5c-1"; review notes
-- N-1/N-2 and correction (a) of .superpowers/sdd/drishti/p2-5b-rereview.md). New forward migration; 0019..0025 are not edited.
-- Apply through `npx supabase migration up` (one transaction per file); no BEGIN/COMMIT of its own on purpose (like 0019..0025).
--
-- 1. discovery_findings: what the last camera discovery of each NVR could not place (possible_move, missing, channel_taken, unplaced),
--    kept for the reconciliation list until a person links, merges or dismisses it, or the next discovery of that NVR replaces it.
--    Server only (the screens read it with the service role after the administrator check). Notes only: no foreign keys into the
--    inventory (a purge of a test organisation must not trip over them); discovery_apply checks every camera id it writes.
-- 2. discovery_apply gains p_findings and saves them in the same transaction as the discovery itself (all or nothing, review M-8).
-- 3. camera_merge(org, keep, duplicate, actor): a camera physically moved to another NVR got a second identity there (P2-5b ruling I-2);
--    the merge keeps the OLD camera (its id, grants, group memberships and history), moves it onto the duplicate's NVR channel (also at
--    another location) and archives the duplicate (its own history kept). A plain remap cannot do this: the duplicate holds the channel.
-- 4. Camera groups with dynamic rules (ruling C-1, Release 1 item 3): camera_group_rules (region / cluster / location / recorder / name,
--    with an optional "name contains" filter on a place rule), resolved at read time by camera_group_rule_members (internal) and, for
--    signed-in people, by group_rule_members(), which returns only members of groups they may see AND cameras they may see: a dynamic
--    group never widens access. cctv_visible_group_ids() counts dynamic members too (an empty group — no items and no rule members — is
--    still visible to its maker and to admin.inventory only).

-- ═══ 1. discovery_findings ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.discovery_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  recorder_id uuid NOT NULL,
  location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('possible_move', 'missing', 'channel_taken', 'unplaced')),
  channel integer CHECK (channel IS NULL OR channel > 0),
  camera_id uuid NOT NULL,
  other_camera_id uuid,
  reported_name text CHECK (reported_name IS NULL OR length(reported_name) <= 200),
  because text CHECK (because IS NULL OR because IN ('same_address', 'same_name', 'unmapped_same_channel')),
  found_at timestamptz NOT NULL DEFAULT now(),
  found_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution text CHECK (resolution IS NULL OR resolution IN ('superseded', 'linked', 'merged', 'dismissed', 'archived')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT discovery_findings_resolved CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
COMMENT ON TABLE public.discovery_findings IS
  'P2-5c-1: what camera discovery of an NVR could not place, for the reconciliation list. Replaced (resolution superseded) by the next discovery of the same NVR. Server only.';
CREATE INDEX discovery_findings_open_idx ON public.discovery_findings (org_id, found_at) WHERE resolved_at IS NULL;
CREATE INDEX discovery_findings_recorder_idx ON public.discovery_findings (recorder_id) WHERE resolved_at IS NULL;
CREATE INDEX discovery_findings_camera_idx ON public.discovery_findings (camera_id);
ALTER TABLE public.discovery_findings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.discovery_findings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.discovery_findings TO service_role;

-- ═══ 2. discovery_apply with its findings (one transaction) ═════════════════════════════════════════════════════════════════
-- p_ops as in 0025. p_findings: [{kind, channel, camera_id, other_camera_id?, reported_name?, because?}] for the reconciliation list;
-- every camera named must be a camera of this recorder's location in this organisation (else the whole call is refused, 22023).
-- The open findings of this recorder from an earlier discovery are closed as 'superseded' first.
DROP FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid);
CREATE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL, p_findings jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_loc uuid;
  o jsonb;
  f jsonb;
  v_op text;
  v_cam uuid;
  v_other uuid;
  v_n integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_mapped integer := 0;
  v_moved integer := 0;
  v_found integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT r.location_id INTO v_loc FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_ops must be an array' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(coalesce(p_findings, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_findings must be an array' USING ERRCODE = '22023'; END IF;
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
  -- The reconciliation list: this discovery's findings replace the open ones of the same NVR.
  UPDATE public.discovery_findings SET resolved_at = now(), resolved_by = p_actor, resolution = 'superseded'
  WHERE org_id = p_org AND recorder_id = p_recorder AND resolved_at IS NULL;
  FOR f IN SELECT * FROM jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) LOOP
    v_cam := (f ->> 'camera_id')::uuid;
    v_other := NULLIF(f ->> 'other_camera_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_cam AND c.org_id = p_org AND c.location_id = v_loc)
       OR (v_other IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cameras c WHERE c.id = v_other AND c.org_id = p_org AND c.location_id = v_loc)) THEN
      RAISE EXCEPTION 'a finding names a camera of another location' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.discovery_findings (org_id, recorder_id, location_id, kind, channel, camera_id, other_camera_id, reported_name, because, found_by)
    VALUES (p_org, p_recorder, v_loc, f ->> 'kind', NULLIF(f ->> 'channel', '')::integer, v_cam, v_other, left(f ->> 'reported_name', 200), f ->> 'because', p_actor);
    v_found := v_found + 1;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'cameras_discovered', 'store', v_loc, jsonb_build_object(
    'capability', 'admin.inventory', 'locationIds', jsonb_build_array(v_loc), 'count', 1, 'recorder_id', p_recorder,
    'created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'to_reconcile', coalesce(p_to_reconcile, 0), 'findings', v_found));
  RETURN jsonb_build_object('created', v_created, 'updated', v_updated, 'mapped', v_mapped, 'moved', v_moved, 'findings', v_found);
END
$$;
COMMENT ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb) IS
  'P2-5b review M-8 / P2-5c-1: everything one camera discovery of one NVR saves, its findings for the reconciliation list and its audit row, in one transaction. Server only.';
REVOKE ALL ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb) TO service_role;

-- ═══ 3. camera_merge ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Keeps p_keep (the camera people already have: its id, grants, group memberships, monitoring history) and archives p_duplicate (the
-- second identity discovery made on the NVR the camera was moved to). p_keep takes over the duplicate's active NVR channel (and its
-- location when that differs); the duplicate's group memberships are added to p_keep; findings about either camera are closed as
-- 'merged'. Camera grants on the duplicate are NOT moved (giving access is the access editor's job): they are counted in the answer
-- and end with the archived duplicate. Access versions: holders of the duplicate (archive), of the old and new NVR (remap) and of the
-- kept camera (its route changed) go up — the P2-4 revalidation signal. Audited as camera_merged. Server only.
CREATE FUNCTION public.camera_merge(p_org uuid, p_keep uuid, p_duplicate uuid, p_actor uuid DEFAULT NULL) RETURNS jsonb
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
COMMENT ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid) IS
  'P2-5c-1: merge a duplicate camera identity into the camera to keep (id, grants, groups, history kept; duplicate archived). Server only.';
REVOKE ALL ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid) TO service_role;

-- ═══ 4. Dynamic camera-group rules ══════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.camera_group_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  group_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('region', 'cluster', 'location', 'recorder', 'name')),
  ref_id uuid,
  name_contains text CHECK (name_contains IS NULL OR length(btrim(name_contains)) BETWEEN 1 AND 100),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camera_group_rules_ref CHECK ((kind = 'name') = (ref_id IS NULL)),
  CONSTRAINT camera_group_rules_name CHECK (kind <> 'name' OR name_contains IS NOT NULL),
  FOREIGN KEY (group_id, org_id) REFERENCES public.camera_groups (id, org_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.camera_group_rules IS
  'P2-5c-1: dynamic members of a camera group (all cameras of a region / cluster / location / NVR, or by name; a place rule may also filter by name). Resolved at read time and intersected with what the reader may see. Server only.';
CREATE UNIQUE INDEX camera_group_rules_key ON public.camera_group_rules
  (group_id, kind, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(coalesce(name_contains, '')));
CREATE INDEX camera_group_rules_org_idx ON public.camera_group_rules (org_id);
ALTER TABLE public.camera_group_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.camera_group_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.camera_group_rules TO service_role;

-- The place a rule names must be a node of the same organisation (a polymorphic reference cannot have a foreign key).
CREATE FUNCTION public.camera_group_rules_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ok boolean := false;
BEGIN
  IF NEW.kind = 'name' THEN
    v_ok := true;
  ELSIF NEW.kind = 'region' THEN
    v_ok := EXISTS (SELECT 1 FROM public.regions x WHERE x.id = NEW.ref_id AND x.org_id = NEW.org_id);
  ELSIF NEW.kind = 'cluster' THEN
    v_ok := EXISTS (SELECT 1 FROM public.clusters x WHERE x.id = NEW.ref_id AND x.org_id = NEW.org_id);
  ELSIF NEW.kind = 'location' THEN
    v_ok := EXISTS (SELECT 1 FROM public.locations x WHERE x.id = NEW.ref_id AND x.org_id = NEW.org_id);
  ELSIF NEW.kind = 'recorder' THEN
    v_ok := EXISTS (SELECT 1 FROM public.recorders x WHERE x.id = NEW.ref_id AND x.org_id = NEW.org_id);
  END IF;
  IF NOT v_ok THEN RAISE EXCEPTION 'the rule names a place outside this organisation' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.camera_group_rules_check() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER camera_group_rules_check BEFORE INSERT OR UPDATE ON public.camera_group_rules FOR EACH ROW EXECUTE FUNCTION public.camera_group_rules_check();

-- Every camera a rule of these groups (all groups of the organisation when NULL) matches now, regardless of who asks. Internal: the
-- functions below intersect it with the caller's own access. Archived cameras, archived locations and archived clusters / regions
-- match nothing; a camera matches a recorder rule through its ACTIVE mapping only.
CREATE FUNCTION public.camera_group_rule_members(p_org uuid, p_groups uuid[] DEFAULT NULL) RETURNS TABLE (group_id uuid, camera_id uuid)
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
REVOKE ALL ON FUNCTION public.camera_group_rule_members(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- A group is visible when the reader may see at least one of its members (static or dynamic); an empty group (no items and no rule
-- members) only to its maker and to admin.inventory. Unchanged otherwise (20261021000009).
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

-- For signed-in people: the dynamic members of the groups they may see (one group, or all), only the cameras they may see.
CREATE FUNCTION public.group_rule_members(p_group uuid DEFAULT NULL) RETURNS TABLE (group_id uuid, camera_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH mine AS MATERIALIZED (SELECT x AS id FROM public.any_cctv_camera_ids() AS x),
       vis AS MATERIALIZED (SELECT x AS id FROM public.cctv_visible_group_ids() AS x)
  SELECT m.group_id, m.camera_id
  FROM public.camera_group_rule_members((SELECT public.current_org_id()), CASE WHEN p_group IS NULL THEN NULL ELSE ARRAY[p_group] END) AS m
  JOIN mine ON mine.id = m.camera_id
  JOIN vis ON vis.id = m.group_id
$$;
COMMENT ON FUNCTION public.group_rule_members(uuid) IS
  'P2-5c-1: dynamic camera-group members for the caller: groups they may see, cameras they may see (never wider than their own access).';
REVOKE ALL ON FUNCTION public.group_rule_members(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.group_rule_members(uuid) TO authenticated;

-- ═══ Self-test ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'P2-5c-1 self-test: privilege_violations() is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stale_name_scan()) THEN RAISE EXCEPTION 'P2-5c-1 self-test: a function names a removed legacy column'; END IF;
  IF has_function_privilege('authenticated', 'public.camera_merge(uuid, uuid, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.camera_group_rule_members(uuid, uuid[])', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.discovery_findings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.camera_group_rules', 'SELECT') THEN
    RAISE EXCEPTION 'P2-5c-1 self-test: a server-only object is reachable by signed-in people';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
