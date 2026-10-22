import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, atCamera, CCTV_VIEW, cleanupOrg, createOrg, createSite, createUser, grant, primaryRecorderOf, READ_EVERYTHING, withRecorders, type TestUser } from '../setup/fixtures'
import { fenced } from '../setup/lease'

const admin = () => adminClient()
const T0 = new Date('2026-03-10T10:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString()

type R = { type: 'camera' | 'device' | 'recorder'; id: string; ok: boolean; at: string; method?: string; error?: string; cause?: 'nvr_down' }
// P2-6: camera results name their recorder (required), as the worker sends them. P2-7: with a lease and its fencing token.
const apply = async (org: string, results: R[], threshold = 2) =>
  admin().rpc('monitor_apply_results', { ...(await fenced()), p_org: org, p_results: await withRecorders(results), p_threshold: threshold })

describe('monitoring in the database', () => {
  let orgId: string
  let otherOrg: string
  let storeId: string
  let recorderId: string
  let cam1: string
  let cam2: string
  let deviceId: string
  let viewer: TestUser
  let manager: TestUser
  let foreignCam: string
  const gapIds: string[] = []

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    const a = admin()
    // P2-5b: a location with its NVR (a recorder of its own); the cameras added below are mapped to it.
    const site = await createSite(orgId, { code: 'MON', name: 'Mon', host: '127.0.0.1', username: 'u' })
    storeId = site.locationId
    recorderId = site.recorderId
    const cams = await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, location_id: storeId, channel: n, name: `C${n}` }))).select('id, channel').order('channel')
    cam1 = cams.data![0].id
    cam2 = cams.data![1].id
    deviceId = (await a.from('assets').insert({ org_id: orgId, location_id: storeId, type: 'server', name: 'ERP', ip: '127.0.0.1', tcp_port: 9 }).select('id').single()).data!.id
    const otherStore = (await createSite(otherOrg, { code: 'OTH', name: 'Oth', host: '127.0.0.1', username: 'u' })).locationId
    foreignCam = (await a.from('cameras').insert({ org_id: otherOrg, location_id: otherStore, channel: 1, name: 'F' }).select('id').single()).data!.id
    viewer = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
    await grant(orgId, viewer.id, CCTV_VIEW, atCamera(cam1)) // a camera grant (P2-1)
  })

  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  const state = async (type: string, id: string) =>
    (await admin().from('check_state').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).maybeSingle()).data
  const outagesOf = async (type: string, id: string) =>
    (await admin().from('outages').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).order('started_at')).data ?? []

  it('one failure is not an outage; the second opens it at the time of the first failure', async () => {
    await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: at(0), method: 'isapi', error: 'no answer' }])
    let s = await state('camera', cam1)
    expect(s?.status).toBe('unknown')
    expect(s?.consecutive_failures).toBe(1)
    expect(await outagesOf('camera', cam1)).toHaveLength(0)

    await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: at(5), method: 'isapi', error: 'no answer' }])
    s = await state('camera', cam1)
    expect(s?.status).toBe('down')
    expect(new Date(s!.down_since!).toISOString()).toBe(at(0))
    const o = await outagesOf('camera', cam1)
    expect(o).toHaveLength(1)
    expect(new Date(o[0].started_at).toISOString()).toBe(at(0))
    expect(o[0].ended_at).toBeNull()
  })

  it('more failures do not open a second outage; the first success closes it', async () => {
    await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: at(10) }])
    expect(await outagesOf('camera', cam1)).toHaveLength(1)
    await apply(orgId, [{ type: 'camera', id: cam1, ok: true, at: at(15), method: 'isapi' }])
    const s = await state('camera', cam1)
    expect(s?.status).toBe('up')
    expect(s?.consecutive_failures).toBe(0)
    expect(s?.error).toBeNull()
    expect(new Date(s!.last_up_at!).toISOString()).toBe(at(15))
    const o = await outagesOf('camera', cam1)
    expect(new Date(o[0].ended_at!).toISOString()).toBe(at(15))
  })

  it('a flapping target (fail, ok, fail) never reaches down', async () => {
    await apply(orgId, [{ type: 'device', id: deviceId, ok: false, at: at(0) }])
    await apply(orgId, [{ type: 'device', id: deviceId, ok: true, at: at(1) }])
    await apply(orgId, [{ type: 'device', id: deviceId, ok: false, at: at(2) }])
    expect((await state('device', deviceId))?.status).toBe('up')
    expect(await outagesOf('device', deviceId)).toHaveLength(0)
  })

  it('with threshold 1 and cause nvr_down a failure opens an outage at once, with the cause', async () => {
    await apply(orgId, [{ type: 'camera', id: cam2, ok: false, at: at(20), method: 'nvr_down', cause: 'nvr_down' }], 1)
    const s = await state('camera', cam2)
    expect(s?.status).toBe('down')
    const o = await outagesOf('camera', cam2)
    expect(o).toHaveLength(1)
    expect(o[0].cause).toBe('nvr_down')
  })

  it('ignores targets that do not belong to the organisation', async () => {
    await apply(orgId, [{ type: 'camera', id: foreignCam, ok: false, at: at(0) }, { type: 'camera', id: randomUUID(), ok: true, at: at(0) }])
    const { data } = await admin().from('check_state').select('id').eq('target_id', foreignCam)
    expect(data).toEqual([])
  })

  // P2-5a (brief item 2) replaces "deleting removes its status and outages", the behaviour that erased history: nothing is deleted;
  // archiving stops monitoring like switching off does (current state forgotten, open outages closed) and keeps the outages.
  it('a location cannot be deleted; archiving it stops monitoring of its NVR and cameras and keeps their outages', async () => {
    const a = admin()
    const gone = await createSite(orgId, { code: 'GONE', name: 'Gone', host: '127.0.0.1', username: 'u' })
    const s2 = { id: gone.locationId }
    const { data: c } = await a.from('cameras').insert({ org_id: orgId, location_id: s2.id, channel: 1, name: 'G' }).select('id').single()
    const rec = await primaryRecorderOf(s2.id)
    await apply(orgId, [{ type: 'recorder', id: rec, ok: false, at: at(0) }, { type: 'camera', id: c!.id, ok: false, at: at(0) }], 1)
    expect((await state('recorder', rec))?.status).toBe('down')
    expect((await a.from('locations').delete().eq('id', s2.id)).error?.code).toBe('DR003')
    expect((await a.rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: s2.id })).error).toBeNull()
    expect(await state('recorder', rec)).toBeNull()
    expect(await state('camera', c!.id)).toBeNull()
    for (const o of [...await outagesOf('camera', c!.id), ...await outagesOf('recorder', rec)]) expect(o.ended_at).not.toBeNull()
    expect(await outagesOf('camera', c!.id)).toHaveLength(1)
    expect(await outagesOf('recorder', rec)).toHaveLength(1)
  })

  it('people read status only for what they may see, and nobody but the server writes it', async () => {
    // viewer was granted cam1 only
    const seen = await viewer.client.from('check_state').select('target_type, target_id')
    expect(seen.data).toEqual([{ target_type: 'camera', target_id: cam1 }])
    const seenManager = await manager.client.from('check_state').select('target_id')
    expect((seenManager.data ?? []).map((r) => r.target_id)).toEqual(expect.arrayContaining([cam1, cam2, deviceId]))
    const ins = await viewer.client.from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: cam1 })
    expect(ins.error?.code).toBe('42501')
    expect((await viewer.client.from('outages').select('target_id')).data?.map((r) => r.target_id)).toEqual([cam1])
    expect((await viewer.client.from('worker_state').select('id')).error?.code).toBe('42501')
    expect((await viewer.client.rpc('monitor_apply_results', { ...(await fenced()), p_org: orgId, p_results: [], p_threshold: 2 })).error?.code).toBe('42501')
  })

  it('location_status (was store_status) counts what the reader may see', async () => {
    // Results must be recent: a "Live" older than 20 minutes counts as stale, not live.
    const now = new Date().toISOString()
    await apply(orgId, [{ type: 'recorder', id: recorderId, ok: true, at: now }, { type: 'camera', id: cam1, ok: true, at: now }])
    const m = await manager.client.from('location_status').select('*').eq('location_id', storeId).single()
    // P4-L1 review I-3 (MC-4): cam2 is down with the worker's method nvr_down (its NVR was not reachable), so it is "recorder not
    // reachable", no longer counted as down.
    expect(m.data).toMatchObject({ cameras_total: 2, cameras_live: 1, cameras_down: 0, cameras_recorder_unreachable: 1, cameras_unknown: 0, nvr_status: 'up', recorders_total: 1, recorders_up: 1 })
    const v = await viewer.client.from('location_status').select('*').eq('location_id', storeId).single()
    expect(v.data).toMatchObject({ cameras_total: 1, cameras_live: 1, cameras_down: 0 })
  })

  describe('uptime', () => {
    const NOW = new Date('2026-04-01T20:00:00Z')
    const t = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
    let u: string // camera used for the uptime cases

    const uptime = async (windowHours: number, id = u) => {
      const { data, error } = await admin().rpc('targets_uptime', { p_org: orgId, p_type: 'camera', p_ids: [id], p_window: `${windowHours} hours`, p_now: NOW.toISOString() })
      expect(error).toBeNull()
      return data?.[0]?.uptime_pct ?? null
    }
    const makeCamera = async (n: number, createdHoursAgo: number) => {
      const a = admin()
      const { data } = await a.from('cameras').insert({ org_id: orgId, location_id: storeId, channel: 10 + n, name: `U${n}` }).select('id').single()
      await a.from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: data!.id, status: 'up', created_at: t(createdHoursAgo) })
      return data!.id
    }
    const outage = (id: string, fromH: number, toH: number | null) =>
      admin().from('outages').insert({ org_id: orgId, target_type: 'camera', target_id: id, started_at: t(fromH), ended_at: toH === null ? null : t(toH) })
    const gap = async (fromH: number, toH: number) => {
      const { data } = await admin().from('monitor_gaps').insert({ started_at: t(fromH), ended_at: t(toH) }).select('id').single()
      gapIds.push(data!.id)
    }

    it('is 90 percent for a one hour outage in a ten hour window', async () => {
      u = await makeCamera(1, 20)
      await outage(u, 6, 5)
      expect(Number(await uptime(10))).toBeCloseTo(90, 1)
    })

    it('has no value for a target that was never checked', async () => {
      expect(await uptime(10, randomUUID())).toBeNull()
    })

    it('starts counting when the target was first checked', async () => {
      const c = await makeCamera(2, 2)
      expect(Number(await uptime(24, c))).toBeCloseTo(100, 1)
    })

    it('counts an outage that is still open up to now', async () => {
      const c = await makeCamera(3, 20)
      await outage(c, 5, null)
      expect(Number(await uptime(10, c))).toBeCloseTo(50, 1)
    })

    it('leaves out the time the worker was not running', async () => {
      const c = await makeCamera(4, 20)
      await outage(c, 7.5, 6) // 1.5 hours down
      await gap(8, 7) // worker stopped from 8h to 7h ago: 0.5 of the outage is inside the gap
      // window 10h: observed = 10 - 1 = 9h; down = 1.5 - 0.5 = 1h; uptime = 8/9
      expect(Number(await uptime(10, c))).toBeCloseTo((8 / 9) * 100, 1)
    })
  })
})
