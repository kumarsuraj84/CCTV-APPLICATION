-- P2-3 (WP-2.1c) administration of access: who may grant what, a change applied in one transaction, the review of migrated grants,
-- and a per-person summary for the people list. Directive AC-5, AC-6, AC-9, AC-12; decisions D-1, D-2a. docs/drishti/access-model.md
-- ("Who may grant what") explains the rules; the Server Actions check the same rules first (lib/admin/access-rules.ts).
--
-- Rules, enforced here for every change made by a person (p_actor set). Changes without an acting person are made only by the server's
-- own tooling (the migration, the dev-admin script, the demo seed, test fixtures); no screen can reach them.
--   1. The acting person is active, has chosen a password, belongs to the organisation, has the admin or platform_owner role and holds
--      admin.access for the whole organisation now.
--   2. Nobody changes their own access (grant, revoke or confirm a review), not even a platform owner.
--   3. A plain administrator manages only viewers, operators and managers (as canManageRole in lib/admin/roles.ts).
--   4. A plain administrator gives only what they hold themselves, now, at an equal or wider scope (organisation covers everything; a
--      location covers itself and its cameras and assets; a camera or asset covers only itself) and for no longer than they hold it.
--   5. it.os.deploy, it.credentials.admin, it.remote.control, it.script.run, it.software.manage, it.config.deploy and it.patch.manage are
--      given only by a platform owner. A platform owner may give every capability.
--   6. A reason is required for every high-risk capability and for cctv.export, and for every revocation.
--   7. Administration capabilities (admin.*) go only to people with the admin or platform_owner role.
-- Rollback: supabase/rollback/20261021000015_access_admin_rollback.sql
BEGIN;

-- ── Review decisions on migrated grants (append-only) ───────────────────────
-- A grant cannot be changed (append-only history), so "keep this migrated grant" is recorded here, once per grant.
CREATE TABLE public.access_grant_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES public.access_grants (id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision = 'kept'),
  note text CHECK (note IS NULL OR length(note) <= 500),
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_grant_reviews_grant_key ON public.access_grant_reviews (grant_id);
CREATE INDEX access_grant_reviews_org_idx ON public.access_grant_reviews (org_id);
ALTER TABLE public.access_grant_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.access_grant_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.access_grant_reviews TO service_role;
COMMENT ON TABLE public.access_grant_reviews IS 'P2-3: an administrator confirmed (kept) a migrated grant. Written only by access_review_keep.';

-- ── Rules 1-3: the acting person may change this person's access ─────────────
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

-- ── access_put_grant: the grant rule for every grant made by a person ────────
-- Same body as 20261021000012, plus the access_check_grantor line.
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

-- ── The three existing writers check the acting person as well (rules 1-3) ───
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
  IF p_actor IS NOT NULL THEN PERFORM public.access_check_manager(p_org, p_actor, p_user); END IF;
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
  IF p_actor IS NOT NULL THEN PERFORM public.access_check_manager(p_org, p_actor, p_user); END IF;
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
  IF p_actor IS NOT NULL THEN PERFORM public.access_check_manager(p_org, p_actor, p_user); END IF;
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

-- ── One change, one transaction (the access editor's save) ───────────────────
-- p_changes: [{op: 'revoke', grant_id, reason} | {op: 'grant', capability, scope_kind, scope_id?, valid_until?, reason?}].
-- Revocations first (each needs a reason and must be the person's live grant), then grants (monotonic, access_put_grant, with the
-- grant rule). Anything refused undoes the whole change. Returns {version, added, revoked, unchanged, grant_ids (one per grant, in order)}.
CREATE OR REPLACE FUNCTION public.apply_access_change(p_org uuid, p_user uuid, p_changes jsonb, p_actor uuid, p_expected_version bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_version bigint;
  v_change jsonb;
  v_grant uuid;
  v_reason text;
  v_put record;
  v_ids uuid[] := '{}';
  v_added integer := 0;
  v_revoked integer := 0;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'an acting person is required' USING ERRCODE = '22023'; END IF;
  PERFORM public.access_check_actor(p_org, p_actor);
  PERFORM public.access_check_manager(p_org, p_actor, p_user);
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'changes must be a list' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_changes) AS e WHERE (e.value ->> 'op') IS DISTINCT FROM 'grant' AND (e.value ->> 'op') IS DISTINCT FROM 'revoke') THEN
    RAISE EXCEPTION 'unknown change' USING ERRCODE = '22023';
  END IF;
  v_version := public.access_lock_person(p_org, p_user, p_expected_version);

  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e WHERE e.value ->> 'op' = 'revoke' LOOP
    v_grant := NULLIF(v_change ->> 'grant_id', '')::uuid;
    v_reason := btrim(coalesce(v_change ->> 'reason', ''));
    IF length(v_reason) < 3 THEN RAISE EXCEPTION 'reason required for a revocation' USING ERRCODE = '22023'; END IF;
    UPDATE public.access_grants g SET revoked_at = now(), revoked_by = p_actor, revoke_reason = left(v_reason, 500)
    WHERE g.id = v_grant AND g.user_id = p_user AND g.org_id = p_org AND g.revoked_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'grant not found' USING ERRCODE = 'P0002'; END IF;
    v_revoked := v_revoked + 1;
  END LOOP;

  FOR v_change IN SELECT e.value FROM jsonb_array_elements(p_changes) AS e WHERE e.value ->> 'op' = 'grant' LOOP
    v_reason := NULLIF(left(btrim(coalesce(v_change ->> 'reason', '')), 500), '');
    SELECT * INTO v_put FROM public.access_put_grant(p_org, p_user, v_change - 'op' - 'reason' - 'valid_from', p_actor, v_reason, 'manual', false);
    v_ids := v_ids || v_put.grant_id;
    IF v_put.added THEN v_added := v_added + 1; END IF;
  END LOOP;

  IF v_added + v_revoked > 0 THEN v_version := public.access_bump_version(p_user); END IF;
  RETURN jsonb_build_object('version', v_version, 'added', v_added, 'revoked', v_revoked, 'unchanged', cardinality(v_ids) - v_added,
                            'grant_ids', to_jsonb(v_ids));
END
$$;

-- ── Review: keep (confirm) migrated grants ───────────────────────────────────
-- Reviewable: a live grant flagged needs_review, or migrated from a home store, the manager role or the administrator role (D-2a).
-- Returns how many were newly confirmed (already confirmed ones are skipped).
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

-- ── Summary for the people list ──────────────────────────────────────────────
-- What is in effect now per person and capability (the grants' window and revocation; the person's status is shown separately).
CREATE OR REPLACE FUNCTION public.access_grant_summary(p_org uuid)
RETURNS TABLE (user_id uuid, capability text, organization_wide boolean, locations integer, cameras integer, assets integer, next_expiry timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.user_id, g.capability,
         bool_or(g.scope_kind = 'organization'),
         (count(*) FILTER (WHERE g.scope_kind = 'location'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'camera'))::integer,
         (count(*) FILTER (WHERE g.scope_kind = 'asset'))::integer,
         min(g.valid_until)
  FROM public.access_grants g
  WHERE g.org_id = p_org AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
  GROUP BY g.user_id, g.capability
  ORDER BY g.user_id, g.capability
$$;

-- ── Privileges ───────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION
  public.access_check_manager(uuid, uuid, uuid), public.access_check_grantor(uuid, uuid, uuid, jsonb, text),
  public.apply_access_change(uuid, uuid, jsonb, uuid, bigint), public.access_review_keep(uuid, uuid, uuid[], text),
  public.access_grant_summary(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.apply_access_change(uuid, uuid, jsonb, uuid, bigint), public.access_review_keep(uuid, uuid, uuid[], text),
  public.access_grant_summary(uuid)
  TO service_role;

COMMIT;
