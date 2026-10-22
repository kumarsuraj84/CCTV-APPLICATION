import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STALE_AFTER_MINUTES } from '@/lib/queries/status'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, primaryRecorderOf, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()

type R = { type: 'camera' | 'device' | 'recorder'; id: string; ok: boolean; at: string; method?: string; error?: string; cause?: 'nvr_down' }
const apply = (org: string, results: R[], threshold = 2) => admin().rpc('monitor_apply_results', { p_org: org, p_results: results, p_threshold: threshold })
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

describe('monitoring fixes in the database', () => {
  let orgId: string
  let manager: TestUser
  const gapIds: string[] = []

  // P2-5b: a store is a location with its NVR (a recorder of its own); its cameras are mapped to that recorder.
  const makeStore = async (code: string) => (await createSite(orgId, { code, name: `Store ${code}`, host: '127.0.0.1', username: 'u' })).locationId
  const makeCamera = async (store: string, channel: number, extra: Record<string, unknown> = {}) =>
    (await admin().from('cameras').insert({ org_id: orgId, location_id: store, channel, name: `C${channel}`, ...extra }).select('id').single()).data!.id
  const makeDevice = async (store: string, port: number) =>
    (await admin().from('assets').insert({ org_id: orgId, location_id: store, type: 'server', name: `D${port}`, ip: '127.0.0.1', tcp_port: port }).select('id').single()).data!.id
  const state = async (type: string, id: string) =>
    (await admin().from('check_state').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).maybeSingle()).data
  const outagesOf = async (type: string, id: string) =>
    (await admin().from('outages').select('*').eq('org_id', orgId).eq('target_type', type).eq('target_id', id).order('started_at')).data ?? []

  beforeAll(async () => {
    orgId = await createOrg()
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
    // Gaps are global and real ones are routine (the worker records silences). A real, recent gap must not disturb anything below.
    const { data } = await admin().from('monitor_gaps').insert({ started_at: ago(180), ended_at: ago(120) }).select('id').single()
    gapIds.push(data!.id)
  })
  afterAll(async () => {
    if (gapIds.length) await admin().from('monitor_gaps').delete().in('id', gapIds)
    await cleanupOrg(orgId)
  })

  describe('an outage is never dated before a worker stop (I1)', () => {
    // Long ago, so that these gaps cannot touch the uptime of any other test.
    const T0 = new Date('2020-05-01T10:00:00Z')
    const at = (m: number) => new Date(T0.getTime() + m * 60_000).toISOString()
    const gap = async (fromMin: number, toMin: number) => {
      const { data } = await admin().from('monitor_gaps').insert({ started_at: at(fromMin), ended_at: at(toMin) }).select('id').single()
      gapIds.push(data!.id)
    }

    it('without a gap two failures in a row still open the outage at the first one', async () => {
      const cam = await makeCamera(await makeStore('NOGAP'), 1)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(0) }])
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(1) }])
      expect(new Date((await outagesOf('camera', cam))[0].started_at).toISOString()).toBe(at(0))
    })

    it('a failure before the stop and one after it are not two failures in a row', async () => {
      const cam = await makeCamera(await makeStore('GAP'), 1)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(100) }])
      await gap(101, 130) // the worker was off; it is back by minute 130
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(131) }])
      let s = await state('camera', cam)
      expect(s?.status).toBe('unknown')
      expect(s?.consecutive_failures).toBe(1)
      expect(new Date(s!.first_failure_at!).toISOString()).toBe(at(131))
      expect(await outagesOf('camera', cam)).toHaveLength(0)

      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(136) }])
      s = await state('camera', cam)
      expect(s?.status).toBe('down')
      const o = await outagesOf('camera', cam)
      expect(o).toHaveLength(1)
      expect(new Date(o[0].started_at).toISOString()).toBe(at(131)) // after the stop, never before it
    })

    it('a gap that ended before the last check changes nothing', async () => {
      const cam = await makeCamera(await makeStore('OLDGAP'), 1)
      await gap(200, 210)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(220) }])
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(225) }])
      expect(new Date((await outagesOf('camera', cam))[0].started_at).toISOString()).toBe(at(220))
    })

    it('a gap that began after the result was taken does not reset the run of failures', async () => {
      const cam = await makeCamera(await makeStore('LATEGAP'), 1)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(600) }])
      await gap(610, 620) // ended after the last check, but began after this result
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(605) }])
      const o = await outagesOf('camera', cam)
      expect(o).toHaveLength(1)
      expect(new Date(o[0].started_at).toISOString()).toBe(at(600))
    })

    it('a real, recent gap (any time, in the present) does not affect results from long ago', async () => {
      const { data } = await admin().from('monitor_gaps').insert({ started_at: ago(10), ended_at: ago(1) }).select('id').single()
      gapIds.push(data!.id)
      const cam = await makeCamera(await makeStore('REALGAP'), 1)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(700) }])
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(705) }])
      expect(new Date((await outagesOf('camera', cam))[0].started_at).toISOString()).toBe(at(700))
    })

    it('a target that is already down stays down, with the same outage, across a stop', async () => {
      const cam = await makeCamera(await makeStore('DOWNGAP'), 1)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(300) }])
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(305) }])
      await gap(306, 330)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: at(331) }])
      expect((await state('camera', cam))?.status).toBe('down')
      const o = await outagesOf('camera', cam)
      expect(o).toHaveLength(1)
      expect(new Date(o[0].started_at).toISOString()).toBe(at(300))
    })
  })

  describe('switched-off targets (I3a, R11)', () => {
    it('switching a store off closes its open outages and forgets its status; switched on again it starts as not checked yet', async () => {
      const store = await makeStore('OFF')
      const cam = await makeCamera(store, 1)
      // The NVR's state and outages belong to the location's recorder ('recorder', its id).
      const rec = await primaryRecorderOf(store)
      await apply(orgId, [{ type: 'recorder', id: rec, ok: false, at: ago(30) }], 1)
      await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: ago(30), cause: 'nvr_down' }], 1)
      expect((await outagesOf('recorder', rec))[0].ended_at).toBeNull()

      expect((await admin().from('locations').update({ is_active: false }).eq('id', store)).error).toBeNull()
      for (const [type, id] of [['recorder', rec], ['camera', cam]] as const) {
        const o = await outagesOf(type, id)
        expect(o).toHaveLength(1)
        expect(o[0].ended_at).not.toBeNull()
        expect(await state(type, id)).toBeNull()
      }
      // It is gone from the status view, and a late result from a round that was already running changes nothing.
      expect((await manager.client.from('location_status').select('location_id').eq('location_id', store)).data).toEqual([])
      await apply(orgId, [{ type: 'recorder', id: rec, ok: false, at: new Date().toISOString() }, { type: 'camera', id: cam, ok: true, at: new Date().toISOString() }], 1)
      expect(await state('recorder', rec)).toBeNull()
      expect(await state('camera', cam)).toBeNull()

      expect((await admin().from('locations').update({ is_active: true }).eq('id', store)).error).toBeNull()
      const back = await manager.client.from('location_status').select('*').eq('location_id', store).single()
      expect(back.data).toMatchObject({ cameras_total: 1, cameras_live: 0, cameras_unknown: 1, nvr_status: null })
    })

    it('switching a device off or a camera off does the same for that target only', async () => {
      const store = await makeStore('OFF2')
      const cam1 = await makeCamera(store, 1)
      const cam2 = await makeCamera(store, 2)
      const dev = await makeDevice(store, 7001)
      await apply(orgId, [{ type: 'camera', id: cam1, ok: false, at: ago(30) }, { type: 'camera', id: cam2, ok: false, at: ago(30) }, { type: 'device', id: dev, ok: false, at: ago(30) }], 1)
      await admin().from('assets').update({ enabled: false }).eq('id', dev)
      await admin().from('cameras').update({ is_active: false }).eq('id', cam1)
      expect((await outagesOf('device', dev))[0].ended_at).not.toBeNull()
      expect(await state('device', dev)).toBeNull()
      expect((await outagesOf('camera', cam1))[0].ended_at).not.toBeNull()
      expect(await state('camera', cam1)).toBeNull()
      // The other camera is untouched, and the view counts only the active one.
      expect((await outagesOf('camera', cam2))[0].ended_at).toBeNull()
      const v = await manager.client.from('location_status').select('*').eq('location_id', store).single()
      expect(v.data).toMatchObject({ cameras_total: 1, cameras_down: 1 })
      // A result for a disabled device or an inactive camera is ignored.
      await apply(orgId, [{ type: 'device', id: dev, ok: true, at: new Date().toISOString() }, { type: 'camera', id: cam1, ok: true, at: new Date().toISOString() }])
      expect(await state('device', dev)).toBeNull()
      expect(await state('camera', cam1)).toBeNull()
    })
  })

  describe('stale states (I3b, R10)', () => {
    it('the stale limit in the app is the one in the database', async () => {
      const { data, error } = await manager.client.rpc('monitor_stale_after_minutes')
      expect(error).toBeNull()
      expect(data).toBe(STALE_AFTER_MINUTES)
      expect(STALE_AFTER_MINUTES).toBe(20)
    })

    it('a camera or NVR last checked more than 20 minutes ago is stale, not live; offline stays offline', async () => {
      const store = await makeStore('STALE')
      const rec = await primaryRecorderOf(store)
      const fresh = await makeCamera(store, 1)
      const old = await makeCamera(store, 2)
      const down = await makeCamera(store, 3)
      const never = await makeCamera(store, 4)
      await apply(orgId, [
        { type: 'camera', id: fresh, ok: true, at: ago(STALE_AFTER_MINUTES - 1) },
        { type: 'camera', id: old, ok: true, at: ago(STALE_AFTER_MINUTES + 1) },
        { type: 'recorder', id: rec, ok: true, at: ago(STALE_AFTER_MINUTES + 1) },
      ])
      await apply(orgId, [{ type: 'camera', id: down, ok: false, at: ago(STALE_AFTER_MINUTES + 30) }], 1)
      void never
      const v = await manager.client.from('location_status').select('*').eq('location_id', store).single()
      expect(v.data).toMatchObject({ cameras_total: 4, cameras_live: 1, cameras_stale: 1, cameras_down: 1, cameras_unknown: 1, nvr_status: 'up', nvr_stale: true })

      // A fresh NVR result is not stale.
      await apply(orgId, [{ type: 'recorder', id: rec, ok: true, at: ago(1) }])
      const w = await manager.client.from('location_status').select('nvr_stale').eq('location_id', store).single()
      expect(w.data?.nvr_stale).toBe(false)
    })

    it('a store that was never checked has no stale NVR', async () => {
      const store = await makeStore('NEVER')
      const v = await manager.client.from('location_status').select('*').eq('location_id', store).single()
      expect(v.data).toMatchObject({ nvr_status: null, nvr_stale: false, cameras_stale: 0 })
    })
  })

  describe('the check request and the round times (minor 2, I4)', () => {
    it('monitor_request_check stamps the request with the database clock and only the service role may call it', async () => {
      const saved = (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
      try {
        const { data, error } = await admin().rpc('monitor_request_check')
        expect(error).toBeNull()
        expect(typeof data).toBe('string')
        const row = (await admin().from('worker_state').select('check_requested_at').eq('id', 1).single()).data!
        expect(new Date(row.check_requested_at!).getTime()).toBe(new Date(data as string).getTime())
        expect(Math.abs(Date.now() - new Date(data as string).getTime())).toBeLessThan(10_000)
        expect((await manager.client.rpc('monitor_request_check')).error?.code).toBe('42501')
      } finally {
        await admin().from('worker_state').update(saved).eq('id', 1)
      }
    })

    it('worker_state has the times of the last devices round and cameras round', async () => {
      const saved = (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
      try {
        const t = new Date().toISOString()
        const { error } = await admin().from('worker_state').update({ last_devices_round_at: t, last_cameras_round_at: t }).eq('id', 1)
        expect(error).toBeNull()
        expect((await manager.client.from('worker_state').select('last_devices_round_at')).error?.code).toBe('42501')
      } finally {
        await admin().from('worker_state').update(saved).eq('id', 1)
      }
    })
  })
})
