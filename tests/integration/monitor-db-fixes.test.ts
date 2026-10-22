import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanResults, SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createSite } from '../setup/fixtures'

const admin = () => adminClient()

/** The service-role client, with every filter put on every query recorded: [table, column, value]. */
function recording() {
  const filters: [string, string, unknown][] = []
  const real = admin()
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop !== 'from') {
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (table: string) => {
        const wrap = (builder: object): object =>
          new Proxy(builder, {
            get(b, p) {
              const v = Reflect.get(b, p)
              if (typeof v !== 'function') return v
              return (...args: unknown[]) => {
                if (p === 'eq') filters.push([table, String(args[0]), args[1]])
                const out = v.apply(b, args)
                return out && typeof out === 'object' && typeof (out as { eq?: unknown }).eq === 'function' ? wrap(out as object) : out
              }
            },
          })
        return wrap((target.from as (t: string) => object)(table))
      }
    },
  }) as SupabaseClient<Database>
  return { client, filters }
}

describe('SupabaseMonitorDb restricted to one organisation (I6)', () => {
  let orgA: string
  let orgB: string
  let recA: string
  let recB: string

  beforeAll(async () => {
    orgA = await createOrg()
    orgB = await createOrg()
    const a = admin()
    const siteA = await createSite(orgA, { code: 'SCA', host: '127.0.0.1', username: 'u', cameras: 1 })
    const siteB = await createSite(orgB, { code: 'SCB', host: '127.0.0.1', username: 'u', cameras: 1 })
    recA = siteA.recorderId
    recB = siteB.recorderId
    await a.from('assets').insert([
      { org_id: orgA, location_id: siteA.locationId, type: 'server', name: 'DA', ip: '127.0.0.1', tcp_port: 1 },
      { org_id: orgB, location_id: siteB.locationId, type: 'server', name: 'DB', ip: '127.0.0.1', tcp_port: 2 },
    ])
    await a.rpc('monitor_apply_results', { p_org: orgB, p_results: [{ type: 'recorder', id: recB, ok: false, at: new Date().toISOString() }], p_threshold: 1 })
  })
  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('reads only that organisation: devices, NVRs, recorder jobs with their mapped cameras and the NVR state', async () => {
    const { client, filters } = recording()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = new SupabaseMonitorDb(client, { orgId: orgA })
    expect((await db.loadDevices()).map((d) => d.org_id)).toEqual([orgA])
    expect((await db.loadNvrs()).map((n) => n.org_id)).toEqual([orgA])
    const jobs = await db.loadRecorderJobs()
    expect(jobs.map((j) => j.id)).toEqual([recA])
    expect(jobs[0].cameras).toHaveLength(1)
    // Every one of those reads said so in the query itself, including the ones that read the mappings and the NVR states (P2-5b).
    for (const table of ['assets', 'recorders', 'camera_channel_mappings', 'check_state']) {
      expect(filters.some(([t, col, val]) => t === table && col === 'org_id' && val === orgA)).toBe(true)
    }
    vi.restoreAllMocks()
  })

  it('without the option it still sees every organisation (the worker)', async () => {
    const db = new SupabaseMonitorDb(admin())
    const orgs = new Set((await db.loadDevices()).map((d) => d.org_id))
    expect(orgs.has(orgA) && orgs.has(orgB)).toBe(true)
    const jobs = await db.loadRecorderJobs([recA, recB], new Date(Date.now() - 180_000))
    expect(jobs.find((j) => j.id === recB)?.knownDown).toBe(true)
    expect(jobs.find((j) => j.id === recA)?.knownDown).toBe(false)
  })
})

describe('SupabaseMonitorDb gaps and round times', () => {
  const gapIds: string[] = []
  let saved: Database['public']['Tables']['worker_state']['Row']
  beforeAll(async () => {
    saved = (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
  })
  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await admin().from('worker_state').update(saved).eq('id', 1)
  })

  it('recordGap saves the period', async () => {
    const from = new Date('2020-02-01T10:00:00Z')
    const to = new Date('2020-02-01T10:10:00Z')
    await new SupabaseMonitorDb(admin()).recordGap(from, to)
    const { data } = await admin().from('monitor_gaps').select('id, started_at, ended_at').eq('started_at', from.toISOString())
    data?.forEach((g) => gapIds.push(g.id))
    expect(data).toHaveLength(1)
    expect(new Date(data![0].ended_at).getTime()).toBe(to.getTime())
  })

  it('recordGap fails out loud when it cannot save', async () => {
    const refusing = { from: () => ({ insert: async () => ({ error: { message: 'boom' } }) }) } as unknown as SupabaseClient<Database>
    await expect(new SupabaseMonitorDb(refusing).recordGap(new Date(), new Date())).rejects.toThrow('recording the gap failed')
  })

  it('markRound saves the time of the devices round and of the cameras round separately', async () => {
    const db = new SupabaseMonitorDb(admin())
    const t1 = new Date('2026-06-01T10:00:00Z')
    const t2 = new Date('2026-06-01T10:05:00Z')
    await db.markRound('devices', t1)
    await db.markRound('cameras', t2)
    const row = (await admin().from('worker_state').select('last_devices_round_at, last_cameras_round_at').eq('id', 1).single()).data!
    expect(new Date(row.last_devices_round_at!).getTime()).toBe(t1.getTime())
    expect(new Date(row.last_cameras_round_at!).getTime()).toBe(t2.getTime())
  })
})

describe('what is sent to monitor_apply_results (minor 11)', () => {
  it('drops elements with an id that is not a UUID or a type that is not known, and keeps the rest', () => {
    const good = { type: 'camera' as const, id: randomUUID(), ok: true, at: new Date().toISOString() }
    const clean = cleanResults([
      { ...good, id: 'not-a-uuid' },
      { ...good, id: '' },
      { ...good, id: `${randomUUID()}; drop table x` },
      { ...good, type: 'bogus' as never },
      good,
    ])
    expect(clean).toEqual([{ type: 'camera', id: good.id, ok: true, at: good.at }])
  })

  it('one bad id does not stop the others in the batch from being saved', async () => {
    const org = await createOrg()
    try {
      const a = admin()
      const cam = (await createSite(org, { code: 'CL', host: '127.0.0.1', username: 'u', cameras: 1 })).cameraIds[0]
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const at = new Date().toISOString()
      await new SupabaseMonitorDb(admin(), { orgId: org }).applyResults(
        org,
        [{ type: 'camera', id: 'not-a-uuid', ok: false, at }, { type: 'camera', id: cam, ok: true, at }],
        2,
      )
      vi.restoreAllMocks()
      expect((await a.from('check_state').select('status').eq('target_id', cam).single()).data?.status).toBe('up')
    } finally {
      await cleanupOrg(org)
    }
  })
})
