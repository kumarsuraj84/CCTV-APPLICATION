import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import { createServer, type Socket } from 'node:net'
import { adminClient, cleanupOrg, createOrg, createSite } from '../setup/fixtures'
import { testFence } from '../setup/lease'
import { closedPort, startFakeNvr, startFakeRtsp, startFakeTcp, type FakeNvr, type FakeRtsp, type Running } from '../helpers/fake-servers'

const admin = () => adminClient()

type WorkerRow = Database['public']['Tables']['worker_state']['Row']

describe('the worker against a fake network', () => {
  let orgId: string
  let storeId: string
  let recorderId: string
  let cams: string[]
  let devUp: string
  let devDown: string
  let nvr: FakeNvr
  let rtsp: FakeRtsp
  let tcp: Running
  let runner: MonitorRunner
  let saved: WorkerRow

  const state = async (type: string, id: string) => (await admin().from('check_state').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).maybeSingle()).data
  const openOutage = async (type: string, id: string) =>
    (await admin().from('outages').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).is('ended_at', null).maybeSingle()).data

  beforeAll(async () => {
    saved = (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
    orgId = await createOrg()
    nvr = await startFakeNvr({
      statuses: { 1: true, 2: false, 3: true },
      channels: [{ channel: 1, name: 'Door', ip: '192.0.2.11' }, { channel: 2, name: 'Till', ip: '192.0.2.12' }, { channel: 3, name: 'Yard', ip: '192.0.2.13' }],
    })
    rtsp = await startFakeRtsp('refuse')
    tcp = await startFakeTcp()
    const downPort = await closedPort()
    const a = admin()
    // P2-5b: the location's NVR is a recorder with its own address, ports and login; the worker reports ('recorder', its id).
    const site = await createSite(orgId, { code: 'RUN', name: 'Run', host: '127.0.0.1', rtspPort: rtsp.port, httpPort: nvr.port, secret: 'secret-pass', cameras: 3 })
    storeId = site.locationId
    recorderId = site.recorderId
    cams = site.cameraIds
    devUp = (await a.from('assets').insert({ org_id: orgId, location_id: storeId, type: 'server', name: 'Up', ip: '127.0.0.1', tcp_port: tcp.port }).select('id').single()).data!.id
    devDown = (await a.from('assets').insert({ org_id: orgId, location_id: storeId, type: 'attendance', name: 'Down', ip: '127.0.0.1', tcp_port: downPort }).select('id').single()).data!.id
    // P2-7: the runner's writes carry this file's test lease.
    runner = new MonitorRunner({ db: new SupabaseMonitorDb(a, { orgId, fence: await testFence() }), probes: realProbes, cfg: { ...loadMonitorConfig({}), nvrTimeoutMs: 2000 }, clock: () => new Date() })
  })

  afterAll(async () => {
    await nvr.close()
    await rtsp.close()
    await tcp.close()
    await admin().from('worker_state').update(saved).eq('id', 1)
    await cleanupOrg(orgId)
  })

  it('two full runs find what is up and what is down, with outages only after the second failure', async () => {
    await runner.runFull()
    expect((await state('camera', cams[1]))?.status).toBe('unknown') // one failure is not an outage yet
    await runner.runFull()
    expect((await state('recorder', recorderId))?.status).toBe('up')
    expect((await state('camera', cams[0]))?.status).toBe('up')
    expect((await state('camera', cams[2]))?.status).toBe('up')
    expect((await state('camera', cams[1]))?.status).toBe('down')
    expect(await openOutage('camera', cams[1])).not.toBeNull()
    expect((await state('device', devUp))?.status).toBe('up')
    expect((await state('device', devDown))?.status).toBe('down')
    expect(await openOutage('device', devDown)).not.toBeNull()
    expect((await state('camera', cams[1]))?.error).toBe('The camera gave an answer this app does not expect.') // the fake RTSP port answers 404
    expect(rtsp.requests.length).toBeGreaterThanOrEqual(2) // the offline camera was confirmed with RTSP
    const { data: camera } = await admin().from('cameras').select('camera_ip').eq('id', cams[0]).single()
    expect(camera?.camera_ip).toBe('192.0.2.11')
    expect((await admin().from('worker_state').select('run_finished_at, progress_done, progress_total').eq('id', 1).single()).data).toMatchObject({ progress_done: 1, progress_total: 1 })
  })

  it('a camera that comes back closes its outage', async () => {
    nvr.setStatuses({ 1: true, 2: true, 3: true })
    await runner.runCameras()
    expect((await state('camera', cams[1]))?.status).toBe('up')
    expect(await openOutage('camera', cams[1])).toBeNull()
  })

  it('when the NVR goes down its cameras go down at once with the NVR as the cause', async () => {
    await rtsp.close() // the NVR video port is gone
    // Final fix X (review C M-6): an NVR is called down after three failed reachability checks in a row (RECORDER_FAIL_THRESHOLD).
    await runner.runDevices()
    await runner.runDevices()
    expect((await state('recorder', recorderId))?.status).not.toBe('down')
    await runner.runDevices()
    expect((await state('recorder', recorderId))?.status).toBe('down')
    await runner.runCameras()
    for (const c of cams) {
      expect((await state('camera', c))?.status).toBe('down')
      expect((await openOutage('camera', c))?.cause).toBe('nvr_down')
    }
  })

  it('a check-now request makes the worker run everything once', async () => {
    const a = admin()
    await a.from('worker_state').update({ check_requested_at: new Date().toISOString(), run_started_at: null, run_finished_at: null }).eq('id', 1)
    await runner.pollOnce()
    const first = (await a.from('worker_state').select('run_started_at, run_finished_at, last_heartbeat').eq('id', 1).single()).data!
    expect(first.run_started_at).not.toBeNull()
    expect(first.run_finished_at).not.toBeNull()
    expect(Date.now() - new Date(first.last_heartbeat!).getTime()).toBeLessThan(15_000)
    await runner.pollOnce()
    const second = (await a.from('worker_state').select('run_started_at').eq('id', 1).single()).data!
    expect(second.run_started_at).toBe(first.run_started_at)
  })
  it('saves when the last devices round and the last cameras round finished', async () => {
    const a = admin()
    await a.from('worker_state').update({ last_devices_round_at: null, last_cameras_round_at: null }).eq('id', 1)
    const before = Date.now()
    await runner.runDevices()
    let row = (await a.from('worker_state').select('last_devices_round_at, last_cameras_round_at').eq('id', 1).single()).data!
    expect(new Date(row.last_devices_round_at!).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(row.last_cameras_round_at).toBeNull()
    await runner.runCameras()
    row = (await a.from('worker_state').select('last_devices_round_at, last_cameras_round_at').eq('id', 1).single()).data!
    expect(new Date(row.last_cameras_round_at!).getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('owner addition: an NVR with monitoring switched off is never contacted by any round (zero connections), and switched on again it is', async () => {
    // Fresh fake NVR and a counting TCP listener as its video (RTSP) port, so every connection the worker opens is seen.
    const offNvr = await startFakeNvr({ statuses: { 1: true }, channels: [{ channel: 1, name: 'Real' }] })
    const sockets: Socket[] = []
    let connections = 0
    const video = createServer((s) => { connections++; sockets.push(s); s.destroy() })
    await new Promise<void>((resolve) => video.listen(0, '127.0.0.1', resolve))
    const videoPort = (video.address() as { port: number }).port
    const a = admin()
    try {
      const real = await createSite(orgId, { code: 'REAL', name: 'Real NVR', host: '127.0.0.1', rtspPort: videoPort, httpPort: offNvr.port, secret: 'secret-pass', cameras: 1 })
      const cam = real.cameraIds[0]
      const rec = real.recorderId
      expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR: read-only, not now' })).error).toBeNull()
      await runner.runFull()
      await runner.runDevices()
      await runner.runCameras()
      expect(offNvr.requests).toEqual([])
      expect(connections).toBe(0)
      expect(await state('recorder', rec)).toBeNull()
      expect(await state('camera', cam)).toBeNull()
      // Enabling resumes monitoring.
      expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab check allowed' })).error).toBeNull()
      await runner.runFull()
      expect(offNvr.requests.length + connections).toBeGreaterThan(0)
      expect(await state('recorder', rec)).not.toBeNull()
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => video.close(() => resolve()))
      await offNvr.close()
    }
  })
})
