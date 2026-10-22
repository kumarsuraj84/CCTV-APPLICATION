import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLeaseLost, LeaseLostError, LEASE_REFUSED_SQLSTATE, type LeaseFence } from '@/lib/monitor/lease'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { loadMonitorConfig } from '@/lib/monitor/config'
import type { Probes } from '@/lib/monitor/types'
import type { Database } from '@/types/database'
import { MemoryDb } from '../helpers/memory-db'

// P2-7 (D-8): every write of the worker carries its lease name and fencing token, and goes through a database function that checks
// them in the same transaction. Without a valid token nothing is sent at all.

const ORG = '00000000-0000-4000-8000-000000000001'
const CAM = '00000000-0000-4000-8000-000000000002'
const REC = '00000000-0000-4000-8000-000000000003'

type Call = { fn: string; args: Record<string, unknown> }

function fakeClient(answer: (fn: string) => { data?: unknown; error: { code?: string; message: string } | null } = () => ({ error: null })) {
  const calls: Call[] = []
  const tables: string[] = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return { data: null, ...answer(fn) }
    },
    from: (t: string) => {
      tables.push(t)
      throw new Error(`direct table access to ${t}`)
    },
  } as unknown as SupabaseClient<Database>
  return { client, calls, tables }
}

function fence(token: number | null = 7, name = 'monitor') {
  const lost: string[] = []
  const f: LeaseFence = { name, token: () => token, lost: (r) => lost.push(r) }
  return { f, lost }
}

const writes = (db: SupabaseMonitorDb) => [
  ['monitor_apply_results', () => db.applyResults(ORG, [{ type: 'camera', id: CAM, recorder: REC, ok: true, at: '2026-10-23T08:00:00.000Z' }], 2)],
  ['monitor_save_camera_ips', () => db.saveCameraIps(ORG, [{ cameraId: CAM, ip: '192.0.2.10', recorderId: REC }])],
  ['monitor_heartbeat', () => db.touchHeartbeat(new Date('2026-10-23T08:00:00Z'))],
  ['monitor_record_gap', () => db.recordGap(new Date('2026-10-23T07:00:00Z'), new Date('2026-10-23T08:00:00Z'))],
  ['monitor_mark_round', () => db.markRound('devices', new Date('2026-10-23T08:00:00Z'))],
  ['monitor_run_started', () => db.markRunStarted(new Date('2026-10-23T08:00:00Z'), 0)],
  ['monitor_run_progress', () => db.markProgress(1, 2)],
  ['monitor_run_finished', () => db.markRunFinished(new Date('2026-10-23T08:00:00Z'))],
] as const

afterEach(() => vi.restoreAllMocks())

describe('SupabaseMonitorDb writes are fenced (P2-7)', () => {
  it('every write goes through its database function with the lease name and the fencing token, never straight into a table', async () => {
    const c = fakeClient()
    const { f } = fence(7, 'monitor:shard-3')
    const db = new SupabaseMonitorDb(c.client, { fence: f })
    for (const [fn, write] of writes(db)) {
      c.calls.length = 0
      await write()
      expect(c.calls.map((x) => x.fn), fn).toEqual([fn])
      expect(c.calls[0].args, fn).toMatchObject({ p_lease: 'monitor:shard-3', p_fencing_token: 7 })
    }
    expect(c.tables).toEqual([])
  })

  it('apply results sends the threshold, the organisation and the cleaned results; camera addresses go in one call with their recorder', async () => {
    const c = fakeClient()
    const db = new SupabaseMonitorDb(c.client, { fence: fence().f })
    await db.applyResults(ORG, [{ type: 'camera', id: CAM, recorder: REC, ok: false, at: '2026-10-23T08:00:00.000Z', error: 'x' }], 3)
    expect(c.calls[0].args).toEqual({ p_org: ORG, p_threshold: 3, p_lease: 'monitor', p_fencing_token: 7, p_results: [{ type: 'camera', id: CAM, recorder: REC, ok: false, at: '2026-10-23T08:00:00.000Z', error: 'x' }] })
    c.calls.length = 0
    await db.saveCameraIps(ORG, [{ cameraId: CAM, ip: '192.0.2.10', recorderId: REC }])
    expect(c.calls[0].args).toEqual({ p_org: ORG, p_lease: 'monitor', p_fencing_token: 7, p_rows: [{ camera: CAM, ip: '192.0.2.10', recorder: REC }] })
    // The round of devices and NVRs is 'assets' in the database (the P2-5a word); the camera round is 'cameras'.
    c.calls.length = 0
    await db.markRound('devices', new Date('2026-10-23T08:00:00Z'))
    await db.markRound('cameras', new Date('2026-10-23T08:00:00Z'))
    expect(c.calls.map((x) => x.args.p_kind)).toEqual(['assets', 'cameras'])
  })

  it('without a lease (no fence, or a fence whose token is gone) nothing is sent and the write fails with LeaseLostError', async () => {
    for (const opts of [{}, { fence: fence(null).f }]) {
      const c = fakeClient()
      const db = new SupabaseMonitorDb(c.client, opts)
      for (const [fn, write] of writes(db)) {
        if (fn === 'monitor_save_camera_ips') continue // checked below: it logs instead of failing the recorder's round
        await expect(write(), fn).rejects.toBeInstanceOf(LeaseLostError)
      }
      await expect(db.saveCameraIps(ORG, [{ cameraId: CAM, ip: '192.0.2.10', recorderId: REC }])).rejects.toBeInstanceOf(LeaseLostError)
      expect(c.calls).toEqual([])
    }
  })

  it('a write the database refuses as fenced (stale or expired token) ends the epoch: fence.lost and LeaseLostError, with a clear message', async () => {
    const c = fakeClient(() => ({ error: { code: LEASE_REFUSED_SQLSTATE, message: 'the worker lease monitor is not held with token 7' } }))
    const { f, lost } = fence()
    const db = new SupabaseMonitorDb(c.client, { fence: f })
    const e = await db.applyResults(ORG, [{ type: 'device', id: CAM, ok: true, at: '2026-10-23T08:00:00.000Z' }], 2).catch((x: unknown) => x)
    expect(isLeaseLost(e)).toBe(true)
    expect((e as Error).message).toMatch(/lease/i)
    expect(lost).toEqual(['write_refused'])
    await expect(db.touchHeartbeat(new Date())).rejects.toBeInstanceOf(LeaseLostError)
  })

  it('a write refused because this lease may not write those rows (WL002) is an ordinary error: the lease is not ended (review M-1)', async () => {
    const c = fakeClient(() => ({ error: { code: 'WL002', message: 'only the monitor lease writes the worker state' } }))
    const { f, lost } = fence(7, 'monitor:shard-3')
    const db = new SupabaseMonitorDb(c.client, { fence: f })
    const e = await db.touchHeartbeat(new Date()).catch((x: unknown) => x)
    expect(isLeaseLost(e)).toBe(false)
    expect((e as Error).message).toContain('only the monitor lease')
    expect(lost).toEqual([])
  })

  it('the heartbeat answers how far the worker clock is from the database clock; more than 30 s is logged once as worker_clock_skew (review I-1)', async () => {
    let skewMs = 125_000
    const c = fakeClient((fn) => (fn === 'monitor_heartbeat' ? { data: skewMs, error: null } : { error: null }))
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(String(l)))
    const db = new SupabaseMonitorDb(c.client, { fence: fence().f })
    await db.touchHeartbeat(new Date())
    await db.touchHeartbeat(new Date())
    const skew = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'worker_clock_skew')
    expect(skew()).toHaveLength(1)
    expect(skew()[0]).toMatchObject({ aheadOfDatabaseSec: 125 })
    skewMs = 200
    await db.touchHeartbeat(new Date()) // back in step: logged as such once
    expect(lines.some((l) => l.includes('worker_clock_in_step'))).toBe(true)
    skewMs = -3_600_000
    await db.touchHeartbeat(new Date())
    expect(skew()).toHaveLength(2)
    expect(skew()[1]).toMatchObject({ aheadOfDatabaseSec: -3600 })
  })

  it('other database errors stay ordinary errors with the old wording (the runner counts them, the lease is not touched)', async () => {
    const c = fakeClient(() => ({ error: { code: 'XX000', message: 'boom' } }))
    const { f, lost } = fence()
    const db = new SupabaseMonitorDb(c.client, { fence: f })
    await expect(db.applyResults(ORG, [{ type: 'device', id: CAM, ok: true, at: '2026-10-23T08:00:00.000Z' }], 2)).rejects.toThrow('monitor_apply_results failed')
    await expect(db.recordGap(new Date(), new Date())).rejects.toThrow('recording the gap failed')
    await expect(db.touchHeartbeat(new Date())).rejects.toThrow('heartbeat failed')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.saveCameraIps(ORG, [{ cameraId: CAM, ip: '192.0.2.10', recorderId: REC }]) // logged, not thrown
    expect(lost).toEqual([])
  })
})

describe('MonitorRunner.abandon (P2-7: the lease was lost)', () => {
  it('stops the timers and the cycle in progress probes nothing further; nothing is written afterwards', async () => {
    const db = new MemoryDb()
    db.devices = Array.from({ length: 5 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000010${i}`, org_id: ORG, ip: '127.0.0.1', tcp_port: 1000 + i }))
    let probed = 0
    const holder: { runner?: MonitorRunner } = {}
    const probes: Probes = {
      tcp: async () => {
        probed++
        if (probed === 1) holder.runner!.abandon() // the lease is lost while the first device is being checked
        return { ok: true }
      },
      icmp: async () => ({ ok: true }),
      rtsp: async () => ({ code: 200 }),
      nvr: () => ({ channelStatus: async () => new Map(), channels: async () => [] }),
    }
    const runner = new MonitorRunner({ db, probes, cfg: { ...loadMonitorConfig({}), deviceConcurrency: 1 }, clock: () => new Date() })
    holder.runner = runner
    await runner.runDevices()
    expect(probed).toBe(1)
    expect(db.applied).toEqual([]) // the result computed after the loss is not sent
    expect(db.rounds).toEqual([]) // a round cut short is not marked finished
    const before = db.heartbeats.length
    await runner.pollOnce()
    expect(db.heartbeats.length).toBe(before)
  })
})
