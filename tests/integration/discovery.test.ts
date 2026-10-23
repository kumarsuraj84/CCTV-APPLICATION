import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { discoverRecorderCameras, discoverLocationCameras } from '@/lib/monitor/discovery'
import { adminClient, atCamera, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createSite, createUser, grant, READ_EVERYTHING, withRecorders, type TestUser } from '../setup/fixtures'
import { fenced } from '../setup/lease'
import { startFakeGo2rtc } from '../helpers/fake-go2rtc'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

const admin = () => adminClient()

// P2-5b: discovery is per recorder (NVR). "Find cameras" for a store asks every NVR of the location in turn; cameras are matched by
// (recorder, channel) — the active mapping — so they keep their ids; nothing is ever deleted.
describe('finding cameras on the NVR', () => {
  let orgId: string
  let actor: Actor
  let storeId: string
  let recorderId: string
  let nvr: FakeNvr
  let me: TestUser
  // P2-2: discovery needs the administrator role AND admin.inventory (organisation-wide), asked as the person (has_capability_for on the store).
  const d = (u: TestUser = me) => ({ admin: admin(), rls: u.client })
  const site = (code: string, httpPort: number, secret?: string) => createSite(orgId, { code, name: code, host: '127.0.0.1', httpPort, username: 'viewer', secret })

  beforeAll(async () => {
    orgId = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, 'admin.inventory')
    actor = { id: me.id, orgId, role: 'admin' }
    nvr = await startFakeNvr({
      channels: [{ channel: 1, name: 'Entrance', ip: '192.0.2.11' }, { channel: 2, name: 'Billing counter', ip: '192.0.2.12' }, { channel: 3, name: 'Stockroom' }],
      statuses: { 1: true, 2: true, 3: true },
    })
    const s = await site('DISC', nvr.port, 'secret-pass')
    storeId = s.locationId
    recorderId = s.recorderId
    await admin().from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, location_id: storeId, recorder_id: recorderId, channel: n, name: `Camera ${n}` })))
  })
  afterAll(async () => {
    await nvr.close()
    await cleanupOrg(orgId)
  })

  it('replaces placeholder names, adds new channels on THIS NVR and keeps camera ids', async () => {
    const before = (await admin().from('cameras').select('id, channel').eq('location_id', storeId).order('channel')).data!
    const res = await discoverLocationCameras(d(), actor, storeId)
    // Exact (review M-10: was toMatchObject): the whole answer, nothing more.
    expect(res).toEqual({
      ok: true, cameras: 3, created: 1, updated: 2, mapped: 0, moved: 0,
      recorders: [{ recorderId, name: 'NVR', ok: true, result: { recorderId, locationId: storeId, cameras: 3, created: 1, updated: 2, mapped: 0, moved: 0, reconciliation: [] } }],
    })
    const after = (await admin().from('cameras').select('id, channel, name, camera_ip, recorder_id').eq('location_id', storeId).order('channel')).data!
    expect(after.map((c) => [c.channel, c.name, c.camera_ip, c.recorder_id])).toEqual([
      [1, 'Entrance', '192.0.2.11', recorderId], [2, 'Billing counter', '192.0.2.12', recorderId], [3, 'Stockroom', null, recorderId],
    ])
    expect(after.slice(0, 2).map((c) => c.id)).toEqual(before.map((c) => c.id))
    expect((await admin().from('admin_audit_log').select('action').eq('org_id', orgId)).data?.map((r) => r.action)).toContain('cameras_discovered')
  })

  it('does not forget a camera address the NVR no longer reports, never removes cameras, and lists the channel it no longer has', async () => {
    const a = admin()
    const quiet = await startFakeNvr({ channels: [{ channel: 1, name: 'Camera 1' }], statuses: { 1: true } })
    const { locationId: id, recorderId: rec } = await site('KEEP', quiet.port, 'secret-pass')
    const old = await createCamera(orgId, { locationId: id, recorderId: rec, channel: 9, name: 'Old channel', cameraIp: '192.0.2.78' })
    await createCamera(orgId, { locationId: id, recorderId: rec, channel: 1, name: 'Front door (renamed by hand)', cameraIp: '192.0.2.77' })
    const res = await discoverRecorderCameras(d(), actor, rec)
    expect(res).toMatchObject({ ok: true, cameras: 1, created: 0, updated: 1 })
    expect(res.ok && res.reconciliation).toEqual([{ kind: 'missing', channel: 9, cameraId: old, cameraName: 'Old channel' }])
    const rows = (await a.from('cameras').select('channel, name, camera_ip, archived_at').eq('location_id', id).order('channel')).data!
    expect(rows).toEqual([
      { channel: 1, name: 'Front door (renamed by hand)', camera_ip: '192.0.2.77', archived_at: null },
      { channel: 9, name: 'Old channel', camera_ip: '192.0.2.78', archived_at: null },
    ])
    await quiet.close()
  })

  it('puts a restored (unmapped) camera back on its NVR channel instead of making a second one (5a ruling: discovery after restore)', async () => {
    const a = admin()
    const { locationId: id, recorderId: rec } = await site('REST', nvr.port, 'secret-pass')
    const cam = await createCamera(orgId, { locationId: id, recorderId: rec, channel: 2, name: 'Till' })
    expect((await a.rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
    expect((await a.rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
    expect((await a.from('cameras').select('recorder_id').eq('id', cam).single()).data?.recorder_id).toBeNull() // restored unmapped
    const res = await discoverRecorderCameras(d(), actor, rec)
    expect(res).toMatchObject({ ok: true, cameras: 3, created: 2, mapped: 1 })
    expect((await a.from('cameras').select('id, recorder_id, channel').eq('id', cam).single()).data).toEqual({ id: cam, recorder_id: rec, channel: 2 })
    expect((await a.from('cameras').select('id').eq('location_id', id).eq('channel', 2)).data).toHaveLength(1)
  })

  it('says plainly what went wrong, and tries a refused login only once', async () => {
    const wrongPassword = (await site('BADPW', nvr.port, 'not-the-password')).locationId
    const logins = nvr.authorizations.length
    expect(await discoverLocationCameras(d(), actor, wrongPassword)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
    expect(nvr.authorizations.length - logins).toBe(1)
    const gone = (await site('GONE', await closedPort(), 'secret-pass')).locationId
    expect(await discoverLocationCameras(d(), actor, gone)).toEqual({ ok: false, error: 'The NVR did not answer.' })
    // A location without any NVR.
    const ho = await createLocation(orgId, { code: 'HO', kind: 'head_office' })
    expect(await discoverLocationCameras(d(), actor, ho)).toEqual({ ok: false, error: 'This location has no NVR.' })
  })

  it('does not ask the NVR at all when it has no saved password', async () => {
    const id = (await site('NOPW', nvr.port)).locationId
    const asked = nvr.requests.length
    const res = await discoverLocationCameras(d(), actor, id)
    expect(res).toEqual({ ok: false, error: 'This NVR has no password saved. Add it under Locations and NVRs first.' })
    expect(nvr.requests.length).toBe(asked)
    // M-8: a store's further NVR cannot be edited on that page: no advice that leads nowhere.
    const second = await createRecorder(orgId, id, { name: 'Second', host: '127.0.0.1', httpPort: 9, rtspPort: 8554 })
    expect(await discoverRecorderCameras(d(), actor, second)).toEqual({ ok: false, error: 'This NVR has no password saved yet.' })
    expect(nvr.requests.length).toBe(asked)
  })

  it('owner addition: refuses an NVR whose monitoring is switched off without opening a single socket; switched on again it works', async () => {
    const a = admin()
    const own = await startFakeNvr({ channels: [{ channel: 1, name: 'Gate', ip: '192.0.2.91' }], statuses: { 1: true } })
    try {
      const { locationId: loc, recorderId: rec } = await site('OFFD', own.port, 'secret-pass')
      expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR: do not contact' })).error).toBeNull()
      expect(await discoverRecorderCameras(d(), actor, rec)).toEqual({ ok: false, error: 'Monitoring is switched off for this NVR.' })
      expect(own.requests).toEqual([])
      // Switched on again: discovery works (review M-10: a real answer, not just "a socket was opened").
      expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab NVR' })).error).toBeNull()
      expect(await discoverRecorderCameras(d(), actor, rec)).toEqual({ ok: true, recorderId: rec, locationId: loc, cameras: 1, created: 1, updated: 0, mapped: 0, moved: 0, reconciliation: [] })
      expect((await a.from('cameras').select('name, channel, recorder_id').eq('location_id', loc)).data).toEqual([{ name: 'Gate', channel: 1, recorder_id: rec }])
    } finally {
      await own.close()
    }
  })

  it('a location with two NVRs: each NVR\'s channels go to its own cameras; the same channel number on both never collides', async () => {
    const second = await startFakeNvr({ channels: [{ channel: 1, name: 'Loading bay' }, { channel: 2, name: 'Cash office' }], statuses: { 1: true, 2: true } })
    try {
      const loc = await createLocation(orgId, { code: 'TWIN' })
      const r1 = await createRecorder(orgId, loc, { name: 'Front', host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
      const r2 = await createRecorder(orgId, loc, { name: 'Back', host: '127.0.0.1', httpPort: second.port, rtspPort: 8554, secret: 'secret-pass' })
      const res = await discoverLocationCameras(d(), actor, loc)
      expect(res).toMatchObject({ ok: true, cameras: 5, created: 5 })
      const rows = (await admin().from('cameras').select('name, recorder_id, channel').eq('location_id', loc).order('name')).data!
      expect(rows).toEqual([
        { name: 'Billing counter', recorder_id: r1, channel: 2 }, { name: 'Cash office', recorder_id: r2, channel: 2 },
        { name: 'Entrance', recorder_id: r1, channel: 1 }, { name: 'Loading bay', recorder_id: r2, channel: 1 }, { name: 'Stockroom', recorder_id: r1, channel: 3 },
      ])
      // Again: nothing new, every camera matched by (recorder, channel).
      expect(await discoverLocationCameras(d(), actor, loc)).toMatchObject({ ok: true, created: 0, updated: 5 })
    } finally {
      await second.close()
    }
  })

  it('is for administrators only and only for stores and NVRs of the own organisation', async () => {
    const asked = nvr.requests.length
    for (const role of ['operator', 'manager', 'user'] as const) { // 'operator' was 'agent' before P2-1 (AC-15)
      expect((await discoverLocationCameras(d(), { ...actor, role }, storeId)).ok).toBe(false)
      expect((await discoverRecorderCameras(d(), { ...actor, role }, recorderId)).ok).toBe(false)
    }
    // P2-2: the administrator role without admin.inventory (even with every read grant) is refused too, and so is admin.inventory
    // without the role. The NVR is never asked.
    const plainAdmin = await createUser(orgId, 'admin')
    await grant(orgId, plainAdmin.id, READ_EVERYTHING)
    expect(await discoverLocationCameras(d(plainAdmin), { id: plainAdmin.id, orgId, role: 'admin' }, storeId)).toEqual({ ok: false, error: 'Only administrators can look for cameras.' })
    expect(await discoverRecorderCameras(d(plainAdmin), { id: plainAdmin.id, orgId, role: 'admin' }, recorderId)).toEqual({ ok: false, error: 'Only administrators can look for cameras.' })
    const capOnly = await createUser(orgId, 'operator')
    await grant(orgId, capOnly.id, 'admin.inventory')
    expect((await discoverLocationCameras(d(capOnly), { id: capOnly.id, orgId, role: 'operator' }, storeId)).ok).toBe(false)
    expect(nvr.requests.length).toBe(asked)
    const other = await createOrg()
    const foreign = await createSite(other, { code: 'OTH', host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
    expect(await discoverLocationCameras(d(), actor, foreign.locationId)).toEqual({ ok: false, error: 'Location not found.' })
    expect(await discoverRecorderCameras(d(), actor, foreign.recorderId)).toEqual({ ok: false, error: 'NVR not found.' })
    expect(await discoverLocationCameras(d(), actor, 'not-an-id')).toEqual({ ok: false, error: 'Location not found.' })
    expect(await discoverRecorderCameras(d(), actor, 'not-an-id')).toEqual({ ok: false, error: 'NVR not found.' })
    expect((await admin().from('cameras').select('id').eq('location_id', foreign.locationId)).data).toEqual([])
    expect(nvr.requests.length).toBe(asked)
    await cleanupOrg(other)
  })

  it('also works for a platform owner holding admin.inventory', async () => {
    const owner = await createUser(orgId, 'platform_owner')
    await grant(orgId, owner.id, 'admin.inventory')
    expect((await discoverLocationCameras(d(owner), { id: owner.id, orgId, role: 'platform_owner' }, storeId)).ok).toBe(true)
  })

  it('reports an NVR with no cameras', async () => {
    const empty = await startFakeNvr({ channels: [], statuses: {} })
    const id = (await site('EMPTY', empty.port, 'secret-pass')).locationId
    expect(await discoverLocationCameras(d(), actor, id)).toEqual({ ok: false, error: 'The NVR did not list any cameras.' })
    await empty.close()
  })

  it('never puts the password in a result or an audit row', async () => {
    const res = await discoverLocationCameras(d(), actor, storeId)
    const audit = (await admin().from('admin_audit_log').select('detail, action').eq('org_id', orgId)).data!
    expect(JSON.stringify([res, audit])).not.toContain('secret-pass')
  })
})

// P2-5b review round 1 (I-1, I-2, I-5, M-4, M-8): discovery matches by (recorder, channel) first, never takes a camera that belongs to
// another NVR, and never makes a second identity for a camera that only moved to another channel of the same NVR.
describe('finding cameras: identities across channels and NVRs (review round 1)', () => {
  let orgId: string
  let actor: Actor
  let me: TestUser
  const d = () => ({ admin: admin(), rls: me.client })
  const camerasAt = async (loc: string) =>
    (await admin().from('cameras').select('id, name, channel, recorder_id, camera_ip').eq('location_id', loc).is('archived_at', null).order('recorder_id').order('channel')).data!
  /** An NVR answer given directly (no network): the channel list only. */
  const lists = (channels: { channel: number; name: string; ip: string | null }[]) => () => ({ channelStatus: async () => new Map<number, boolean>(), channels: async () => channels })

  beforeAll(async () => {
    orgId = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, 'admin.inventory')
    actor = { id: me.id, orgId, role: 'admin' }
  })
  afterAll(() => cleanupOrg(orgId))

  it('I-1: a camera re-patched to another channel of the SAME NVR keeps its id (found by its address), and no second camera is made', async () => {
    const loc = await createLocation(orgId, { code: 'REPATCH' })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 5, name: 'Back door', cameraIp: '192.0.2.55' })
    const keep = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1, name: 'Front', cameraIp: '192.0.2.51' })
    const viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live'], atCamera(cam))
    await admin().rpc('monitor_apply_results', { ...(await fenced()), p_org: orgId, p_results: await withRecorders([{ type: 'camera', id: cam, ok: true, at: new Date().toISOString() }]), p_threshold: 1 })
    const history = (await admin().from('check_state').select('id').eq('target_id', cam).single()).data!.id
    const go2rtc = await startFakeGo2rtc()
    try {
      go2rtc.streams.set(`cam_${cam}_main`, 'rtsp://old-channel')
      go2rtc.streams.set(`cam_${keep}_main`, 'rtsp://front')
      // The installer moved the cable from port 5 to port 7: the NVR lists the camera (same address) on channel 7 and no channel 5.
      const r = await discoverRecorderCameras(d(), actor, rec, { nvr: lists([{ channel: 1, name: 'Front', ip: '192.0.2.51' }, { channel: 7, name: 'Back door', ip: '192.0.2.55' }]), go2rtc: go2rtc.client })
      expect(r).toEqual({ ok: true, recorderId: rec, locationId: loc, cameras: 2, created: 0, updated: 1, mapped: 0, moved: 1, reconciliation: [] })
      expect((await camerasAt(loc)).map((c) => [c.id, c.channel])).toEqual([[keep, 1], [cam, 7]])
      expect((await admin().from('check_state').select('id').eq('target_id', cam).single()).data?.id).toBe(history)
      expect((await admin().from('access_grants').select('scope_id').eq('user_id', viewer.id).is('revoked_at', null)).data).toEqual([{ scope_id: cam }])
      // M-4: the live stream pointing at the old channel is gone; the other camera's stream is untouched.
      expect(go2rtc.streams.has(`cam_${cam}_main`)).toBe(false)
      expect(go2rtc.streams.has(`cam_${keep}_main`)).toBe(true)
    } finally {
      await go2rtc.close()
    }
  })

  it('I-1: moved on the same NVR without an address but with its own name: listed for reconciliation, nothing created', async () => {
    const loc = await createLocation(orgId, { code: 'REPATCH2' })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 5, name: 'Back door' })
    const r = await discoverRecorderCameras(d(), actor, rec, { nvr: lists([{ channel: 7, name: 'Back door', ip: null }]) })
    expect(r).toMatchObject({ ok: true, created: 0, moved: 0 })
    expect(r.ok && r.reconciliation).toEqual([
      { kind: 'possible_move', channel: 7, reportedName: 'Back door', cameraId: cam, cameraName: 'Back door', because: 'same_name' },
      { kind: 'missing', channel: 5, cameraId: cam, cameraName: 'Back door' },
    ])
    expect((await camerasAt(loc)).map((c) => [c.id, c.channel])).toEqual([[cam, 5]])
  })

  it('I-2: two PoE NVRs at one store with the same internal addresses (192.168.254.x) and default names ("Camera 01"): each gets its own cameras, in either order', async () => {
    const channels = [{ channel: 1, name: 'Camera 01', ip: '192.168.254.2' }, { channel: 2, name: 'IPCamera 02', ip: '192.168.254.3' }, { channel: 3, name: 'D3', ip: '192.168.254.4' }]
    for (const order of ['first-then-second', 'second-then-first'] as const) {
      const loc = await createLocation(orgId, { code: `POE-${order === 'first-then-second' ? 'A' : 'B'}` })
      const r1 = await createRecorder(orgId, loc, { name: 'Ground', host: '127.0.0.1', secret: 'secret-pass' })
      const r2 = await createRecorder(orgId, loc, { name: 'First floor', host: '127.0.0.1', httpPort: 8080, rtspPort: 8554, secret: 'secret-pass' })
      const runs = order === 'first-then-second' ? [r1, r2] : [r2, r1]
      for (const rec of runs) {
        const r = await discoverRecorderCameras(d(), actor, rec, { nvr: lists(channels) })
        expect(r, `${order} ${rec === r1 ? 'Ground' : 'First floor'}`).toMatchObject({ ok: true, created: 3, reconciliation: [] })
      }
      const rows = await camerasAt(loc)
      expect(rows.filter((c) => c.recorder_id === r1).map((c) => [c.channel, c.name, c.camera_ip])).toEqual(channels.map((c) => [c.channel, c.name, c.ip]))
      expect(rows.filter((c) => c.recorder_id === r2).map((c) => [c.channel, c.name, c.camera_ip])).toEqual(channels.map((c) => [c.channel, c.name, c.ip]))
    }
  })

  it('I-2: a camera mapped to ANOTHER NVR is never taken, even with the same chosen name and address: this NVR gets its own camera', async () => {
    const loc = await createLocation(orgId, { code: 'OTHERNVR' })
    const r1 = await createRecorder(orgId, loc, { name: 'One', host: '127.0.0.1', secret: 'secret-pass' })
    const r2 = await createRecorder(orgId, loc, { name: 'Two', host: '127.0.0.1', httpPort: 8080, rtspPort: 8554, secret: 'secret-pass' })
    const onOne = await createCamera(orgId, { locationId: loc, recorderId: r1, channel: 4, name: 'Till', cameraIp: '192.0.2.44' })
    const r = await discoverRecorderCameras(d(), actor, r2, { nvr: lists([{ channel: 4, name: 'Till', ip: '192.0.2.44' }]) })
    expect(r).toMatchObject({ ok: true, created: 1, reconciliation: [] })
    const rows = await camerasAt(loc)
    expect(rows.find((c) => c.id === onOne)).toMatchObject({ recorder_id: r1, channel: 4 })
    expect(rows.filter((c) => c.recorder_id === r2).map((c) => [c.channel, c.name])).toEqual([[4, 'Till']])
  })

  it('I-5: a restored camera at a store with two NVRs goes back to ITS NVR only (the NVR it was last on), not to the other one with the same channel', async () => {
    const loc = await createLocation(orgId, { code: 'RESTORE2' })
    const r1 = await createRecorder(orgId, loc, { name: 'One', host: '127.0.0.1', secret: 'secret-pass' })
    const r2 = await createRecorder(orgId, loc, { name: 'Two', host: '127.0.0.1', httpPort: 8080, rtspPort: 8554, secret: 'secret-pass' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: r2, channel: 2, name: 'Stockroom' })
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
    const both = [{ channel: 2, name: 'Stockroom', ip: null }]
    const first = await discoverRecorderCameras(d(), actor, r1, { nvr: lists(both) })
    expect(first).toMatchObject({ ok: true, created: 1, mapped: 0 })
    expect((await admin().from('cameras').select('recorder_id').eq('id', cam).single()).data?.recorder_id).toBeNull()
    const second = await discoverRecorderCameras(d(), actor, r2, { nvr: lists(both) })
    expect(second).toMatchObject({ ok: true, created: 0, mapped: 1 })
    expect((await admin().from('cameras').select('recorder_id, channel').eq('id', cam).single()).data).toEqual({ recorder_id: r2, channel: 2 })
  })

  it('M-8: a restored camera whose channel another camera now uses is listed, not silently left aside', async () => {
    const loc = await createLocation(orgId, { code: 'TAKEN' })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
    const old = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'Old one' })
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: old })).error).toBeNull()
    const replacement = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'New one' })
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: old })).error).toBeNull()
    const r = await discoverRecorderCameras(d(), actor, rec, { nvr: lists([{ channel: 3, name: 'New one', ip: null }]) })
    expect(r).toMatchObject({ ok: true, created: 0, updated: 1, mapped: 0 })
    expect(r.ok && r.reconciliation).toEqual([{ kind: 'channel_taken', channel: 3, cameraId: old, cameraName: 'Old one', takenBy: replacement }])
  })

  it('M-8: the saves of one discovery are all made or none (a failing change leaves no new camera and no audit row)', async () => {
    const loc = await createLocation(orgId, { code: 'ATOMIC' })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
    await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1, name: 'Existing' })
    const audits = async () => (await admin().from('admin_audit_log').select('id').eq('org_id', orgId).eq('action', 'cameras_discovered')).data!.length
    const before = await audits()
    // A bad NVR answer: channel -1 cannot be saved (cameras.channel > 0). The rename of channel 1 and the new camera on channel 2 are
    // then not saved either, and no audit row says they were.
    const r = await discoverRecorderCameras(d(), actor, rec, { nvr: lists([{ channel: 1, name: 'Renamed', ip: null }, { channel: 2, name: 'New', ip: null }, { channel: -1, name: 'Broken', ip: null }]) })
    expect(r.ok).toBe(false)
    expect((await camerasAt(loc)).map((c) => [c.channel, c.name])).toEqual([[1, 'Existing']])
    expect(await audits()).toBe(before)
  })
})
