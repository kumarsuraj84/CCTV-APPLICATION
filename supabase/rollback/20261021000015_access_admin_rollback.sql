-- Rollback of 20261021000015_access_admin.sql: drops the review table and the new functions, and restores the 20261021000012
-- definitions of access_put_grant, grant_access, revoke_grant and replace_user_grants (without the P2-3 grant rules).
-- WARNING: review confirmations recorded in access_grant_reviews are lost; grants made meanwhile stay (they are ordinary grants).
BEGIN;

DROP FUNCTION IF EXISTS public.apply_access_change(uuid, uuid, jsonb, uuid, bigint);
DROP FUNCTION IF EXISTS public.access_review_keep(uuid, uuid, uuid[], text);
DROP FUNCTION IF EXISTS public.access_grant_summary(uuid);
DROP TABLE IF EXISTS public.access_grant_reviews;

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

DROP FUNCTION IF EXISTS public.access_check_grantor(uuid, uuid, uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.access_check_manager(uuid, uuid, uuid);

COMMIT;
