-- Rollback of 20261021000049_final_fix_y.sql (Release 1 final fix round, builder Y). Runs in its own transaction.
-- Dry run first (everything is undone at the end):  psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1 -f <this file>
-- For real:                                         psql -v ON_ERROR_STOP=1 -f <this file>
-- Puts back verbatim the definitions the migration replaced (as they were at 0048 (discovery_apply as final fix X left it): the nine inventory functions, access_grants_before_insert,
-- change_person_role, access_check_manager, access_check_people_admin, security_settings_audit_mfa, mfa_enforced_for_user,
-- ops_health_status), the four policies, INSERT on profiles and the old credential / sign-out grants for app_web; drops the new
-- functions, triggers, columns and the code-failure table. The auth_events check comes back NOT VALID, so the lock events already
-- written stay as history. What opens again: two-step sign-in off by default with no check (A I-1, B I-1), unlimited code guessing
-- (B I-2), the TypeScript-only gates of A M-1, M-2, M-7, the single-path E-1 rule (M-3), concurrent mutual revocation (M-4), the
-- organisation-less web functions (M-6), restores under an archived parent (C I-9) and the row-by-row device import (C I-8, the old
-- lib/import/apply.ts path must come back with it). Roll back 0049 before 0048.

BEGIN;

DROP TRIGGER profiles_role_rights ON public.profiles;
DROP FUNCTION public.profiles_role_rights();
DROP TRIGGER security_settings_mfa_normalise ON public.security_settings;
DROP FUNCTION public.security_settings_mfa_normalise();
DROP TRIGGER security_settings_audit_mfa ON public.security_settings;

DROP FUNCTION public.inventory_devices_import(uuid, uuid, jsonb, boolean);
DROP FUNCTION public.create_person(uuid, uuid, uuid, text, text, public.user_role, uuid);
DROP FUNCTION public.revoke_user_sessions(uuid, uuid);
DROP FUNCTION public.recorder_store_credential(uuid, uuid, text, uuid);
DROP FUNCTION public.access_check_password_reset(uuid, uuid, uuid);
DROP FUNCTION public.mfa_code_lock_clear(uuid, uuid, uuid, text);
DROP FUNCTION public.mfa_code_locks(uuid);
DROP FUNCTION public.mfa_code_attempt_end(uuid, text);
DROP FUNCTION public.mfa_code_attempt_begin(uuid);
DROP FUNCTION public.mfa_code_lock_record(uuid, uuid, integer, integer, boolean);
DROP FUNCTION public.mfa_code_lock_minutes(integer);
DROP TABLE public.mfa_code_failures;
DROP FUNCTION public.security_set_mfa(uuid, uuid, boolean, text);

ALTER TABLE public.auth_events DROP CONSTRAINT auth_events_event_check;
ALTER TABLE public.auth_events ADD CONSTRAINT auth_events_event_check CHECK (event = ANY (ARRAY[
  'sign_in', 'sign_in_failed', 'sign_out', 'sign_out_everywhere', 'session_expired_idle', 'session_expired_absolute', 'mfa_enrolled',
  'mfa_verified', 'mfa_failed', 'mfa_removed', 'mfa_factor_reset', 'reauth', 'reauth_failed'])) NOT VALID;

-- The definitions as they were (verbatim from the database at 0048).
CREATE OR REPLACE FUNCTION public.access_check_manager(p_org uuid, p_actor uuid, p_user uuid)
 RETURNS user_role
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.access_check_people_admin(p_org uuid, p_actor uuid, p_user uuid, p_new_role user_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.access_grants_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  NEW.region_id := CASE WHEN NEW.scope_kind = 'region' THEN NEW.scope_id END;
  NEW.cluster_id := CASE WHEN NEW.scope_kind = 'cluster' THEN NEW.scope_id END;
  NEW.location_id := CASE WHEN NEW.scope_kind = 'location' THEN NEW.scope_id END;
  NEW.recorder_id := CASE WHEN NEW.scope_kind = 'recorder' THEN NEW.scope_id END;
  NEW.camera_id := CASE WHEN NEW.scope_kind = 'camera' THEN NEW.scope_id END;
  NEW.asset_id := CASE WHEN NEW.scope_kind = 'asset' THEN NEW.scope_id END;
  NEW.granted_at := now();
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.camera_merge(p_org uuid, p_keep uuid, p_duplicate uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.camera_remap(p_org uuid, p_camera uuid, p_recorder uuid, p_channel integer, p_at timestamp with time zone DEFAULT now(), p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c public.cameras%ROWTYPE;
  v_id uuid;
  v_at timestamptz;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT * INTO c FROM public.cameras x WHERE x.id = p_camera AND x.org_id = p_org FOR UPDATE;
  IF NOT FOUND OR c.archived_at IS NOT NULL THEN RAISE EXCEPTION 'camera not found' USING ERRCODE = 'P0002'; END IF;
  IF p_channel IS NULL OR p_channel < 1 THEN RAISE EXCEPTION 'a channel number is needed' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
                 WHERE r.id = p_recorder AND r.org_id = p_org AND r.location_id = c.location_id) THEN
    RAISE EXCEPTION 'a camera can only be mapped to a recorder at its own location' USING ERRCODE = 'DR006';
  END IF;
  -- The switch moment; never before the current mapping began (a mapping made earlier in the same transaction).
  v_at := greatest(p_at, coalesce((SELECT m.valid_from + interval '1 microsecond' FROM public.camera_channel_mappings m
                                   WHERE m.camera_id = p_camera AND m.valid_to IS NULL), p_at));
  PERFORM set_config('drishti.mapping_sync', 'on', true);
  UPDATE public.camera_channel_mappings SET valid_to = v_at WHERE camera_id = p_camera AND valid_to IS NULL;
  INSERT INTO public.camera_channel_mappings (org_id, camera_id, recorder_id, channel, valid_from, created_by)
  VALUES (p_org, p_camera, p_recorder, p_channel, v_at, p_actor) RETURNING id INTO v_id;
  UPDATE public.cameras SET recorder_id = p_recorder, channel = p_channel WHERE id = p_camera;
  PERFORM set_config('drishti.mapping_sync', '', true);
  PERFORM public.inventory_remap_effects(p_org, p_camera, c.recorder_id, p_recorder);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'camera_remapped', 'camera', p_camera, jsonb_build_object('from_recorder', c.recorder_id, 'from_channel', c.channel,
          'to_recorder', p_recorder, 'to_channel', p_channel, 'mapping_id', v_id));
  RETURN v_id;
END
$function$
;

CREATE OR REPLACE FUNCTION public.change_person_role(p_org uuid, p_actor uuid, p_user uuid, p_role user_role, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.discovery_apply(p_org uuid, p_recorder uuid, p_ops jsonb, p_to_reconcile integer DEFAULT 0, p_actor uuid DEFAULT NULL::uuid, p_findings jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_loc uuid;
  v_live boolean;
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
  SELECT r.location_id, (r.monitoring_enabled AND a.enabled AND l.is_active AND l.archived_at IS NULL) INTO v_loc, v_live
  FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL JOIN public.locations l ON l.id = r.location_id
  WHERE r.id = p_recorder AND r.org_id = p_org FOR UPDATE OF r;
  IF v_loc IS NULL THEN RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT v_live THEN RAISE EXCEPTION 'this NVR was switched off (or its location) while it was asked; nothing was saved' USING ERRCODE = '55000'; END IF;
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
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_apply_proposals(p_org uuid, p_items jsonb, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_archive(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_at timestamptz := now();
  v_n integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_kind NOT IN ('camera', 'asset', 'recorder', 'location', 'cluster', 'region') THEN
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  v_people := public.inventory_affected_people(p_org, p_kind, p_id);
  IF p_kind = 'camera' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings SET valid_to = greatest(v_at, valid_from + interval '1 microsecond')
    WHERE camera_id = p_id AND org_id = p_org AND valid_to IS NULL;
    UPDATE public.cameras SET archived_was_active = is_active, is_active = false, archived_at = v_at, recorder_id = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    PERFORM set_config('drishti.mapping_sync', '', true);
  ELSIF p_kind IN ('asset', 'recorder') THEN
    IF p_kind = 'recorder' AND NOT EXISTS (SELECT 1 FROM public.recorders r WHERE r.id = p_id AND r.org_id = p_org) THEN
      RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM public.camera_channel_mappings m WHERE m.recorder_id = p_id AND m.valid_to IS NULL) THEN
      RAISE EXCEPTION 'move or archive the cameras of this NVR first' USING ERRCODE = 'DR004';
    END IF;
    UPDATE public.assets SET archived_was_enabled = enabled, enabled = false, archived_at = v_at
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    PERFORM set_config('drishti.mapping_sync', 'on', true);
    UPDATE public.camera_channel_mappings m SET valid_to = greatest(v_at, m.valid_from + interval '1 microsecond')
    FROM public.cameras c WHERE m.camera_id = c.id AND c.location_id = p_id AND c.org_id = p_org AND m.valid_to IS NULL;
    UPDATE public.cameras SET archived_was_active = is_active, is_active = false, archived_at = v_at, recorder_id = NULL
    WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    PERFORM set_config('drishti.mapping_sync', '', true);
    UPDATE public.assets SET archived_was_enabled = enabled, enabled = false, archived_at = v_at
    WHERE location_id = p_id AND org_id = p_org AND archived_at IS NULL;
    UPDATE public.locations SET archived_was_active = is_active, is_active = false, archived_at = v_at
    WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'cluster' THEN
    IF EXISTS (SELECT 1 FROM public.locations l WHERE l.cluster_id = p_id AND l.org_id = p_org AND l.archived_at IS NULL) THEN
      RAISE EXCEPTION 'the cluster still has locations: move or archive them first' USING ERRCODE = 'DR007';
    END IF;
    UPDATE public.clusters SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    IF EXISTS (SELECT 1 FROM public.clusters c WHERE c.region_id = p_id AND c.org_id = p_org AND c.archived_at IS NULL) THEN
      RAISE EXCEPTION 'the region still has clusters: move or archive them first' USING ERRCODE = 'DR007';
    END IF;
    UPDATE public.regions SET archived_at = v_at WHERE id = p_id AND org_id = p_org AND archived_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_archived', p_kind, p_id, jsonb_build_object('archived_at', v_at, 'affected_people', cardinality(v_people)));
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id, 'archived_at', v_at);
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_move_cluster(p_org uuid, p_cluster uuid, p_region uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old uuid;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT c.region_id INTO v_old FROM public.clusters c WHERE c.id = p_cluster AND c.org_id = p_org AND c.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002'; END IF;
  IF p_region IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.regions r WHERE r.id = p_region AND r.org_id = p_org AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'region not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  UPDATE public.clusters SET region_id = p_region WHERE id = p_cluster;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('from', v_old, 'to', p_region);
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_move_location(p_org uuid, p_location uuid, p_cluster uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old uuid;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  SELECT l.cluster_id INTO v_old FROM public.locations l WHERE l.id = p_location AND l.org_id = p_org AND l.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
  IF p_cluster IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.clusters c WHERE c.id = p_cluster AND c.org_id = p_org AND c.archived_at IS NULL) THEN
    RAISE EXCEPTION 'cluster not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('drishti.actor', coalesce(p_actor::text, ''), true);
  UPDATE public.locations SET cluster_id = p_cluster WHERE id = p_location;
  PERFORM set_config('drishti.actor', '', true);
  RETURN jsonb_build_object('from', v_old, 'to', p_cluster);
END
$function$
;

CREATE OR REPLACE FUNCTION public.inventory_restore(p_org uuid, p_kind text, p_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_at timestamptz;
  v_n integer := 0;
  v_people uuid[];
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_kind = 'camera' THEN
    UPDATE public.cameras SET archived_at = NULL, is_active = coalesce(archived_was_active, true), archived_was_active = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind IN ('asset', 'recorder') THEN
    UPDATE public.assets SET archived_at = NULL, enabled = coalesce(archived_was_enabled, true), archived_was_enabled = NULL
    WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'location' THEN
    SELECT l.archived_at INTO v_at FROM public.locations l WHERE l.id = p_id AND l.org_id = p_org AND l.archived_at IS NOT NULL;
    IF v_at IS NOT NULL THEN
      UPDATE public.locations SET archived_at = NULL, is_active = coalesce(archived_was_active, true), archived_was_active = NULL WHERE id = p_id;
      v_n := 1;
      -- What was archived with it comes back with it, in the state it had.
      UPDATE public.assets SET archived_at = NULL, enabled = coalesce(archived_was_enabled, true), archived_was_enabled = NULL
      WHERE location_id = p_id AND archived_at = v_at;
      UPDATE public.cameras SET archived_at = NULL, is_active = coalesce(archived_was_active, true), archived_was_active = NULL
      WHERE location_id = p_id AND archived_at = v_at;
    END IF;
  ELSIF p_kind = 'cluster' THEN
    UPDATE public.clusters SET archived_at = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_kind = 'region' THEN
    UPDATE public.regions SET archived_at = NULL WHERE id = p_id AND org_id = p_org AND archived_at IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unknown kind' USING ERRCODE = '22023';
  END IF;
  IF v_n = 0 THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  v_people := public.inventory_affected_people(p_org, p_kind, p_id);
  PERFORM public.access_bump_versions(v_people);
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, 'inventory_restored', p_kind, p_id, jsonb_build_object('affected_people', cardinality(v_people)));
  RETURN jsonb_build_object('kind', p_kind, 'id', p_id);
END
$function$
;

CREATE OR REPLACE FUNCTION public.mfa_enforced_for_user(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT coalesce((SELECT s.mfa_enforced FROM public.security_settings s JOIN public.profiles p ON p.org_id = s.org_id WHERE p.id = p_user), false)
$function$
;

CREATE OR REPLACE FUNCTION public.ops_health_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_level text;
  v_applied integer := 0;
  v_vault boolean := false;
  v_hk jsonb;
BEGIN
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(version)::text, count(*)::integer FROM supabase_migrations.schema_migrations' INTO v_level, v_applied;
  END IF;
  BEGIN
    SELECT ds.decrypted_secret = 'drishti-vault-canary-v1' INTO v_vault FROM vault.decrypted_secrets ds WHERE ds.name = 'drishti_vault_canary';
    v_vault := coalesce(v_vault, false);
  EXCEPTION WHEN OTHERS THEN
    v_vault := false;
  END;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'task', h.task, 'last_run_at', h.last_run_at, 'removed', h.last_removed, 'db_role', h.db_role) ORDER BY h.task), '[]'::jsonb)
  INTO v_hk FROM public.housekeeping_runs h;
  RETURN pg_catalog.jsonb_build_object(
    'db_time', now(),
    'migration', pg_catalog.jsonb_build_object('level', v_level, 'applied', v_applied),
    'vault', pg_catalog.jsonb_build_object('ok', v_vault),
    'housekeeping', v_hk,
    'test_fixtures', pg_catalog.jsonb_build_object(
      'on', public.test_fixtures_enabled(),
      'production', coalesce((SELECT t.production FROM public.test_fixture_switch t WHERE t.id), false)));
END
$function$
;

CREATE OR REPLACE FUNCTION public.recorder_save(p_org uuid, p_location uuid, p_recorder uuid, p_host text, p_http_port integer, p_rtsp_port integer, p_username text, p_expected_channels integer DEFAULT 0, p_name text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  l public.locations%ROWTYPE;
  v_id uuid := p_recorder;
  v_space uuid;
  v_try integer;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_created boolean := false;
BEGIN
  PERFORM public.access_check_actor(p_org, p_actor);
  IF p_host IS NULL OR btrim(p_host) = '' OR length(p_host) > 253 THEN RAISE EXCEPTION 'an NVR address is needed' USING ERRCODE = '22023'; END IF;
  IF p_http_port IS NULL OR p_http_port NOT BETWEEN 1 AND 65535 OR p_rtsp_port IS NULL OR p_rtsp_port NOT BETWEEN 1 AND 65535 THEN
    RAISE EXCEPTION 'a port must be from 1 to 65535' USING ERRCODE = '22023';
  END IF;
  IF p_expected_channels IS NOT NULL AND p_expected_channels NOT BETWEEN 0 AND 999 THEN
    RAISE EXCEPTION 'the number of cameras must be from 0 to 999' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 200 THEN RAISE EXCEPTION 'the NVR name is too long' USING ERRCODE = '22023'; END IF;
  SELECT * INTO l FROM public.locations x WHERE x.id = p_location AND x.org_id = p_org AND x.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'location not found' USING ERRCODE = 'P0002'; END IF;
  IF v_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
       WHERE r.id = v_id AND r.org_id = p_org AND r.location_id = p_location) THEN
    RAISE EXCEPTION 'recorder not found' USING ERRCODE = 'P0002';
  END IF;
  -- M-2: two NVRs of one location at the same address and web port are one box typed twice.
  IF EXISTS (
       SELECT 1 FROM public.recorders r JOIN public.assets a ON a.id = r.id AND a.archived_at IS NULL
       WHERE r.location_id = p_location AND r.id IS DISTINCT FROM v_id AND a.ip = btrim(p_host) AND r.http_port = p_http_port) THEN
    RAISE EXCEPTION 'another NVR of this location already has this address' USING ERRCODE = 'DR010';
  END IF;
  FOR v_try IN 1..2 LOOP
    BEGIN
      IF v_id IS NULL THEN
        -- I-4: switched on (before: switched on only when the location was active, and never switched on again).
        INSERT INTO public.assets (org_id, location_id, type, name, ip, tcp_port, enabled, address_space_id)
        VALUES (p_org, p_location, 'nvr', coalesce(v_name, 'NVR'), btrim(p_host), p_http_port, true, v_space)
        RETURNING id INTO v_id;
        INSERT INTO public.recorders (id, org_id, location_id, http_port, rtsp_port, username, expected_channels, created_asset)
        VALUES (v_id, p_org, p_location, p_http_port, p_rtsp_port, nullif(btrim(coalesce(p_username, '')), ''), coalesce(p_expected_channels, 0), true);
        v_created := true;
      ELSE
        UPDATE public.assets SET ip = btrim(p_host), tcp_port = p_http_port, name = coalesce(v_name, name),
               address_space_id = coalesce(v_space, address_space_id), enabled = true
        WHERE id = v_id AND (ip, tcp_port, name, address_space_id, enabled) IS DISTINCT FROM (btrim(p_host), p_http_port, coalesce(v_name, name), coalesce(v_space, address_space_id), true);
        UPDATE public.recorders SET http_port = p_http_port, rtsp_port = p_rtsp_port, username = nullif(btrim(coalesce(p_username, '')), ''),
               expected_channels = coalesce(p_expected_channels, expected_channels)
        WHERE id = v_id;
      END IF;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_try = 2 THEN RAISE; END IF;
      -- The address is taken in the company network: this location gets (or reuses) its own address space (D5-8).
      IF p_recorder IS NULL THEN v_id := NULL; v_created := false; END IF;
      SELECT s.id INTO v_space FROM public.address_spaces s WHERE s.location_id = l.id AND s.kind = 'location_nat';
      IF v_space IS NULL THEN
        INSERT INTO public.address_spaces (org_id, name, kind, location_id, notes)
        VALUES (l.org_id, 'Location ' || l.code || ' (own addresses)', 'location_nat', l.id,
                'Made because an NVR address of this location is also used elsewhere (SD-WAN addressing unknown, D5-8).')
        RETURNING id INTO v_space;
      END IF;
    END;
  END LOOP;
  INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_org, p_actor, CASE WHEN v_created THEN 'recorder_created' ELSE 'recorder_updated' END, 'recorder', v_id,
          jsonb_build_object('location_id', p_location, 'own_address_space', v_space IS NOT NULL));
  RETURN v_id;
END
$function$
;

CREATE OR REPLACE FUNCTION public.security_settings_audit_mfa()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_from boolean := CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.mfa_enforced END;
BEGIN
  IF NEW.mfa_enforced IS DISTINCT FROM v_from THEN
    INSERT INTO public.admin_audit_log (org_id, actor_id, action, entity_type, entity_id, detail)
    VALUES (NEW.org_id, NULL, 'mfa_enforced_changed', 'organization', NEW.org_id,
            pg_catalog.jsonb_build_object('from', v_from, 'to', NEW.mfa_enforced, 'db_user', session_user::text, 'note', NEW.note));
  END IF;
  RETURN NEW;
END
$function$
;


-- After the old definitions (mfa_enforced_for_user and ops_health_status no longer use them).
DROP FUNCTION public.security_mfa_overview();
DROP FUNCTION public.access_admin_lock(uuid);
DROP FUNCTION public.inventory_check_admin(uuid, uuid);
ALTER TABLE public.security_settings DROP CONSTRAINT security_settings_mfa_off_check;
ALTER TABLE public.security_settings ALTER COLUMN mfa_enforced SET DEFAULT false;
ALTER TABLE public.security_settings DROP COLUMN mfa_off_reason, DROP COLUMN mfa_off_by, DROP COLUMN mfa_off_at;
DROP FUNCTION public.mfa_default_enforced();
CREATE TRIGGER security_settings_audit_mfa AFTER INSERT OR UPDATE OF mfa_enforced ON public.security_settings
  FOR EACH ROW EXECUTE FUNCTION public.security_settings_audit_mfa();

REVOKE ALL ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid), public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid),
  public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb), public.inventory_apply_proposals(uuid, jsonb, uuid),
  public.inventory_archive(uuid, text, uuid, uuid), public.inventory_move_cluster(uuid, uuid, uuid, uuid),
  public.inventory_move_location(uuid, uuid, uuid, uuid), public.inventory_restore(uuid, text, uuid, uuid),
  public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid),
  public.change_person_role(uuid, uuid, uuid, public.user_role, bigint)
  FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.camera_merge(uuid, uuid, uuid, uuid), public.camera_remap(uuid, uuid, uuid, integer, timestamptz, uuid),
  public.discovery_apply(uuid, uuid, jsonb, integer, uuid, jsonb), public.inventory_apply_proposals(uuid, jsonb, uuid),
  public.inventory_archive(uuid, text, uuid, uuid), public.inventory_move_cluster(uuid, uuid, uuid, uuid),
  public.inventory_move_location(uuid, uuid, uuid, uuid), public.inventory_restore(uuid, text, uuid, uuid),
  public.recorder_save(uuid, uuid, uuid, text, integer, integer, text, integer, text, uuid),
  public.change_person_role(uuid, uuid, uuid, public.user_role, bigint)
  TO service_role, app_web;
REVOKE ALL ON FUNCTION public.access_grants_before_insert(), public.access_check_manager(uuid, uuid, uuid),
  public.access_check_people_admin(uuid, uuid, uuid, public.user_role), public.security_settings_audit_mfa(), public.mfa_enforced_for_user(uuid)
  FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
REVOKE ALL ON FUNCTION public.ops_health_status() FROM PUBLIC, anon, authenticated, service_role, app_web, media_service, monitor_worker, video_gateway;
GRANT EXECUTE ON FUNCTION public.ops_health_status() TO app_web, service_role;
GRANT EXECUTE ON FUNCTION public.recorder_store_credential(uuid, text) TO service_role, app_web;
GRANT EXECUTE ON FUNCTION public.revoke_user_sessions(uuid) TO service_role, app_web;
GRANT INSERT ON TABLE public.profiles TO app_web;

DROP POLICY profiles_select_org ON public.profiles;
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.users')));
DROP POLICY access_grants_select ON public.access_grants;
CREATE POLICY access_grants_select ON public.access_grants FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = (SELECT auth.uid()) OR (SELECT public.has_capability('admin.access'))));
DROP POLICY admin_audit_log_select ON public.admin_audit_log;
CREATE POLICY admin_audit_log_select ON public.admin_audit_log FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.audit.read')));
DROP POLICY auth_events_select ON public.auth_events;
CREATE POLICY auth_events_select ON public.auth_events FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.has_capability('admin.audit.read')));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.privilege_violations()) THEN RAISE EXCEPTION 'rollback of 0049: privilege_violations() is not empty'; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

\if :{?drishti_dry_run}
ROLLBACK;
\else
COMMIT;
\endif
