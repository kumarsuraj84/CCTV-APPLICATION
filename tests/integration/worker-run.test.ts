import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg } from '../setup/fixtures'
import { closedPort, startFakeNvr, startFakeRtsp, startFakeTcp, type FakeNvr, type FakeRtsp, type Running } from '../helpers/fake-servers'

const admin = () => adminClient()

type WorkerRow = Database['public']['Tables']['worker_state']['Row']

describe('the worker against a fake network', () => {
  let orgId: string
  let storeId: string
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
    storeId = (await a.from('stores').insert({ org_id: orgId, code: 'RUN', name: 'Run', nvr_ip: '127.0.0.1', rtsp_port: rtsp.port, http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: storeId, p_secret: 'secret-pass' })
    cams = (await a.from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `Camera ${n}` }))).select('id, channel').order('channel')).data!.map((c) => c.id)
    devUp = (await a.from('devices').insert({ org_id: orgId, store_id: storeId, type: 'server', name: 'Up', ip: '127.0.0.1', tcp_port: tcp.port }).select('id').single()).data!.id
    devDown = (await a.from('devices').insert({ org_id: orgId, store_id: storeId, type: 'attendance', name: 'Down', ip: '127.0.0.1', tcp_port: downPort }).select('id').single()).data!.id
    runner = new MonitorRunner({ db: new SupabaseMonitorDb(a, { orgId }), probes: realProbes, cfg: { ...loadMonitorConfig({}), nvrTimeoutMs: 2000 }, clock: () => new Date() })
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
    expect((await state('nvr', storeId))?.status).toBe('up')
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
    await runner.runDevices()
    await runner.runDevices()
    expect((await state('nvr', storeId))?.status).toBe('down')
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
})
