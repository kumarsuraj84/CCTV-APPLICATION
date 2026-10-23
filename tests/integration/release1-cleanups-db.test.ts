import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSharedLimiter, databaseStore, SIGN_IN_IP_LIMIT } from '@/lib/rate-limit-shared'
import { adminClient, atLocation, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

// Release 1 clean-up package, the database items of migration 20261021000044 (release1-cleanups.md):
//   P2-4 re-review N1 / N3   the commit-time re-check of open video: a failed re-check keeps the person marked; the 1,000 budget; a second
//                            transaction of the same person is re-checked again (nothing leaks between transactions).
//   P2-7 re-review R-5       the test fixtures' header works only while the database switch says so (production: off).
//   P2-6 re-review N-3       the per-address ceiling of sign-ins counts failures only.
//   P4-L2 re-review N-1      a fast playback session never reopens after its first stream ended.
//   P3-1 re-review N-4       deleting the security settings row is audited, emptying the table is refused, and an organisation that was
//                            not made by the tests cannot be renamed into the tests' namespace by an API role (the test helpers trust it).
// The tests that need a second database session or the database owner use psql in the database container (docker exec), as in
// worker-lease.test.ts; every owner-side change they make is inside a transaction that is rolled back, or on the tests' own rows.

const admin = () => adminClient()
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_cctv_hub'
function dockerPsqlAvailable(): boolean {
  try {
    execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-At', '-c', 'select 1'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/** SQL in its own database session (as the database owner); resolves when it ends, with the time it took. */
function psql(sql: string): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (c) => resolve({ code: c, out, err, ms: Date.now() - t0 }))
    p.stdin.end(sql)
  })
}
const skipDocker = process.env.DRISHTI_SKIP_DOCKER_TESTS === '1'
const canPsql = dockerPsqlAvailable()
const needPsql = () => {
  if (!canPsql) throw new Error(`These tests need psql in the database container ${DB_CONTAINER} (docker exec). Start Docker, or set DRISHTI_SKIP_DOCKER_TESTS=1 to skip them on purpose.`)
}
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const count = (s: string, part: string) => s.split(part).length - 1

describe('release 1 clean-ups: the database (migration 0044)', () => {
  let orgId: string
  let loc: string
  let cam: string
  beforeAll(async () => {
    orgId = await createOrg()
    loc = await createLocation(orgId)
    const rec = await createRecorder(orgId, loc, { host: '10.144.0.1' })
    cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
  })

  /** A person who watches `cam`: `n` opened live sessions (made in batches of 100, then marked opened by the owner). */
  async function watcher(n: number): Promise<{ u: TestUser; grantId: string }> {
    const u = await createUser(orgId, 'operator')
    const [grantId] = await grant(orgId, u.id, 'cctv.live', atLocation(loc))
    const batches = Math.ceil(n / 100)
    const made = await psql(`SELECT count(*) FROM generate_series(1, ${batches}) g,
      LATERAL public.media_session_create('${orgId}'::uuid, '${u.id}'::uuid, 'live', array_fill('${cam}'::uuid, ARRAY[100 + 0 * g]), array_fill('cam_${cam}_sub'::text, ARRAY[100 + 0 * g])) s;
      UPDATE public.media_sessions SET opened_at = now(), last_validated_at = now() WHERE user_id = '${u.id}'::uuid
        AND id IN (SELECT id FROM public.media_sessions WHERE user_id = '${u.id}'::uuid ORDER BY id LIMIT ${n});
      DELETE FROM public.media_sessions WHERE user_id = '${u.id}'::uuid AND opened_at IS NULL;`)
    expect(made.code, made.err).toBe(0)
    return { u, grantId }
  }
  const revokedOf = async (userId: string) => {
    const { count: c, error } = await admin().from('media_sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId).not('revoked_at', 'is', null)
    if (error) throw new Error(error.message)
    return c ?? 0
  }

  describe('P2-4 re-review N1 / N3: the commit-time re-check of open video', () => {
    it.skipIf(skipDocker)('N1: a person whose sessions are locked is waited for once per transaction (2 s), not once per event; the change commits', async () => {
      needPsql()
      const { u, grantId } = await watcher(3)
      // Session L holds the person's session rows for 8 s.
      const holder = psql(`BEGIN; SELECT count(*) FROM (SELECT id FROM public.media_sessions WHERE user_id = '${u.id}'::uuid FOR UPDATE) x; SELECT pg_sleep(8); COMMIT;`)
      await sleepMs(1000)
      // Session T: three access events of the same person in one transaction (a revocation and two more version bumps).
      const t = await psql(`BEGIN;
        SELECT public.revoke_grant('${orgId}'::uuid, '${u.id}'::uuid, ARRAY['${grantId}'::uuid]);
        SELECT public.access_bump_version('${u.id}'::uuid);
        SELECT public.access_bump_version('${u.id}'::uuid);
        COMMIT;`)
      const h = await holder
      expect(h.code, h.err).toBe(0)
      expect(t.code, t.err).toBe(0) // the access change itself never fails on the lock wait
      expect(count(t.err, 're-check after an access change failed')).toBe(1) // one failed re-check, the other events skip it
      expect(t.ms).toBeLessThan(4500) // before 0044: about 3 × 2 s
      expect(t.ms).toBeGreaterThan(1500) // it did wait for the lock once
      // The re-check could not run, so the sessions are left to the gateway's check (which revokes them through media_sessions_still_valid).
      expect(await revokedOf(u.id)).toBe(0)
    }, 30_000)

    it.skipIf(skipDocker)('N3: two people with 600 open sessions each in one transaction: the first is re-checked, the second is over the 1,000 budget and left to the gateway', async () => {
      needPsql()
      const a = await watcher(600)
      const b = await watcher(600)
      const t = await psql(`BEGIN;
        SELECT public.revoke_grant('${orgId}'::uuid, '${a.u.id}'::uuid, ARRAY['${a.grantId}'::uuid]);
        SELECT public.revoke_grant('${orgId}'::uuid, '${b.u.id}'::uuid, ARRAY['${b.grantId}'::uuid]);
        COMMIT;`)
      expect(t.code, t.err).toBe(0)
      expect(t.err).toContain('re-check budget reached')
      const counts = [await revokedOf(a.u.id), await revokedOf(b.u.id)].sort((x, y) => x - y)
      expect(counts).toEqual([0, 600])
    }, 60_000)

    it.skipIf(skipDocker)('N3: a second transaction on the same database session re-checks the same person again (the marker is per transaction)', async () => {
      needPsql()
      const { u, grantId } = await watcher(2)
      const t = await psql(`BEGIN; SELECT public.access_bump_version('${u.id}'::uuid); COMMIT;
        BEGIN; SELECT public.revoke_grant('${orgId}'::uuid, '${u.id}'::uuid, ARRAY['${grantId}'::uuid]); COMMIT;`)
      expect(t.code, t.err).toBe(0)
      expect(await revokedOf(u.id)).toBe(2)
    }, 30_000)
  })

  describe('P2-7 re-review R-5: the test fixtures header needs the database switch', () => {
    const asServiceKey = (switchOn: boolean) => `BEGIN;
      UPDATE public.test_fixture_switch SET honoured = ${switchOn};
      SELECT set_config('request.headers', '{"x-drishti-test-fixture":"on"}', true);
      SET LOCAL ROLE service_role;
      UPDATE public.worker_state SET check_requested_at = check_requested_at WHERE id = 1;
      ROLLBACK;`

    it.skipIf(skipDocker)('switch off (production): a direct write of worker_state by the service key is refused even with the header', async () => {
      needPsql()
      const r = await psql(asServiceKey(false))
      expect(r.code).not.toBe(0)
      expect(r.err).toMatch(/written only by the worker/)
    })

    it.skipIf(skipDocker)('switch on (the local test stack): the header is honoured', async () => {
      needPsql()
      const r = await psql(asServiceKey(true))
      expect(r.code, r.err).toBe(0)
    })

    it('the switch is on in this local stack, readable by the service role only', async () => {
      const { data, error } = await admin().from('test_fixture_switch' as never).select('honoured')
      expect(error).toBeNull()
      expect(data).toEqual([{ honoured: true }])
      const { error: e2 } = await serviceClient('app_web').from('test_fixture_switch' as never).select('honoured')
      expect(e2?.code).toBe('42501')
    })
  })

  describe('P2-6 re-review N-3: the per-address ceiling counts failed sign-ins only', () => {
    const ip = () => `2001:db8:${randomBytes(2).toString('hex')}::${randomBytes(2).toString('hex')}`

    it(`${SIGN_IN_IP_LIMIT} successful sign-ins from one address do not hold the next person out`, async () => {
      const lim = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
      const address = ip()
      for (let i = 0; i < SIGN_IN_IP_LIMIT; i++) {
        const g = await lim.signInGate(`${randomUUID()}@example.test`, address)
        expect(g.allowed, `try ${i + 1}`).toBe(true)
        if (g.allowed) await g.finish('succeeded')
      }
      const next = await lim.signInGate(`${randomUUID()}@example.test`, address)
      expect(next).toMatchObject({ allowed: true })
      if (next.allowed) await next.finish('succeeded')
    }, 60_000)

    it(`${SIGN_IN_IP_LIMIT} wrong passwords from one address still reach the ceiling`, async () => {
      const lim = createSharedLimiter(databaseStore(() => serviceClient('app_web')))
      const address = ip()
      for (let i = 0; i < SIGN_IN_IP_LIMIT; i++) {
        const g = await lim.signInGate(`${randomUUID()}@example.test`, address)
        expect(g.allowed, `try ${i + 1}`).toBe(true)
        if (g.allowed) await g.finish('refused')
      }
      expect(await lim.signInGate(`${randomUUID()}@example.test`, address)).toMatchObject({ allowed: false, reason: 'ip' })
    }, 60_000)
  })

  describe('P4-L2 re-review N-1: a fast playback token plays once', () => {
    it('after its stream closed, the same token cannot open it again, even before it is finished', async () => {
      const u = await createUser(orgId, 'operator')
      await grant(orgId, u.id, 'cctv.playback', atLocation(loc))
      const start = Math.floor(Date.now() / 1000) - 3600
      const stream = `fpb_${cam}_${start}_${start + 600}`
      const made = await admin().rpc('media_session_create_fast', { p_org: orgId, p_user: u.id, p_camera: cam, p_stream: stream, p_hour_min: 120, p_day_min: 480 })
      expect(made.error).toBeNull()
      const sid = (made.data as { sid: string | null }[])[0].sid!
      const open = async () => ((await admin().rpc('media_session_open', { p_sid: sid, p_user: u.id, p_camera: cam, p_kind: 'playback', p_stream: stream })).data as { ok: boolean; reason: string | null }[])[0]
      expect(await open()).toMatchObject({ ok: true })
      expect((await admin().rpc('media_session_close', { p_sid: sid })).error).toBeNull()
      // Between the close and media_session_finish a replay used to reopen it (closed, not revoked, inside its 90 s window).
      expect(await open()).toMatchObject({ ok: false, reason: 'closed' })
    })

    it('a live session still reconnects with the same token after its socket closed (P2-4 m-1 unchanged)', async () => {
      const u = await createUser(orgId, 'operator')
      await grant(orgId, u.id, 'cctv.live', atLocation(loc))
      const { data } = await admin().rpc('media_session_create', { p_org: orgId, p_user: u.id, p_kind: 'live', p_cameras: [cam], p_streams: [`cam_${cam}_sub`] })
      const sid = (data as { sid: string }[])[0].sid
      const open = async () => ((await admin().rpc('media_session_open', { p_sid: sid, p_user: u.id, p_camera: cam, p_kind: 'live', p_stream: `cam_${cam}_sub` })).data as { ok: boolean }[])[0]
      expect(await open()).toMatchObject({ ok: true })
      await admin().rpc('media_session_close', { p_sid: sid })
      expect(await open()).toMatchObject({ ok: true })
    })
  })

  describe('P3-1 re-review N-4: the security settings row and the test namespace', () => {
    it.skipIf(skipDocker)('deleting an organisation\'s security settings row is audited (the switch falls back to its default)', async () => {
      needPsql()
      const r = await psql(`BEGIN;
        SELECT public.security_settings_set_mfa_test('${orgId}'::uuid, true);
        DELETE FROM public.security_settings WHERE org_id = '${orgId}'::uuid;
        SELECT count(*) FROM public.admin_audit_log WHERE org_id = '${orgId}'::uuid AND action = 'security_settings_deleted'
          AND (detail ->> 'mfa_enforced')::boolean AND detail ? 'db_user';
        ROLLBACK;`)
      expect(r.code, r.err).toBe(0)
      expect(r.out.trim().split('\n').pop()).toBe('1')
    })

    it.skipIf(skipDocker)('emptying the security settings table is refused', async () => {
      needPsql()
      const r = await psql('BEGIN; TRUNCATE public.security_settings; ROLLBACK;')
      expect(r.code).not.toBe(0)
      expect(r.err).toMatch(/security_settings/)
    })

    it.skipIf(skipDocker)('an organisation that was not made by the tests cannot be renamed into the tests\' namespace by the service key', async () => {
      needPsql()
      const tag = randomUUID()
      const r = await psql(`BEGIN;
        INSERT INTO public.organizations (name, slug) VALUES ('Real ${tag}', 'real-${tag}');
        SET LOCAL ROLE service_role;
        UPDATE public.organizations SET slug = 'test-${tag}' WHERE slug = 'real-${tag}';
        ROLLBACK;`)
      expect(r.code).not.toBe(0)
      expect(r.err).toMatch(/test organisations/)
    })

    it('an organisation the tests made may leave the namespace and come back (the clean-up guard tests rely on it)', async () => {
      const o = await createOrg()
      try {
        expect((await admin().from('organizations').update({ slug: `real-${o}` }).eq('id', o)).error).toBeNull()
        expect((await admin().from('organizations').update({ slug: `test-${o}` }).eq('id', o)).error).toBeNull()
      } finally {
        await cleanupOrg(o)
      }
    })

    it('the service key cannot mark an organisation as made by the tests', async () => {
      const o = await createOrg()
      try {
        const { error } = await admin().from('organizations').update({ created_as_test: false } as never).eq('id', o)
        expect(error).toBeNull()
        const { data } = await admin().from('organizations').select('created_as_test' as never).eq('id', o).single()
        expect(data).toEqual({ created_as_test: true }) // kept: the column is fixed when the organisation is made
      } finally {
        await cleanupOrg(o)
      }
    })
  })
})
