import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { discoverStoreCameras } from '@/lib/monitor/discovery'
import { adminClient, cleanupOrg, createOrg, createUser, grant, primaryRecorderOf, READ_EVERYTHING, type TestUser } from '../setup/fixtures'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

const admin = () => adminClient()

describe('finding cameras on the NVR', () => {
  let orgId: string
  let actor: Actor
  let storeId: string
  let nvr: FakeNvr
  let me: TestUser
  // P2-2: discovery needs the administrator role AND admin.inventory (organisation-wide), asked as the person (has_capability_for on the store).
  const d = (u: TestUser = me) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, 'admin.inventory')
    actor = { id: me.id, orgId, role: 'admin' }
    nvr = await startFakeNvr({
      channels: [{ channel: 1, name: 'Entrance', ip: '192.0.2.11' }, { channel: 2, name: 'Billing counter', ip: '192.0.2.12' }, { channel: 3, name: 'Stockroom' }],
      statuses: { 1: true, 2: true, 3: true },
    })
    const a = admin()
    storeId = (await a.from('locations').insert({ org_id: orgId, code: 'DISC', name: 'Disc', nvr_ip: '127.0.0.1', http_port: nvr.port, nvr_username: 'viewer', expected_channels: 2 }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: storeId, p_secret: 'secret-pass' })
    await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, location_id: storeId, channel: n, name: `Camera ${n}` })))
  })
  afterAll(async () => {
    await nvr.close()
    await cleanupOrg(orgId)
  })

  it('replaces placeholder names, adds new channels and keeps camera ids', async () => {
    const before = (await admin().from('cameras').select('id, channel').eq('location_id', storeId).order('channel')).data!
    const res = await discoverStoreCameras(d(), actor, storeId)
    expect(res).toEqual({ ok: true, cameras: 3, created: 1, updated: 2 })
    const after = (await admin().from('cameras').select('id, channel, name, camera_ip').eq('location_id', storeId).order('channel')).data!
    expect(after.map((c) => [c.channel, c.name, c.camera_ip])).toEqual([[1, 'Entrance', '192.0.2.11'], [2, 'Billing counter', '192.0.2.12'], [3, 'Stockroom', null]])
    expect(after.slice(0, 2).map((c) => c.id)).toEqual(before.map((c) => c.id))
    expect((await admin().from('admin_audit_log').select('action').eq('org_id', orgId)).data?.map((r) => r.action)).toContain('cameras_discovered')
  })

  it('does not forget a camera address the NVR no longer reports, and never removes cameras', async () => {
    const a = admin()
    const quiet = await startFakeNvr({ channels: [{ channel: 1, name: 'Camera 1' }], statuses: { 1: true } })
    const id = (await a.from('locations').insert({ org_id: orgId, code: 'KEEP', name: 'Keep', nvr_ip: '127.0.0.1', http_port: quiet.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: id, p_secret: 'secret-pass' })
    await a.from('cameras').insert([
      { org_id: orgId, location_id: id, channel: 1, name: 'Front door (renamed by hand)', camera_ip: '192.0.2.77' },
      { org_id: orgId, location_id: id, channel: 9, name: 'Old channel', camera_ip: '192.0.2.78' },
    ])
    expect(await discoverStoreCameras(d(), actor, id)).toEqual({ ok: true, cameras: 1, created: 0, updated: 1 })
    const rows = (await a.from('cameras').select('channel, name, camera_ip').eq('location_id', id).order('channel')).data!
    expect(rows).toEqual([
      { channel: 1, name: 'Front door (renamed by hand)', camera_ip: '192.0.2.77' },
      { channel: 9, name: 'Old channel', camera_ip: '192.0.2.78' },
    ])
    await quiet.close()
  })

  it('says plainly what went wrong, and tries a refused login only once', async () => {
    const a = admin()
    const wrongPassword = (await a.from('locations').insert({ org_id: orgId, code: 'BADPW', name: 'Bad', nvr_ip: '127.0.0.1', http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: wrongPassword, p_secret: 'not-the-password' })
    const logins = nvr.authorizations.length
    expect(await discoverStoreCameras(d(), actor, wrongPassword)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
    expect(nvr.authorizations.length - logins).toBe(1)

    const gone = (await a.from('locations').insert({ org_id: orgId, code: 'GONE', name: 'Gone', nvr_ip: '127.0.0.1', http_port: await closedPort(), nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: gone, p_secret: 'secret-pass' })
    expect(await discoverStoreCameras(d(), actor, gone)).toEqual({ ok: false, error: 'The NVR did not answer.' })
  })

  it('does not ask the NVR at all when the store has no saved password', async () => {
    const a = admin()
    const id = (await a.from('locations').insert({ org_id: orgId, code: 'NOPW', name: 'No password', nvr_ip: '127.0.0.1', http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    const asked = nvr.requests.length
    const res = await discoverStoreCameras(d(), actor, id)
    expect(res).toEqual({ ok: false, error: 'This store has no NVR password saved. Add it on the Manage stores page first.' })
    expect(nvr.requests.length).toBe(asked)
  })

  it('owner addition: refuses an NVR whose monitoring is switched off without contacting it; switched on again it works', async () => {
    const a = admin()
    const id = (await a.from('locations').insert({ org_id: orgId, code: 'OFFD', name: 'Switched off', nvr_ip: '127.0.0.1', http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: id, p_secret: 'secret-pass' })
    const rec = await primaryRecorderOf(id)
    expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR: do not contact' })).error).toBeNull()
    const asked = nvr.requests.length
    expect(await discoverStoreCameras(d(), actor, id)).toEqual({ ok: false, error: 'Monitoring is switched off for this NVR.' })
    expect(nvr.requests.length).toBe(asked)
    expect((await a.rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab NVR' })).error).toBeNull()
    expect((await discoverStoreCameras(d(), actor, id)).ok).toBe(true)
    expect(nvr.requests.length).toBeGreaterThan(asked)
  })

  it('is for administrators only and only for stores of the own organisation', async () => {
    const asked = nvr.requests.length
    for (const role of ['operator', 'manager', 'user'] as const) { // 'operator' was 'agent' before P2-1 (AC-15)
      expect((await discoverStoreCameras(d(), { ...actor, role }, storeId)).ok).toBe(false)
    }
    // P2-2: the administrator role without admin.inventory (even with every read grant) is refused too, and so is admin.inventory
    // without the role. The NVR is never asked.
    const plainAdmin = await createUser(orgId, 'admin')
    await grant(orgId, plainAdmin.id, READ_EVERYTHING)
    expect(await discoverStoreCameras(d(plainAdmin), { id: plainAdmin.id, orgId, role: 'admin' }, storeId)).toEqual({ ok: false, error: 'Only administrators can look for cameras.' })
    const capOnly = await createUser(orgId, 'operator')
    await grant(orgId, capOnly.id, 'admin.inventory')
    expect((await discoverStoreCameras(d(capOnly), { id: capOnly.id, orgId, role: 'operator' }, storeId)).ok).toBe(false)
    expect(nvr.requests.length).toBe(asked)
    const other = await createOrg()
    const { data } = await admin().from('locations').insert({ org_id: other, code: 'OTH', name: 'Oth', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    expect(await discoverStoreCameras(d(), actor, data!.id)).toEqual({ ok: false, error: 'Store not found.' })
    expect(await discoverStoreCameras(d(), actor, 'not-an-id')).toEqual({ ok: false, error: 'Store not found.' })
    expect((await admin().from('cameras').select('id').eq('location_id', data!.id)).data).toEqual([])
    await cleanupOrg(other)
  })

  it('also works for a platform owner holding admin.inventory', async () => {
    const owner = await createUser(orgId, 'platform_owner')
    await grant(orgId, owner.id, 'admin.inventory')
    expect((await discoverStoreCameras(d(owner), { id: owner.id, orgId, role: 'platform_owner' }, storeId)).ok).toBe(true)
  })

  it('reports an NVR with no cameras', async () => {
    const empty = await startFakeNvr({ channels: [], statuses: {} })
    const a = admin()
    const id = (await a.from('locations').insert({ org_id: orgId, code: 'EMPTY', name: 'Empty', nvr_ip: '127.0.0.1', http_port: empty.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    await a.rpc('nvr_store_credential', { p_store: id, p_secret: 'secret-pass' })
    expect(await discoverStoreCameras(d(), actor, id)).toEqual({ ok: false, error: 'The NVR did not list any cameras.' })
    await empty.close()
  })

  it('never puts the password in a result or an audit row', async () => {
    const res = await discoverStoreCameras(d(), actor, storeId)
    const audit = (await admin().from('admin_audit_log').select('detail, action').eq('org_id', orgId)).data!
    expect(JSON.stringify([res, audit])).not.toContain('secret-pass')
  })
})
