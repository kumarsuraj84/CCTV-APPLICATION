import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { discoverRecorderCameras, discoverStoreCameras } from '@/lib/monitor/discovery'
import { adminClient, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createSite, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'
import { closedPort, startCountingTcp, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

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
    const res = await discoverStoreCameras(d(), actor, storeId)
    expect(res).toMatchObject({ ok: true, cameras: 3, created: 1, updated: 2, mapped: 0 })
    if (!res.ok) return
    expect(res.recorders.map((r) => [r.recorderId, r.ok])).toEqual([[recorderId, true]])
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
    expect(await discoverStoreCameras(d(), actor, wrongPassword)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
    expect(nvr.authorizations.length - logins).toBe(1)
    const gone = (await site('GONE', await closedPort(), 'secret-pass')).locationId
    expect(await discoverStoreCameras(d(), actor, gone)).toEqual({ ok: false, error: 'The NVR did not answer.' })
    // A location without any NVR.
    const ho = await createLocation(orgId, { code: 'HO', kind: 'head_office' })
    expect(await discoverStoreCameras(d(), actor, ho)).toEqual({ ok: false, error: 'This store has no NVR.' })
  })

  it('does not ask the NVR at all when it has no saved password', async () => {
    const id = (await site('NOPW', nvr.port)).locationId
    const asked = nvr.requests.length
    const res = await discoverStoreCameras(d(), actor, id)
    expect(res).toEqual({ ok: false, error: 'This NVR has no password saved. Add it on the Manage stores page first.' })
    expect(nvr.requests.length).toBe(asked)
  })

  it('owner addition: refuses an NVR whose monitoring is switched off without opening a single socket; switched on again it works', async () => {
    const a = admin()
    const counting = await startCountingTcp()
    try {
      const { recorderId: rec } = await site('OFFD', counting.port, 'secret-pass')
      expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR: do not contact' })).error).toBeNull()
      expect(await discoverRecorderCameras(d(), actor, rec)).toEqual({ ok: false, error: 'Monitoring is switched off for this NVR.' })
      expect(counting.connections()).toBe(0)
      expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab NVR' })).error).toBeNull()
      expect((await discoverRecorderCameras(d(), actor, rec)).ok).toBe(false) // the counting port is no NVR, but it was asked
      expect(counting.connections()).toBeGreaterThan(0)
    } finally {
      await counting.close()
    }
  })

  it('a location with two NVRs: each NVR\'s channels go to its own cameras; the same channel number on both never collides', async () => {
    const second = await startFakeNvr({ channels: [{ channel: 1, name: 'Loading bay' }, { channel: 2, name: 'Cash office' }], statuses: { 1: true, 2: true } })
    try {
      const loc = await createLocation(orgId, { code: 'TWIN' })
      const r1 = await createRecorder(orgId, loc, { name: 'Front', host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
      const r2 = await createRecorder(orgId, loc, { name: 'Back', host: '127.0.0.1', httpPort: second.port, rtspPort: 8554, secret: 'secret-pass' })
      const res = await discoverStoreCameras(d(), actor, loc)
      expect(res).toMatchObject({ ok: true, cameras: 5, created: 5 })
      const rows = (await admin().from('cameras').select('name, recorder_id, channel').eq('location_id', loc).order('name')).data!
      expect(rows).toEqual([
        { name: 'Billing counter', recorder_id: r1, channel: 2 }, { name: 'Cash office', recorder_id: r2, channel: 2 },
        { name: 'Entrance', recorder_id: r1, channel: 1 }, { name: 'Loading bay', recorder_id: r2, channel: 1 }, { name: 'Stockroom', recorder_id: r1, channel: 3 },
      ])
      // Again: nothing new, every camera matched by (recorder, channel).
      expect(await discoverStoreCameras(d(), actor, loc)).toMatchObject({ ok: true, created: 0, updated: 5 })
    } finally {
      await second.close()
    }
  })

  it('is for administrators only and only for stores and NVRs of the own organisation', async () => {
    const asked = nvr.requests.length
    for (const role of ['operator', 'manager', 'user'] as const) { // 'operator' was 'agent' before P2-1 (AC-15)
      expect((await discoverStoreCameras(d(), { ...actor, role }, storeId)).ok).toBe(false)
      expect((await discoverRecorderCameras(d(), { ...actor, role }, recorderId)).ok).toBe(false)
    }
    // P2-2: the administrator role without admin.inventory (even with every read grant) is refused too, and so is admin.inventory
    // without the role. The NVR is never asked.
    const plainAdmin = await createUser(orgId, 'admin')
    await grant(orgId, plainAdmin.id, READ_EVERYTHING)
    expect(await discoverStoreCameras(d(plainAdmin), { id: plainAdmin.id, orgId, role: 'admin' }, storeId)).toEqual({ ok: false, error: 'Only administrators can look for cameras.' })
    expect(await discoverRecorderCameras(d(plainAdmin), { id: plainAdmin.id, orgId, role: 'admin' }, recorderId)).toEqual({ ok: false, error: 'Only administrators can look for cameras.' })
    const capOnly = await createUser(orgId, 'operator')
    await grant(orgId, capOnly.id, 'admin.inventory')
    expect((await discoverStoreCameras(d(capOnly), { id: capOnly.id, orgId, role: 'operator' }, storeId)).ok).toBe(false)
    expect(nvr.requests.length).toBe(asked)
    const other = await createOrg()
    const foreign = await createSite(other, { code: 'OTH', host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
    expect(await discoverStoreCameras(d(), actor, foreign.locationId)).toEqual({ ok: false, error: 'Store not found.' })
    expect(await discoverRecorderCameras(d(), actor, foreign.recorderId)).toEqual({ ok: false, error: 'NVR not found.' })
    expect(await discoverStoreCameras(d(), actor, 'not-an-id')).toEqual({ ok: false, error: 'Store not found.' })
    expect(await discoverRecorderCameras(d(), actor, 'not-an-id')).toEqual({ ok: false, error: 'NVR not found.' })
    expect((await admin().from('cameras').select('id').eq('location_id', foreign.locationId)).data).toEqual([])
    expect(nvr.requests.length).toBe(asked)
    await cleanupOrg(other)
  })

  it('also works for a platform owner holding admin.inventory', async () => {
    const owner = await createUser(orgId, 'platform_owner')
    await grant(orgId, owner.id, 'admin.inventory')
    expect((await discoverStoreCameras(d(owner), { id: owner.id, orgId, role: 'platform_owner' }, storeId)).ok).toBe(true)
  })

  it('reports an NVR with no cameras', async () => {
    const empty = await startFakeNvr({ channels: [], statuses: {} })
    const id = (await site('EMPTY', empty.port, 'secret-pass')).locationId
    expect(await discoverStoreCameras(d(), actor, id)).toEqual({ ok: false, error: 'The NVR did not list any cameras.' })
    await empty.close()
  })

  it('never puts the password in a result or an audit row', async () => {
    const res = await discoverStoreCameras(d(), actor, storeId)
    const audit = (await admin().from('admin_audit_log').select('detail, action').eq('org_id', orgId)).data!
    expect(JSON.stringify([res, audit])).not.toContain('secret-pass')
  })
})
