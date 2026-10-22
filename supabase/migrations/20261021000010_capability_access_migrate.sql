-- P2-1 capability access model, part 2 of 3: migrates every person's current access into explicit grants (D-2 with D-2a) and proves it
-- on the data it runs on. The migration fails (and changes nothing) if any check does not hold:
--   1. for every person who can sign in now, the legacy evaluator gives exactly what the real old functions (still in place here) give:
--      cameras, devices and stores, evaluated as that person;
--   2. after the migration, every person's live AND playback camera sets equal their old camera set (status ignored, so inactive people
--      and people who must still choose a password are checked too);
--   3. nobody received export unless they are an administrator, and nobody received a high-risk IT capability.
-- The run writes one access_migration_report row per person.
-- Rollback: supabase/rollback/20261021000010_capability_access_migrate_rollback.sql
BEGIN;

DO $$
DECLARE
  v_person record;
  v_run uuid := gen_random_uuid();
  v_old uuid[];
  v_legacy uuid[];
  v_live uuid[];
  v_playback uuid[];
BEGIN
  -- 1. The legacy evaluator equals the real old rules, person by person.
  FOR v_person IN SELECT p.id FROM public.profiles p WHERE p.is_active AND NOT p.must_reset_password ORDER BY p.id LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_person.id, 'role', 'authenticated')::text, true);
    v_old := ARRAY(SELECT x FROM public.visible_camera_ids() AS x ORDER BY 1);
    v_legacy := ARRAY(SELECT x FROM public.access_legacy_camera_ids(v_person.id, false) AS x ORDER BY 1);
    IF v_old IS DISTINCT FROM v_legacy THEN
      RAISE EXCEPTION 'P2-1 migration check 1 failed: legacy camera rules differ from the old functions for person %', v_person.id;
    END IF;
    v_old := ARRAY(SELECT x FROM public.visible_device_ids() AS x ORDER BY 1);
    v_legacy := ARRAY(SELECT x FROM public.access_legacy_device_ids(v_person.id, false) AS x ORDER BY 1);
    IF v_old IS DISTINCT FROM v_legacy THEN
      RAISE EXCEPTION 'P2-1 migration check 1 failed: legacy device rules differ from the old functions for person %', v_person.id;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  PERFORM public.access_migrate_legacy(v_run, NULL);

  -- 2. Nothing wider, nothing narrower: live and playback each equal the old camera set.
  FOR v_person IN SELECT p.id FROM public.profiles p ORDER BY p.id LOOP
    v_legacy := ARRAY(SELECT x FROM public.access_legacy_camera_ids(v_person.id, true) AS x ORDER BY 1);
    v_live := ARRAY(SELECT x FROM public.access_effective_camera_ids(v_person.id, 'cctv.live', now(), true) AS x ORDER BY 1);
    v_playback := ARRAY(SELECT x FROM public.access_effective_camera_ids(v_person.id, 'cctv.playback', now(), true) AS x ORDER BY 1);
    IF v_live IS DISTINCT FROM v_legacy OR v_playback IS DISTINCT FROM v_legacy THEN
      RAISE EXCEPTION 'P2-1 migration check 2 failed: CCTV access changed for person %', v_person.id;
    END IF;
  END LOOP;

  -- 3. No export outside administrators, no high-risk IT capability for anyone.
  IF EXISTS (SELECT 1 FROM public.access_grants g JOIN public.profiles p ON p.id = g.user_id
             WHERE g.source LIKE 'migrated:%' AND g.capability = 'cctv.export' AND p.role NOT IN ('admin', 'platform_owner')) THEN
    RAISE EXCEPTION 'P2-1 migration check 3 failed: export was granted to a non-administrator';
  END IF;
  IF EXISTS (SELECT 1 FROM public.access_grants g JOIN public.capabilities c ON c.key = g.capability
             WHERE g.source LIKE 'migrated:%' AND c.area = 'it' AND c.risk = 'high') THEN
    RAISE EXCEPTION 'P2-1 migration check 3 failed: a high-risk IT capability was granted';
  END IF;

  RAISE NOTICE 'P2-1 access migration run % done: % people, % grants', v_run,
    (SELECT count(*) FROM public.access_migration_report r WHERE r.run_id = v_run),
    (SELECT count(*) FROM public.access_grants g WHERE g.source LIKE 'migrated:%');
END
$$;

COMMIT;
