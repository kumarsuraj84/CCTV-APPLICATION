// P2-1 VA-20: performance smoke test of the capability model at the planned size: 300 locations × 27 cameras (8,100 cameras) and 200
// people with mixed grants. The numbers are printed (one JSON line, "access_perf") and recorded in .superpowers/sdd/drishti/p2-1-report.md.
// The bound is deliberately loose (a slow laptop must pass); the report has the EXPLAIN ANALYZE numbers.
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, atCamera, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

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

describe('VA-20: access model performance at 8,100 cameras and 200 people', () => {
  let orgId: string
  let stores: string[] = []
  const cameras: string[] = []
  const viewers: Record<string, TestUser> = {}

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const s = await a.from('stores').insert(Array.from({ length: LOCATIONS }, (_, i) => ({ org_id: orgId, code: `P${String(i).padStart(3, '0')}`, name: `Perf ${i}`, zone: `Z${i % 10}`, nvr_ip: '192.0.2.1', nvr_username: 'u' }))).select('id, code')
    if (s.error) throw new Error(s.error.message)
    stores = [...s.data].sort((a, b) => a.code.localeCompare(b.code)).map((r) => r.id)
    const camRows = stores.flatMap((store) => Array.from({ length: CAMERAS_PER_LOCATION }, (_, i) => ({ org_id: orgId, store_id: store, channel: i + 1, name: `Cam ${i + 1}` })))
    for (let i = 0; i < camRows.length; i += 1000) {
      const r = await a.from('cameras').insert(camRows.slice(i, i + 1000)).select('id')
      if (r.error) throw new Error(r.error.message)
      cameras.push(...r.data.map((c) => c.id))
    }
    // 197 people without a sign-in (their grants only add rows to scan) plus three typical viewers who sign in.
    const ids: string[] = []
    for (let i = 0; i < PEOPLE - 3; i++) {
      const created = await a.auth.admin.createUser({ email: `${randomUUID()}@example.test`, password: randomBytes(12).toString('base64url') + 'aA1!', email_confirm: true })
      if (created.error || !created.data.user) throw new Error(created.error?.message)
      ids.push(created.data.user.id)
    }
    const p = await a.from('profiles').insert(ids.map((id, i) => ({ id, org_id: orgId, email: `perf-${i}-${id}@example.test`, role: 'user' as const, must_reset_password: false })))
    if (p.error) throw new Error(p.error.message)
    for (let i = 0; i < ids.length; i++) {
      if (i % 10 === 0) await grant(orgId, ids[i], READ_EVERYTHING)
      else if (i % 2 === 0) await grant(orgId, ids[i], CCTV_VIEW, Array.from({ length: 1 + (i % 10) }, (_, k) => atLocation(stores[(i * 7 + k * 13) % LOCATIONS])))
      else await grant(orgId, ids[i], i % 3 ? 'cctv.live' : 'cctv.playback', Array.from({ length: 20 + (i % 30) }, (_, k) => atCamera(cameras[(i * 101 + k * 37) % cameras.length])))
    }
    viewers.orgWide = await createUser(orgId, 'user')
    await grant(orgId, viewers.orgWide.id, READ_EVERYTHING)
    viewers.tenLocations = await createUser(orgId, 'user')
    await grant(orgId, viewers.tenLocations.id, CCTV_VIEW, stores.slice(0, 10).map(atLocation))
    viewers.fiftyCameras = await createUser(orgId, 'user')
    await grant(orgId, viewers.fiftyCameras.id, 'cctv.live', cameras.slice(500, 550).map(atCamera))
  }, 600_000)
  afterAll(() => cleanupOrg(orgId), 600_000)

  it('counting cameras, listing stores and a capability check stay under the bound for typical viewers', async () => {
    const results: Record<string, Record<string, number>> = {}
    const expectedCount = { orgWide: LOCATIONS * CAMERAS_PER_LOCATION, tenLocations: 10 * CAMERAS_PER_LOCATION, fiftyCameras: 50 }
    for (const [key, u] of Object.entries(viewers)) {
      const c = u.client as SupabaseClient<Database>
      const count = await c.from('cameras').select('id', { count: 'exact', head: true })
      expect(count.count, key).toBe(expectedCount[key as keyof typeof expectedCount])
      results[key] = {
        countCameras: await median(7, () => c.from('cameras').select('id', { count: 'exact', head: true })),
        listStores: await median(7, () => c.from('stores').select('id, code, name').order('code').limit(1000)),
        canLiveOneCamera: await median(7, () => c.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'camera', p_id: cameras[520] })),
        storeStatus: await median(5, () => c.from('store_status').select('store_id, cameras_total').limit(1000)),
      }
    }
    // One JSON line for the report.
    console.info(JSON.stringify({ event: 'access_perf', locations: LOCATIONS, cameras: cameras.length, people: PEOPLE, medians_ms: results }))
    for (const [key, r] of Object.entries(results)) {
      expect(r.countCameras, `${key} count`).toBeLessThan(BOUND_MS)
      expect(r.listStores, `${key} stores`).toBeLessThan(BOUND_MS)
      expect(r.canLiveOneCamera, `${key} check`).toBeLessThan(BOUND_MS)
      expect(r.storeStatus, `${key} store_status`).toBeLessThan(BOUND_MS * 2)
    }
  }, 120_000)

  it('an anonymous client is still refused at this size', async () => {
    const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    expect((await anon.from('cameras').select('id').limit(1)).error?.code).toBe('42501')
  })
})
