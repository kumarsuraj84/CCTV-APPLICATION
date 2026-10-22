import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createSite } from '../setup/fixtures'
import { testFence } from '../setup/lease'

const admin = () => adminClient()

/**
 * The service-role client, with every credential read counted (by recorder id), and optionally failing. P2-6: the worker reads through
 * the logged recorder_credential_read with purpose `monitoring` (and nothing else).
 */
function watched(fail = false) {
  const reads: string[] = []
  const real = admin()
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === 'rpc') {
        return (name: string, args: { p_recorder?: string; p_purpose?: string }) => {
          if (name === 'recorder_read_credential') throw new Error('the worker must use recorder_credential_read (P2-6)')
          if (name !== 'recorder_credential_read') return target.rpc(name as never, args as never)
          if (args.p_purpose !== 'monitoring') throw new Error(`the worker read a login for ${args.p_purpose}`)
          reads.push(args.p_recorder ?? '')
          return fail ? Promise.resolve({ data: null, error: { code: 'XX000', message: 'vault is down' } }) : target.rpc(name, args as never)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SupabaseClient<Database>
  return { client, reads }
}

// P2-5b: the worker's data layer reads RECORDERS (one job per NVR, its own address, ports, login and password) and the cameras of
// each recorder's ACTIVE channel mappings. The old per-store job on the location's legacy NVR columns is gone.
describe('SupabaseMonitorDb (per recorder)', () => {
  let orgId: string
  let storeId: string
  let recorderId: string
  let bareRecorder: string
  let noPassRecorder: string
  let camIds: string[]
  let db: SupabaseMonitorDb
  const gapIds: string[] = []
  let savedHeartbeat: string | null

  beforeAll(async () => {
    orgId = await createOrg()
    // P2-7: the data layer writes with this file's test lease (every write carries its fencing token).
    db = new SupabaseMonitorDb(admin(), { orgId, fence: await testFence() })
    const a = admin()
    const site = await createSite(orgId, { code: 'DB1', host: '127.0.0.1', rtspPort: 8554, httpPort: 8081, secret: 'secret-pass', cameras: 2 })
    storeId = site.locationId
    recorderId = site.recorderId
    camIds = site.cameraIds
    bareRecorder = (await createSite(orgId, { code: 'DB2', host: '127.0.0.2' })).recorderId
    noPassRecorder = (await createSite(orgId, { code: 'DB3', host: '127.0.0.3', cameras: 1 })).recorderId
    await a.from('assets').insert([
      { org_id: orgId, location_id: storeId, type: 'server', name: 'On', ip: '127.0.0.1', tcp_port: 9, enabled: true },
      { org_id: orgId, location_id: storeId, type: 'server', name: 'Off', ip: '127.0.0.1', tcp_port: 10, enabled: false },
    ])
    savedHeartbeat = (await a.from('worker_state').select('last_heartbeat').eq('id', 1).single()).data!.last_heartbeat
  })

  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await admin().from('worker_state').update({ last_heartbeat: savedHeartbeat, check_requested_at: null, run_started_at: null, run_finished_at: null, progress_done: 0, progress_total: 0 }).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('loads only enabled devices, and each monitored NVR with its own address and video port', async () => {
    const devices = (await db.loadDevices()).filter((d) => d.org_id === orgId)
    expect(devices.map((d) => d.tcp_port)).toEqual([9])
    expect((await db.loadNvrs()).find((n) => n.id === recorderId)).toEqual({ id: recorderId, org_id: orgId, location_id: storeId, ip: '127.0.0.1', rtsp_port: 8554 })
  })

  it('loads a recorder job with its decrypted password, its cameras and its own state', async () => {
    const [job] = await db.loadRecorderJobs([recorderId])
    expect(job).toMatchObject({ id: recorderId, location_id: storeId, org_id: orgId, code: 'DB1', name: 'NVR', http_port: 8081, rtsp_port: 8554, username: 'viewer', password: 'secret-pass', nvr_status: 'unknown' })
    expect(job.cameras.map((c) => c.channel)).toEqual([1, 2])
    await db.applyResults(orgId, [{ type: 'recorder', id: recorderId, ok: false, at: new Date().toISOString() }], 1)
    expect((await db.loadRecorderJobs([recorderId]))[0].nvr_status).toBe('down')
  })

  it('loads a recorder without a saved password with an empty one, and only the recorders asked for', async () => {
    const jobs = await db.loadRecorderJobs([recorderId, bareRecorder, noPassRecorder, randomUUID()])
    expect(jobs.map((j) => j.code).sort()).toEqual(['DB1', 'DB2', 'DB3'])
    expect(jobs.find((j) => j.id === bareRecorder)).toMatchObject({ password: '', cameras: [] })
    expect(jobs.find((j) => j.id === noPassRecorder)).toMatchObject({ password: '' })
    expect(jobs.find((j) => j.id === noPassRecorder)?.cameras).toHaveLength(1)
    expect(await db.loadRecorderJobs([])).toEqual([])
  })

  it('owner addition: an NVR with monitoring switched off is in no round (no NVR check, no cameras, no password read)', async () => {
    const a = admin()
    const { recorderId: rec } = await createSite(orgId, { code: 'DBOFF', host: '127.0.0.9', secret: 'secret-pass', cameras: 1 })
    expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR, not to be contacted' })).error).toBeNull()
    const { client, reads } = watched()
    const watchedDb = new SupabaseMonitorDb(client, { orgId })
    expect((await watchedDb.loadNvrs()).map((n) => n.id)).not.toContain(rec)
    expect(await watchedDb.loadRecorderJobs([rec])).toEqual([])
    expect((await watchedDb.loadRecorderJobs()).map((j) => j.id)).not.toContain(rec)
    expect(reads).not.toContain(rec) // its password is never read
    // Its NVR is a recorder, never probed as a device either.
    expect((await watchedDb.loadDevices()).map((d) => d.id)).not.toContain(rec)
    // Switched on again: back in the rounds.
    await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab NVR' })
    expect((await watchedDb.loadNvrs()).map((n) => n.id)).toContain(rec)
    expect((await watchedDb.loadRecorderJobs([rec]))[0]?.cameras).toHaveLength(1)
  })

  it('an archived, disabled or inactive-location NVR is in no round either', async () => {
    const a = admin()
    const disabled = (await createSite(orgId, { code: 'DBDIS', host: '127.0.0.21', cameras: 1 })).recorderId
    await a.from('assets').update({ enabled: false }).eq('id', disabled)
    const inactive = await createSite(orgId, { code: 'DBINA', host: '127.0.0.22', cameras: 1 })
    await a.from('locations').update({ is_active: false }).eq('id', inactive.locationId)
    const loc = await createLocation(orgId, { code: 'DBARC' })
    const archived = await createRecorder(orgId, loc, { host: '127.0.0.23' })
    expect((await a.rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: archived })).error).toBeNull()
    const ids = [disabled, inactive.recorderId, archived]
    expect((await db.loadNvrs()).map((n) => n.id).filter((id) => ids.includes(id))).toEqual([])
    expect(await db.loadRecorderJobs(ids)).toEqual([])
  })

  it('a location with three NVRs is three jobs; each holds exactly the cameras mapped to it (the same channel number on each)', async () => {
    const two = await createLocation(orgId, { code: 'DBTWO' })
    const r1 = await createRecorder(orgId, two, { host: '127.0.0.11' })
    const r2 = await createRecorder(orgId, two, { host: '127.0.0.12' })
    const r3 = await createRecorder(orgId, two, { host: '127.0.0.13' })
    const c1 = await createCamera(orgId, { locationId: two, recorderId: r1, channel: 1, name: 'On first' })
    const c2 = await createCamera(orgId, { locationId: two, recorderId: r2, channel: 1, name: 'On second' })
    const c3 = await createCamera(orgId, { locationId: two, recorderId: r2, channel: 2, name: 'Also on second' })
    // A camera of this location without a mapping (several NVRs: the database does not guess one) is never in a job.
    const unmapped = await createCamera(orgId, { locationId: two, channel: 9, name: 'Not mapped' })
    expect((await admin().from('camera_channel_mappings').select('id').eq('camera_id', unmapped)).data).toEqual([])
    const jobs = await db.loadRecorderJobs([r1, r2, r3])
    const by = new Map(jobs.map((j) => [j.id, j.cameras.map((c) => [c.id, c.channel])]))
    expect(by.get(r1)).toEqual([[c1, 1]])
    expect(by.get(r2)).toEqual([[c2, 1], [c3, 2]])
    expect(by.get(r3)).toEqual([])
    expect(jobs.flatMap((j) => j.cameras.map((c) => c.id))).not.toContain(unmapped)
    expect(new Set(jobs.map((j) => j.ip))).toEqual(new Set(['127.0.0.11', '127.0.0.12', '127.0.0.13']))
    // A remap moves the camera to the other job at once (the mapping is the truth).
    await admin().rpc('camera_remap', { p_org: orgId, p_camera: c3, p_recorder: r3, p_channel: 5 })
    const after = new Map((await db.loadRecorderJobs([r2, r3])).map((j) => [j.id, j.cameras.map((c) => [c.id, c.channel])]))
    expect(after.get(r2)).toEqual([[c2, 1]])
    expect(after.get(r3)).toEqual([[c3, 5]])
  })

  it('leaves a recorder out of the round when its password cannot be read; only that recorder\'s login is read', async () => {
    const { client, reads } = watched(true)
    expect(await new SupabaseMonitorDb(client, { orgId }).loadRecorderJobs([noPassRecorder])).toEqual([])
    expect(reads).toEqual([noPassRecorder])
  })

  it('does not read the password of a recorder without cameras or with a recent NVR "down", and still returns it', async () => {
    const { client, reads } = watched(true) // a vault that is down must not matter for these recorders
    const jobs = await new SupabaseMonitorDb(client, { orgId }).loadRecorderJobs([recorderId, bareRecorder], new Date(Date.now() - 180_000))
    expect(reads).toEqual([])
    expect(jobs.map((j) => j.code).sort()).toEqual(['DB1', 'DB2'])
    expect(jobs.find((j) => j.id === recorderId)).toMatchObject({ password: '', nvr_status: 'down' })
    expect(jobs.find((j) => j.id === recorderId)?.nvr_checked_at).not.toBeNull()
  })

  it('reads the password again when the NVR "down" is out of date', async () => {
    const { client, reads } = watched()
    const [job] = await new SupabaseMonitorDb(client, { orgId }).loadRecorderJobs([recorderId], new Date(Date.now() + 60_000))
    expect(reads).toEqual([recorderId])
    expect(job).toMatchObject({ password: 'secret-pass', nvr_status: 'down' })
  })

  it('applies results, records camera addresses, and surfaces database errors', async () => {
    await db.applyResults(orgId, [{ type: 'camera', id: camIds[0], recorder: recorderId, ok: true, at: new Date().toISOString() }], 2)
    const { data } = await admin().from('check_state').select('status').eq('target_id', camIds[0]).single()
    expect(data?.status).toBe('up')
    await db.saveCameraIps(orgId, [{ cameraId: camIds[0], ip: '192.0.2.77', recorderId }])
    expect((await admin().from('cameras').select('camera_ip').eq('id', camIds[0]).single()).data?.camera_ip).toBe('192.0.2.77')
    // Review M-3: an address reported by an NVR the camera is no longer on is not saved.
    await db.saveCameraIps(orgId, [{ cameraId: camIds[0], ip: '192.0.2.78', recorderId: '00000000-0000-4000-8000-000000000000' }])
    expect((await admin().from('cameras').select('camera_ip').eq('id', camIds[0]).single()).data?.camera_ip).toBe('192.0.2.77')
    // A database that refuses the call is an error the caller sees (here a client whose call fails).
    const refusing = { rpc: async () => ({ data: null, error: { message: 'boom' } }) } as unknown as SupabaseClient<Database>
    await expect(new SupabaseMonitorDb(refusing, { fence: await testFence() }).applyResults(orgId, [{ type: 'camera', id: camIds[0], recorder: recorderId, ok: true, at: new Date().toISOString() }], 2)).rejects.toThrow('monitor_apply_results failed')
  })

  it('sends the function only complete results, once per target, the last one winning; the old \'nvr\' kind is never sent', async () => {
    const t = Date.now()
    const at = (s: number) => new Date(t + s * 1000).toISOString()
    const sent: unknown[] = []
    const real = admin()
    const spying = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') return (name: string, args: { p_results?: unknown[] }) => { if (name === 'monitor_apply_results') sent.push(...(args.p_results ?? [])); return target.rpc(name as never, args as never) }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SupabaseClient<Database>
    await new SupabaseMonitorDb(spying, { orgId, fence: await testFence() }).applyResults(
      orgId,
      [
        { type: 'camera', id: camIds[1], recorder: recorderId, ok: false, at: at(0), error: 'first' },
        { type: 'camera', id: camIds[1], recorder: recorderId, ok: true, at: at(1) },
        { type: 'camera', id: camIds[0], recorder: recorderId, ok: undefined as never, at: at(1) },
        { type: 'camera', id: camIds[0], recorder: recorderId, ok: true, at: undefined as never },
        // P2-6: a camera result without its recorder is never sent.
        { type: 'camera', id: camIds[0], ok: true, at: at(1) },
        { type: 'bogus' as never, id: camIds[0], ok: true, at: at(1) },
        { type: 'nvr' as never, id: storeId, ok: true, at: at(1) },
      ],
      2,
    )
    expect(sent).toEqual([{ type: 'camera', id: camIds[1], recorder: recorderId, ok: true, at: at(1) }])
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
    await admin().from('worker_state').update({ check_requested_at: t0.toISOString(), run_started_at: null, run_finished_at: null }).eq('id', 1)
    expect(await db.readRequest()).toEqual({ requestedAt: t0, runStartedAt: null, runFinishedAt: null })
    await db.markRunStarted(new Date(t0.getTime() + 1000), 3)
    await db.markProgress(2, 3)
    const { data } = await admin().from('worker_state').select('progress_done, progress_total, run_finished_at').eq('id', 1).single()
    expect(data).toEqual({ progress_done: 2, progress_total: 3, run_finished_at: null })
    await db.markRunFinished(new Date(t0.getTime() + 5000))
    expect((await admin().from('worker_state').select('run_finished_at').eq('id', 1).single()).data?.run_finished_at).not.toBeNull()
  })
})
