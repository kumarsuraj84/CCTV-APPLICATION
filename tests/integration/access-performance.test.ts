// P2-1 VA-20, extended in P2-5a (impact map 4.4 item 26): performance smoke test of the capability model at the planned size with the
// hierarchy of ruling C-1: 3 regions × 10 clusters, 300 locations (every fifth with 2 NVRs, every tenth with 3), 8,100 cameras on
// their recorders, and 200 people with mixed region / cluster / location / recorder / camera grants. The numbers are printed (one JSON
// line, "access_perf") and recorded in .superpowers/sdd/drishti/p2-5a-report.md with the EXPLAIN ANALYZE plans. The bound is
// deliberately loose (a slow laptop must pass).
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import {
  adminClient, atCamera, atCluster, atLocation, atRecorder, atRegion, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, READ_EVERYTHING, type TestUser,
} from '../setup/fixtures'

const REGIONS = 3
const CLUSTERS_PER_REGION = 10
const LOCATIONS = 300
const CAMERAS_PER_LOCATION = 27
const PEOPLE = 200
/** Median wall time through PostgREST (HTTP round trip included) that a typical page read must stay under. */
const BOUND_MS = 400

const admin = () => adminClient()

async function median(times: number, f: () => PromiseLike<unknown>): Promise<number> {
  const t: number[] = []
  for (let i = 0; i < times; i++) {
    const s = performance.now()
    await f()
    t.push(performance.now() - s)
  }
  t.sort((a, b) => a - b)
  return Math.round(t[Math.floor(t.length / 2)] * 10) / 10
}

describe('VA-20: access model performance at 8,100 cameras, 300 locations in 30 clusters of 3 regions, 200 people', () => {
  let orgId: string
  let regions: string[] = []
  let clusters: string[] = []
  let locations: string[] = []
  const recordersOf = new Map<string, string[]>()
  const cameras: string[] = []
  const cameraRecorder = new Map<string, string>()
  const viewers: Record<string, TestUser> = {}
  let threeRecorders: string[] = []

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const r = await a.from('regions').insert(Array.from({ length: REGIONS }, (_, i) => ({ org_id: orgId, code: `PR${i}`, name: `Perf region ${i}` }))).select('id, code')
    if (r.error) throw new Error(r.error.message)
    regions = [...r.data].sort((x, y) => x.code.localeCompare(y.code)).map((x) => x.id)
    const c = await a.from('clusters').insert(Array.from({ length: REGIONS * CLUSTERS_PER_REGION }, (_, i) => ({
      org_id: orgId, region_id: regions[i % REGIONS], code: `PC${String(i).padStart(2, '0')}`, name: `Perf cluster ${i}`,
    }))).select('id, code')
    if (c.error) throw new Error(c.error.message)
    clusters = [...c.data].sort((x, y) => x.code.localeCompare(y.code)).map((x) => x.id)
    // P2-5b: locations hold no NVR data; each gets its first recorder (an nvr asset + recorders row, its own address) explicitly.
    const s = await a.from('locations').insert(Array.from({ length: LOCATIONS }, (_, i) => ({
      org_id: orgId, code: `P${String(i).padStart(3, '0')}`, name: `Perf ${i}`, zone: `Z${i % 10}`, cluster_id: clusters[i % clusters.length],
    }))).select('id, code')
    if (s.error) throw new Error(s.error.message)
    locations = [...s.data].sort((x, y) => x.code.localeCompare(y.code)).map((x) => x.id)
    const firstAssets = await a.from('assets').insert(locations.map((l, k) => ({ org_id: orgId, location_id: l, type: 'nvr' as const, name: 'NVR', ip: `10.199.${Math.floor(k / 250)}.${(k % 250) + 1}`, tcp_port: 80 }))).select('id, location_id')
    if (firstAssets.error) throw new Error(firstAssets.error.message)
    const firstRecs = await a.from('recorders').insert(firstAssets.data.map((x) => ({ id: x.id, org_id: orgId, location_id: x.location_id as string, username: 'u' })))
    if (firstRecs.error) throw new Error(firstRecs.error.message)
    for (const p of firstAssets.data) recordersOf.set(p.location_id as string, [p.id])
    // Every fifth location gets a second NVR, every tenth a third.
    const extra = locations.flatMap((l, i) => (i % 10 === 0 ? [l, l] : i % 5 === 0 ? [l] : []))
    const assets = await a.from('assets').insert(extra.map((l, k) => ({ org_id: orgId, location_id: l, type: 'nvr' as const, name: `NVR extra ${k}`, ip: `10.200.${Math.floor(k / 250)}.${(k % 250) + 1}`, tcp_port: 80 }))).select('id, location_id')
    if (assets.error) throw new Error(assets.error.message)
    const recs = await a.from('recorders').insert(assets.data.map((x) => ({ id: x.id, org_id: orgId, location_id: x.location_id as string })))
    if (recs.error) throw new Error(recs.error.message)
    for (const x of assets.data) recordersOf.get(x.location_id as string)!.push(x.id)
    // 27 cameras per location, spread over its recorders; channel numbers start at 1 on each recorder.
    const camRows = locations.flatMap((l) => {
      const list = recordersOf.get(l)!
      return Array.from({ length: CAMERAS_PER_LOCATION }, (_, i) => ({
        org_id: orgId, location_id: l, recorder_id: list[i % list.length], channel: Math.floor(i / list.length) + 1, name: `Cam ${i + 1}`,
      }))
    })
    for (let i = 0; i < camRows.length; i += 1000) {
      const res = await a.from('cameras').insert(camRows.slice(i, i + 1000)).select('id, recorder_id')
      if (res.error) throw new Error(res.error.message)
      for (const cam of res.data) {
        cameras.push(cam.id)
        cameraRecorder.set(cam.id, cam.recorder_id as string)
      }
    }
    // Review M11: monitoring state for every camera and every recorder (~8,500 check_state rows): every tenth camera down, the rest up.
    const now = new Date().toISOString()
    const stateRows = [
      ...cameras.map((id, i) => ({ org_id: orgId, target_type: 'camera', target_id: id, status: i % 10 === 0 ? 'down' : 'up', last_checked_at: now, down_since: i % 10 === 0 ? now : null })),
      ...[...recordersOf.values()].flat().map((id) => ({ org_id: orgId, target_type: 'recorder', target_id: id, status: 'up', last_checked_at: now, down_since: null })),
    ]
    for (let i = 0; i < stateRows.length; i += 1000) {
      const res = await a.from('check_state').insert(stateRows.slice(i, i + 1000))
      if (res.error) throw new Error(res.error.message)
    }
    // 196 people without a sign-in (their grants only add rows to scan) plus seven typical viewers who sign in.
    const ids: string[] = []
    for (let i = 0; i < PEOPLE - 7; i++) {
      const created = await a.auth.admin.createUser({ email: `${randomUUID()}@example.test`, password: randomBytes(12).toString('base64url') + 'aA1!', email_confirm: true })
      if (created.error || !created.data.user) throw new Error(created.error?.message)
      ids.push(created.data.user.id)
    }
    const p = await a.from('profiles').insert(ids.map((id, i) => ({ id, org_id: orgId, email: `perf-${i}-${id}@example.test`, role: 'user' as const, must_reset_password: false })))
    if (p.error) throw new Error(p.error.message)
    const allRecorders = [...recordersOf.values()].flat()
    for (let i = 0; i < ids.length; i++) {
      if (i % 10 === 0) await grant(orgId, ids[i], READ_EVERYTHING)
      else if (i % 10 === 1) await grant(orgId, ids[i], CCTV_VIEW, atRegion(regions[i % REGIONS]))
      else if (i % 10 === 3) await grant(orgId, ids[i], CCTV_VIEW, Array.from({ length: 1 + (i % 3) }, (_, k) => atCluster(clusters[(i + k * 7) % clusters.length])))
      else if (i % 10 === 5) await grant(orgId, ids[i], 'cctv.live', Array.from({ length: 1 + (i % 4) }, (_, k) => atRecorder(allRecorders[(i * 11 + k * 17) % allRecorders.length])))
      else if (i % 2 === 0) await grant(orgId, ids[i], CCTV_VIEW, Array.from({ length: 1 + (i % 10) }, (_, k) => atLocation(locations[(i * 7 + k * 13) % LOCATIONS])))
      else await grant(orgId, ids[i], i % 3 ? 'cctv.live' : 'cctv.playback', Array.from({ length: 20 + (i % 30) }, (_, k) => atCamera(cameras[(i * 101 + k * 37) % cameras.length])))
    }
    viewers.orgWide = await createUser(orgId, 'user')
    await grant(orgId, viewers.orgWide.id, READ_EVERYTHING)
    viewers.region = await createUser(orgId, 'user')
    await grant(orgId, viewers.region.id, CCTV_VIEW, atRegion(regions[0]))
    viewers.cluster = await createUser(orgId, 'user')
    await grant(orgId, viewers.cluster.id, CCTV_VIEW, atCluster(clusters[0]))
    viewers.tenLocations = await createUser(orgId, 'user')
    await grant(orgId, viewers.tenLocations.id, CCTV_VIEW, locations.slice(0, 10).map(atLocation))
    viewers.threeRecorders = await createUser(orgId, 'user')
    threeRecorders = recordersOf.get(locations[0])! // the first location has three NVRs
    await grant(orgId, viewers.threeRecorders.id, 'cctv.live', threeRecorders.map(atRecorder))
    viewers.fiftyCameras = await createUser(orgId, 'user')
    await grant(orgId, viewers.fiftyCameras.id, 'cctv.live', cameras.slice(500, 550).map(atCamera))
    viewers.itOrgWide = await createUser(orgId, 'user') // the IT view only, organisation-wide (recorder figures of every location)
    await grant(orgId, viewers.itOrgWide.id, ['it.inventory.view', 'it.monitoring.view'])
    // P2-5b: a bulk seed changes the tables faster than autovacuum re-analyses them; the importer does the same at the end of a bulk
    // import (measured: location_status 1.8 s on stale statistics, 18 ms after).
    const stats = await a.rpc('inventory_refresh_statistics')
    if (stats.error) throw new Error(stats.error.message)
  }, 900_000)
  afterAll(() => cleanupOrg(orgId), 900_000)

  it('the hierarchy seed is what the brief asked for', async () => {
    expect(cameras).toHaveLength(LOCATIONS * CAMERAS_PER_LOCATION)
    expect([...recordersOf.values()].filter((r) => r.length === 3)).toHaveLength(LOCATIONS / 10)
    expect([...recordersOf.values()].filter((r) => r.length === 2)).toHaveLength(LOCATIONS / 10)
  })

  it('counting cameras, listing locations, a capability check, a batch check and the status view stay under the bound for typical viewers', async () => {
    const results: Record<string, Record<string, number>> = {}
    const perLocation = CAMERAS_PER_LOCATION
    const expectedCount: Record<string, number> = {
      orgWide: LOCATIONS * perLocation,
      region: (LOCATIONS / REGIONS) * perLocation,
      cluster: (LOCATIONS / clusters.length) * perLocation,
      tenLocations: 10 * perLocation,
      threeRecorders: perLocation, // the three NVRs of one location hold all its cameras
      fiftyCameras: 50,
      itOrgWide: 0, // IT only: no camera rows
    }
    const batch = cameras.slice(0, 1000)
    for (const [key, u] of Object.entries(viewers)) {
      const c = u.client as SupabaseClient<Database>
      const count = await c.from('cameras').select('id', { count: 'exact', head: true })
      expect(count.count, key).toBe(expectedCount[key])
      results[key] = {
        countCameras: await median(7, () => c.from('cameras').select('id', { count: 'exact', head: true })),
        listLocations: await median(7, () => c.from('locations').select('id, code, name').order('code').limit(1000)),
        canLiveOneCamera: await median(7, () => c.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'camera', p_id: cameras[520] })),
        batch1000: await median(5, () => c.rpc('cameras_with_capability', { p_cap: 'cctv.live', p_ids: batch })),
        locationStatus: await median(5, () => c.from('location_status').select('location_id, cameras_total').limit(1000)),
        summary: await median(5, () => c.rpc('my_access_summary')),
      }
    }
    console.info(JSON.stringify({ event: 'access_perf', regions: REGIONS, clusters: clusters.length, locations: LOCATIONS, recorders: [...recordersOf.values()].flat().length, cameras: cameras.length, people: PEOPLE, medians_ms: results }))
    for (const [key, r] of Object.entries(results)) {
      expect(r.countCameras, `${key} count`).toBeLessThan(BOUND_MS)
      expect(r.listLocations, `${key} locations`).toBeLessThan(BOUND_MS)
      expect(r.canLiveOneCamera, `${key} check`).toBeLessThan(BOUND_MS)
      expect(r.batch1000, `${key} batch`).toBeLessThan(BOUND_MS)
      expect(r.locationStatus, `${key} location_status`).toBeLessThan(BOUND_MS * 2)
      expect(r.summary, `${key} summary`).toBeLessThan(BOUND_MS)
    }
  }, 180_000)

  it('with ~8,500 check_state rows the status views are exact and fast, also for an organisation-wide IT viewer (review M11)', async () => {
    const recorders = [...recordersOf.values()].flat().length
    const down = cameras.filter((_, i) => i % 10 === 0).length
    const sum = (rows: Record<string, number>[], k: string) => rows.reduce((s, r) => s + r[k], 0)
    const cols = 'cameras_total, cameras_live, cameras_down, recorders_total, recorders_up, recorders_down'
    const it = (await viewers.itOrgWide.client.from('location_status').select(cols).limit(1000)).data as unknown as Record<string, number>[]
    expect(it).toHaveLength(LOCATIONS)
    expect({ cams: sum(it, 'cameras_total'), recs: sum(it, 'recorders_total'), up: sum(it, 'recorders_up'), down: sum(it, 'recorders_down') })
      .toEqual({ cams: 0, recs: recorders, up: recorders, down: 0 })
    const all = (await viewers.orgWide.client.from('location_status').select(cols).limit(1000)).data as unknown as Record<string, number>[]
    expect({ cams: sum(all, 'cameras_total'), live: sum(all, 'cameras_live'), down: sum(all, 'cameras_down'), recs: sum(all, 'recorders_total') })
      .toEqual({ cams: cameras.length, live: cameras.length - down, down, recs: recorders })
    const timing = {
      itOrgWide: {
        locationStatus: await median(5, () => viewers.itOrgWide.client.from('location_status').select('*').limit(1000)),
        recorderStatus: await median(5, () => viewers.itOrgWide.client.from('recorder_status').select('*').limit(1000)),
      },
      orgWide: {
        locationStatus: await median(5, () => viewers.orgWide.client.from('location_status').select('*').limit(1000)),
        cameraStates: await median(5, () => viewers.orgWide.client.from('check_state').select('target_id, status').eq('target_type', 'camera').limit(1000)),
      },
    }
    console.info(JSON.stringify({ event: 'access_perf_status', check_state_rows: cameras.length + recorders, medians_ms: timing }))
    for (const [key, r] of Object.entries(timing)) for (const [k, ms] of Object.entries(r)) expect(ms, `${key} ${k}`).toBeLessThan(BOUND_MS * 2)
  }, 120_000)

  // P2-5b (task item 7, re-measure): the worker's data layer on the recorder model at this size — 390 recorders, 8,100 mapped cameras.
  it('the worker loads 390 recorder jobs with their 8,100 mapped cameras, and applies results in batches of 200, quickly', async () => {
    const db = new SupabaseMonitorDb(admin(), { orgId })
    const t0 = performance.now()
    const nvrs = await db.loadNvrs()
    const tNvrs = performance.now() - t0
    const t1 = performance.now()
    const jobs = await db.loadRecorderJobs()
    const tJobs = performance.now() - t1
    expect(nvrs).toHaveLength([...recordersOf.values()].flat().length)
    expect(jobs).toHaveLength(nvrs.length)
    expect(jobs.reduce((n, j) => n + j.cameras.length, 0)).toBe(cameras.length)
    // Every camera's job is its own recorder's.
    for (const j of jobs) for (const c of j.cameras) expect(cameraRecorder.get(c.id)).toBe(j.id)
    // One full camera round's results (every camera, 200 per call as the checks send them), then one NVR round.
    const at = new Date().toISOString()
    const batchMs: number[] = []
    for (let i = 0; i < cameras.length; i += 200) {
      const s = performance.now()
      await db.applyResults(orgId, cameras.slice(i, i + 200).map((id, k) => ({ type: 'camera' as const, id, ok: (i + k) % 10 !== 0, at })), 2)
      batchMs.push(performance.now() - s)
    }
    const s = performance.now()
    const recorders = [...recordersOf.values()].flat()
    for (let i = 0; i < recorders.length; i += 200) await db.applyResults(orgId, recorders.slice(i, i + 200).map((id) => ({ type: 'recorder' as const, id, ok: true, at })), 2)
    const nvrRoundMs = performance.now() - s
    batchMs.sort((a, b) => a - b)
    const numbers = {
      loadNvrsMs: Math.round(tNvrs), loadRecorderJobsMs: Math.round(tJobs), applyBatches: batchMs.length,
      applyBatchMedianMs: Math.round(batchMs[Math.floor(batchMs.length / 2)]), applyBatchMaxMs: Math.round(batchMs.at(-1)!), applyCameraRoundMs: Math.round(batchMs.reduce((x, y) => x + y, 0)),
      applyNvrRoundMs: Math.round(nvrRoundMs),
    }
    console.info(JSON.stringify({ event: 'worker_perf', recorders: recorders.length, cameras: cameras.length, ...numbers }))
    expect(numbers.loadRecorderJobsMs).toBeLessThan(20_000)
    expect(numbers.applyBatchMedianMs).toBeLessThan(BOUND_MS * 5)
  }, 180_000)

  it('the batch check equals the expansion for a recorder-scoped and a region-scoped person', async () => {
    for (const key of ['threeRecorders', 'region'] as const) {
      const c = viewers[key].client
      // One answer carries at most 1000 rows (PostgREST max-rows): the expansion is read in pages (a scalar set has no column to order
      // by; the same plan gives the same order, and a page that slipped would show up as a repeat below).
      const all: string[] = []
      for (let from = 0; ; from += 1000) {
        const res = await c.rpc('capability_camera_ids', { p_cap: 'cctv.live' }).range(from, from + 999)
        expect(res.error, key).toBeNull()
        const page = (res.data as unknown as string[]).map(String)
        all.push(...page)
        if (page.length < 1000) break
      }
      all.sort()
      expect(new Set(all).size, key).toBe(all.length)
      expect(all.length, key).toBe(key === 'region' ? cameras.length / 3 : cameras.filter((id) => threeRecorders.includes(cameraRecorder.get(id)!)).length)
      const viaBatch: string[] = []
      for (let i = 0; i < cameras.length; i += 1000) {
        viaBatch.push(...((await c.rpc('cameras_with_capability', { p_cap: 'cctv.live', p_ids: cameras.slice(i, i + 1000) })).data as unknown as string[]).map(String))
      }
      expect(viaBatch.sort(), key).toEqual(all)
    }
    const onThree = cameras.filter((id) => threeRecorders.includes(cameraRecorder.get(id)!)).sort()
    expect(((await viewers.threeRecorders.client.rpc('capability_camera_ids', { p_cap: 'cctv.live' })).data as unknown as string[]).map(String).sort()).toEqual(onThree)
  }, 120_000)

  it('an anonymous client is still refused at this size', async () => {
    const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    expect((await anon.from('cameras').select('id').limit(1)).error?.code).toBe('42501')
  })
})
