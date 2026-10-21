import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg } from '../setup/fixtures'

const admin = () => adminClient()

describe('SupabaseMonitorDb', () => {
  let orgId: string
  let storeId: string
  let bareStoreId: string
  let camIds: string[]
  let db: SupabaseMonitorDb
  const gapIds: string[] = []
  let savedHeartbeat: string | null

  beforeAll(async () => {
    orgId = await createOrg()
    db = new SupabaseMonitorDb(admin())
    const a = admin()
    storeId = (await a.from('stores').insert({ org_id: orgId, code: 'DB1', name: 'Db1', nvr_ip: '127.0.0.1', rtsp_port: 8554, http_port: 8081, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: storeId, p_secret: 'secret-pass' })
    bareStoreId = (await a.from('stores').insert({ org_id: orgId, code: 'DB2', name: 'Db2', nvr_ip: '127.0.0.2', nvr_username: 'viewer' }).select('id').single()).data!.id
    camIds = (await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `C${n}` }))).select('id, channel').order('channel')).data!.map((c) => c.id)
    await a.from('devices').insert([
      { org_id: orgId, store_id: storeId, type: 'server', name: 'On', ip: '127.0.0.1', tcp_port: 9, enabled: true },
      { org_id: orgId, store_id: storeId, type: 'server', name: 'Off', ip: '127.0.0.1', tcp_port: 10, enabled: false },
    ])
    savedHeartbeat = (await a.from('worker_state').select('last_heartbeat').eq('id', 1).single()).data!.last_heartbeat
  })

  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await admin().from('worker_state').update({ last_heartbeat: savedHeartbeat, check_requested_at: null, run_started_at: null, run_finished_at: null, progress_done: 0, progress_total: 0 }).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('loads only enabled devices and the NVR of active stores', async () => {
    const devices = (await db.loadDevices()).filter((d) => d.org_id === orgId)
    expect(devices.map((d) => d.tcp_port)).toEqual([9])
    expect((await db.loadNvrs()).find((n) => n.id === storeId)).toMatchObject({ ip: '127.0.0.1', rtsp_port: 8554 })
  })

  it('loads a store with its decrypted password, cameras and NVR state', async () => {
    const [job] = await db.loadStoreJobs([storeId])
    expect(job).toMatchObject({ id: storeId, org_id: orgId, code: 'DB1', http_port: 8081, rtsp_port: 8554, username: 'viewer', password: 'secret-pass', nvr_status: 'unknown' })
    expect(job.cameras.map((c) => c.channel)).toEqual([1, 2])
    await db.applyResults(orgId, [{ type: 'nvr', id: storeId, ok: false, at: new Date().toISOString() }], 1)
    expect((await db.loadStoreJobs([storeId]))[0].nvr_status).toBe('down')
  })

  it('loads a store without a saved password with an empty one, and only the stores asked for', async () => {
    const jobs = await db.loadStoreJobs([storeId, bareStoreId, randomUUID()])
    expect(jobs.map((j) => j.code).sort()).toEqual(['DB1', 'DB2'])
    expect(jobs.find((j) => j.id === bareStoreId)).toMatchObject({ password: '', cameras: [] })
    expect(await db.loadStoreJobs([])).toEqual([])
  })

  it('leaves a store out of the round when its password cannot be read', async () => {
    const real = admin()
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') {
          return (name: string, args: never) =>
            name === 'nvr_read_credential' ? Promise.resolve({ data: null, error: { code: 'XX000', message: 'vault is down' } }) : target.rpc(name as never, args)
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SupabaseClient<Database>
    expect(await new SupabaseMonitorDb(failing).loadStoreJobs([storeId])).toEqual([])
  })

  it('applies results, records camera addresses, and surfaces database errors', async () => {
    await db.applyResults(orgId, [{ type: 'camera', id: camIds[0], ok: true, at: new Date().toISOString() }], 2)
    const { data } = await admin().from('check_state').select('status').eq('target_id', camIds[0]).single()
    expect(data?.status).toBe('up')
    await db.saveCameraIps(orgId, [{ cameraId: camIds[0], ip: '192.0.2.77' }])
    expect((await admin().from('cameras').select('camera_ip').eq('id', camIds[0]).single()).data?.camera_ip).toBe('192.0.2.77')
    await expect(db.applyResults(randomUUID(), [{ type: 'camera', id: 'not-a-uuid' as never, ok: true, at: new Date().toISOString() }], 2)).rejects.toThrow('monitor_apply_results failed')
  })

  it('sends the function only complete results, once per target, the last one winning', async () => {
    const t = Date.now()
    const at = (s: number) => new Date(t + s * 1000).toISOString()
    await db.applyResults(
      orgId,
      [
        { type: 'camera', id: camIds[1], ok: false, at: at(0), error: 'first' },
        { type: 'camera', id: camIds[1], ok: true, at: at(1) },
        { type: 'camera', id: camIds[0], ok: undefined as never, at: at(1) },
        { type: 'camera', id: camIds[0], ok: true, at: undefined as never },
        { type: 'bogus' as never, id: camIds[0], ok: true, at: at(1) },
      ],
      2,
    )
    const { data } = await admin().from('check_state').select('status, consecutive_failures').eq('target_id', camIds[1]).single()
    expect(data).toEqual({ status: 'up', consecutive_failures: 0 })
  })

  it('keeps the heartbeat, notes a gap after a long silence and not after a short one', async () => {
    const now = new Date()
    await admin().from('worker_state').update({ last_heartbeat: new Date(now.getTime() - 60_000).toISOString() }).eq('id', 1)
    expect(await db.recordStartupGap(now, 30_000)).toBe(true)
    const { data: gaps } = await admin().from('monitor_gaps').select('id').gte('ended_at', now.toISOString())
    gaps?.forEach((g) => gapIds.push(g.id))
    expect(gaps?.length).toBeGreaterThanOrEqual(1)
    expect(await db.recordStartupGap(new Date(now.getTime() + 10_000), 30_000)).toBe(false)
  })

  it('reads the check request and tracks the progress of a run', async () => {
    const t0 = new Date()
    await admin().from('worker_state').update({ check_requested_at: t0.toISOString(), run_started_at: null }).eq('id', 1)
    expect(await db.readRequest()).toEqual({ requestedAt: t0, runStartedAt: null })
    await db.markRunStarted(new Date(t0.getTime() + 1000), 3)
    await db.markProgress(2, 3)
    const { data } = await admin().from('worker_state').select('progress_done, progress_total, run_finished_at').eq('id', 1).single()
    expect(data).toEqual({ progress_done: 2, progress_total: 3, run_finished_at: null })
    await db.markRunFinished(new Date(t0.getTime() + 5000))
    expect((await admin().from('worker_state').select('run_finished_at').eq('id', 1).single()).data?.run_finished_at).not.toBeNull()
  })
})
