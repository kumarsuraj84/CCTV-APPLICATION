import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { MSG_MONITORING_OFF, MSG_NOT_MAPPED } from '@/lib/inventory/recorders'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { discoverAllRecorders, discoverRecorderCameras, discoverStoreCameras } from '@/lib/monitor/discovery'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { getStates, statusLabel } from '@/lib/queries/status'
import { openStreams } from '@/lib/streams/open'
import { listDaySegments, openPlayback } from '@/lib/streams/playback'
import { shownNowMs } from '@/lib/streams/timeline'
import { serveVod } from '@/lib/streams/vod'
import type { Database } from '@/types/database'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { closedPort, startCountingTcp, startFakeNvr, startFakeRtsp, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'
import { fakeSpawn } from '../helpers/fake-spawn'
import {
  ADMINISTRATOR_SET, adminClient, atLocation, CCTV_VIEW, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, type TestUser,
} from '../setup/fixtures'
import { testFence } from '../setup/lease'

const admin = () => adminClient()
const SECRET = 'integration-test-stream-secret-0123456789'

/** The service-role client with every RPC recorded (name and arguments). */
function recordingRpc() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const real = admin()
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === 'rpc') return (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return target.rpc(name as never, args as never) }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as SupabaseClient<Database>
  return { client, calls }
}

// P2-5b (VA-5, brief "multi-NVR location end to end"): ONE location with three NVRs, each with its own address, ports, login and clock
// offset: A answers (a fake NVR on loopback), B is down (nothing listens), C has monitoring switched off (two counting listeners prove
// that nothing ever opens a socket to it). Cameras have the SAME channel numbers on A and B. One camera of the location has no mapping.
describe('a location with several NVRs, end to end', () => {
  let orgId: string
  let loc: string
  let recA: string, recB: string, recC: string
  let a1: string, a2: string, b1: string, b2: string, c1: string, unmapped: string
  let nvrA: FakeNvr
  let rtspA: FakeRtsp
  let cHttp: Awaited<ReturnType<typeof startCountingTcp>>, cRtsp: Awaited<ReturnType<typeof startCountingTcp>>
  let bHttp: number, bRtsp: number
  let viewer: TestUser, it_: TestUser, administrator: TestUser
  let adminActor: Actor
  let go2rtc: FakeGo2rtc
  let runner: MonitorRunner
  let savedWorker: Database['public']['Tables']['worker_state']['Row']
  const savedSecret = process.env.STREAM_TOKEN_SECRET
  const cConnections = () => cHttp.connections() + cRtsp.connections()

  const state = async (type: string, id: string) => (await admin().from('check_state').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).maybeSingle()).data
  const openOutage = async (type: string, id: string) =>
    (await admin().from('outages').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).is('ended_at', null).maybeSingle()).data

  beforeAll(async () => {
    savedWorker = (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
    orgId = await createOrg()
    nvrA = await startFakeNvr({
      password: 'pass-a',
      statuses: { 1: true, 2: false },
      channels: [{ channel: 1, name: 'Door A', ip: '192.0.2.41' }, { channel: 2, name: 'Till A', ip: '192.0.2.42' }, { channel: 3, name: 'Yard A', ip: '192.0.2.43' }],
    })
    rtspA = await startFakeRtsp('refuse')
    cHttp = await startCountingTcp()
    cRtsp = await startCountingTcp()
    bHttp = await closedPort()
    bRtsp = await closedPort()
    loc = await createLocation(orgId, { code: 'MNVR', name: 'Three NVRs' })
    // A: no clock offset of its own (the default applies); B: one hour ahead (measured); C: switched off.
    recA = await createRecorder(orgId, loc, { name: 'A', host: '127.0.0.1', httpPort: nvrA.port, rtspPort: rtspA.port, username: 'viewer', secret: 'pass-a' })
    recB = await createRecorder(orgId, loc, { name: 'B', host: '127.0.0.1', httpPort: bHttp, rtspPort: bRtsp, username: 'viewer', secret: 'pass-b', clockOffsetSec: 3600 })
    recC = await createRecorder(orgId, loc, { name: 'C', host: '127.0.0.1', httpPort: cHttp.port, rtspPort: cRtsp.port, username: 'viewer', secret: 'pass-c', monitoringOff: 'Real NVR: not to be contacted' })
    a1 = await createCamera(orgId, { locationId: loc, recorderId: recA, channel: 1, name: 'Door A' })
    a2 = await createCamera(orgId, { locationId: loc, recorderId: recA, channel: 2, name: 'Till A' })
    b1 = await createCamera(orgId, { locationId: loc, recorderId: recB, channel: 1, name: 'Door B' })
    b2 = await createCamera(orgId, { locationId: loc, recorderId: recB, channel: 2, name: 'Till B' })
    c1 = await createCamera(orgId, { locationId: loc, recorderId: recC, channel: 1, name: 'Door C' })
    unmapped = await createCamera(orgId, { locationId: loc, channel: 7, name: 'Not linked' })
    viewer = await createUser(orgId, 'user')
    it_ = await createUser(orgId, 'user')
    administrator = await createUser(orgId, 'admin')
    adminActor = { id: administrator.id, orgId, role: 'admin' }
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(loc))
    await grant(orgId, it_.id, ['it.monitoring.view', 'cctv.live'], atLocation(loc))
    await grant(orgId, administrator.id, ADMINISTRATOR_SET)
    // P2-7: the runner's writes carry this file's test lease.
    runner = new MonitorRunner({ db: new SupabaseMonitorDb(admin(), { orgId, fence: await testFence() }), probes: realProbes, cfg: { ...loadMonitorConfig({}), nvrTimeoutMs: 1500, tcpTimeoutMs: 1500 }, clock: () => new Date() })
  })

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await Promise.all([nvrA.close(), rtspA.close(), cHttp.close(), cRtsp.close()])
    await admin().from('worker_state').update(savedWorker).eq('id', 1)
    await cleanupOrg(orgId)
  })

  beforeEach(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    go2rtc = await startFakeGo2rtc()
  })
  afterEach(async () => {
    await go2rtc.close()
    // Every step ends with the same proof: the switched-off NVR was never contacted.
    expect(cConnections()).toBe(0)
  })

  it('the setup is what it says: no mapping for the unlinked camera, the same channel numbers on A and B', async () => {
    expect((await admin().from('camera_channel_mappings').select('id').eq('camera_id', unmapped)).data).toEqual([])
    const maps = (await admin().from('camera_channel_mappings').select('camera_id, recorder_id, channel').in('camera_id', [a1, b1]).is('valid_to', null)).data!
    expect(new Map(maps.map((m) => [m.camera_id, [m.recorder_id, m.channel]]))).toEqual(new Map([[a1, [recA, 1]], [b1, [recB, 1]]]))
  })

  it('a monitor round: only the down NVR\'s cameras are marked with the recorder as the cause; the other NVR\'s cameras are checked normally', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runner.runFull()
    await runner.runFull()
    vi.restoreAllMocks()
    expect((await state('recorder', recA))?.status).toBe('up')
    expect((await state('recorder', recB))?.status).toBe('down')
    expect(await state('recorder', recC)).toBeNull()
    expect((await state('camera', a1))?.status).toBe('up')
    const a2State = await state('camera', a2)
    expect(a2State?.status).toBe('down')
    expect((await openOutage('camera', a2))?.cause).toBeNull() // its own failure, not the recorder's
    for (const b of [b1, b2]) {
      expect((await state('camera', b))?.status).toBe('down')
      expect((await state('camera', b))?.method).toBe('nvr_down')
      expect((await openOutage('camera', b))?.cause).toBe('nvr_down')
    }
    // Never probed: the switched-off NVR's camera and the camera without a mapping.
    expect(await state('camera', c1)).toBeNull()
    expect(await state('camera', unmapped)).toBeNull()
    // NVR A's camera addresses came from A only.
    expect((await admin().from('cameras').select('camera_ip').eq('id', a1).single()).data?.camera_ip).toBe('192.0.2.41')
    expect((await admin().from('cameras').select('camera_ip').eq('id', b1).single()).data?.camera_ip).toBeNull()
  })

  it('what people see: the viewer gets camera terms and "Not checked yet" for the unlinked camera; the IT person sees each NVR', async () => {
    const forViewer = await getStates(viewer.client, 'camera', [a1, a2, b1, c1, unmapped])
    expect(statusLabel(forViewer.get(unmapped)?.status)).toBe('Not checked yet')
    expect(forViewer.get(c1)?.status).toBe('off')
    expect(forViewer.get(b1)?.error).toBe('Recorder not reachable.')
    expect(forViewer.get(a2)?.error).toBe('The camera is not responding.')
    expect((await getStates(viewer.client, 'recorder', [recA, recB, recC])).size).toBe(0) // no recorder detail for viewers
    const nvrs = await getStates(it_.client, 'recorder', [recA, recB, recC])
    expect([nvrs.get(recA)?.status, nvrs.get(recB)?.status, nvrs.get(recC)?.status]).toEqual(['up', 'down', 'off'])
    const row = (await it_.client.from('location_status').select('recorders_total, recorders_down, recorders_monitoring_off, nvr_status, cameras_monitoring_off').eq('location_id', loc).single()).data
    expect(row).toEqual({ recorders_total: 3, recorders_down: 1, recorders_monitoring_off: 1, nvr_status: 'down', cameras_monitoring_off: 1 })
  })

  it('live video opens each camera through ITS OWN recorder (address, video port, login, channel); never C, never the unlinked camera', async () => {
    const { client, calls } = recordingRpc()
    const res = await openStreams({ admin: client, rls: viewer.client, go2rtc: go2rtc.client, env: {} }, { id: viewer.id, orgId }, [a1, b1, c1, unmapped], 'sub')
    expect(res.ok && res.streams.map((s) => [s.cameraId, s.channel])).toEqual([[a1, 1], [b1, 1]])
    const srcOf = (cam: string) => go2rtc.seen.find((s) => s.name === `cam_${cam}_sub`)!.src
    expect(srcOf(a1)).toBe(`rtsp://viewer:pass-a@127.0.0.1:${rtspA.port}/Streaming/Channels/102`)
    expect(srcOf(b1)).toBe(`rtsp://viewer:pass-b@127.0.0.1:${bRtsp}/Streaming/Channels/102`)
    // One login read per recorder that is used, keyed by recorder — never C's, never a location-keyed function.
    const reads = calls.filter((c) => /credential/.test(c.name))
    expect(reads.map((c) => c.name)).toEqual(['recorder_credential_read', 'recorder_credential_read']) // P2-6: logged, purpose live
    expect(reads.map((c) => c.args.p_recorder).sort()).toEqual([recA, recB].sort())
    // Only the switched-off camera, or only the unlinked one: a plain refusal and nothing registered.
    expect(await openStreams({ admin: admin(), rls: viewer.client, go2rtc: go2rtc.client, env: {} }, { id: viewer.id, orgId }, [c1], 'sub')).toEqual({ ok: false, error: MSG_MONITORING_OFF })
    expect(await openStreams({ admin: admin(), rls: viewer.client, go2rtc: go2rtc.client, env: {} }, { id: viewer.id, orgId }, [unmapped], 'sub')).toEqual({ ok: false, error: MSG_NOT_MAPPED })
    expect(go2rtc.seen.map((s) => s.name).sort()).toEqual([`cam_${a1}_sub`, `cam_${b1}_sub`].sort())
  })

  it('playback opens the right recorder and applies ITS clock offset (ruling R13: the NVR is asked for shown time minus the offset)', async () => {
    const start = new Date(Math.floor((shownNowMs(Date.now()) - 2 * 3600_000) / 1000) * 1000)
    const deps = { admin: admin(), rls: viewer.client, go2rtc: go2rtc.client, env: {} }
    const nvrTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    // A has no offset of its own: the default (here 30 minutes) applies. B has +3600 s of its own, whatever the default is.
    const pa = await openPlayback(deps, { id: viewer.id, orgId }, a1, start, 10, 30)
    const pb = await openPlayback(deps, { id: viewer.id, orgId }, b1, start, 10, 30)
    expect(pa.ok && pb.ok).toBe(true)
    const srcA = go2rtc.seen.find((s) => pa.ok && s.name === pa.name)!.src!
    const srcB = go2rtc.seen.find((s) => pb.ok && s.name === pb.name)!.src!
    expect(srcA).toContain(`rtsp://viewer:pass-a@127.0.0.1:${rtspA.port}/Streaming/tracks/101?starttime=${nvrTime(new Date(start.getTime() - 30 * 60_000))}`)
    expect(srcB).toContain(`rtsp://viewer:pass-b@127.0.0.1:${bRtsp}/Streaming/tracks/101?starttime=${nvrTime(new Date(start.getTime() - 3600_000))}`)
    // The stream names are the camera's (never the channel's).
    expect(pa.ok && pa.name.startsWith(`pb_${a1}_`)).toBe(true)
    // The recording search on A uses A's address and the default offset.
    const day = start.toISOString().slice(0, 10)
    expect((await listDaySegments(deps, { id: viewer.id, orgId }, a1, day, 30)).ok).toBe(true)
    const search = nvrA.posts.filter((p) => p.path === '/ISAPI/ContentMgmt/search').at(-1)!.body
    expect(search).toContain(`<startTime>${new Date(Date.parse(`${day}T00:00:00Z`) - 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')}</startTime>`)
    // B is down: camera terms for the viewer. C and the unlinked camera: plain refusals, nothing contacted.
    expect(await listDaySegments(deps, { id: viewer.id, orgId }, b1, day, 30)).toEqual({ ok: false, error: 'The recordings of this camera cannot be reached right now.' })
    expect(await openPlayback(deps, { id: viewer.id, orgId }, c1, start, 10, 30)).toEqual({ ok: false, error: MSG_MONITORING_OFF })
    expect(await openPlayback(deps, { id: viewer.id, orgId }, unmapped, start, 10, 30)).toEqual({ ok: false, error: MSG_NOT_MAPPED })
    expect(await listDaySegments(deps, { id: viewer.id, orgId }, c1, day, 30)).toEqual({ ok: false, error: MSG_MONITORING_OFF })
  })

  it('fast playback (export) refuses the switched-off and the unlinked camera before any request or conversion', async () => {
    const spawn = fakeSpawn('copy')
    for (const [cam, message] of [[c1, MSG_MONITORING_OFF], [unmapped, MSG_NOT_MAPPED]] as const) {
      const res = await serveVod({ rls: administrator.client, admin: admin(), spawn, env: { FFMPEG: '/opt/fake/ffmpeg' } }, { id: administrator.id, orgId }, { camera: cam, start: new Date(shownNowMs(Date.now()) - 3600_000), minutes: 5, probe: false })
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toBe(message)
    }
    expect(spawn.calls).toEqual([])
  })

  it('discovery is per recorder: A\'s channels match A\'s cameras by (recorder, channel); B\'s cameras are untouched; C is refused unasked', async () => {
    const before = (await admin().from('cameras').select('id, name, recorder_id').eq('location_id', loc).order('id')).data!
    const clients = { admin: admin(), rls: administrator.client }
    const found = await discoverRecorderCameras(clients, adminActor, recA)
    expect(found).toMatchObject({ ok: true, recorderId: recA, cameras: 3, created: 1, updated: 2, mapped: 0 })
    const after = (await admin().from('cameras').select('id, name, recorder_id, channel').eq('location_id', loc).order('id')).data!
    const created = after.filter((c) => !before.some((b) => b.id === c.id))
    expect(created.map((c) => [c.name, c.recorder_id, c.channel])).toEqual([['Yard A', recA, 3]])
    for (const id of [b1, b2]) expect(after.find((c) => c.id === id)).toMatchObject({ recorder_id: recB })
    expect(await discoverRecorderCameras(clients, adminActor, recC)).toEqual({ ok: false, error: MSG_MONITORING_OFF })
    // The whole location: A answers, B cannot be reached, C is skipped with its plain message.
    const all = await discoverStoreCameras(clients, adminActor, loc)
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.recorders.map((r) => [r.name, r.ok])).toEqual([['A', true], ['B', false], ['C', false]])
    expect(all.recorders.find((r) => r.name === 'C')).toMatchObject({ ok: false, error: MSG_MONITORING_OFF })
  })

  it('a camera moved to another NVR keeps its id, grants, group and history; discovery never makes a second identity for it', async () => {
    const group = (await admin().from('camera_groups').insert({ org_id: orgId, name: 'Doors', created_by: administrator.id }).select('id').single()).data!.id
    await admin().from('camera_group_items').insert({ org_id: orgId, group_id: group, camera_id: b2 })
    const history = (await admin().from('check_state').select('id, status').eq('target_id', b2).single()).data!
    // b2 ("Till B") is moved from B channel 2 to A channel 4.
    expect((await admin().rpc('camera_remap', { p_org: orgId, p_camera: b2, p_recorder: recA, p_channel: 4 })).error).toBeNull()
    const clients = { admin: admin(), rls: administrator.client }
    // A now lists channel 4 (the moved camera) and channel 5 named like B's other camera: the first is matched by its mapping (recorder
    // + channel). The second is A's own new camera: B's "Door B" is still mapped to B, and a camera of another NVR is never taken
    // (review round 1, I-2; before, it was listed as a possible move and nothing was made, which left A's channel 5 without a camera).
    const nvr = () => ({
      channelStatus: async () => new Map<number, boolean>(),
      channels: async () => [
        { channel: 1, name: 'Door A', ip: '192.0.2.41' }, { channel: 2, name: 'Till A', ip: '192.0.2.42' }, { channel: 3, name: 'Yard A', ip: null },
        { channel: 4, name: 'Till B moved', ip: null }, { channel: 5, name: 'Door B', ip: null },
      ],
    })
    const r = await discoverRecorderCameras(clients, adminActor, recA, { nvr })
    expect(r).toMatchObject({ ok: true, created: 1, updated: 4 })
    if (!r.ok) return
    expect(r.reconciliation).toEqual([{ kind: 'renamed', channel: 4, cameraId: b2, from: 'Till B', to: 'Till B moved' }])
    const doors = (await admin().from('cameras').select('id, recorder_id, channel').eq('location_id', loc).eq('name', 'Door B').order('recorder_id')).data!
    expect(doors.find((c) => c.id === b1)).toEqual({ id: b1, recorder_id: recB, channel: 1 })
    expect(doors.filter((c) => c.id !== b1).map((c) => [c.recorder_id, c.channel])).toEqual([[recA, 5]])
    // Same id, same group, same history row; viewer access unchanged (location grant), and live now goes through A.
    expect((await admin().from('camera_group_items').select('camera_id').eq('group_id', group)).data).toEqual([{ camera_id: b2 }])
    // Review I-5: the row must still be there (a remap that deleted the camera's state must fail this).
    const kept = (await admin().from('check_state').select('id').eq('target_id', b2).maybeSingle()).data
    expect(kept).not.toBeNull()
    expect(kept!.id).toBe(history.id)
    const res = await openStreams({ admin: admin(), rls: viewer.client, go2rtc: go2rtc.client, env: {} }, { id: viewer.id, orgId }, [b2], 'main')
    expect(res.ok && res.streams.map((s) => [s.cameraId, s.channel])).toEqual([[b2, 4]])
    expect(go2rtc.seen[0]).toMatchObject({ name: `cam_${b2}_main`, src: `rtsp://viewer:pass-a@127.0.0.1:${rtspA.port}/Streaming/Channels/401` })
    // Review I-5: playback after the move goes to A as well: A's address and login, channel 4, A's clock offset (the default, 30 min).
    const start = new Date(Math.floor((shownNowMs(Date.now()) - 2 * 3600_000) / 1000) * 1000)
    const pb = await openPlayback({ admin: admin(), rls: viewer.client, go2rtc: go2rtc.client, env: {} }, { id: viewer.id, orgId }, b2, start, 10, 30)
    expect(pb.ok).toBe(true)
    const src = go2rtc.seen.find((s) => pb.ok && s.name === pb.name)!.src!
    const nvrTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    expect(src).toContain(`rtsp://viewer:pass-a@127.0.0.1:${rtspA.port}/Streaming/tracks/401?starttime=${nvrTime(new Date(start.getTime() - 30 * 60_000))}`)
  })

  it('"discover all recorders": every NVR of the organisation, bounded, with progress; the switched-off one is skipped without contact', async () => {
    const progress: [number, number][] = []
    const r = await discoverAllRecorders({ admin: admin(), rls: administrator.client }, adminActor, { concurrency: 2, onProgress: (d, t) => progress.push([d, t]) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.map((i) => [i.name, i.ok])).toEqual([['A', true], ['B', false], ['C', false]])
    expect(r.items.find((i) => i.name === 'C')).toMatchObject({ skipped: 'monitoring_off', error: MSG_MONITORING_OFF })
    expect(progress.at(-1)).toEqual([3, 3])
    // Only administrators with admin.inventory for the organisation.
    expect(await discoverAllRecorders({ admin: admin(), rls: viewer.client }, { id: viewer.id, orgId, role: 'user' })).toEqual({ ok: false, error: 'Only administrators can look for cameras.' })
  })

  it('the history of an NVR moved over from the old store model carries on in the same rows (check_state and outages continuity)', async () => {
    // A recorder as the 5a data migration left it: migrated_from_location_id = its location, its old ('nvr', location) rows re-keyed to
    // ('recorder', id) — here an open outage and a down state from before.
    const site = await createLocation(orgId, { code: 'MIGR' })
    const nvr = await startFakeNvr({ password: 'pass-m', statuses: { 1: true }, channels: [{ channel: 1, name: 'Old camera' }] })
    const rtsp = await startFakeRtsp('refuse')
    try {
      const rec = await createRecorder(orgId, site, { host: '127.0.0.1', httpPort: nvr.port, rtspPort: rtsp.port, secret: 'pass-m' })
      await admin().from('recorders').update({ migrated_from_location_id: site }).eq('id', rec)
      const since = new Date(Date.now() - 3 * 3600_000).toISOString()
      const st = (await admin().from('check_state').insert({ org_id: orgId, target_type: 'recorder', target_id: rec, status: 'down', down_since: since, last_checked_at: since, consecutive_failures: 5, created_at: since }).select('id').single()).data!
      const out = (await admin().from('outages').insert({ org_id: orgId, target_type: 'recorder', target_id: rec, started_at: since }).select('id').single()).data!
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await runner.runDevices()
      vi.restoreAllMocks()
      const now = (await admin().from('check_state').select('id, status').eq('target_type', 'recorder').eq('target_id', rec).single()).data!
      expect(now).toEqual({ id: st.id, status: 'up' }) // the same row, carried on
      const closed = (await admin().from('outages').select('id, ended_at').eq('id', out.id).single()).data!
      expect(closed.ended_at).not.toBeNull()
      expect((await admin().from('outages').select('id').eq('target_type', 'recorder').eq('target_id', rec)).data).toHaveLength(1)
      const { data: uptime, error } = await admin().rpc('targets_uptime', { p_org: orgId, p_type: 'recorder', p_ids: [rec], p_window: '1 day' })
      expect(error).toBeNull()
      expect((uptime as { uptime_pct: number | null }[])[0]?.uptime_pct ?? 100).toBeLessThan(100) // the old down time still counts
    } finally {
      await nvr.close()
      await rtsp.close()
    }
  })
})
