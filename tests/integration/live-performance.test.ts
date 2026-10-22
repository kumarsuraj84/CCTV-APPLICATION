import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCapabilities } from '@/lib/auth/capabilities'
import { getRollups } from '@/lib/live/rollups'
import { treeLocations } from '@/lib/live/tree'
import { loadHomeRollups } from '@/lib/queries/home-rollups'
import { getLiveScope } from '@/lib/queries/live'
import { loadLiveLanding } from '@/lib/queries/live-landing'
import { getDashboard } from '@/lib/queries/status'
import { adminClient, atCluster, atRegion, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P4-L1 performance budget: the Live landing and the Home roll-ups take less than 300 ms of server time at the size of the owner's
// estate — 216 locations, 216 NVRs, 4,637 cameras — measured through PostgREST as the signed-in person (the way the pages read), in a
// throw-away organisation with synthetic data (never the real estate). Six regions of five clusters, 200 locations in clusters and 16
// without one, every tenth NVR down (its cameras "recorder not reachable"). Medians of 7 runs after one warm-up are printed as
// `live_perf` JSON. No NVR is contacted (documentation addresses only, and nothing here opens a stream).

const admin = () => adminClient()
const LOCATIONS = 216
const CAMERAS = 4637
const RUNS = 7

async function median(fn: () => Promise<unknown>): Promise<number> {
  await fn()
  const times: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    await fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return Math.round(times[Math.floor(RUNS / 2)] * 10) / 10
}

async function insertAll(table: 'locations' | 'cameras' | 'check_state', rows: Record<string, unknown>[], select = false): Promise<{ id: string }[]> {
  const out: { id: string }[] = []
  for (let i = 0; i < rows.length; i += 500) {
    const q = admin().from(table).insert(rows.slice(i, i + 500) as never)
    const { data, error } = select ? await q.select('id') : await q
    if (error) throw new Error(`${table}: ${error.message}`)
    if (data) out.push(...(data as { id: string }[]))
  }
  return out
}

describe('Live landing and Home roll-ups at the size of the estate (P4-L1 budget: < 300 ms)', () => {
  let orgId: string
  let orgAll: TestUser, regionUser: TestUser, clusterUser: TestUser
  let regionIds: string[] = []
  let clusterIds: string[] = []
  const results: Record<string, Record<string, number>> = {}

  beforeAll(async () => {
    orgId = await createOrg()
    const regions = await admin().from('regions').insert(Array.from({ length: 6 }, (_, i) => ({ org_id: orgId, code: `PR${i}`, name: `Perf region ${i}` }))).select('id')
    regionIds = (regions.data ?? []).map((r) => r.id)
    const clusters = await admin().from('clusters').insert(Array.from({ length: 30 }, (_, i) => ({ org_id: orgId, region_id: regionIds[i % 6], code: `PC${i}`, name: `Perf cluster ${i}` }))).select('id')
    clusterIds = (clusters.data ?? []).map((c) => c.id)
    const locations = await insertAll('locations', Array.from({ length: LOCATIONS }, (_, i) => ({
      org_id: orgId, code: `PL${String(i).padStart(3, '0')}`, name: `Perf location ${i}`, city: `City ${i % 40}`, kind: 'store', cluster_id: i < 200 ? clusterIds[i % 30] : null,
    })), true)
    const recorders: string[] = []
    for (let i = 0; i < LOCATIONS; i++) {
      const { data, error } = await admin().rpc('recorder_save', {
        p_org: orgId, p_location: locations[i].id, p_recorder: null as unknown as string, p_host: `192.0.2.${(i % 250) + 1}`, p_http_port: 8000 + i, p_rtsp_port: 554,
        p_username: 'viewer', p_expected_channels: 0, p_name: `NVR ${i}`,
      })
      if (error) throw new Error(`recorder_save: ${error.message}`)
      recorders.push(data as string)
    }
    const cams: Record<string, unknown>[] = []
    for (let i = 0; i < CAMERAS; i++) {
      const l = i % LOCATIONS
      cams.push({ org_id: orgId, location_id: locations[l].id, recorder_id: recorders[l], channel: Math.floor(i / LOCATIONS) + 1, name: `Camera ${i}`, is_active: true })
    }
    const cameraIds = await insertAll('cameras', cams, true)
    const at = new Date().toISOString()
    const states: Record<string, unknown>[] = recorders.map((r, i) => ({ org_id: orgId, target_type: 'recorder', target_id: r, status: i % 10 === 0 ? 'down' : 'up', last_checked_at: at }))
    cameraIds.forEach((c, i) => {
      const l = i % LOCATIONS
      if (i % 20 === 7) return // never checked
      const nvrDown = l % 10 === 0
      states.push({ org_id: orgId, target_type: 'camera', target_id: c.id, status: nvrDown || i % 20 === 3 ? 'down' : 'up', method: nvrDown ? 'nvr_down' : i % 20 === 3 ? 'rtsp' : null, last_checked_at: at })
    })
    await insertAll('check_state', states)
    expect((await admin().rpc('inventory_refresh_statistics')).error).toBeNull()
    orgAll = await createUser(orgId, 'manager')
    await grant(orgId, orgAll.id, ['cctv.live', 'cctv.playback', 'it.monitoring.view'], ORG_SCOPE)
    regionUser = await createUser(orgId, 'user')
    await grant(orgId, regionUser.id, CCTV_VIEW, atRegion(regionIds[0]))
    clusterUser = await createUser(orgId, 'user')
    await grant(orgId, clusterUser.id, CCTV_VIEW, atCluster(clusterIds[0]))
  }, 600_000)
  afterAll(async () => {
    await cleanupOrg(orgId)
    console.log(JSON.stringify({ live_perf: results, size: { locations: LOCATIONS, recorders: LOCATIONS, cameras: CAMERAS }, runs: RUNS }))
  }, 600_000)

  it('the estate is the size it should be, and an organisation-wide viewer sees all of it', async () => {
    const rollups = await getRollups(orgAll.client, 'cctv.live')
    expect(rollups.filter((r) => r.level === 'location')).toHaveLength(LOCATIONS)
    expect(rollups.filter((r) => r.level === 'location').reduce((n, r) => n + r.cameras.total, 0)).toBe(CAMERAS)
    const landing = await loadLiveLanding(orgAll.client, await readCapabilities(orgAll.client), {})
    expect(treeLocations(landing.tree)).toHaveLength(LOCATIONS)
    expect(landing.tree.regions).toHaveLength(6)
    expect(landing.tree.locations).toHaveLength(16)
  })

  for (const who of ['organisation', 'region', 'cluster'] as const) {
    it(`${who}: Live landing and Home roll-ups under 300 ms`, async () => {
      const u = who === 'organisation' ? orgAll : who === 'region' ? regionUser : clusterUser
      const caps = await readCapabilities(u.client)
      const r: Record<string, number> = {}
      r.status_rollups_live = await median(() => getRollups(u.client, 'cctv.live'))
      r.live_landing = await median(() => loadLiveLanding(u.client, caps, {}))
      r.live_landing_search = await median(() => loadLiveLanding(u.client, caps, { q: 'Camera 12' }))
      r.home_rollups = await median(() => loadHomeRollups(u.client))
      r.home_dashboard_and_rollups = await median(() => Promise.all([getDashboard(u.client), loadHomeRollups(u.client)]))
      if (who !== 'cluster') r.region_wall = await median(() => getLiveScope(u.client, { region: regionIds[0] }, 'cctv.live'))
      r.cluster_wall = await median(() => getLiveScope(u.client, { cluster: clusterIds[0] }, 'cctv.live'))
      results[who] = r
      expect(r.live_landing, 'Live landing').toBeLessThan(300)
      expect(r.home_rollups, 'Home roll-ups').toBeLessThan(300)
    }, 300_000)
  }
})
