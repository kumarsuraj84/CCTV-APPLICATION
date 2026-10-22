-- P2-3 review fix round 1 (docs/drishti/access-model.md):
--   I-1  every organisation keeps at least one active super administrator (platform_owner): a trigger on profiles refuses
--        deactivating, demoting or deleting the last one (SQLSTATE DR001), serialised per organisation.
--   I-2  change_person_role: a role change and the revocation of the rights the new role may not keep happen in one transaction
--        (expected_version honoured): leaving admin/platform_owner revokes admin.*; leaving platform_owner revokes the owner-only rights.
--        set_person_active: activation changes through the database, so the automatic full-rights grant knows who acted.
--   M-2  granting joins a new window only with live grants that are in effect now or overlap / touch it; an expired grant is history
--        and stays as it is. Several live grants of the same right and scope may exist (no overlapping windows: exclusion constraint).
--   M-3  automatic full-rights grants are audited (source platform_owner_auto, with the acting person when known).
--   M-8  new reason text 'Super administrator: all capabilities' (old rows keep theirs; history is immutable).
--   M-9  wifi.credentials.admin is owner-only like it.credentials.admin.
--   M-10 confirming a review needs the right to give that grant; M-11 the only super administrator may self-confirm with a reason.
--   M-12 the target's role is read after locking the person.
--   M-13 a capability that gains organisation scope is granted to super administrators too; the probe also covers it.
--   T-1  catalogue wording after decision D-L1 (fast playback is a playback right; export is about files).
--   Test support: access_teardown_test_org_people removes the people of a test or demo organisation (the last-super-admin rule
--        would otherwise stop the test clean-up); it refuses every other organisation.
-- Rollback: supabase/rollback/20261021000017_access_admin_fixes_rollback.sql
BEGIN;
SET LOCAL search_path = public, extensions;

-- ── T-1: catalogue wording (catalogue rows are reference data, not history) ───────────────
UPDATE public.capabilities SET description = 'Export or download recordings as files' WHERE key = 'cctv.export';
UPDATE public.capabilities SET description = 'Search recordings and play them back (calendar, timeline, player, fast playback)' WHERE key = 'cctv.playback';

-- ── M-2: several live grants per right and scope, never overlapping ──────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_live_no_overlap EXCLUDE USING gist (
  user_id WITH =, capability WITH =, scope_kind WITH =, (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  (tstzrange(valid_from, valid_until)) WITH &&
) WHERE (revoked_at IS NULL);
DROP INDEX public.access_grants_active_key;
CREATE INDEX access_grants_live_idx ON public.access_grants (user_id, capability) WHERE revoked_at IS NULL;

-- Which of the live grants of one right and scope a new window [p_from, p_until) is joined with, and the joined window.
-- p_rows: [{valid_from, valid_until}] (positions 1..n). A grant is joined when it is in effect at p_now or overlaps / touches the
-- growing window. covered: the position of a joined grant that already covers the new window (then nothing changes).
CREATE OR REPLACE FUNCTION public.access_merge_plan(p_rows jsonb, p_from timestamptz, p_until timestamptz, p_now timestamptz,
  OUT covered integer, OUT take integer[], OUT hull_from timestamptz, OUT hull_until timestamptz)
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  f timestamptz[];
  u timestamptz[];
  n integer;
  i integer;
  prev integer := -1;
  inf timestamptz := 'infinity'::timestamptz;
BEGIN
  SELECT coalesce(array_agg((e.value ->> 'valid_from')::timestamptz ORDER BY e.ordinality), '{}'),
         coalesce(array_agg(NULLIF(e.value ->> 'valid_until', '')::timestamptz ORDER BY e.ordinality), '{}')
  INTO f, u FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e;
  n := coalesce(array_length(f, 1), 0);
  FOR i IN 1..n LOOP
    IF ((f[i] <= p_now AND (u[i] IS NULL OR u[i] > p_now)) OR (f[i] <= coalesce(p_until, inf) AND p_from <= coalesce(u[i], inf)))
       AND (public.access_merge_window(f[i], u[i], p_from, p_until)).covered THEN
      covered := i;
      RETURN;
    END IF;
  END LOOP;
  hull_from := p_from;
  hull_until := p_until;
  take := '{}';
  LOOP
    take := '{}';
    FOR i IN 1..n LOOP
      IF (f[i] <= p_now AND (u[i] IS NULL OR u[i] > p_now)) OR (f[i] <= coalesce(hull_until, inf) AND hull_from <= coalesce(u[i], inf)) THEN
        take := take || i;
      END IF;
    END LOOP;
    EXIT WHEN cardinality(take) = prev;
    prev := cardinality(take);
    FOREACH i IN ARRAY take LOOP
      hull_from := least(hull_from, f[i]);
      hull_until := CASE WHEN hull_until IS NULL OR u[i] IS NULL THEN NULL ELSE greatest(hull_until, u[i]) END;
    END LOOP;
  END LOOP;
END
$$;

-- ── I-1 / M-12: rules about the acting person ────────────────────────────────────────────
-- Locks the person, then reads their role (M-12), so a concurrent role change cannot slip between the check and the write.
CREATE OR REPLACE FUNCTION public.access_check_manager(p_org uuid, p_actor uuid, p_user uuid) RETURNS public.user_role
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
BEGIN
  SELECT p.role INTO v_role FROM public.profiles p
  WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner') THEN
    RAISE EXCEPTION 'the acting person is not an administrator with admin.access' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                 WHERE g.org_id = p_org AND g.capability = 'admin.access' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person is not an administrator with admin.access' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN
    RAISE EXCEPTION 'nobody changes their own access' USING ERRCODE = '42501';
  END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org FOR UPDATE;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'admin' AND v_target NOT IN ('user', 'operator', 'manager') THEN
    RAISE EXCEPTION 'the acting person may not manage this person' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END
$$;

-- Rules 4-7, with wifi.credentials.admin owner-only (M-9).
CREATE OR REPLACE FUNCTION public.access_check_grantor(p_org uuid, p_actor uuid, p_user uuid, p_spec jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_until timestamptz := NULLIF(p_spec ->> 'valid_until', '')::timestamptz;
  v_role public.user_role;
  v_target public.user_role;
  v_c public.capabilities%ROWTYPE;
  v_parent uuid;
BEGIN
  v_role := public.access_check_manager(p_org, p_actor, p_user);
  SELECT * INTO v_c FROM public.capabilities c WHERE c.key = v_cap;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF (v_c.risk = 'high' OR v_c.key = 'cctv.export') AND length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'reason required for %', v_cap USING ERRCODE = '22023';
  END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_c.area = 'admin' AND v_target NOT IN ('admin', 'platform_owner') THEN
    RAISE EXCEPTION 'administration rights only for administrators' USING ERRCODE = '42501';
  END IF;
  -- Owner ruling E-1: downloads (cctv.export) only for administrators and super administrators.
  IF v_cap = 'cctv.export' AND v_target NOT IN ('admin', 'platform_owner') THEN
    RAISE EXCEPTION 'download rights only for administrators' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'platform_owner' THEN RETURN; END IF;
  IF v_cap = ANY (public.access_owner_only()) THEN
    RAISE EXCEPTION 'only a platform owner may give %', v_cap USING ERRCODE = '42501';
  END IF;
  v_parent := CASE v_kind
    WHEN 'camera' THEN (SELECT c.store_id FROM public.cameras c WHERE c.id = v_scope AND c.org_id = p_org)
    WHEN 'asset' THEN (SELECT d.store_id FROM public.devices d WHERE d.id = v_scope AND d.org_id = p_org)
    ELSE NULL END;
  IF NOT EXISTS (
    SELECT 1 FROM public.access_grants g
    WHERE g.user_id = p_actor AND g.org_id = p_org AND g.capability = v_cap AND g.revoked_at IS NULL
      AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
      AND (g.valid_until IS NULL OR (v_until IS NOT NULL AND g.valid_until >= v_until))
      AND (g.scope_kind = 'organization'
           OR (g.scope_kind = v_kind AND g.scope_id = v_scope)
           OR (g.scope_kind = 'location' AND v_kind IN ('camera', 'asset') AND v_parent IS NOT NULL AND g.scope_id = v_parent))
  ) THEN
    RAISE EXCEPTION '% at this scope or for this long is not held by the acting person', v_cap USING ERRCODE = '42501';
  END IF;
END
$$;

-- The rights only a super administrator gives (and, on demotion to administrator, the rights an administrator does not keep).
CREATE OR REPLACE FUNCTION public.access_owner_only() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['it.os.deploy', 'it.credentials.admin', 'it.remote.control', 'it.script.run', 'it.software.manage', 'it.config.deploy',
               'it.patch.manage', 'wifi.credentials.admin']
$$;

-- ── M-2: granting with the new joining rule ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.access_put_grant(
  p_org uuid, p_user uuid, p_spec jsonb, p_actor uuid, p_reason text, p_source text, p_needs_review boolean,
  OUT grant_id uuid, OUT added boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text := p_spec ->> 'capability';
  v_kind text := p_spec ->> 'scope_kind';
  v_scope uuid := NULLIF(p_spec ->> 'scope_id', '')::uuid;
  v_from timestamptz := coalesce(NULLIF(p_spec ->> 'valid_from', '')::timestamptz, now());
  v_until timestamptz := NULLIF(p_spec ->> 'valid_until', '')::timestamptz;
  v_rows jsonb;
  v_plan record;
BEGIN
  PERFORM public.access_check_spec(p_org, p_spec);
  IF p_actor IS NOT NULL THEN PERFORM public.access_check_grantor(p_org, p_actor, p_user, p_spec, p_reason); END IF;
  PERFORM 1 FROM public.access_grants g
  WHERE g.user_id = p_user AND g.capability = v_cap AND g.scope_kind = v_kind AND g.scope_id IS NOT DISTINCT FROM v_scope AND g.revoked_at IS NULL
  FOR UPDATE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'valid_from', g.valid_from, 'valid_until', g.valid_until) ORDER BY g.valid_from, g.id), '[]'::jsonb)
  INTO v_rows FROM public.access_grants g
  WHERE g.user_id = p_user AND g.capability = v_cap AND g.scope_kind = v_kind AND g.scope_id IS NOT DISTINCT FROM v_scope AND g.revoked_at IS NULL;
  SELECT * INTO v_plan FROM public.access_merge_plan(v_rows, v_from, v_until, now());
  IF v_plan.covered IS NOT NULL THEN
    grant_id := (v_rows -> (v_plan.covered - 1) ->> 'id')::uuid;
    added := false;
    RETURN;
  END IF;
  IF cardinality(v_plan.take) > 0 THEN
    UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = 'Replaced by a wider grant (the two date ranges joined).'
    WHERE id IN (SELECT (v_rows -> (i - 1) ->> 'id')::uuid FROM unnest(v_plan.take) AS i);
    v_from := v_plan.hull_from;
    v_until := v_plan.hull_until;
  END IF;
  INSERT INTO public.access_grants (org_id, user_id, capability, scope_kind, scope_id, valid_from, valid_until, granted_by, reason, source, needs_review)
  VALUES (p_org, p_user, v_cap, v_kind, v_scope, v_from, v_until, p_actor, p_reason, p_source, p_needs_review)
  RETURNING id INTO grant_id;
  added := true;
END
$$;

-- The preview with the same joining rule.
CREATE OR REPLACE FUNCTION public.preview_access_change(p_org uuid, p_user uuid, p_changes jsonb, p_at timestamptz DEFAULT now(), p_sample integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_active boolean;
  v_before jsonb;
  v_after jsonb;
  v_same jsonb;
  v_other jsonb;
  v_change jsonb;
  v_grant uuid;
  v_from timestamptz;
  v_until timestamptz;
  v_plan record;
  v_cap text;
  v_out jsonb := '{}'::jsonb;
  v_sample integer := least(greatest(coalesce(p_sample, 10), 0), 100);
BEGIN
  SELECT p.access_version, (p.is_active AND NOT p.must_reset_password) INTO v_version, v_active
  FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'changes must be a list' USING ERRCODE = '22023'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'capability', g.capability, 'scope_kind', g.scope_kind, 'scope_id', g.scope_id,
                                               'valid_from', g.valid_from, 'valid_until', g.valid_until)), '[]'::jsonb)
  INTO v_before
  FROM public.access_grants g WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL;
  v_after := v_before;

  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e WHERE e.value ->> 'op' = 'revoke' LOOP
    v_grant := NULLIF(v_change ->> 'grant_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = v_grant AND g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
    END IF;
    SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_after FROM jsonb_array_elements(v_after) AS e
    WHERE e.value ->> 'id' IS NULL OR (e.value ->> 'id')::uuid <> v_grant;
  END LOOP;

  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e LOOP
    IF v_change ->> 'op' = 'revoke' THEN CONTINUE; END IF;
    IF v_change ->> 'op' IS DISTINCT FROM 'grant' THEN RAISE EXCEPTION 'unknown change' USING ERRCODE = '22023'; END IF;
    PERFORM public.access_check_spec(p_org, v_change - 'op');
    v_from := coalesce(NULLIF(v_change ->> 'valid_from', '')::timestamptz, now());
    v_until := NULLIF(v_change ->> 'valid_until', '')::timestamptz;
    SELECT coalesce(jsonb_agg(e.value ORDER BY (e.value ->> 'valid_from')::timestamptz), '[]'::jsonb) INTO v_same FROM jsonb_array_elements(v_after) AS e
    WHERE e.value ->> 'capability' = v_change ->> 'capability' AND e.value ->> 'scope_kind' = v_change ->> 'scope_kind'
      AND NULLIF(e.value ->> 'scope_id', '')::uuid IS NOT DISTINCT FROM NULLIF(v_change ->> 'scope_id', '')::uuid;
    SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_other FROM jsonb_array_elements(v_after) AS e
    WHERE NOT (e.value ->> 'capability' = v_change ->> 'capability' AND e.value ->> 'scope_kind' = v_change ->> 'scope_kind'
      AND NULLIF(e.value ->> 'scope_id', '')::uuid IS NOT DISTINCT FROM NULLIF(v_change ->> 'scope_id', '')::uuid);
    SELECT * INTO v_plan FROM public.access_merge_plan(v_same, v_from, v_until, now());
    IF v_plan.covered IS NOT NULL THEN CONTINUE; END IF;
    SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_same FROM jsonb_array_elements(v_same) WITH ORDINALITY AS e
    WHERE NOT (e.ordinality::integer = ANY (v_plan.take));
    v_after := v_other || v_same || jsonb_build_array((v_change - 'op' - 'reason') || jsonb_build_object(
      'valid_from', CASE WHEN cardinality(v_plan.take) > 0 THEN v_plan.hull_from ELSE v_from END,
      'valid_until', CASE WHEN cardinality(v_plan.take) > 0 THEN v_plan.hull_until ELSE v_until END));
  END LOOP;

  FOR v_cap IN
    SELECT DISTINCT e.value ->> 'capability' FROM jsonb_array_elements(v_before || v_after) AS e ORDER BY 1
  LOOP
    WITH b AS (SELECT * FROM public.access_items(p_org, v_cap, v_before, now())),
         a AS (SELECT * FROM public.access_items(p_org, v_cap, v_after, p_at)),
         added AS (SELECT a.item_id, a.label FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.item_id = a.item_id)),
         removed AS (SELECT b.item_id, b.label FROM b WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.item_id = b.item_id))
    SELECT v_out || jsonb_build_object(v_cap, jsonb_build_object(
      'target', (SELECT CASE c.area WHEN 'cctv' THEN 'camera' WHEN 'it' THEN 'asset' WHEN 'wifi' THEN 'location' ELSE 'organization' END
                 FROM public.capabilities c WHERE c.key = v_cap),
      'added_count', (SELECT count(*) FROM added),
      'removed_count', (SELECT count(*) FROM removed),
      'sample_added', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.item_id, 'label', s.label) ORDER BY s.label, s.item_id)
                                FROM (SELECT * FROM added ORDER BY label, item_id LIMIT v_sample) s), '[]'::jsonb),
      'sample_removed', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.item_id, 'label', s.label) ORDER BY s.label, s.item_id)
                                  FROM (SELECT * FROM removed ORDER BY label, item_id LIMIT v_sample) s), '[]'::jsonb)
    ))
    INTO v_out;
  END LOOP;
  RETURN jsonb_build_object('version', v_version, 'at', p_at, 'person_active', v_active, 'capabilities', v_out);
END
$$;

-- ── I-1: at least one active super administrator per organisation ────────────────────────
-- Serialised with a lock on the organisation row (one order for everybody, so two administrators acting on each other at the same
-- time cannot both pass: the second waits, then sees the first one's change). The organisation being deleted, and the test/demo
-- clean-up (access_teardown_test_org_people), are the only exceptions.
CREATE OR REPLACE FUNCTION public.profiles_keep_super_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (OLD.role = 'platform_owner' AND OLD.is_active) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'platform_owner' AND NEW.is_active THEN RETURN NEW; END IF;
  IF current_setting('drishti.teardown_org', true) = OLD.org_id::text THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  PERFORM 1 FROM public.organizations o WHERE o.id = OLD.org_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF; -- the organisation is being deleted
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.org_id = OLD.org_id AND p.id <> OLD.id AND p.role = 'platform_owner' AND p.is_active) THEN
    RAISE EXCEPTION 'the last active super administrator of an organisation cannot be deactivated, demoted or deleted' USING ERRCODE = 'DR001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER profiles_keep_super_admin BEFORE UPDATE OF role, is_active OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_keep_super_admin();

-- TEST AND DEMO CLEAN-UP ONLY: deletes the people of an organisation made by the test suite (slug "test-…") or the local demo
-- (slug "demo-sample-data"), the last super administrator included. Refuses every other organisation.
CREATE OR REPLACE FUNCTION public.access_teardown_test_org_people(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND (o.slug LIKE 'test-%' OR o.slug = 'demo-sample-data')) THEN
    RAISE EXCEPTION 'only test and demo organisations can be torn down' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('drishti.teardown_org', p_org::text, true);
  DELETE FROM public.profiles WHERE org_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('drishti.teardown_org', '', true);
  RETURN v_n;
END
$$;
COMMENT ON FUNCTION public.access_teardown_test_org_people(uuid) IS 'TEST/DEMO CLEAN-UP ONLY: organisations whose slug starts with "test-" or is "demo-sample-data".';

-- ── I-2: role and status changes through the database ────────────────────────────────────
-- The acting person may change people (admin.users, administrative role, not themselves) and give the new role (canManageRole).
CREATE OR REPLACE FUNCTION public.access_check_people_admin(p_org uuid, p_actor uuid, p_user uuid, p_new_role public.user_role) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role public.user_role;
  v_target public.user_role;
  manages boolean;
BEGIN
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active AND NOT p.must_reset_password;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'platform_owner')
     OR NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g
                    WHERE g.org_id = p_org AND g.capability = 'admin.users' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'the acting person may not change people (admin.users)' USING ERRCODE = '42501';
  END IF;
  IF p_actor = p_user THEN RAISE EXCEPTION 'nobody changes their own role or status' USING ERRCODE = '42501'; END IF;
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org FOR UPDATE;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  manages := v_role = 'platform_owner' OR (v_target IN ('user', 'operator', 'manager') AND (p_new_role IS NULL OR p_new_role IN ('user', 'operator', 'manager')));
  IF NOT manages THEN RAISE EXCEPTION 'the acting person may not manage this person or give that role' USING ERRCODE = '42501'; END IF;
END
$$;

-- Changes a person's role and, in the same transaction, revokes what the new role may not keep:
-- leaving admin / platform_owner: every admin.* grant ('Role changed: administration rights removed');
-- leaving platform_owner: the owner-only rights ('Role changed: rights only a super administrator may hold were removed').
-- Returns {old_role, new_role, version, revoked: [{id, capability, scope_kind, scope_id, valid_until, reason}]}.
CREATE OR REPLACE FUNCTION public.change_person_role(p_org uuid, p_actor uuid, p_user uuid, p_role public.user_role, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old public.user_role;
  v_version bigint;
  v_revoked jsonb := '[]'::jsonb;
  v_part jsonb;
BEGIN
  PERFORM public.access_check_people_admin(p_org, p_actor, p_user, p_role);
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  SELECT p.role INTO v_old FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_old = p_role THEN
    RETURN jsonb_build_object('old_role', v_old, 'new_role', p_role, 'version', v_version, 'revoked', v_revoked);
  END IF;
  PERFORM set_config('drishti.actor', p_actor::text, true);
  UPDATE public.profiles SET role = p_role WHERE id = p_user AND org_id = p_org;
  IF v_old IN ('admin', 'platform_owner') AND p_role NOT IN ('admin', 'platform_owner') THEN
    WITH r AS (
      UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor,
        revoke_reason = CASE WHEN g.capability = 'cctv.export' THEN 'Role changed: download rights removed' ELSE 'Role changed: administration rights removed' END
      WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL AND (g.capability LIKE 'admin.%' OR g.capability = 'cctv.export')
      RETURNING g.id, g.capability, g.scope_kind, g.scope_id, g.valid_until, g.revoke_reason
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'capability', r.capability, 'scope_kind', r.scope_kind, 'scope_id', r.scope_id,
                                                  'valid_until', r.valid_until, 'reason', r.revoke_reason)), '[]'::jsonb) INTO v_part FROM r;
    v_revoked := v_revoked || v_part;
  END IF;
  IF v_old = 'platform_owner' AND p_role <> 'platform_owner' THEN
    WITH r AS (
      UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor, revoke_reason = 'Role changed: rights only a super administrator may hold were removed'
      WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL AND g.capability = ANY (public.access_owner_only())
      RETURNING g.id, g.capability, g.scope_kind, g.scope_id, g.valid_until, g.revoke_reason
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'capability', r.capability, 'scope_kind', r.scope_kind, 'scope_id', r.scope_id,
                                                  'valid_until', r.valid_until, 'reason', r.revoke_reason)), '[]'::jsonb) INTO v_part FROM r;
    v_revoked := v_revoked || v_part;
  END IF;
  IF jsonb_array_length(v_revoked) > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  SELECT p.access_version INTO v_version FROM public.profiles p WHERE p.id = p_user;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('old_role', v_old, 'new_role', p_role, 'version', v_version, 'revoked', v_revoked);
END
$$;

-- Activates or deactivates a person (the sign-in ban and ending sessions stay in the app); the automatic full-rights grant on
-- reactivating a super administrator records who acted.
CREATE OR REPLACE FUNCTION public.set_person_active(p_org uuid, p_actor uuid, p_user uuid, p_active boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old boolean;
BEGIN
  PERFORM public.access_check_people_admin(p_org, p_actor, p_user, NULL);
  SELECT p.is_active INTO v_old FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  PERFORM set_config('drishti.actor', p_actor::text, true);
  UPDATE public.profiles SET is_active = p_active WHERE id = p_user AND org_id = p_org;
  PERFORM set_config('drishti.actor', '', true);
  RETURN v_old;
END
$$;

-- ── M-3 / M-8: automatic full rights, audited, with the new reason ───────────────────────
DROP FUNCTION public.grant_platform_owner_all(uuid, uuid);
CREATE OR REPLACE FUNCTION public.grant_platform_owner_all(p_org uuid, p_user uuid, p_actor uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text;
  v_put record;
  v_added integer := 0;
  v_ids uuid[] := '{}';
  v_actor uuid := coalesce(p_actor, NULLIF(current_setting('drishti.actor', true), '')::uuid);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org AND p.role = 'platform_owner' AND p.is_active) THEN
    RAISE EXCEPTION 'not an active platform owner of this organisation' USING ERRCODE = '42501';
  END IF;
  PERFORM public.access_lock_person(p_org, p_user, NULL);
  FOR v_cap IN SELECT c.key FROM public.capabilities c WHERE 'organization' = ANY (c.scope_kinds) ORDER BY c.key LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'),
      NULL, 'Super administrator: all capabilities', 'manual', false);
    IF v_put.added THEN
      v_added := v_added + 1;
      v_ids := v_ids || v_put.grant_id;
    END IF;
  END LOOP;
  IF v_added > 0 THEN
    PERFORM public.access_bump_version(p_user);
    INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (p_org, v_actor, 'access_granted', 'profile', p_user, jsonb_build_object('count', v_added, 'source', 'platform_owner_auto',
            'reason', 'Super administrator: all capabilities', 'grant_ids', to_jsonb(v_ids)));
  END IF;
  RETURN v_added;
END
$$;

CREATE OR REPLACE FUNCTION public.profiles_platform_owner_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.grant_platform_owner_all(NEW.org_id, NEW.id, NULL);
  RETURN NULL;
END
$$;

-- A capability added to the catalogue, or one that gains organisation scope (M-13), goes to every active platform owner.
CREATE OR REPLACE FUNCTION public.capabilities_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner record;
  v_put record;
BEGIN
  IF NOT ('organization' = ANY (NEW.scope_kinds)) THEN RETURN NULL; END IF;
  FOR v_owner IN SELECT p.id, p.org_id FROM public.profiles p WHERE p.role = 'platform_owner' AND p.is_active ORDER BY p.org_id, p.id LOOP
    PERFORM public.access_lock_person(v_owner.org_id, v_owner.id, NULL);
    SELECT * INTO v_put FROM public.access_put_grant(v_owner.org_id, v_owner.id, jsonb_build_object('capability', NEW.key, 'scope_kind', 'organization'),
      NULL, 'Super administrator: all capabilities', 'manual', false);
    IF v_put.added THEN
      PERFORM public.access_bump_version(v_owner.id);
      INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
      VALUES (v_owner.org_id, NULL, 'access_granted', 'profile', v_owner.id, jsonb_build_object('count', 1, 'source', 'platform_owner_auto',
              'reason', 'Super administrator: all capabilities', 'capability', NEW.key, 'grant_ids', jsonb_build_array(v_put.grant_id)));
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER capabilities_grant_platform_owners_on_scope AFTER UPDATE OF scope_kinds ON public.capabilities
  FOR EACH ROW WHEN (NOT ('organization' = ANY (OLD.scope_kinds)) AND 'organization' = ANY (NEW.scope_kinds))
  EXECUTE FUNCTION public.capabilities_after_insert();

-- TEST HELPER (kept in the schema, documented in access-model.md: the test suite only talks to the database through PostgREST).
CREATE OR REPLACE FUNCTION public.access_catalogue_probe_test(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_insert jsonb := '[]'::jsonb;
  v_update jsonb := '[]'::jsonb;
  v_with jsonb := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'the probe only runs for test organisations' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)
    VALUES ('it.zz_catalogue_probe', 'it', 'Probe (test only, always rolled back)', 'low', false, ARRAY['location', 'asset']);
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_insert
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe' AND g.revoked_at IS NULL;
    UPDATE public.capabilities SET scope_kinds = ARRAY['organization', 'location', 'asset'] WHERE key = 'it.zz_catalogue_probe';
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_update
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe' AND g.revoked_at IS NULL AND g.scope_kind = 'organization';
    INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)
    VALUES ('it.zz_catalogue_probe_two', 'it', 'Probe (test only, always rolled back)', 'low', false, ARRAY['organization', 'location', 'asset']);
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_with
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe_two' AND g.revoked_at IS NULL AND g.scope_kind = 'organization';
    RAISE EXCEPTION 'probe rolled back' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL;
  END;
  RETURN jsonb_build_object('after_insert_without_org', v_insert, 'after_update_to_org', v_update, 'after_insert_with_org', v_with);
END
$$;

-- ── M-10 / M-11: reviews ──────────────────────────────────────────────────────────────────
ALTER TABLE public.access_grant_reviews DROP CONSTRAINT access_grant_reviews_decision_check;
ALTER TABLE public.access_grant_reviews ADD CONSTRAINT access_grant_reviews_decision_check CHECK (decision IN ('kept', 'self_confirmed'));

CREATE OR REPLACE FUNCTION public.access_review_keep(p_org uuid, p_actor uuid, p_grant_ids uuid[], p_note text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_g public.access_grants%ROWTYPE;
  v_id uuid;
  v_n integer := 0;
  v_rows integer;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'an acting person is required' USING ERRCODE = '22023'; END IF;
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_note IS NOT NULL AND length(p_note) > 500 THEN RAISE EXCEPTION 'note too long' USING ERRCODE = '22023'; END IF;
  FOREACH v_id IN ARRAY coalesce(p_grant_ids, '{}') LOOP
    SELECT * INTO v_g FROM public.access_grants g WHERE g.id = v_id AND g.org_id = p_org;
    IF NOT FOUND THEN RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002'; END IF;
    PERFORM public.access_check_manager(p_org, p_actor, v_g.user_id);
    IF v_g.revoked_at IS NOT NULL OR NOT (v_g.needs_review OR v_g.source IN ('migrated:home', 'migrated:manager', 'migrated:admin')) THEN
      RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
    END IF;
    -- M-10: confirming is giving: the reviewer must be allowed to give exactly this grant.
    PERFORM public.access_check_grantor(p_org, p_actor, v_g.user_id,
      jsonb_build_object('capability', v_g.capability, 'scope_kind', v_g.scope_kind, 'scope_id', v_g.scope_id, 'valid_until', v_g.valid_until),
      coalesce(NULLIF(btrim(coalesce(p_note, '')), ''), 'Reviewed and kept'));
    INSERT INTO public.access_grant_reviews (org_id, grant_id, decision, note, reviewed_by)
    VALUES (p_org, v_id, 'kept', NULLIF(btrim(coalesce(p_note, '')), ''), p_actor)
    ON CONFLICT (grant_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_n := v_n + v_rows;
  END LOOP;
  RETURN v_n;
END
$$;

-- Break-glass (M-11): the ONLY active super administrator of an organisation confirms their own migrated grants, with a typed reason
-- (at least 10 characters), recorded as 'self_confirmed' and audited. Refused as soon as another active super administrator exists.
CREATE OR REPLACE FUNCTION public.access_review_self_confirm(p_org uuid, p_actor uuid, p_grant_ids uuid[], p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_n integer := 0;
  v_rows integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.role = 'platform_owner' AND p.is_active AND NOT p.must_reset_password)
     OR NOT EXISTS (SELECT 1 FROM public.access_grants_of(p_actor, now(), false, true) g WHERE g.org_id = p_org AND g.capability = 'admin.access' AND g.scope_kind = 'organization') THEN
    RAISE EXCEPTION 'only a super administrator with admin.access may self-confirm' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations o WHERE o.id = p_org FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.org_id = p_org AND p.id <> p_actor AND p.role = 'platform_owner' AND p.is_active) THEN
    RAISE EXCEPTION 'another super administrator exists' USING ERRCODE = 'DR002';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'reason required (10 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  FOREACH v_id IN ARRAY coalesce(p_grant_ids, '{}') LOOP
    IF NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = v_id AND g.org_id = p_org AND g.user_id = p_actor AND g.revoked_at IS NULL
                     AND (g.needs_review OR g.source IN ('migrated:home', 'migrated:manager', 'migrated:admin'))) THEN
      RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.access_grant_reviews (org_id, grant_id, decision, note, reviewed_by)
    VALUES (p_org, v_id, 'self_confirmed', btrim(p_reason), p_actor)
    ON CONFLICT (grant_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_n := v_n + v_rows;
  END LOOP;
  RETURN v_n;
END
$$;

-- ── E-1 on existing data: no cctv.export for anybody who is not an administrator ─────────
-- (Expected to find nothing: the P2-1 migration gave export only to administrators.) Each person affected gets an audit row.
WITH r AS (
  UPDATE public.access_grants g SET revoked_at = now(), revoked_by = NULL, revoke_reason = 'Downloads are only for administrators (ruling E-1).'
  FROM public.profiles p
  WHERE p.id = g.user_id AND p.org_id = g.org_id AND g.revoked_at IS NULL AND g.capability = 'cctv.export' AND p.role NOT IN ('admin', 'platform_owner')
  RETURNING g.org_id, g.user_id, g.id
)
INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
SELECT r.org_id, NULL, 'access_revoked', 'profile', r.user_id,
       jsonb_build_object('count', count(*), 'reason', 'Downloads are only for administrators (ruling E-1).', 'source', 'migration 20261021000017',
                          'grant_ids', jsonb_agg(r.id))
FROM r GROUP BY r.org_id, r.user_id;

-- ── Privileges ───────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  public.access_merge_plan(jsonb, timestamptz, timestamptz, timestamptz), public.access_owner_only(),
  public.profiles_keep_super_admin(), public.access_teardown_test_org_people(uuid),
  public.access_check_people_admin(uuid, uuid, uuid, public.user_role), public.change_person_role(uuid, uuid, uuid, public.user_role, bigint),
  public.set_person_active(uuid, uuid, uuid, boolean), public.grant_platform_owner_all(uuid, uuid, uuid),
  public.access_review_self_confirm(uuid, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.access_teardown_test_org_people(uuid), public.change_person_role(uuid, uuid, uuid, public.user_role, bigint),
  public.set_person_active(uuid, uuid, uuid, boolean), public.grant_platform_owner_all(uuid, uuid, uuid),
  public.access_review_self_confirm(uuid, uuid, uuid[], text)
  TO service_role;

COMMIT;
