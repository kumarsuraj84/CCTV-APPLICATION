import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDashboard, getStates, listStoreStatus } from '@/lib/queries/status'
import { uptimeFor } from '@/lib/monitor/uptime'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

describe('status queries', () => {
  let orgId: string
  let s1: string
  let s2: string
  let cams1: string[]
  let cam2: string
  let dev: string[]
  let manager: TestUser
  let viewer: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const mk = async (code: string) => (await a.from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    s1 = await mk('ST1')
    s2 = await mk('ST2')
    cams1 = (await a.from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: s1, channel: n, name: `C${n}` }))).select('id, channel').order('channel')).data!.map((c) => c.id)
    cam2 = (await a.from('cameras').insert({ org_id: orgId, store_id: s2, channel: 1, name: 'D1' }).select('id').single()).data!.id
    dev = (await a.from('devices').insert([
      { org_id: orgId, store_id: s1, type: 'server', name: 'ERP', ip: '127.0.0.1', tcp_port: 1 },
      { org_id: orgId, store_id: s1, type: 'server', name: 'Mail', ip: '127.0.0.1', tcp_port: 2 },
    ]).select('id, name').order('name')).data!.map((d) => d.id)
    // ST1: camera 1 up, camera 2 down (own outage), camera 3 not checked; NVR up; ERP up, Mail down.
    // ST2: NVR down, its camera down because of the NVR.
    const apply = (results: object[], threshold = 2) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: threshold })
    await apply([{ type: 'camera', id: cams1[0], ok: true, at: ago(5) }, { type: 'nvr', id: s1, ok: true, at: ago(5) }, { type: 'device', id: dev[0], ok: true, at: ago(5) }])
    await apply([{ type: 'camera', id: cams1[1], ok: false, at: ago(20) }, { type: 'device', id: dev[1], ok: false, at: ago(20) }])
    await apply([{ type: 'camera', id: cams1[1], ok: false, at: ago(10) }, { type: 'device', id: dev[1], ok: false, at: ago(10) }])
    await apply([{ type: 'nvr', id: s2, ok: false, at: ago(8) }], 1)
    await apply([{ type: 'camera', id: cam2, ok: false, at: ago(8), cause: 'nvr_down' }], 1)
    manager = await createUser(orgId, 'manager')
    viewer = await createUser(orgId, 'user')
    await a.rpc('replace_user_access', { p_user: viewer.id, p_stores: [s1], p_zones: [], p_cameras: [] })
  })
  afterAll(() => cleanupOrg(orgId))

  it('the dashboard summarises what the reader may see', async () => {
    const d = await getDashboard(manager.client)
    expect(d.cameras).toEqual({ total: 4, live: 1, down: 2, unknown: 1 })
    expect(d.stores.total).toBe(2)
    expect(d.stores.nvrDown.map((s) => s.code)).toEqual(['ST2'])
    expect(d.stores.noLiveCamera).toBe(1)
    expect(d.devices.server).toEqual({ total: 2, up: 1, down: 1, unknown: 0 })
    const labels = d.recentOutages.map((o) => `${o.kind}:${o.label}`)
    expect(labels).toEqual(expect.arrayContaining(['camera:C2', 'device:Mail', 'nvr:Store ST2']))
    expect(labels).not.toContain('camera:D1') // listed once, as the NVR outage
  })

  it('a viewer sees the numbers of their own store only', async () => {
    const d = await getDashboard(viewer.client)
    expect(d.cameras.total).toBe(3)
    expect(d.stores.total).toBe(1)
    expect(d.stores.nvrDown).toEqual([])
    expect(d.recentOutages.map((o) => o.label)).not.toContain('Store ST2')
  })

  it('lists the status of each store and of individual targets', async () => {
    const stores = await listStoreStatus(viewer.client)
    expect([...stores.keys()]).toEqual([s1])
    expect(stores.get(s1)).toMatchObject({ cameras_total: 3, cameras_live: 1, cameras_down: 1, cameras_unknown: 1, nvr_status: 'up' })
    const states = await getStates(viewer.client, 'camera', [...cams1, cam2])
    expect(states.get(cams1[1])).toMatchObject({ status: 'down' })
    expect(states.has(cam2)).toBe(false) // not visible to the viewer
    expect(states.has(cams1[2])).toBe(false) // never checked
  })

  it('computes uptime for visible ids and gives nothing for unchecked ones', async () => {
    const up = await uptimeFor(admin(), orgId, 'camera', [cams1[0], cams1[1], cams1[2]], '24h')
    expect(up.get(cams1[0])).toBe(100)
    expect(up.get(cams1[1])).toBeLessThan(100)
    expect(up.get(cams1[2])).toBeNull()
  })

})

describe('status queries: outages of cameras whose NVR was down', () => {
  let orgId: string
  let manager: TestUser
  let flaky: string

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const mk = async (code: string) => (await a.from('stores').insert({ org_id: orgId, code, name: `Shop ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const open = await mk('OPN')
    const closed = await mk('CLS')
    const camOpen = (await a.from('cameras').insert({ org_id: orgId, store_id: open, channel: 1, name: 'InOpen' }).select('id').single()).data!.id
    const camClosed = (await a.from('cameras').insert({ org_id: orgId, store_id: closed, channel: 1, name: 'InClosed' }).select('id').single()).data!.id
    const apply = (results: object[]) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: 1 })
    // OPN: the NVR is down and still down; its camera went down because of it.
    await apply([{ type: 'nvr', id: open, ok: false, at: ago(30) }])
    await apply([{ type: 'camera', id: camOpen, ok: false, at: ago(30), cause: 'nvr_down' }])
    // CLS: the NVR went down and came back; the camera outage it caused is still open and must now be listed on its own.
    await apply([{ type: 'nvr', id: closed, ok: false, at: ago(60) }])
    await apply([{ type: 'camera', id: camClosed, ok: false, at: ago(60), cause: 'nvr_down' }])
    await apply([{ type: 'nvr', id: closed, ok: true, at: ago(20) }])
    const flk = await mk('FLK')
    flaky = (await a.from('cameras').insert({ org_id: orgId, store_id: flk, channel: 1, name: 'Flaky' }).select('id').single()).data!.id
    await apply([{ type: 'camera', id: flaky, ok: true, at: ago(60) }])
    await apply([{ type: 'camera', id: flaky, ok: false, at: ago(30) }])
    manager = await createUser(orgId, 'manager')
  })
  afterAll(() => cleanupOrg(orgId))

  it('groups under the NVR outage only while that outage is open', async () => {
    const d = await getDashboard(manager.client)
    const labels = d.recentOutages.map((o) => `${o.kind}:${o.label}`)
    expect(labels).toContain('nvr:Shop OPN')
    expect(labels).not.toContain('camera:InOpen')
    expect(labels).toContain('camera:InClosed')
  })

  it('measures uptime as of an earlier moment, so a later stoppage is not counted as downtime', async () => {
    // Up for 30 minutes, then down for 30: 50% now. Measured 15 minutes ago it had been down for 15 of 45 minutes.
    const now = await uptimeFor(admin(), orgId, 'camera', [flaky], '24h')
    const earlier = await uptimeFor(admin(), orgId, 'camera', [flaky], '24h', new Date(Date.now() - 15 * 60_000))
    expect(now.get(flaky)!).toBeCloseTo(50, 0)
    expect(earlier.get(flaky)!).toBeCloseTo(66.67, 0)
  })
})
