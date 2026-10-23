// P5.4 fix round 2 (migration 20261021000046_p54_fixture_guards.sql; p5-4-rereview.md N-2, release1-cleanups-review.md Important 1):
//   - every test helper needs BOTH the test fixture switch on AND an organisation MADE as a test one (or, for the clean-ups, made as
//     the demo one: created_as_demo, fixed at creation). A real organisation renamed to test-… or to demo-sample-data is refused by
//     every helper, with the switch on and with it off;
//   - an API role cannot rename an organisation into demo-sample-data, nor set either marker;
//   - a database marked as a production one never turns the switch on again (supabase/seed.sql fails there), and the mark stays.
// Everything runs as the database owner (psql in the database container) in transactions that are rolled back: no organisation, person
// or session is left behind, and the switch is as it was.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { serviceClient } from '../setup/service-keys'

const skip = process.env.DRISHTI_SKIP_DOCKER_TESTS === '1'

function ownerSql(sql: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_cctv_hub', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (c) => resolve({ code: c, out, err }))
    p.stdin.end(sql)
  })
}
const rows = (out: string) => out.trim().split(/\r?\n/).filter((l) => l.includes('|')).map((l) => l.split('|'))

// One person and one media session of an organisation, as the owner (for the helpers that act on people and sessions).
const person = (slugExpr: string, tag: string) => `
  INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), '${tag}@example.test');
  INSERT INTO public.profiles (id, org_id, email, full_name, role)
    SELECT u.id, o.id, u.email, 'Guard probe', 'user' FROM auth.users u, public.organizations o WHERE u.email = '${tag}@example.test' AND o.slug = ${slugExpr};
  INSERT INTO public.media_sessions (org_id, user_id, kind, capability, camera_id, stream, connect_by, expires_at)
    SELECT p.org_id, p.id, 'live', 'cctv.live', gen_random_uuid(), 'guardprobe', now() + interval '1 minute', now() + interval '5 minutes'
    FROM public.profiles p WHERE p.email = '${tag}@example.test';`

// Every helper, for one organisation, with the switch as given; one result row per helper: ALLOWED or the SQLSTATE it refused with.
const probeAll = `
  CREATE OR REPLACE FUNCTION pg_temp.guard_probe(p_label text, p_org uuid, p_switch boolean) RETURNS SETOF text LANGUAGE plpgsql AS $f$
  DECLARE
    v_user uuid := (SELECT p.id FROM public.profiles p WHERE p.org_id = p_org LIMIT 1);
    v_sid uuid := (SELECT m.id FROM public.media_sessions m WHERE m.org_id = p_org LIMIT 1);
    v_fn text;
  BEGIN
    UPDATE public.test_fixture_switch SET honoured = p_switch;
    FOREACH v_fn IN ARRAY ARRAY['audit_purge_test_org', 'inventory_purge_test_org', 'access_teardown_test_org_people', 'inventory_require_test_org',
                                'access_catalogue_probe_test', 'access_migrate_legacy_test', 'media_sessions_age_test', 'worker_fence_org', 'worker_lease_forget_test'] LOOP
      BEGIN
        CASE v_fn
          WHEN 'audit_purge_test_org' THEN PERFORM public.audit_purge_test_org(p_org);
          WHEN 'inventory_purge_test_org' THEN PERFORM public.inventory_purge_test_org(p_org);
          WHEN 'access_teardown_test_org_people' THEN PERFORM public.access_teardown_test_org_people(p_org);
          WHEN 'inventory_require_test_org' THEN PERFORM public.inventory_require_test_org(p_org);
          WHEN 'access_catalogue_probe_test' THEN PERFORM public.access_catalogue_probe_test(p_org);
          WHEN 'access_migrate_legacy_test' THEN PERFORM public.access_migrate_legacy_test(gen_random_uuid(), ARRAY[v_user]);
          WHEN 'media_sessions_age_test' THEN PERFORM public.media_sessions_age_test(v_sid, 10);
          WHEN 'worker_fence_org' THEN PERFORM public.worker_fence_org('test:' || p_org::text, 1, p_org);
          WHEN 'worker_lease_forget_test' THEN PERFORM public.worker_lease_forget_test();
        END CASE;
        RETURN NEXT format('%s|%s|%s|ALLOWED', p_label, p_switch::text, v_fn);
        RAISE EXCEPTION 'undo' USING ERRCODE = 'P0099';
      EXCEPTION
        WHEN SQLSTATE 'P0099' THEN NULL;
        WHEN OTHERS THEN RETURN NEXT format('%s|%s|%s|%s', p_label, p_switch::text, v_fn, SQLSTATE);
      END;
    END LOOP;
  END
  $f$;`

describe.skipIf(skip)('test helpers: the switch AND a marker fixed at creation (migration 0046)', () => {
  it('a real organisation renamed to test-… or to demo-sample-data is refused by every helper, with the switch on and off; a real test organisation only with the switch on', async () => {
    const tag = randomUUID().slice(0, 8)
    const r = await ownerSql(`BEGIN;
      UPDATE public.organizations SET slug = 'demo-moved-' || left(id::text, 8) WHERE slug = 'demo-sample-data';
      INSERT INTO public.organizations (name, slug) VALUES ('Real T ${tag}', 'real-t-${tag}'), ('Real D ${tag}', 'real-d-${tag}'), ('test-g-${tag}', 'test-g-${tag}');
      ${person(`'real-t-${tag}'`, `t-${tag}`)}
      ${person(`'real-d-${tag}'`, `d-${tag}`)}
      ${person(`'test-g-${tag}'`, `g-${tag}`)}
      UPDATE public.organizations SET slug = 'test-r-${tag}' WHERE slug = 'real-t-${tag}';
      UPDATE public.organizations SET slug = 'demo-sample-data', name = 'DEMO renamed ${tag}' WHERE slug = 'real-d-${tag}';
      ${probeAll}
      SELECT pg_temp.guard_probe('renamed-test', (SELECT id FROM public.organizations WHERE slug = 'test-r-${tag}'), true);
      SELECT pg_temp.guard_probe('renamed-test', (SELECT id FROM public.organizations WHERE slug = 'test-r-${tag}'), false);
      SELECT pg_temp.guard_probe('renamed-demo', (SELECT id FROM public.organizations WHERE slug = 'demo-sample-data'), true);
      SELECT pg_temp.guard_probe('renamed-demo', (SELECT id FROM public.organizations WHERE slug = 'demo-sample-data'), false);
      SELECT pg_temp.guard_probe('made-test', (SELECT id FROM public.organizations WHERE slug = 'test-g-${tag}'), true);
      SELECT pg_temp.guard_probe('made-test', (SELECT id FROM public.organizations WHERE slug = 'test-g-${tag}'), false);
      ROLLBACK;`)
    expect(r.code, r.err).toBe(0)
    const got = rows(r.out)
    expect(got.length, r.out).toBe(54)
    const outcome = (label: string, sw: string, fn: string) => got.find((g) => g[0] === label && g[1] === sw && g[2] === fn)?.[3]
    const helpers = ['audit_purge_test_org', 'inventory_purge_test_org', 'access_teardown_test_org_people', 'inventory_require_test_org',
      'access_catalogue_probe_test', 'access_migrate_legacy_test', 'media_sessions_age_test', 'worker_fence_org']
    for (const label of ['renamed-test', 'renamed-demo']) {
      for (const sw of ['true', 'false']) {
        for (const fn of helpers) expect(outcome(label, sw, fn), `${label} switch=${sw} ${fn}`).toBe(fn === 'worker_fence_org' ? 'WL002' : '42501')
      }
    }
    // With the switch off, nothing runs, not even for an organisation made by the tests.
    for (const fn of [...helpers, 'worker_lease_forget_test']) expect(outcome('made-test', 'false', fn), `made-test off ${fn}`).toBe(fn === 'worker_fence_org' ? 'WL002' : '42501')
    // With it on, an organisation made by the tests is still cleaned up (the fence then asks for a real lease, not WL002).
    for (const fn of helpers.filter((f) => f !== 'worker_fence_org')) expect(outcome('made-test', 'true', fn), `made-test on ${fn}`).toBe('ALLOWED')
    expect(outcome('made-test', 'true', 'worker_fence_org')).not.toBe('WL002')
    expect(outcome('made-test', 'true', 'worker_lease_forget_test')).toBe('ALLOWED')
  })

  it('an API role cannot rename an organisation into demo-sample-data or test-…, nor set created_as_test or created_as_demo; the owner rename keeps both false', async () => {
    const tag = randomUUID().slice(0, 8)
    const r = await ownerSql(`BEGIN;
      UPDATE public.organizations SET slug = 'demo-moved-' || left(id::text, 8) WHERE slug = 'demo-sample-data';
      INSERT INTO public.organizations (name, slug) VALUES ('Real A ${tag}', 'real-a-${tag}'), ('test-a-${tag}', 'test-a-${tag}');
      CREATE TEMP TABLE out (k text, v text);
      GRANT INSERT ON out TO service_role;
      SET LOCAL ROLE service_role;
      DO $d$
      BEGIN
        BEGIN UPDATE public.organizations SET slug = 'demo-sample-data', name = 'DEMO x' WHERE slug = 'test-a-${tag}'; INSERT INTO out VALUES ('rename test to demo', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('rename test to demo', SQLSTATE); END;
        BEGIN UPDATE public.organizations SET slug = 'demo-sample-data', name = 'DEMO x' WHERE slug = 'real-a-${tag}'; INSERT INTO out VALUES ('rename real to demo', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('rename real to demo', SQLSTATE); END;
        BEGIN UPDATE public.organizations SET slug = 'test-b-${tag}' WHERE slug = 'real-a-${tag}'; INSERT INTO out VALUES ('rename real to test', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('rename real to test', SQLSTATE); END;
        UPDATE public.organizations SET created_as_test = true, created_as_demo = true WHERE slug = 'real-a-${tag}';
        -- The control: the service role may rename (a test organisation within the test names), so the refusals above are the guard's.
        BEGIN UPDATE public.organizations SET slug = 'test-c-${tag}' WHERE slug = 'test-a-${tag}'; INSERT INTO out VALUES ('control rename test to test', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('control rename test to test', SQLSTATE); END;
      END
      $d$;
      RESET ROLE;
      UPDATE public.organizations SET slug = 'demo-sample-data', name = 'DEMO by owner' WHERE slug = 'real-a-${tag}';
      SELECT k, v FROM out ORDER BY k;
      SELECT 'markers', created_as_test::text || ',' || created_as_demo::text FROM public.organizations WHERE slug = 'demo-sample-data';
      ROLLBACK;`)
    expect(r.code, r.err).toBe(0)
    expect(Object.fromEntries(rows(r.out))).toEqual({
      'rename test to demo': '42501',
      'rename real to demo': '42501',
      'rename real to test': '42501',
      'control rename test to test': 'ALLOWED',
      markers: 'false,false',
    })
  })

  it('a database marked as a production one: the switch cannot be turned on (as supabase/seed.sql does), the mark cannot be taken back, the row cannot go', async () => {
    const r = await ownerSql(`BEGIN;
      UPDATE public.test_fixture_switch SET honoured = false, production = true;
      CREATE TEMP TABLE out (k text, v text);
      DO $d$
      BEGIN
        BEGIN UPDATE public.test_fixture_switch SET honoured = true; INSERT INTO out VALUES ('seed', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('seed', SQLSTATE || ' ' || SQLERRM); END;
        BEGIN UPDATE public.test_fixture_switch SET production = false; INSERT INTO out VALUES ('unmark', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('unmark', SQLSTATE); END;
        BEGIN DELETE FROM public.test_fixture_switch; INSERT INTO out VALUES ('delete', 'ALLOWED');
        EXCEPTION WHEN OTHERS THEN INSERT INTO out VALUES ('delete', SQLSTATE); END;
      END
      $d$;
      SELECT k, v FROM out ORDER BY k;
      SELECT 'ops', (public.ops_health_status() -> 'test_fixtures')::text;
      ROLLBACK;`)
    expect(r.code, r.err).toBe(0)
    const got = Object.fromEntries(rows(r.out))
    expect(got.seed).toMatch(/^42501 .*production database.*seed\.sql must never be applied here/)
    expect(got.unmark).toBe('42501')
    expect(got.delete).toBe('42501')
    expect(JSON.parse(got.ops)).toEqual({ on: false, production: true })
  })

  it('test_fixtures_enabled() answers the web app (its production start-up refuses while it is on); the worker and the gateway may not ask (fenced functions only)', async () => {
    for (const role of ['app_web'] as const) {
      const { data, error } = await (serviceClient(role).rpc as unknown as (f: string) => PromiseLike<{ data: unknown; error: { code?: string } | null }>)('test_fixtures_enabled')
      expect(error, role).toBeNull()
      expect(data, role).toBe(true) // the local test stack (supabase/seed.sql)
    }
    for (const role of ['monitor_worker', 'video_gateway', 'media_service'] as const) {
      const { error } = await (serviceClient(role).rpc as unknown as (f: string) => PromiseLike<{ error: { code?: string } | null }>)('test_fixtures_enabled')
      expect(error?.code, role).toBe('42501')
    }
  })
})
