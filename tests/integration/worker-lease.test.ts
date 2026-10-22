import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { getWorkerLease } from '@/lib/monitor/health'
import { isLeaseLost, LEASE_REFUSED_SQLSTATE, WorkerLease, type LeaseFence } from '@/lib/monitor/lease'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { WorkerSupervisor } from '@/lib/monitor/supervisor'
import type { MonitorConfig, Probes } from '@/lib/monitor/types'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createAsset, createOrg, createSite, createUser } from '../setup/fixtures'
import { rpcOf, takeTestLease, testLeaseName, type RpcAnswer } from '../setup/lease'
import { serviceClient } from '../setup/service-keys'
import { startFakeNvr, startFakeRtsp, startFakeTcp, type Bound, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'

// P2-7 (WP-2.5, D-8, SO-14): the atomic worker lease and the fencing token, against the real local database (migration
// 20261021000036). Lease names here are always "test:<uuid>" (never the worker's own "monitor"); the worker code runs in-process against
// a test organisation and fake NVRs on loopback only. Brief item 5 (a)-(j) is named on each test.

type Admin = SupabaseClient<Database>
type WorkerRow = Database['public']['Tables']['worker_state']['Row']
const admin = () => adminClient()
const worker = () => serviceClient('monitor_worker')
const code = (r: RpcAnswer) => r.error?.code ?? null
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

const acquire = (c: Admin, name: string, holder: string, ttl = 20) =>
  rpcOf(c)('worker_acquire_lease', { p_name: name, p_holder: holder, p_ttl_sec: ttl, p_holder_info: { host: 'test' } })
type AcquireRow = { acquired: boolean; fencing_token: number | null; lease_until: string; retry_after_ms: number }
const row = <T>(r: RpcAnswer) => (r.data as T[])[0]
const renew = (c: Admin, name: string, holder: string, token: number, ttl = 20) =>
  rpcOf(c)('worker_renew_lease', { p_name: name, p_holder: holder, p_fencing_token: token, p_ttl_sec: ttl })
const release = (c: Admin, name: string, holder: string, token: number) =>
  rpcOf(c)('worker_release_lease', { p_name: name, p_holder: holder, p_fencing_token: token })
/** Test-only (service role, names "test:" only): sets lease_until to the database's now() plus this many milliseconds. */
const setUntil = async (name: string, offsetMs: number) => {
  const r = await rpcOf(admin())('worker_lease_set_until_test', { p_name: name, p_offset_ms: offsetMs })
  expect(r.error).toBeNull()
}
/** A fence that always carries the same token, as a process that was paused would after it wakes up (its own clock did not notice). */
const fixedFence = (name: string, token: number | null): LeaseFence & { lostReasons: string[] } => {
  const lostReasons: string[] = []
  return { name, token: () => token, lost: (r) => lostReasons.push(r), lostReasons }
}

const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_cctv_hub'
function dockerPsqlAvailable(): boolean {
  try {
    execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-At', '-c', 'select 1'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/** Runs SQL in its own database session (as the database owner) and resolves when it ends. Only test rows are touched by the callers. */
function psql(sql: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (c) => resolve({ code: c, out, err }))
    p.stdin.end(sql)
  })
}
const canPsql = dockerPsqlAvailable()

describe('worker lease and fencing (P2-7)', () => {
  let orgId: string
  let recorderId: string
  let cams: string[]
  let saved: WorkerRow

  const camState = async (id: string) =>
    (await admin().from('check_state').select('status, last_checked_at, consecutive_failures').eq('org_id', orgId).eq('target_type', 'camera').eq('target_id', id).maybeSingle()).data
  const camResult = (id: string, ok: boolean, at = nowIso()) => ({ type: 'camera' as const, id, recorder: recorderId, ok, at })
  const apply = (c: Admin, name: string, token: number | null, results: object[], threshold = 1) =>
    rpcOf(c)('monitor_apply_results', { p_org: orgId, p_results: results, p_threshold: threshold, p_lease: name, p_fencing_token: token })
  const workerState = async () => (await admin().from('worker_state').select('*').eq('id', 1).single()).data!

  beforeAll(async () => {
    saved = await workerState()
    orgId = await createOrg()
    const site = await createSite(orgId, { code: 'LSE', host: '127.0.0.1', username: 'u', secret: 'lease-pass', cameras: 20 })
    recorderId = site.recorderId
    cams = site.cameraIds
  })
  // The SQL guard skips results older than a camera's last check, so tests that need a camera in a known state use their own cameras.
  const raceCams = () => cams.slice(0, 10)
  const lockCams = () => cams.slice(10, 18)
  const guardCam = () => cams[19]
  afterAll(async () => {
    await admin().from('worker_state').update(saved).eq('id', 1)
    await rpcOf(admin())('worker_lease_forget_test')
    await cleanupOrg(orgId)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('the lease functions', () => {
    it('(a) two workers started together: exactly one acquires; the others are told how long the lease still runs', async () => {
      const name = testLeaseName()
      const holders = Array.from({ length: 12 }, () => randomUUID())
      const answers = await Promise.all(holders.map((h) => acquire(worker(), name, h)))
      for (const a of answers) expect(a.error).toBeNull()
      const rows = answers.map((a) => row<AcquireRow>(a))
      expect(rows.filter((r) => r.acquired)).toHaveLength(1)
      expect(rows.find((r) => r.acquired)!.fencing_token).toBe(1)
      for (const r of rows.filter((x) => !x.acquired)) {
        expect(r.fencing_token).toBeNull()
        expect(r.retry_after_ms).toBeGreaterThan(15_000)
        expect(r.retry_after_ms).toBeLessThanOrEqual(20_000)
      }
      // The same through the worker's own code: eight WorkerLease objects on one free name, at once.
      const other = testLeaseName()
      const leases = Array.from({ length: 8 }, () => new WorkerLease({ rpc: rpcOf(worker()), name: other, log: () => {} }))
      const tried = await Promise.all(leases.map((l) => l.tryAcquire()))
      expect(tried.filter((t) => t.result === 'acquired')).toHaveLength(1)
      expect(leases.filter((l) => l.token() !== null)).toHaveLength(1)
    })

    it('a takeover of an ended lease increments the token; the live holder asking again keeps its token; another holder is refused', async () => {
      const name = testLeaseName()
      const [a, b] = [randomUUID(), randomUUID()]
      expect(row<AcquireRow>(await acquire(worker(), name, a)).fencing_token).toBe(1)
      expect(row<AcquireRow>(await acquire(worker(), name, a))).toMatchObject({ acquired: true, fencing_token: 1 })
      expect(row<AcquireRow>(await acquire(worker(), name, b))).toMatchObject({ acquired: false, fencing_token: null })
      await setUntil(name, -1)
      expect(row<AcquireRow>(await acquire(worker(), name, b))).toMatchObject({ acquired: true, fencing_token: 2 })
      // A comes back after its lease ran out: a new epoch even for the same holder would be token 3, but B holds it now.
      expect(row<AcquireRow>(await acquire(worker(), name, a)).acquired).toBe(false)
    })

    it('(c) a renewal with a stale token, by another holder, or after the lease ended fails; with the current token it extends the lease', async () => {
      const name = testLeaseName()
      const [a, b] = [randomUUID(), randomUUID()]
      await acquire(worker(), name, a, 5)
      const ok = await renew(worker(), name, a, 1, 20)
      expect(ok.error).toBeNull()
      expect(row<{ renewed: boolean; lease_until: string }>(ok).renewed).toBe(true)
      expect(row<{ renewed: boolean }>(await renew(worker(), name, b, 1)).renewed).toBe(false) // not the holder
      expect(row<{ renewed: boolean }>(await renew(worker(), name, a, 2)).renewed).toBe(false) // a token that was never given
      await setUntil(name, -1)
      expect(row<{ renewed: boolean }>(await renew(worker(), name, a, 1)).renewed).toBe(false) // ended: lost, even with no new holder
      await acquire(worker(), name, b)
      expect(row<{ renewed: boolean }>(await renew(worker(), name, a, 1)).renewed).toBe(false) // stale: B holds token 2
      expect(row<{ renewed: boolean }>(await renew(worker(), name, b, 2)).renewed).toBe(true)
    })

    it('(h) a release lets another worker acquire at once (token + 1); a release with a stale token changes nothing', async () => {
      const name = testLeaseName()
      const [a, b] = [randomUUID(), randomUUID()]
      await acquire(worker(), name, a, 20)
      expect((await release(worker(), name, b, 1)).data).toBe(false)
      expect((await release(worker(), name, a, 9)).data).toBe(false)
      expect(row<AcquireRow>(await acquire(worker(), name, b)).acquired).toBe(false) // still A's
      expect((await release(worker(), name, a, 1)).data).toBe(true)
      expect(row<AcquireRow>(await acquire(worker(), name, b))).toMatchObject({ acquired: true, fencing_token: 2 })
      expect(code(await apply(worker(), name, 1, [camResult(cams[0], true)]))).toBe(LEASE_REFUSED_SQLSTATE) // A's released token
    })

    it('(e) boundaries: a lease that ends in the future is held (writes pass, others wait); one that ended is not (writes refused, takeover)', async () => {
      const name = testLeaseName()
      const [a, b] = [randomUUID(), randomUUID()]
      await acquire(worker(), name, a, 20)
      await setUntil(name, 3000)
      const waiting = row<AcquireRow>(await acquire(worker(), name, b))
      expect(waiting.acquired).toBe(false)
      expect(waiting.retry_after_ms).toBeGreaterThan(1000)
      expect(waiting.retry_after_ms).toBeLessThanOrEqual(3000)
      expect((await apply(worker(), name, 1, [camResult(cams[0], true)])).error).toBeNull()
      await setUntil(name, 0) // ends "now": a lease is held only while lease_until > now()
      expect(code(await apply(worker(), name, 1, [camResult(cams[0], true)]))).toBe(LEASE_REFUSED_SQLSTATE)
      expect(row<{ renewed: boolean }>(await renew(worker(), name, a, 1)).renewed).toBe(false)
      expect(row<AcquireRow>(await acquire(worker(), name, b))).toMatchObject({ acquired: true, fencing_token: 2 })
    })

    it.skipIf(!canPsql)('(e) exactly at lease_until = now() the lease has ended: a takeover succeeds and the fence refuses, in one transaction', async () => {
      const name = testLeaseName()
      const [a, b] = [randomUUID(), randomUUID()]
      const r = await psql(`
        BEGIN;
        SELECT fencing_token FROM public.worker_acquire_lease('${name}', '${a}', 20, '{}');
        UPDATE public.worker_leases SET lease_until = now() WHERE name = '${name}';
        DO $$ BEGIN PERFORM public.worker_fence('${name}', 1); RAISE NOTICE 'fence accepted'; EXCEPTION WHEN SQLSTATE '${LEASE_REFUSED_SQLSTATE}' THEN RAISE NOTICE 'fence refused'; END $$;
        SELECT acquired::text || ' ' || fencing_token::text FROM public.worker_acquire_lease('${name}', '${b}', 20, '{}');
        ROLLBACK;`)
      expect(r.code).toBe(0)
      expect(r.out.trim().split(/\r?\n/)).toEqual(['1', 'true 2'])
      expect(r.err).toContain('fence refused')
    })

    it('(f) only the database clock decides: a worker whose clock is years off gets the same lease times', async () => {
      const name = testLeaseName()
      const c = worker() // the key is signed before the clock is moved
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2039-06-01T00:00:00Z'))
      const lease = new WorkerLease({ rpc: rpcOf(c), name, ttlSec: 20, log: () => {} })
      expect((await lease.tryAcquire()).result).toBe('acquired')
      vi.useRealTimers()
      const held = (await admin().from('worker_leases' as never).select('lease_until, renewed_at').eq('name', name).single()).data as unknown as { lease_until: string; renewed_at: string }
      const lifetime = Date.parse(held.lease_until) - Date.parse(held.renewed_at)
      expect(lifetime).toBe(20_000)
      expect(Math.abs(Date.parse(held.renewed_at) - Date.now())).toBeLessThan(10_000) // the database's now, not 2039
      const other = row<AcquireRow>(await acquire(worker(), name, randomUUID()))
      expect(other.retry_after_ms).toBeGreaterThan(10_000)
      expect(other.retry_after_ms).toBeLessThanOrEqual(20_000)
    })

    it('sharding seam: two lease names are held by two workers at the same time, and a token is valid for its own name only', async () => {
      const [one, two] = [`test:${randomUUID()}:shard-1`, `test:${randomUUID()}:shard-2`]
      const ra = row<AcquireRow>(await acquire(worker(), one, randomUUID()))
      const rb = row<AcquireRow>(await acquire(worker(), two, randomUUID()))
      expect(ra).toMatchObject({ acquired: true, fencing_token: 1 })
      expect(rb).toMatchObject({ acquired: true, fencing_token: 1 })
      expect((await apply(worker(), one, 1, [camResult(cams[1], true)])).error).toBeNull()
      expect((await apply(worker(), two, 1, [camResult(cams[1], true)])).error).toBeNull()
      expect(code(await apply(worker(), testLeaseName(), 1, [camResult(cams[1], true)]))).toBe(LEASE_REFUSED_SQLSTATE) // a name nobody holds
    })

    it('refuses bad requests: a malformed name, a missing holder, a TTL outside 1..900 s, holder information that is not a small object', async () => {
      for (const args of [
        { p_name: 'Monitor Shard', p_holder: randomUUID(), p_ttl_sec: 20, p_holder_info: {} },
        { p_name: testLeaseName(), p_holder: null, p_ttl_sec: 20, p_holder_info: {} },
        { p_name: testLeaseName(), p_holder: randomUUID(), p_ttl_sec: 0, p_holder_info: {} },
        { p_name: testLeaseName(), p_holder: randomUUID(), p_ttl_sec: 901, p_holder_info: {} },
        { p_name: testLeaseName(), p_holder: randomUUID(), p_ttl_sec: 20, p_holder_info: [] },
        { p_name: testLeaseName(), p_holder: randomUUID(), p_ttl_sec: 20, p_holder_info: { note: 'x'.repeat(3000) } },
      ]) {
        expect(code(await rpcOf(worker())('worker_acquire_lease', args)), JSON.stringify(args).slice(0, 80)).toBe('22023')
      }
    })

    it('only the worker (and the service role) may use the lease and the fenced functions; nobody writes worker_leases through the API', async () => {
      const name = testLeaseName()
      const holder = randomUUID()
      const person = await createUser(orgId, 'user')
      const fenced = { p_lease: name, p_fencing_token: 1 }
      const calls: [string, object][] = [
        ['worker_acquire_lease', { p_name: name, p_holder: holder, p_ttl_sec: 20, p_holder_info: {} }],
        ['worker_renew_lease', { p_name: name, p_holder: holder, p_fencing_token: 1, p_ttl_sec: 20 }],
        ['worker_release_lease', { p_name: name, p_holder: holder, p_fencing_token: 1 }],
        ['monitor_apply_results', { p_org: orgId, p_results: [], p_threshold: 2, ...fenced }],
        ['monitor_heartbeat', { ...fenced, p_at: nowIso() }],
        ['monitor_record_gap', { ...fenced, p_from: nowIso(), p_to: nowIso() }],
        ['monitor_mark_round', { ...fenced, p_kind: 'assets', p_at: nowIso() }],
        ['monitor_run_started', { ...fenced, p_at: nowIso(), p_total: 0 }],
        ['monitor_run_progress', { ...fenced, p_done: 0, p_total: 0 }],
        ['monitor_run_finished', { ...fenced, p_at: nowIso() }],
        ['monitor_save_camera_ips', { ...fenced, p_org: orgId, p_rows: [] }],
        ['worker_lease_set_until_test', { p_name: name, p_offset_ms: 0 }],
        ['worker_lease_forget_test', {}],
      ]
      for (const c of [serviceClient('app_web'), serviceClient('media_service'), serviceClient('video_gateway'), person.client]) {
        for (const [fn, args] of calls) expect(code(await rpcOf(c)(fn, args as Record<string, unknown>)), fn).toBe('42501')
      }
      // The worker may not use the test helpers either.
      expect(code(await rpcOf(worker())('worker_lease_set_until_test', { p_name: name, p_offset_ms: 0 }))).toBe('42501')
      // The table is written by its functions only; the web app may read it (worker status), the worker and people may not.
      expect(code(await rpcOf(admin())('privilege_violations') as RpcAnswer)).toBeNull()
      expect((await rpcOf(admin())('privilege_violations')).data).toEqual([])
      const insert = { name, holder, lease_until: nowIso(), fencing_token: 99, acquired_at: nowIso(), renewed_at: nowIso() }
      expect((await admin().from('worker_leases' as never).insert(insert as never)).error?.code).toBe('42501')
      expect((await worker().from('worker_leases' as never).update({ fencing_token: 99 } as never).eq('name', name)).error?.code).toBe('42501')
      expect((await serviceClient('app_web').from('worker_leases' as never).select('name').limit(1)).error).toBeNull()
      expect((await person.client.from('worker_leases' as never).select('name').limit(1)).error?.code).toBe('42501')
    })

    it.skipIf(!canPsql)('privilege_violations() names each new kind of mistake (probes in a transaction that is rolled back)', async () => {
      const r = await psql(`
        BEGIN;
        GRANT INSERT ON public.monitor_gaps TO monitor_worker;
        GRANT UPDATE (name) ON public.cameras TO monitor_worker;
        GRANT EXECUTE ON FUNCTION public.targets_uptime(uuid, text, uuid[], interval, timestamptz) TO monitor_worker;
        GRANT EXECUTE ON FUNCTION public.worker_fence(text, bigint) TO app_web;
        GRANT INSERT ON public.worker_leases TO service_role;
        GRANT SELECT ON public.worker_leases TO authenticated;
        SELECT v FROM public.privilege_violations() v ORDER BY v;
        ROLLBACK;
        SELECT count(*) FROM public.privilege_violations();`)
      expect(r.code, r.err).toBe(0)
      const lines = r.out.trim().split(/\r?\n/)
      expect(lines.pop()).toBe('0') // after the rollback: clean again
      expect([...lines].sort()).toEqual([
        'cameras (column): monitor_worker may UPDATE (the worker writes only through fenced functions)',
        'function targets_uptime: monitor_worker may execute it without a fencing token (every worker write takes p_fencing_token)',
        'function worker_fence: app_web may execute it (internal; only the fenced functions call it)',
        'monitor_gaps: monitor_worker may INSERT (the worker writes only through fenced functions)',
        'worker_leases: authenticated has SELECT (server-only table)',
        'worker_leases: service_role may INSERT (written by the database only)',
      ].sort())
    })

    it('the worker writes nothing straight into a table any more: worker_state, monitor_gaps and camera addresses only through the fenced functions', async () => {
      const w = worker()
      expect((await w.from('worker_state').update({ last_heartbeat: nowIso() }).eq('id', -1)).error?.code).toBe('42501')
      expect((await w.from('monitor_gaps').insert({ started_at: nowIso(), ended_at: nowIso() })).error?.code).toBe('42501')
      expect((await w.from('cameras').update({ camera_ip: '192.0.2.99' }).eq('id', randomUUID())).error?.code).toBe('42501')
      expect((await w.from('check_state').select('id').limit(1)).error).toBeNull() // reads stay
    })
  })

  describe('fenced writes', () => {
    it('(b) A pauses, B takes over with token + 1, A wakes up: its results, gap and worker-state writes are refused with a clear error and nothing of them is stored', async () => {
      const name = testLeaseName()
      const a = await takeTestLease(name, randomUUID(), 3, worker())
      // A works normally while it holds the lease.
      const fenceA = fixedFence(name, a.token)
      const dbA = new SupabaseMonitorDb(worker(), { orgId, fence: fenceA })
      await dbA.applyResults(orgId, [camResult(cams[2], true)], 1)
      expect((await camState(cams[2]))?.status).toBe('up')
      const before = { cam: await camState(cams[2]), state: await workerState() }
      // A is paused: it does not renew. The lease runs out (3 s, on the database clock) and B takes over.
      await sleepMs(3300)
      const b = row<AcquireRow>(await acquire(worker(), name, randomUUID()))
      expect(b).toMatchObject({ acquired: true, fencing_token: a.token + 1 })
      // A wakes up and carries on with what it was doing, with its old token.
      const late = new Date().toISOString()
      const refusals: unknown[] = []
      for (const write of [
        () => dbA.applyResults(orgId, [camResult(cams[2], false, late)], 1),
        () => dbA.recordGap(new Date(Date.now() - 60_000), new Date()),
        () => dbA.touchHeartbeat(new Date()),
        () => dbA.markRound('cameras', new Date()),
        () => dbA.markRunStarted(new Date(), 5),
        () => dbA.markProgress(1, 5),
        () => dbA.markRunFinished(new Date()),
        () => dbA.saveCameraIps(orgId, [{ cameraId: cams[2], ip: '192.0.2.77', recorderId }]),
      ]) refusals.push(await write().then(() => 'stored', (e: unknown) => e))
      for (const r of refusals) {
        expect(isLeaseLost(r)).toBe(true)
        expect((r as Error).message).toMatch(/lease .* (not held|stale|ended)/i)
      }
      expect(fenceA.lostReasons[0]).toBe('write_refused')
      // Nothing A sent after the takeover was stored.
      expect(await camState(cams[2])).toEqual(before.cam)
      expect(await workerState()).toEqual(before.state)
      expect((await admin().from('cameras').select('camera_ip').eq('id', cams[2]).single()).data?.camera_ip).not.toBe('192.0.2.77')
      // The raw refusal names the lease and says why, with SQLSTATE WL001.
      const raw = await apply(worker(), name, a.token, [camResult(cams[2], false)])
      expect(code(raw)).toBe(LEASE_REFUSED_SQLSTATE)
      expect(raw.error?.message).toContain(name)
    })

    it('a write without a token, with a token that was never given or for a lease nobody holds is refused', async () => {
      const name = testLeaseName()
      await takeTestLease(name, randomUUID(), 20, worker())
      expect(code(await apply(worker(), name, null, [camResult(cams[3], true)]))).toBe(LEASE_REFUSED_SQLSTATE)
      expect(code(await apply(worker(), name, 2, [camResult(cams[3], true)]))).toBe(LEASE_REFUSED_SQLSTATE)
      expect(code(await rpcOf(worker())('monitor_heartbeat', { p_lease: null, p_fencing_token: 1, p_at: nowIso() }))).toBe(LEASE_REFUSED_SQLSTATE)
      expect(await camState(cams[3])).toBeNull()
    })

    it('(d) a batch sent with the old token after a takeover is refused whole: none of its results is applied', async () => {
      const name = testLeaseName()
      const a = await takeTestLease(name, randomUUID(), 20, worker())
      const batch = cams.map((c) => camResult(c, false))
      const before = await Promise.all(cams.map((c) => camState(c)))
      await setUntil(name, -1)
      await acquire(worker(), name, randomUUID())
      expect(code(await apply(worker(), name, a.token, batch))).toBe(LEASE_REFUSED_SQLSTATE)
      expect(await Promise.all(cams.map((c) => camState(c)))).toEqual(before)
    })

    it('(d) a batch in flight while the lease runs out and another worker tries to take it: the batch is all or nothing, never partly applied', async () => {
      for (let i = 0; i < 6; i++) {
        const name = testLeaseName()
        const a = await takeTestLease(name, randomUUID(), 20, worker())
        await setUntil(name, 150)
        const at = new Date(Date.now() + i * 1000).toISOString()
        const batch = raceCams().map((c) => camResult(c, i % 2 === 0, at))
        const [applied, takeover] = await Promise.all([
          sleepMs(100 + i * 20).then(() => apply(worker(), name, a.token, batch)),
          sleepMs(150).then(async () => {
            for (;;) {
              const r = row<AcquireRow>(await acquire(worker(), name, randomUUID()))
              if (r.acquired) return r
              await sleepMs(20)
            }
          }),
        ])
        expect(takeover.fencing_token).toBe(a.token + 1)
        const states = await Promise.all(raceCams().map((c) => camState(c)))
        const fromBatch = states.filter((s) => s && Date.parse(s.last_checked_at!) === Date.parse(at)).length
        if (applied.error) {
          expect(code(applied)).toBe(LEASE_REFUSED_SQLSTATE)
          expect(fromBatch).toBe(0)
        } else expect(fromBatch).toBe(raceCams().length)
      }
    })

    it.skipIf(!canPsql)('(d) the locking argument: a takeover waits for a fenced batch that is in progress, and only then hands out token + 1', async () => {
      const name = testLeaseName()
      const a = await takeTestLease(name, randomUUID(), 6, worker())
      const at = new Date().toISOString()
      const batch = JSON.stringify(lockCams().map((c) => camResult(c, true, at)))
      const t0 = Date.now()
      // A's batch runs in its own session: the fence check (FOR SHARE on the lease row), the results, then 8 s more in the same transaction.
      const session = psql(`BEGIN;
        SELECT public.monitor_apply_results('${orgId}'::uuid, '${batch}'::jsonb, 1, '${name}', ${a.token});
        SELECT pg_sleep(8);
        COMMIT;`)
      // The lease has run out (6 s) while the batch is still open. B asks for it.
      await sleepMs(Math.max(0, 6500 - (Date.now() - t0)))
      const asked = Date.now()
      const b = row<AcquireRow>(await acquire(worker(), name, randomUUID()))
      const waited = Date.now() - asked
      const done = await session
      expect(done.code, done.err).toBe(0)
      expect(b).toMatchObject({ acquired: true, fencing_token: a.token + 1 })
      expect(waited).toBeGreaterThan(800) // B's takeover could not interleave: it waited for A's transaction to end
      const states = await Promise.all(lockCams().map((c) => camState(c)))
      expect(states.every((s) => s && Date.parse(s.last_checked_at!) === Date.parse(at))).toBe(true) // A's batch: all of it
    }, 30_000)

    it('SQL guard: a result older than the last check of its target is skipped (the late-result rule is no longer per process only)', async () => {
      const name = testLeaseName()
      const a = await takeTestLease(name, randomUUID(), 20, worker())
      const t2 = new Date(Date.now() - 1000).toISOString()
      const t1 = new Date(Date.now() - 5000).toISOString()
      const cam = guardCam()
      expect((await apply(worker(), name, a.token, [camResult(cam, true, t2)])).error).toBeNull()
      expect((await apply(worker(), name, a.token, [camResult(cam, false, t1)])).error).toBeNull()
      expect(await camState(cam)).toMatchObject({ status: 'up', consecutive_failures: 0 })
      expect(Date.parse((await camState(cam))!.last_checked_at!)).toBe(Date.parse(t2))
      // A result at the same time is not older: it is applied.
      expect((await apply(worker(), name, a.token, [camResult(cam, false, t2)])).error).toBeNull()
      expect(await camState(cam)).toMatchObject({ status: 'down', consecutive_failures: 1 })
    })

    it('health reports the lease: holder, token, when it was taken and renewed and whether it is held', async () => {
      const name = testLeaseName()
      const a = await takeTestLease(name, randomUUID(), 20, worker())
      const l = await getWorkerLease(serviceClient('app_web'), name)
      expect(l).toMatchObject({ name, holder: a.holder, token: a.token, held: true })
      expect(l!.renewedAgeSec).toBeGreaterThanOrEqual(0)
      expect(l!.renewedAgeSec).toBeLessThan(10)
      await setUntil(name, -1)
      expect((await getWorkerLease(serviceClient('app_web'), name))?.held).toBe(false)
      expect(await getWorkerLease(serviceClient('app_web'), testLeaseName())).toBeNull()
    })
  })

  describe('the worker under the lease (in-process, fake NVR on loopback, test organisation only)', () => {
    let nvr: FakeNvr
    let rtsp: FakeRtsp
    let tcp: Bound
    let lOrg: string
    let lRecorder: string
    let lCams: string[]
    let device: string
    const cfg = (): MonitorConfig => ({ ...loadMonitorConfig({}), pollSec: 1, deviceCheckSec: 3600, cameraCheckSec: 3600, nvrTimeoutMs: 2000, tcpTimeoutMs: 1500 })
    const lState = async (type: string, id: string) =>
      (await admin().from('check_state').select('status, last_checked_at').eq('org_id', lOrg).eq('target_type', type).eq('target_id', id).maybeSingle()).data
    /** worker_state quiet and "just beaten", so that a runner's start-up records no gap and finds no open run. */
    const quiet = () => admin().from('worker_state').update({ last_heartbeat: nowIso(), check_requested_at: null, run_started_at: null, run_finished_at: null, progress_done: 0, progress_total: 0 }).eq('id', 1)

    beforeAll(async () => {
      nvr = await startFakeNvr({ statuses: { 1: true, 2: true }, channels: [{ channel: 1, name: 'Door' }, { channel: 2, name: 'Till' }] })
      rtsp = await startFakeRtsp('open')
      tcp = await startFakeTcp()
      lOrg = await createOrg()
      const site = await createSite(lOrg, { code: 'LSW', host: '127.0.0.1', rtspPort: rtsp.port, httpPort: nvr.port, secret: 'secret-pass', cameras: 2 })
      lRecorder = site.recorderId
      lCams = site.cameraIds
      device = await createAsset(lOrg, { locationId: site.locationId, type: 'server', name: 'Lease box', ip: '127.0.0.1', port: tcp.port })
    })
    afterAll(async () => {
      await nvr.close()
      await rtsp.close()
      await tcp.close()
      await admin().from('worker_state').update(saved).eq('id', 1)
      await cleanupOrg(lOrg)
    })

    it('(b, i) a paused worker: its queued writes reach the database after the takeover and are refused; it stops all work, waits in standby and never writes again', async () => {
      await quiet()
      const name = testLeaseName()
      // Every call of worker A goes through this gate: closing it is "the process is paused" (its requests wait, nothing is answered).
      let gate: Promise<void> | null = null
      let openGate: () => void = () => {}
      const real = worker()
      const paused = new Proxy(real, {
        get(target, prop) {
          if (prop !== 'rpc') {
            const v = Reflect.get(target, prop)
            return typeof v === 'function' ? v.bind(target) : v
          }
          return (fn: string, args: object) => ({
            then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
              (async () => {
                if (gate) await gate
                return target.rpc(fn as never, args as never)
              })().then(ok, bad),
          })
        },
      }) as Admin
      const logsA: Record<string, unknown>[] = []
      const leaseA = new WorkerLease({ rpc: rpcOf(paused), name, ttlSec: 3, renewEveryMs: 500, marginMs: 800, log: (e) => logsA.push(e) })
      const writesA: string[] = []
      const supA = new WorkerSupervisor({
        lease: leaseA,
        log: (e) => logsA.push(e),
        sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms)
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
        }),
        makeRunner: (fence) => {
          const db = new SupabaseMonitorDb(paused, { orgId: lOrg, fence })
          const spy = new Proxy(db, {
            get(t, p) {
              const v = Reflect.get(t, p, t)
              if (typeof v !== 'function') return v
              return (...args: unknown[]) => {
                if (['applyResults', 'touchHeartbeat', 'recordGap', 'markRound', 'markRunStarted', 'markRunFinished'].includes(String(p))) writesA.push(String(p))
                return (v as (...a: unknown[]) => unknown).apply(t, args)
              }
            },
          })
          return new MonitorRunner({ db: spy, probes: realProbes, cfg: cfg(), clock: () => new Date() })
        },
      })
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const running = supA.run()
      try {
        // A takes the lease and checks: the device and the NVR are up.
        const until = Date.now() + 15_000
        while (!((await lState('recorder', lRecorder))?.status === 'up' && (await lState('device', device))?.status === 'up')) {
          if (Date.now() > until) throw new Error('worker A did not check')
          await sleepMs(200)
        }
        expect(supA.phase).toBe('active')
        // Pause A. Its beats keep being sent (and wait at the gate) until its own clock says the lease may have run out.
        gate = new Promise<void>((r) => (openGate = r))
        await sleepMs(3500)
        expect(supA.phase).toBe('standby') // stopped all work on its own (local deadline), without any answer from the database
        expect(logsA.filter((l) => l.event === 'lease_lost')).toHaveLength(1)
        const writesWhenStopped = writesA.length
        // B takes over (the lease ran out on the database clock).
        const b = row<AcquireRow>(await acquire(worker(), name, randomUUID(), 20))
        expect(b).toMatchObject({ acquired: true, fencing_token: 2 })
        const snapshot = { state: await workerState(), recorder: await lState('recorder', lRecorder), device: await lState('device', device) }
        nvr.setStatuses({ 1: false, 2: false }) // anything A still wrote would now show
        // A wakes up: its queued requests are answered. The renewal is refused and every queued write is refused by the fence.
        openGate()
        gate = null
        await sleepMs(3000)
        expect(await workerState()).toEqual(snapshot.state)
        expect(await lState('recorder', lRecorder)).toEqual(snapshot.recorder)
        expect(await lState('device', device)).toEqual(snapshot.device)
        expect(writesA.length).toBe(writesWhenStopped) // nothing new was even attempted after it stopped
        expect(supA.phase).toBe('standby') // B holds it: A keeps waiting
        expect(leaseA.token()).toBeNull()
      } finally {
        openGate()
        gate = null
        await supA.stop(2000)
        await running
        nvr.setStatuses({ 1: true, 2: true })
      }
    }, 40_000)

    it('(g) a check-now request survives a takeover: the run A started is repeated once by B, never lost and never run twice; A cannot close it', async () => {
      await quiet()
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const name = testLeaseName()
      const leaseA = new WorkerLease({ rpc: rpcOf(worker()), name, ttlSec: 20, log: () => {} })
      expect((await leaseA.tryAcquire()).result).toBe('acquired')
      let release!: () => void
      const blocked = new Promise<void>((r) => (release = r))
      let blockedOnce = false
      const slowProbes: Probes = {
        ...realProbes,
        tcp: async (host, port, timeoutMs) => {
          if (!blockedOnce) {
            blockedOnce = true
            await blocked // A is stuck in the middle of its run (for example the machine went to sleep)
          }
          return realProbes.tcp(host, port, timeoutMs)
        },
      }
      const lostA: string[] = []
      leaseA.onLost((r) => lostA.push(r))
      const runnerA = new MonitorRunner({ db: new SupabaseMonitorDb(worker(), { orgId: lOrg, fence: leaseA.fence() }), probes: slowProbes, cfg: cfg(), clock: () => new Date() })
      expect((await admin().rpc('monitor_request_check')).error).toBeNull()
      const asked = Date.parse((await workerState()).check_requested_at!)
      const runA = runnerA.checkRequests()
      const deadline = Date.now() + 10_000
      while (!((await workerState()).run_started_at && Date.parse((await workerState()).run_started_at!) >= asked - 2000)) {
        if (Date.now() > deadline) throw new Error('A did not start its run')
        await sleepMs(100)
      }
      const startedByA = (await workerState()).run_started_at
      // A's lease runs out; B takes over and starts.
      await setUntil(name, -1)
      const leaseB = new WorkerLease({ rpc: rpcOf(worker()), name, ttlSec: 20, log: () => {} })
      expect(await leaseB.tryAcquire()).toEqual({ result: 'acquired', token: 2 })
      let startsB = 0
      const dbB = new SupabaseMonitorDb(worker(), { orgId: lOrg, fence: leaseB.fence() })
      const countingB = new Proxy(dbB, {
        get(t, p) {
          const v = Reflect.get(t, p, t)
          if (typeof v !== 'function') return v
          return (...args: unknown[]) => {
            if (p === 'markRunStarted') startsB++
            return (v as (...a: unknown[]) => unknown).apply(t, args)
          }
        },
      })
      const runnerB = new MonitorRunner({ db: countingB, probes: realProbes, cfg: cfg(), clock: () => new Date() })
      await runnerB.start()
      try {
        const end = Date.now() + 20_000
        for (;;) {
          const s = await workerState()
          if (s.run_finished_at && s.run_started_at && s.run_started_at !== startedByA && Date.parse(s.run_finished_at) >= Date.parse(s.run_started_at)) break
          if (Date.now() > end) throw new Error('B did not repeat the run')
          await sleepMs(200)
        }
        await sleepMs(3000) // several more polls: no second run
        expect(startsB).toBe(1)
        const afterB = await workerState()
        // A wakes up: it carries on with its run and tries to finish it with its old token. Every write is refused.
        release()
        await runA.catch(() => {})
        expect(lostA[0]).toBe('write_refused')
        const final = await workerState()
        expect(final.run_started_at).toBe(afterB.run_started_at)
        expect(final.run_finished_at).toBe(afterB.run_finished_at)
        expect(Date.parse(final.check_requested_at!)).toBe(asked) // the request itself is untouched
        expect(startsB).toBe(1)
      } finally {
        release()
        await runnerB.shutdown(5000)
        await leaseB.release()
      }
    }, 60_000)

    it('(i) a database outage: a lease that cannot be renewed is given up locally and no result is sent without a valid token; afterwards a new epoch writes again', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const name = testLeaseName()
      let down = false
      const real = worker()
      const sent: string[] = []
      const flaky = new Proxy(real, {
        get(target, prop) {
          if (prop !== 'rpc') {
            const v = Reflect.get(target, prop)
            return typeof v === 'function' ? v.bind(target) : v
          }
          return (fn: string, args: object) => {
            sent.push(fn)
            if (down) return Promise.reject(new TypeError('fetch failed'))
            return target.rpc(fn as never, args as never)
          }
        },
      }) as Admin
      const lease = new WorkerLease({ rpc: rpcOf(flaky), name, ttlSec: 2, renewEveryMs: 300, marginMs: 500, log: () => {} })
      // The database is down while the worker starts: it keeps trying, then gets the lease.
      down = true
      const stop = new AbortController()
      const got = lease.acquire(stop.signal, (ms, signal) => new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(ms, 300))
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
      }))
      await sleepMs(700)
      down = false
      expect(await got).toBe(true)
      const first = lease.token()
      expect(first).toBe(1)
      const db = new SupabaseMonitorDb(flaky, { orgId: lOrg, fence: lease.fence() })
      await db.applyResults(lOrg, [{ type: 'camera', id: lCams[0], recorder: lRecorder, ok: true, at: nowIso() }], 1)
      // The database goes away for longer than the TTL: renewals fail, the token is given up locally.
      down = true
      expect(await lease.renew()).toBe('error')
      await sleepMs(1600)
      expect(lease.token()).toBeNull()
      sent.length = 0
      down = false
      await expect(db.applyResults(lOrg, [{ type: 'camera', id: lCams[0], recorder: lRecorder, ok: false, at: nowIso() }], 1)).rejects.toSatisfy(isLeaseLost)
      expect(sent).not.toContain('monitor_apply_results') // not even sent
      expect((await lState('camera', lCams[0]))?.status).toBe('up')
      // Back again once the old lease has run out on the database clock too: a new epoch (the token moves on) and writes are accepted.
      const oldFence = db
      await sleepMs(800)
      expect(await lease.acquire(stop.signal, (ms) => sleepMs(Math.min(ms, 300)))).toBe(true)
      expect(lease.token()).toBe(2)
      await expect(oldFence.applyResults(lOrg, [{ type: 'camera', id: lCams[0], recorder: lRecorder, ok: false, at: nowIso() }], 1)).rejects.toSatisfy(isLeaseLost)
      await new SupabaseMonitorDb(flaky, { orgId: lOrg, fence: lease.fence() }).applyResults(lOrg, [{ type: 'camera', id: lCams[0], recorder: lRecorder, ok: false, at: nowIso() }], 1)
      expect((await lState('camera', lCams[0]))?.status).toBe('down')
      await lease.release()
    }, 30_000)
  })
})
