-- Rollback of 20261021000017_access_admin_fixes.sql. Restores the 20261021000015 / 20261021000016 definitions (and the 20261021000012 preview).
-- WARNINGS: (1) if a person has two live grants of the same right and scope (allowed since 0017: an expired one next to a new one),
-- recreating the unique key fails; revoke the older one first. (2) 'self_confirmed' review rows are deleted (the old check allows only
-- 'kept'). (3) Revocations made by 0017 (export of non-administrators, ruling E-1) and by role changes stay revoked. (4) btree_gist stays.
BEGIN;
SET LOCAL search_path = public, extensions;
DROP TRIGGER IF EXISTS profiles_keep_super_admin ON public.profiles;
DROP TRIGGER IF EXISTS capabilities_grant_platform_owners_on_scope ON public.capabilities;
DROP FUNCTION IF EXISTS public.profiles_keep_super_admin();
DROP FUNCTION IF EXISTS public.access_teardown_test_org_people(uuid);
DROP FUNCTION IF EXISTS public.change_person_role(uuid, uuid, uuid, public.user_role, bigint);
DROP FUNCTION IF EXISTS public.set_person_active(uuid, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.access_check_people_admin(uuid, uuid, uuid, public.user_role);
DROP FUNCTION IF EXISTS public.access_review_self_confirm(uuid, uuid, uuid[], text);
DROP FUNCTION IF EXISTS public.grant_platform_owner_all(uuid, uuid, uuid);
DELETE FROM public.access_grant_reviews WHERE decision = 'self_confirmed';
ALTER TABLE public.access_grant_reviews DROP CONSTRAINT access_grant_reviews_decision_check;
ALTER TABLE public.access_grant_reviews ADD CONSTRAINT access_grant_reviews_decision_check CHECK (decision = 'kept');
UPDATE public.capabilities SET description = 'Export or download recordings (includes fast playback, D-6a)' WHERE key = 'cctv.export';
UPDATE public.capabilities SET description = 'Search recordings and play them back (calendar, timeline, 1x player)' WHERE key = 'cctv.playback';

-- 0015 definitions

CREATE OR REPLACE FUNCTION public.access_check_manager(p_org uuid, p_actor uuid, p_user uuid) RETURNS public.user_role
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
  SELECT p.role INTO v_target FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org;
  IF v_target IS NULL THEN RAISE EXCEPTION 'unknown person' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'admin' AND v_target NOT IN ('user', 'operator', 'manager') THEN
    RAISE EXCEPTION 'the acting person may not manage this person' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END
$$;

-- ── Rules 4-7: the acting person may give this grant ─────────────────────────
CREATE OR REPLACE FUNCTION public.access_check_grantor(p_org uuid, p_actor uuid, p_user uuid, p_spec jsonb, p_reason text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
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
  IF v_role = 'platform_owner' THEN RETURN; END IF;
  IF v_cap IN ('it.os.deploy', 'it.credentials.admin', 'it.remote.control', 'it.script.run', 'it.software.manage', 'it.config.deploy', 'it.patch.manage') THEN
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
  v_g public.access_grants%ROWTYPE;
  v_m record;
BEGIN
  PERFORM public.access_check_spec(p_org, p_spec);
  IF p_actor IS NOT NULL THEN PERFORM public.access_check_grantor(p_org, p_actor, p_user, p_spec, p_reason); END IF;
  SELECT * INTO v_g FROM public.access_grants g
  WHERE g.user_id = p_user AND g.capability = v_cap AND g.scope_kind = v_kind AND g.scope_id IS NOT DISTINCT FROM v_scope AND g.revoked_at IS NULL
  FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO v_m FROM public.access_merge_window(v_g.valid_from, v_g.valid_until, v_from, v_until);
    IF v_m.covered THEN
      grant_id := v_g.id;
      added := false;
      RETURN;
    END IF;
    UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = 'Replaced by a wider grant (the two date ranges joined).'
    WHERE id = v_g.id;
    v_from := v_m.merged_from;
    v_until := v_m.merged_until;
  END IF;
  INSERT INTO public.access_grants (org_id, user_id, capability, scope_kind, scope_id, valid_from, valid_until, granted_by, reason, source, needs_review)
  VALUES (p_org, p_user, v_cap, v_kind, v_scope, v_from, v_until, p_actor, p_reason, p_source, p_needs_review)
  RETURNING id INTO grant_id;
  added := true;
END
$$;

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
    INSERT INTO public.access_grant_reviews (org_id, grant_id, decision, note, reviewed_by)
    VALUES (p_org, v_id, 'kept', NULLIF(btrim(coalesce(p_note, '')), ''), p_actor)
    ON CONFLICT (grant_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_n := v_n + v_rows;
  END LOOP;
  RETURN v_n;
END
$$;

-- 0016 definitions

CREATE OR REPLACE FUNCTION public.grant_platform_owner_all(p_org uuid, p_user uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cap text;
  v_put record;
  v_added integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user AND p.org_id = p_org AND p.role = 'platform_owner' AND p.is_active) THEN
    RAISE EXCEPTION 'not an active platform owner of this organisation' USING ERRCODE = '42501';
  END IF;
  PERFORM public.access_lock_person(p_org, p_user, NULL);
  FOR v_cap IN SELECT c.key FROM public.capabilities c WHERE 'organization' = ANY (c.scope_kinds) ORDER BY c.key LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'),
      NULL, 'Platform owner: all capabilities', 'manual', false);
    IF v_put.added THEN v_added := v_added + 1; END IF;
  END LOOP;
  IF v_added > 0 THEN PERFORM public.access_bump_version(p_user); END IF;
  RETURN v_added;
END
$$;

-- A capability added to the catalogue is granted to every active platform owner.
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
      NULL, 'Platform owner: all capabilities', 'manual', false);
    IF v_put.added THEN PERFORM public.access_bump_version(v_owner.id); END IF;
  END LOOP;
  RETURN NULL;
END
$$;
-- (the INSERT trigger capabilities_grant_platform_owners of 0016 is unchanged by 0017 and stays)

-- Becoming a platform owner, or being reactivated as one, gives the full set.
CREATE OR REPLACE FUNCTION public.profiles_platform_owner_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public.grant_platform_owner_all(NEW.org_id, NEW.id);
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.access_catalogue_probe_test(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_holders jsonb := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_org AND o.slug LIKE 'test-%') THEN
    RAISE EXCEPTION 'the probe only runs for test organisations' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.capabilities (key, area, description, risk, requires_mfa, scope_kinds)
    VALUES ('it.zz_catalogue_probe', 'it', 'Probe (test only, always rolled back)', 'low', false, ARRAY['organization', 'location', 'asset']);
    SELECT coalesce(jsonb_agg(g.user_id ORDER BY g.user_id), '[]'::jsonb) INTO v_holders
    FROM public.access_grants g WHERE g.org_id = p_org AND g.capability = 'it.zz_catalogue_probe' AND g.revoked_at IS NULL AND g.scope_kind = 'organization';
    RAISE EXCEPTION 'probe rolled back' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    NULL; -- everything inside the block, the probe capability and its grants included, is undone
  END;
  RETURN v_holders;
END
$$;

-- 0012 preview

CREATE OR REPLACE FUNCTION public.preview_access_change(p_org uuid, p_user uuid, p_changes jsonb, p_at timestamptz DEFAULT now(), p_sample integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_active boolean;
  v_before jsonb;
  v_after jsonb;
  v_change jsonb;
  v_grant uuid;
  v_found jsonb;
  v_pos integer;
  v_from timestamptz;
  v_until timestamptz;
  v_m record;
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

  -- 1. Revocations: only the person's own live grants.
  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e WHERE e.value ->> 'op' = 'revoke' LOOP
    v_grant := NULLIF(v_change ->> 'grant_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = v_grant AND g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
    END IF;
    SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_after FROM jsonb_array_elements(v_after) AS e
    WHERE e.value ->> 'id' IS NULL OR (e.value ->> 'id')::uuid <> v_grant;
  END LOOP;

  -- 2. Grants, joined like access_put_grant.
  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e LOOP
    IF v_change ->> 'op' = 'revoke' THEN CONTINUE; END IF;
    IF v_change ->> 'op' IS DISTINCT FROM 'grant' THEN RAISE EXCEPTION 'unknown change' USING ERRCODE = '22023'; END IF;
    PERFORM public.access_check_spec(p_org, v_change - 'op');
    v_from := coalesce(NULLIF(v_change ->> 'valid_from', '')::timestamptz, now());
    v_until := NULLIF(v_change ->> 'valid_until', '')::timestamptz;
    SELECT e.value, e.ordinality::integer INTO v_found, v_pos FROM jsonb_array_elements(v_after) WITH ORDINALITY AS e
    WHERE e.value ->> 'capability' = v_change ->> 'capability' AND e.value ->> 'scope_kind' = v_change ->> 'scope_kind'
      AND NULLIF(e.value ->> 'scope_id', '')::uuid IS NOT DISTINCT FROM NULLIF(v_change ->> 'scope_id', '')::uuid
    LIMIT 1;
    IF v_found IS NOT NULL THEN
      SELECT * INTO v_m FROM public.access_merge_window((v_found ->> 'valid_from')::timestamptz, NULLIF(v_found ->> 'valid_until', '')::timestamptz, v_from, v_until);
      IF NOT v_m.covered THEN
        v_after := (v_after - (v_pos - 1)) || jsonb_build_array((v_found - 'id') || jsonb_build_object('valid_from', v_m.merged_from, 'valid_until', v_m.merged_until));
      END IF;
    ELSE
      v_after := v_after || jsonb_build_array((v_change - 'op') || jsonb_build_object('valid_from', v_from, 'valid_until', v_until));
    END IF;
    v_found := NULL;
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

DROP FUNCTION IF EXISTS public.access_merge_plan(jsonb, timestamptz, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.access_owner_only();
ALTER TABLE public.access_grants DROP CONSTRAINT IF EXISTS access_grants_live_no_overlap;
DROP INDEX IF EXISTS public.access_grants_live_idx;
CREATE UNIQUE INDEX access_grants_active_key ON public.access_grants (user_id, capability, scope_kind, scope_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;
REVOKE EXECUTE ON FUNCTION public.grant_platform_owner_all(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.grant_platform_owner_all(uuid, uuid) TO service_role;
COMMIT;
