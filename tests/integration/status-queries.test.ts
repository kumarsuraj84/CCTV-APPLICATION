import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDashboard, getStates, listStoreStatus, STALE_AFTER_MINUTES } from '@/lib/queries/status'
import { uptimeFor } from '@/lib/monitor/uptime'
import { adminClient, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

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
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
    viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(s1)) // a CCTV store grant (P2-1)
  })
  afterAll(() => cleanupOrg(orgId))

  it('the dashboard summarises what the reader may see', async () => {
    const d = await getDashboard(manager.client)
    expect(d.cameras).toEqual({ total: 4, live: 1, down: 2, unknown: 1, stale: 0 })
    expect(d.stores.total).toBe(2)
    expect(d.stores.nvrDown.map((s) => s.code)).toEqual(['ST2'])
    expect(d.devices.server).toEqual({ total: 2, up: 1, down: 1, unknown: 0, stale: 0 })
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
    // AC-4 (P2-1): a CCTV-only viewer sees no IT devices and no device outages.
    expect(d.devices).toEqual({})
    expect(d.recentOutages.map((o) => o.kind)).not.toContain('device')
  })

  it('lists the status of each store and of individual targets', async () => {
    const stores = await listStoreStatus(viewer.client)
    expect([...stores.keys()]).toEqual([s1])
    // AC-4 (P2-1): camera availability yes; the NVR's status is IT monitoring data (it.monitoring.view), so it is not shown.
    expect(stores.get(s1)).toMatchObject({ cameras_total: 3, cameras_live: 1, cameras_down: 1, cameras_unknown: 1, nvr_status: null })
    expect((await listStoreStatus(manager.client)).get(s1)).toMatchObject({ nvr_status: 'up' })
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
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
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

describe('status queries: which camera outages hide under an NVR outage', () => {
  let orgId: string
  let manager: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const mk = async (code: string) => (await a.from('stores').insert({ org_id: orgId, code, name: `Unit ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const cam = async (store: string, name: string) => (await a.from('cameras').insert({ org_id: orgId, store_id: store, channel: 1, name }).select('id').single()).data!.id
    const apply = (results: object[]) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: 1 })

    // AGN: the NVR went down, the camera outage it caused ended, then the NVR went down again (open now). The ended camera outage stays listed.
    const agn = await mk('AGN')
    const camAgn = await cam(agn, 'EndedEarlier')
    await apply([{ type: 'nvr', id: agn, ok: false, at: ago(60) }])
    await apply([{ type: 'camera', id: camAgn, ok: false, at: ago(60), cause: 'nvr_down' }])
    await apply([{ type: 'camera', id: camAgn, ok: true, at: ago(40) }, { type: 'nvr', id: agn, ok: true, at: ago(40) }])
    await apply([{ type: 'nvr', id: agn, ok: false, at: ago(10) }])

    // OLD: a camera outage from an earlier NVR outage is still open and the NVR is down again: it began before this NVR outage, so it is listed.
    const old = await mk('OLD')
    const camOld = await cam(old, 'StartedBefore')
    await apply([{ type: 'nvr', id: old, ok: false, at: ago(90) }])
    await apply([{ type: 'camera', id: camOld, ok: false, at: ago(90), cause: 'nvr_down' }])
    await apply([{ type: 'nvr', id: old, ok: true, at: ago(70) }])
    await apply([{ type: 'nvr', id: old, ok: false, at: ago(5) }])

    // NRM: the ordinary case: both open, the camera outage began after the NVR outage began: it hides.
    const nrm = await mk('NRM')
    const camNrm = await cam(nrm, 'Grouped')
    await apply([{ type: 'nvr', id: nrm, ok: false, at: ago(30) }])
    await apply([{ type: 'camera', id: camNrm, ok: false, at: ago(29), cause: 'nvr_down' }])
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
  })
  afterAll(() => cleanupOrg(orgId))

  it('hides only open camera outages that began inside the NVR outage', async () => {
    const d = await getDashboard(manager.client)
    const labels = d.recentOutages.map((o) => `${o.kind}:${o.label}`)
    expect(labels).toEqual(expect.arrayContaining(['nvr:Unit AGN', 'nvr:Unit OLD', 'nvr:Unit NRM', 'camera:EndedEarlier', 'camera:StartedBefore']))
    expect(labels).not.toContain('camera:Grouped')
  })
})

describe('status queries: a capped scan of grouped outages', () => {
  let orgId: string
  let manager: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const store = (await a.from('stores').insert({ org_id: orgId, code: 'BIG', name: 'Big store', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const cams = (await a.from('cameras').insert([1, 2, 3, 4, 5].map((n) => ({ org_id: orgId, store_id: store, channel: n, name: `G${n}` }))).select('id, channel').order('channel')).data!.map((c) => c.id)
    const apply = (results: object[]) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: 1 })
    await apply([{ type: 'nvr', id: store, ok: false, at: ago(60) }])
    await apply(cams.map((id, i) => ({ type: 'camera', id, ok: false, at: ago(50 - i), cause: 'nvr_down' })))
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
  })
  afterAll(() => cleanupOrg(orgId))

  it('says the list may be incomplete when everything scanned was grouped away', async () => {
    const d = await getDashboard(manager.client, { outagePageSize: 2, outageMaxPages: 2 })
    expect(d.recentOutages).toEqual([])
    expect(d.recentOutagesLimited).toBe(true)
  })

  it('does not say so when the whole list was scanned', async () => {
    const d = await getDashboard(manager.client)
    expect(d.recentOutages.map((o) => o.label)).toEqual(['Big store'])
    expect(d.recentOutagesLimited).toBe(false)
  })
})

describe('status queries: grouping uses the time an outage was recorded (I5)', () => {
  let orgId: string
  let manager: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const store = (await a.from('stores').insert({ org_id: orgId, code: 'EAR', name: 'Early camera', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const cam = (await a.from('cameras').insert({ org_id: orgId, store_id: store, channel: 1, name: 'EarlyStart' }).select('id').single()).data!.id
    const apply = (results: object[]) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: 1 })
    // The NVR's outage is recorded first and starts 30 minutes ago. The camera's, caused by it, is recorded afterwards but its first failure
    // (the round began a moment earlier) is dated before the NVR's: it still belongs under the NVR outage.
    await apply([{ type: 'nvr', id: store, ok: false, at: ago(30) }])
    await apply([{ type: 'camera', id: cam, ok: false, at: ago(31), cause: 'nvr_down' }])
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
  })
  afterAll(() => cleanupOrg(orgId))

  it('hides a camera outage recorded after the NVR outage even when it started a little earlier', async () => {
    const d = await getDashboard(manager.client)
    const labels = d.recentOutages.map((o) => `${o.kind}:${o.label}`)
    expect(labels).toContain('nvr:Early camera')
    expect(labels).not.toContain('camera:EarlyStart')
  })
})

describe('status queries: stale and switched-off targets', () => {
  let orgId: string
  let manager: TestUser
  let off: string
  const minutesAgo = (m: number) => ago(m)

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const mk = async (code: string) => (await a.from('stores').insert({ org_id: orgId, code, name: `Place ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const on = await mk('ON')
    off = await mk('OFF')
    const cams = (await a.from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: on, channel: n, name: `K${n}`, is_active: true }))).select('id, channel').order('channel')).data!.map((c) => c.id)
    const offCam = (await a.from('cameras').insert({ org_id: orgId, store_id: off, channel: 1, name: 'InOff' }).select('id').single()).data!.id
    const devs = (await a.from('devices').insert([
      { org_id: orgId, store_id: on, type: 'server', name: 'FreshDev', ip: '127.0.0.1', tcp_port: 1, enabled: true },
      { org_id: orgId, store_id: on, type: 'server', name: 'OldDev', ip: '127.0.0.1', tcp_port: 2, enabled: true },
      { org_id: orgId, store_id: on, type: 'server', name: 'OffDev', ip: '127.0.0.1', tcp_port: 3, enabled: true },
    ]).select('id, name').order('name')).data!
    const dev = Object.fromEntries(devs.map((d) => [d.name, d.id]))
    const apply = (results: object[], threshold = 2) => a.rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: threshold })
    await apply([
      { type: 'camera', id: cams[0], ok: true, at: minutesAgo(2) },
      { type: 'camera', id: cams[1], ok: true, at: minutesAgo(STALE_AFTER_MINUTES + 5) },
      { type: 'nvr', id: on, ok: true, at: minutesAgo(STALE_AFTER_MINUTES + 5) },
      { type: 'device', id: dev.FreshDev, ok: true, at: minutesAgo(1) },
      { type: 'device', id: dev.OldDev, ok: true, at: minutesAgo(STALE_AFTER_MINUTES + 5) },
      { type: 'device', id: dev.OffDev, ok: false, at: minutesAgo(15) },
    ])
    await apply([{ type: 'device', id: dev.OffDev, ok: false, at: minutesAgo(10) }])
    // A store that is switched off while its NVR is down.
    await apply([{ type: 'nvr', id: off, ok: false, at: minutesAgo(8) }], 1)
    await apply([{ type: 'camera', id: offCam, ok: false, at: minutesAgo(8), cause: 'nvr_down' }], 1)
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
  })
  afterAll(() => cleanupOrg(orgId))

  it('counts a live result older than 20 minutes as stale, not live; unknown stays unknown', async () => {
    const d = await getDashboard(manager.client)
    expect(d.cameras).toEqual({ total: 3 + 1, live: 1, down: 1, unknown: 1, stale: 1 })
    expect(d.stores.nvrStale).toBe(1)
  })

  it('counts devices the same way', async () => {
    const d = await getDashboard(manager.client)
    expect(d.devices.server).toEqual({ total: 3, up: 1, down: 1, unknown: 0, stale: 1 })
  })

  it('a store that is switched off leaves the NVR list, the counts and the recent problems; its outage is closed', async () => {
    const before = await getDashboard(manager.client)
    expect(before.stores.nvrDown.map((s) => s.code)).toEqual(['OFF'])
    await admin().from('stores').update({ is_active: false }).eq('id', off)
    const d = await getDashboard(manager.client)
    expect(d.stores.nvrDown).toEqual([])
    expect(d.stores.total).toBe(1)
    expect(d.cameras.total).toBe(3)
    expect(d.recentOutages.map((o) => o.label)).not.toContain('Place OFF')
    expect(d.recentOutages.map((o) => o.label)).not.toContain('InOff')
    expect((await admin().from('outages').select('ended_at').eq('target_id', off)).data?.[0].ended_at).not.toBeNull()
    // Back on: it starts as not checked yet.
    await admin().from('stores').update({ is_active: true }).eq('id', off)
    const back = await listStoreStatus(manager.client)
    expect(back.get(off)).toMatchObject({ nvr_status: null, cameras_unknown: 1, cameras_down: 0 })
  })

  it('a device that is switched off is not counted or listed', async () => {
    await admin().from('devices').update({ enabled: false }).eq('org_id', orgId).eq('name', 'OffDev')
    const d = await getDashboard(manager.client)
    expect(d.devices.server).toEqual({ total: 2, up: 1, down: 0, unknown: 0, stale: 1 })
    expect(d.recentOutages.map((o) => o.label)).not.toContain('OffDev')
  })
})
