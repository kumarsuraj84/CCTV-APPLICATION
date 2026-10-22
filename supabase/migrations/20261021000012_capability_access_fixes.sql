-- P2-1 review fixes (fix round 1). Forward only; nothing here changes anyone's access on the data it runs on.
--   I-1  granting is monotonic: a grant never shortens an existing one; two windows are joined (earliest start, latest end or none).
--        The preview applies exactly the same rule.
--   I-2  replace_user_grants keeps a live grant unchanged when the wanted description has no dates (no re-dating, no resurrection).
--   I-3  the migration never brings back what was revoked: people who already have a report row are skipped unless p_force; only the
--        database owner may run it; tests use access_migrate_legacy_test, which works only on organisations made by tests.
--        Its self-check now runs inside the function, person by person: CCTV camera sets and visible-store sets unchanged, no
--        administrative, Wi-Fi, export or high-risk IT capability for anybody who is not an administrator.
--   Minors: preview_access_change and access_expiring take the organisation; the preview's revoke path accepts only the person's own
--        live grants; mfa_enforced() is STABLE, the session level is parsed in one place and testable with given claims
--        (access_session_capabilities, server only); access_effective_* become report_effective_* (reporting only, they skip MFA);
--        the acting administrator must belong to the organisation; grants keep their history when the person is deleted (no
--        cascade from profiles; the organisation's deletion still removes them); current_org_id / current_user_role run with an
--        empty search_path; set_updated_at is no longer executable by anon / PUBLIC.
-- Rollback: supabase/rollback/20261021000012_capability_access_fixes_rollback.sql
BEGIN;

-- ── Grants outlive their person (minor 4) ────────────────────────────────────
-- History is kept when a profile is deleted. The organisation's deletion still removes its grants.
ALTER TABLE public.access_grants DROP CONSTRAINT access_grants_user_fk;
ALTER TABLE public.access_grants DROP CONSTRAINT access_grants_org_id_fkey;
ALTER TABLE public.access_grants ADD CONSTRAINT access_grants_org_fk FOREIGN KEY (org_id) REFERENCES public.organizations (id) ON DELETE CASCADE;

-- Without the composite key, a new grant is checked here: the person must be a person of the grant's organisation.
CREATE OR REPLACE FUNCTION public.access_grants_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_kinds text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'the person is not in this organisation' USING ERRCODE = '23503';
  END IF;
  SELECT c.scope_kinds INTO v_kinds FROM public.capabilities c WHERE c.key = NEW.capability;
  IF v_kinds IS NULL THEN RAISE EXCEPTION 'unknown capability' USING ERRCODE = '22023'; END IF;
  IF NOT (NEW.scope_kind = ANY (v_kinds)) THEN
    RAISE EXCEPTION 'a % grant cannot have % scope', NEW.capability, NEW.scope_kind USING ERRCODE = '22023';
  END IF;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a grant cannot start revoked' USING ERRCODE = '22023';
  END IF;
  NEW.location_id := CASE WHEN NEW.scope_kind = 'location' THEN NEW.scope_id END;
  NEW.camera_id := CASE WHEN NEW.scope_kind = 'camera' THEN NEW.scope_id END;
  NEW.asset_id := CASE WHEN NEW.scope_kind = 'asset' THEN NEW.scope_id END;
  NEW.granted_at := now();
  RETURN NEW;
END
$$;

-- ── Identity helpers with an empty search_path (minor 8) ─────────────────────
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.org_id FROM public.profiles p
  WHERE p.id = (SELECT auth.uid()) AND p.is_active AND NOT coalesce(p.must_reset_password, false)
$$;

CREATE OR REPLACE FUNCTION public.current_user_role() RETURNS public.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.role FROM public.profiles p
  WHERE p.id = (SELECT auth.uid()) AND p.is_active AND NOT coalesce(p.must_reset_password, false)
$$;

-- A trigger needs no EXECUTE right to fire; nobody calls this directly.
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

-- ── MFA (minor 2) ────────────────────────────────────────────────────────────
-- STABLE, so that P3 can make it read a setting without every plan having folded "false" in.
CREATE OR REPLACE FUNCTION public.mfa_enforced() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = '' AS $$ SELECT false $$;

-- The one place a JWT's session level is read.
CREATE OR REPLACE FUNCTION public.access_aal2_of(p_claims jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT coalesce(p_claims ->> 'aal', '') = 'aal2' $$;

CREATE OR REPLACE FUNCTION public.access_caller_aal2() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT public.access_aal2_of((SELECT auth.jwt())) $$;

-- The rules, with the MFA switch as a parameter (so its aal2 branch can be tested); access_grants_of passes mfa_enforced().
CREATE OR REPLACE FUNCTION public.access_grants_eval(p_user uuid, p_at timestamptz, p_ignore_status boolean, p_aal2 boolean, p_mfa_enforced boolean)
RETURNS TABLE (org_id uuid, capability text, area text, scope_kind text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.org_id, g.capability, c.area, g.scope_kind, g.scope_id
  FROM public.access_grants g
  JOIN public.profiles p ON p.id = g.user_id AND p.org_id = g.org_id
  JOIN public.capabilities c ON c.key = g.capability
  WHERE g.user_id = p_user
    AND g.revoked_at IS NULL
    AND g.valid_from <= p_at AND (g.valid_until IS NULL OR g.valid_until > p_at)
    AND (p_ignore_status OR (p.is_active AND NOT p.must_reset_password))
    AND (NOT c.requires_mfa OR NOT p_mfa_enforced OR p_aal2)
$$;

CREATE OR REPLACE FUNCTION public.access_grants_of(p_user uuid, p_at timestamptz, p_ignore_status boolean, p_aal2 boolean)
RETURNS TABLE (org_id uuid, capability text, area text, scope_kind text, scope_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM public.access_grants_eval(p_user, p_at, p_ignore_status, p_aal2, public.mfa_enforced())
$$;

-- DIAGNOSTIC, server only: the capabilities that would count for a person in a session with these JWT claims and this MFA setting.
-- It takes the claims from its caller, so it must never be used to authorise anything.
CREATE OR REPLACE FUNCTION public.access_session_capabilities(p_user uuid, p_claims jsonb, p_mfa_enforced boolean)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT g.capability FROM public.access_grants_eval(p_user, now(), false, public.access_aal2_of(p_claims), p_mfa_enforced) g ORDER BY 1
$$;
COMMENT ON FUNCTION public.access_session_capabilities(uuid, jsonb, boolean) IS 'DIAGNOSTIC ONLY (tests, administrator tooling). Never use for authorisation: the claims come from the caller.';

-- ── Reporting functions, renamed so nobody mistakes them for authorisation (minor 2) ─────────────
DROP FUNCTION public.access_effective_camera_ids(uuid, text, timestamptz, boolean);
DROP FUNCTION public.access_effective_device_ids(uuid, text, timestamptz, boolean);

CREATE OR REPLACE FUNCTION public.report_effective_camera_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_cameras_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;
CREATE OR REPLACE FUNCTION public.report_effective_device_ids(p_user uuid, p_cap text, p_at timestamptz DEFAULT now(), p_ignore_status boolean DEFAULT false)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x FROM public.access_devices_for(p_user, ARRAY[p_cap], p_at, p_ignore_status, true) AS x
$$;
COMMENT ON FUNCTION public.report_effective_camera_ids(uuid, text, timestamptz, boolean) IS 'REPORTING ONLY: treats every session as MFA-verified and can ignore the person''s status. Never use for authorisation.';
COMMENT ON FUNCTION public.report_effective_device_ids(uuid, text, timestamptz, boolean) IS 'REPORTING ONLY: treats every session as MFA-verified and can ignore the person''s status. Never use for authorisation.';

-- ── Monotonic grants (I-1) ───────────────────────────────────────────────────
-- covered: the old window already contains the new one. merged: the smallest window holding both (earliest start, latest end; no end
-- if either has none).
CREATE OR REPLACE FUNCTION public.access_merge_window(
  p_old_from timestamptz, p_old_until timestamptz, p_new_from timestamptz, p_new_until timestamptz,
  OUT covered boolean, OUT merged_from timestamptz, OUT merged_until timestamptz)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_old_from <= p_new_from AND (p_old_until IS NULL OR (p_new_until IS NOT NULL AND p_old_until >= p_new_until)),
         least(p_old_from, p_new_from),
         CASE WHEN p_old_until IS NULL OR p_new_until IS NULL THEN NULL ELSE greatest(p_old_until, p_new_until) END
$$;

-- Adds one grant, never taking anything away: when a live grant for the same capability and scope already covers the requested
-- window it is returned unchanged; otherwise it is replaced by one grant over both windows. Shortening only through revoke_grant.
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

-- ── The acting administrator belongs to the organisation (minor 3) ───────────
CREATE OR REPLACE FUNCTION public.access_check_actor(p_org uuid, p_actor uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor AND p.org_id = p_org AND p.is_active) THEN
    RAISE EXCEPTION 'the acting person is not an active person of this organisation (actor outside organisation)' USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.grant_access(
  p_org uuid, p_user uuid, p_grants jsonb, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_spec jsonb;
  v_put record;
  v_ids uuid[] := '{}';
  v_added integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF jsonb_typeof(p_grants) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'grants must be a list' USING ERRCODE = '22023'; END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  FOR v_spec IN SELECT e.value FROM jsonb_array_elements(p_grants) AS e LOOP
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_spec, p_actor, p_reason, 'manual', false);
    v_ids := v_ids || v_put.grant_id;
    IF v_put.added THEN v_added := v_added + 1; END IF;
  END LOOP;
  IF v_added > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'grant_ids', to_jsonb(v_ids), 'added', v_added, 'unchanged', cardinality(v_ids) - v_added);
END
$$;

CREATE OR REPLACE FUNCTION public.revoke_grant(
  p_org uuid, p_user uuid, p_grant_ids uuid[], p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_n integer;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_grant_ids, '{}')) AS x(id)
             WHERE NOT EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = x.id AND g.user_id = p_user AND g.org_id = p_org)) THEN
    RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.access_grants SET revoked_at = now(), revoked_by = p_actor, revoke_reason = coalesce(p_reason, 'Revoked.')
  WHERE id = ANY (coalesce(p_grant_ids, '{}')) AND user_id = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'revoked', v_n);
END
$$;

-- I-2: a wanted description without dates matches any live grant of the same capability and scope, whatever its dates, and leaves
-- it as it is (an expired grant stays expired, a future one stays future). A description with dates is added monotonically.
CREATE OR REPLACE FUNCTION public.replace_user_grants(
  p_org uuid, p_user uuid, p_capabilities text[], p_scope_kinds text[], p_grants jsonb,
  p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_spec jsonb;
  v_put record;
  v_added integer := 0;
  v_revoked integer := 0;
  v_kept integer := 0;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF jsonb_typeof(p_grants) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'grants must be a list' USING ERRCODE = '22023'; END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_grants) AS e
             WHERE NOT (e.value ->> 'capability' = ANY (p_capabilities)) OR NOT (e.value ->> 'scope_kind' = ANY (p_scope_kinds))) THEN
    RAISE EXCEPTION 'a grant is outside the capabilities or scope kinds being replaced' USING ERRCODE = '22023';
  END IF;
  WITH wanted AS (
    SELECT DISTINCT e.value ->> 'capability' AS cap, e.value ->> 'scope_kind' AS kind, NULLIF(e.value ->> 'scope_id', '')::uuid AS sid
    FROM jsonb_array_elements(p_grants) AS e
  )
  UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor, revoke_reason = coalesce(p_reason, 'Removed from the access list.')
  WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL
    AND g.capability = ANY (p_capabilities) AND g.scope_kind = ANY (p_scope_kinds)
    AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.cap = g.capability AND w.kind = g.scope_kind AND w.sid IS NOT DISTINCT FROM g.scope_id);
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  FOR v_spec IN SELECT e.value FROM jsonb_array_elements(p_grants) AS e LOOP
    IF NULLIF(v_spec ->> 'valid_from', '') IS NULL AND NULLIF(v_spec ->> 'valid_until', '') IS NULL
       AND EXISTS (SELECT 1 FROM public.access_grants g
                   WHERE g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL AND g.capability = v_spec ->> 'capability'
                     AND g.scope_kind = v_spec ->> 'scope_kind' AND g.scope_id IS NOT DISTINCT FROM NULLIF(v_spec ->> 'scope_id', '')::uuid) THEN
      v_kept := v_kept + 1;
      CONTINUE;
    END IF;
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_spec, p_actor, p_reason, 'manual', false);
    IF v_put.added THEN v_added := v_added + 1; ELSE v_kept := v_kept + 1; END IF;
  END LOOP;
  IF v_added + v_revoked > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'added', v_added, 'revoked', v_revoked, 'unchanged', v_kept);
END
$$;

-- ── Preview with the same rules as the write (I-1, minor 1) ──────────────────
-- p_changes: [{op: 'grant', capability, scope_kind, scope_id?, valid_from?, valid_until?} | {op: 'revoke', grant_id}].
-- Revocations are applied first, then grants, each grant joined with a live grant of the same capability and scope exactly as
-- access_put_grant does. Writes nothing.
DROP FUNCTION public.preview_access_change(uuid, jsonb, timestamptz, integer);
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

-- ── Expiry list per organisation (minor 11) ──────────────────────────────────
DROP FUNCTION public.access_expiring(interval);
CREATE OR REPLACE FUNCTION public.access_expiring(p_org uuid, p_within interval)
RETURNS TABLE (grant_id uuid, org_id uuid, user_id uuid, capability text, scope_kind text, scope_id uuid, valid_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.id, g.org_id, g.user_id, g.capability, g.scope_kind, g.scope_id, g.valid_until
  FROM public.access_grants g
  WHERE g.org_id = p_org AND g.revoked_at IS NULL AND g.valid_until IS NOT NULL AND g.valid_until > now() AND g.valid_until <= now() + p_within
  ORDER BY g.valid_until, g.id
$$;

-- ── Old visible_store_ids rules, for the migration's store check (minor 9) ───
CREATE OR REPLACE FUNCTION public.access_legacy_store_ids(p_user uuid, p_ignore_status boolean DEFAULT false) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH p AS (
    SELECT pr.id, pr.org_id, pr.role FROM public.profiles pr
    WHERE pr.id = p_user AND (p_ignore_status OR (pr.is_active AND NOT pr.must_reset_password))
  )
  SELECT s.id FROM public.stores s JOIN p ON p.org_id = s.org_id WHERE p.role IN ('manager', 'admin', 'platform_owner')
  UNION
  SELECT x FROM public.access_legacy_store_grants(p_user, p_ignore_status) AS x
  UNION
  SELECT c.store_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id JOIN p ON p.org_id = c.org_id
  WHERE a.user_id = p_user
$$;

-- ── The migration: non-resurrecting, self-checking, owner only (I-3, minor 9) ─────────────
DROP FUNCTION public.access_migrate_legacy(uuid, uuid[]);
CREATE OR REPLACE FUNCTION public.access_migrate_legacy(p_run uuid, p_users uuid[] DEFAULT NULL, p_force boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_person record;
  v_store record;
  v_cap text;
  v_camera uuid;
  v_put record;
  v_stores uuid[];
  v_zones text[];
  v_cams uuid[];
  v_narrowed uuid[];
  v_notes text[];
  v_ids uuid[];
  v_old uuid[];
  v_new uuid[];
  v_added integer;
  v_total integer := 0;
  v_lost integer;
  v_home_code text;
  v_admin_caps text[] := ARRAY['cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view',
    'it.monitoring.operate', 'wifi.inventory.view', 'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory',
    'admin.alerts', 'admin.audit.read'];
  v_manager_caps text[] := ARRAY['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'];
  v_reason text := 'Migrated from the old access model (P2-1).';
BEGIN
  IF p_run IS NULL THEN RAISE EXCEPTION 'a run id is needed' USING ERRCODE = '22023'; END IF;
  FOR v_person IN
    SELECT p.id, p.org_id, p.role, p.store_id, p.is_active, p.must_reset_password FROM public.profiles p
    WHERE p_users IS NULL OR p.id = ANY (p_users)
    ORDER BY p.org_id, p.id
  LOOP
    -- Somebody already migrated is never migrated again (that would bring back what an administrator revoked), unless forced.
    IF NOT p_force AND EXISTS (SELECT 1 FROM public.access_migration_report r WHERE r.user_id = v_person.id) THEN
      CONTINUE;
    END IF;
    v_added := 0;
    v_notes := '{}';
    v_ids := '{}';
    v_stores := ARRAY(SELECT a.store_id FROM public.user_store_access a WHERE a.user_id = v_person.id ORDER BY a.store_id);
    v_zones := ARRAY(SELECT z.zone FROM public.user_zone_access z WHERE z.user_id = v_person.id ORDER BY z.zone);
    v_cams := ARRAY(SELECT a.camera_id FROM public.user_camera_access a JOIN public.cameras c ON c.id = a.camera_id AND c.org_id = v_person.org_id
                    WHERE a.user_id = v_person.id ORDER BY a.camera_id);
    v_narrowed := ARRAY(SELECT DISTINCT c.store_id FROM public.cameras c WHERE c.id = ANY (v_cams));

    FOR v_store IN
      SELECT s.id, s.code,
             CASE WHEN s.id = ANY (v_stores) THEN 'migrated:store' WHEN s.zone = ANY (v_zones) THEN 'migrated:zone' ELSE 'migrated:home' END AS source
      FROM public.stores s
      WHERE s.org_id = v_person.org_id
        AND (s.id = ANY (v_stores) OR s.zone = ANY (v_zones) OR s.id = v_person.store_id)
        AND NOT (s.id = ANY (v_narrowed))
      ORDER BY s.code, s.id
    LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'location', 'scope_id', v_store.id),
          NULL, v_reason, v_store.source, v_store.source = 'migrated:home');
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;

    FOREACH v_camera IN ARRAY v_cams LOOP
      FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'camera', 'scope_id', v_camera), NULL, v_reason, 'migrated:camera', false);
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
    END LOOP;

    IF v_person.role = 'manager' THEN
      FOREACH v_cap IN ARRAY v_manager_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:manager', true);
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Manager role saw everything: migrated as organisation-wide live, playback, IT inventory and IT monitoring grants, flagged for review (D-2a).'::text;
    ELSIF v_person.role IN ('admin', 'platform_owner') THEN
      FOREACH v_cap IN ARRAY v_admin_caps LOOP
        SELECT * INTO v_put FROM public.access_put_grant(v_person.org_id, v_person.id,
          jsonb_build_object('capability', v_cap, 'scope_kind', 'organization'), NULL, v_reason, 'migrated:admin', false);
        v_ids := v_ids || v_put.grant_id;
        IF v_put.added THEN v_added := v_added + 1; END IF;
      END LOOP;
      v_notes := v_notes || 'Administrator: organisation-wide administrative set granted so existing administrator work keeps working.'::text;
    END IF;

    -- Self-check, person by person; any failure aborts the whole run.
    FOREACH v_cap IN ARRAY ARRAY['cctv.live', 'cctv.playback'] LOOP
      v_new := ARRAY(SELECT x FROM public.access_camera_set(v_person.org_id,
        EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'organization'),
        ARRAY(SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'location'),
        ARRAY(SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = v_cap AND g.scope_kind = 'camera')) AS x ORDER BY 1);
      v_old := ARRAY(SELECT x FROM public.access_legacy_camera_ids(v_person.id, true) AS x ORDER BY 1);
      IF v_new IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'P2-1 migration check failed: % cameras would change for person %', v_cap, v_person.id;
      END IF;
    END LOOP;
    v_new := ARRAY(
      SELECT s.id FROM public.stores s WHERE s.org_id = v_person.org_id
        AND EXISTS (SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'organization')
      UNION
      SELECT g.scope_id FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'location'
      UNION
      SELECT c.store_id FROM public.access_grants g JOIN public.cameras c ON c.id = g.scope_id
      WHERE g.id = ANY (v_ids) AND g.capability = 'cctv.live' AND g.scope_kind = 'camera'
      ORDER BY 1);
    v_old := ARRAY(SELECT x FROM public.access_legacy_store_ids(v_person.id, true) AS x ORDER BY 1);
    IF v_new IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION 'P2-1 migration check failed: visible stores would change for person %', v_person.id;
    END IF;
    IF v_person.role NOT IN ('admin', 'platform_owner') AND EXISTS (
         SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids)
         AND (g.capability LIKE 'admin.%' OR g.capability LIKE 'wifi.%' OR g.capability = 'cctv.export')) THEN
      RAISE EXCEPTION 'P2-1 migration check failed: an administrative, Wi-Fi or export capability for non-administrator %', v_person.id;
    END IF;
    IF v_person.role NOT IN ('manager', 'admin', 'platform_owner') AND EXISTS (
         SELECT 1 FROM public.access_grants g WHERE g.id = ANY (v_ids) AND g.capability NOT IN ('cctv.live', 'cctv.playback')) THEN
      RAISE EXCEPTION 'P2-1 migration check failed: more than live and playback for person %', v_person.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.access_grants g JOIN public.capabilities c ON c.key = g.capability
               WHERE g.id = ANY (v_ids) AND c.area = 'it' AND c.risk = 'high') THEN
      RAISE EXCEPTION 'P2-1 migration check failed: a high-risk IT capability for person %', v_person.id;
    END IF;

    IF v_person.store_id IS NOT NULL THEN
      SELECT s.code INTO v_home_code FROM public.stores s WHERE s.id = v_person.store_id;
      IF v_person.store_id = ANY (v_narrowed) THEN
        v_notes := v_notes || format('Home store %s had camera grants inside it, so only those cameras were kept (as before).', v_home_code);
      ELSIF NOT (v_person.store_id = ANY (v_stores))
            AND NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = v_person.store_id AND s.zone = ANY (v_zones)) THEN
        v_notes := v_notes || format('Home store %s was a hidden grant: migrated as explicit live and playback grants, flagged for review (D-2a). The home store now grants nothing by itself (AC-7).', v_home_code);
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_zones) AS z(zone)
               WHERE NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.org_id = v_person.org_id AND s.zone = z.zone)) THEN
      v_notes := v_notes || 'A zone grant had no stores in it: nothing to migrate for that zone.'::text;
    END IF;
    IF v_person.role NOT IN ('manager', 'admin', 'platform_owner') THEN
      SELECT count(*) INTO v_lost FROM public.access_legacy_device_ids(v_person.id, true);
      IF v_lost > 0 THEN
        v_notes := v_notes || format('IT devices no longer visible: %s. They were visible only through a store, zone or home-store grant, which is not migrated (directive AC-4).', v_lost);
      END IF;
    END IF;
    IF NOT v_person.is_active THEN
      v_notes := v_notes || 'Account inactive: grants were migrated and take effect only if the account is reactivated.'::text;
    ELSIF v_person.must_reset_password THEN
      v_notes := v_notes || 'The person must still choose a password: the grants take effect after that.'::text;
    END IF;
    IF p_force THEN v_notes := v_notes || 'Run again on purpose (forced).'::text; END IF;

    INSERT INTO public.access_migration_report (run_id, org_id, user_id, old_model, new_grants, note)
    VALUES (
      p_run, v_person.org_id, v_person.id,
      jsonb_build_object(
        'role', v_person.role, 'is_active', v_person.is_active, 'must_reset_password', v_person.must_reset_password,
        'home_store_id', v_person.store_id, 'stores', to_jsonb(v_stores), 'zones', to_jsonb(v_zones), 'cameras', to_jsonb(v_cams),
        'legacy_camera_count', (SELECT count(*) FROM public.access_legacy_camera_ids(v_person.id, true)),
        'legacy_device_count', (SELECT count(*) FROM public.access_legacy_device_ids(v_person.id, true))),
      coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'capability', g.capability, 'scope_kind', g.scope_kind, 'scope_id', g.scope_id,
                                                    'source', g.source, 'needs_review', g.needs_review) ORDER BY g.capability, g.scope_kind, g.scope_id)
                FROM public.access_grants g WHERE g.user_id = v_person.id AND g.revoked_at IS NULL), '[]'::jsonb),
      NULLIF(array_to_string(v_notes, ' '), '')
    );
    IF v_added > 0 THEN PERFORM public.access_bump_version(v_person.id); END IF;
    v_total := v_total + v_added;
  END LOOP;
  RETURN v_total;
END
$$;

-- TEST HELPER: runs the migration for people of organisations made by the test suite only (slug "test-…", tests/setup/fixtures.ts
-- createOrg). It refuses anybody else, so the service role can never re-run the real migration over real people through it.
CREATE OR REPLACE FUNCTION public.access_migrate_legacy_test(p_run uuid, p_users uuid[] DEFAULT NULL, p_force boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_users IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(p_users) AS u(id)
       WHERE NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id WHERE p.id = u.id AND o.slug LIKE 'test-%')) THEN
    RAISE EXCEPTION 'the test migration only runs for people of test organisations' USING ERRCODE = '42501';
  END IF;
  RETURN public.access_migrate_legacy(p_run, ARRAY(
    SELECT p.id FROM public.profiles p JOIN public.organizations o ON o.id = p.org_id
    WHERE o.slug LIKE 'test-%' AND (p_users IS NULL OR p.id = ANY (p_users))), p_force);
END
$$;
COMMENT ON FUNCTION public.access_migrate_legacy_test(uuid, uuid[], boolean) IS 'TEST HELPER ONLY: works only on organisations whose slug starts with "test-".';

-- ── Privileges ───────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  public.access_aal2_of(jsonb), public.access_grants_eval(uuid, timestamptz, boolean, boolean, boolean),
  public.access_session_capabilities(uuid, jsonb, boolean),
  public.report_effective_camera_ids(uuid, text, timestamptz, boolean), public.report_effective_device_ids(uuid, text, timestamptz, boolean),
  public.access_merge_window(timestamptz, timestamptz, timestamptz, timestamptz), public.access_check_actor(uuid, uuid),
  public.preview_access_change(uuid, uuid, jsonb, timestamptz, integer), public.access_expiring(uuid, interval),
  public.access_legacy_store_ids(uuid, boolean), public.access_migrate_legacy(uuid, uuid[], boolean),
  public.access_migrate_legacy_test(uuid, uuid[], boolean)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.access_session_capabilities(uuid, jsonb, boolean),
  public.report_effective_camera_ids(uuid, text, timestamptz, boolean), public.report_effective_device_ids(uuid, text, timestamptz, boolean),
  public.preview_access_change(uuid, uuid, jsonb, timestamptz, integer), public.access_expiring(uuid, interval),
  public.access_legacy_store_ids(uuid, boolean), public.access_migrate_legacy_test(uuid, uuid[], boolean)
  TO service_role;
-- access_migrate_legacy: the database owner only (I-3).

COMMIT;
