// P2-1 VA-20, extended in P2-5a (impact map 4.4 item 26): performance smoke test of the capability model at the planned size with the
// hierarchy of ruling C-1: 3 regions × 10 clusters, 300 locations (every fifth with 2 NVRs, every tenth with 3), 8,100 cameras on
// their recorders, and 200 people with mixed region / cluster / location / recorder / camera grants. The numbers are printed (one JSON
// line, "access_perf") and recorded in .superpowers/sdd/drishti/p2-5a-report.md with the EXPLAIN ANALYZE plans. The bound is
// deliberately loose (a slow laptop must pass).
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    // Written the old way (NVR columns on the location): the seam makes each location's primary recorder. They all share one NVR
    // address (as the old performance data did), so the seam gives every location after the first its own address space (D5-8).
    const s = await a.from('locations').insert(Array.from({ length: LOCATIONS }, (_, i) => ({
      org_id: orgId, code: `P${String(i).padStart(3, '0')}`, name: `Perf ${i}`, zone: `Z${i % 10}`, cluster_id: clusters[i % clusters.length], nvr_ip: '192.0.2.1', nvr_username: 'u',
    }))).select('id, code')
    if (s.error) throw new Error(s.error.message)
    locations = [...s.data].sort((x, y) => x.code.localeCompare(y.code)).map((x) => x.id)
    const prim = await a.from('recorders').select('id, location_id').eq('org_id', orgId)
    for (const p of prim.data ?? []) recordersOf.set(p.location_id, [p.id])
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
    // 197 people without a sign-in (their grants only add rows to scan) plus six typical viewers who sign in.
    const ids: string[] = []
    for (let i = 0; i < PEOPLE - 6; i++) {
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
