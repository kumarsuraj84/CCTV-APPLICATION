import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coversCamera, coversLocation, coversSomeWholeLocation, readCapabilities, type Capability } from '@/lib/auth/capabilities'
import {
  adminClient, atCamera, atCluster, atLocation, atRecorder, atRegion, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder,
  createRegion, createUser, grant, ORG_SCOPE, type GrantScope, type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()

// P2-5b (task item 5): the page-side display helpers (lib/auth/capabilities.ts) never recompute the hierarchy — they read the
// database's own expansion (my_access_summary: covered_location_ids, recorder_camera_ids). This proves it on a matrix: for every person
// and every camera / location, the helper's answer equals has_capability_for asked as that person in the database.
describe('display helpers equal the database (region / cluster / location / recorder / camera grants)', () => {
  let orgId: string
  const cameras: { id: string; location_id: string }[] = []
  const locations: string[] = []
  const people: { name: string; u: TestUser }[] = []
  const cap: Capability = 'cctv.live'

  beforeAll(async () => {
    orgId = await createOrg()
    const r1 = await createRegion(orgId)
    const r2 = await createRegion(orgId)
    const c1 = await createCluster(orgId, r1)
    const c2 = await createCluster(orgId, r1)
    const c3 = await createCluster(orgId, r2)
    const recorders: string[] = []
    for (const [i, cluster] of [c1, c1, c2, c3, null].entries()) {
      const loc = await createLocation(orgId, { clusterId: cluster })
      locations.push(loc)
      // Every other location has two NVRs; channel numbers restart on each.
      for (let n = 0; n < (i % 2 === 0 ? 2 : 1); n++) {
        const rec = await createRecorder(orgId, loc, { host: `10.66.${i}.${n + 1}` })
        recorders.push(rec)
        for (const ch of [1, 2]) cameras.push({ id: await createCamera(orgId, { locationId: loc, recorderId: rec, channel: ch }), location_id: loc })
      }
    }
    // An archived camera is covered by nobody (the database never returns it); the helper is only ever asked about rows people see.
    const archived = await createCamera(orgId, { locationId: locations[0], recorderId: recorders[0], channel: 9 })
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: archived })).error).toBeNull()
    const matrix: [string, GrantScope[]][] = [
      ['organisation', [ORG_SCOPE]],
      ['region 1', [atRegion(r1)]],
      ['region 2', [atRegion(r2)]],
      ['cluster 1', [atCluster(c1)]],
      ['cluster 2 + camera elsewhere', [atCluster(c2), atCamera(cameras[0].id)]],
      ['a location', [atLocation(locations[3])]],
      ['the no-cluster location', [atLocation(locations[4])]],
      ['one recorder', [atRecorder(recorders[0])]],
      ['two recorders of different locations', [atRecorder(recorders[1]), atRecorder(recorders[4])]],
      ['two cameras', [atCamera(cameras[2].id), atCamera(cameras[9].id)]],
      ['nothing', []],
    ]
    for (const [name, scopes] of matrix) {
      const u = await createUser(orgId, 'user')
      if (scopes.length > 0) await grant(orgId, u.id, cap, scopes)
      people.push({ name, u })
    }
  })
  afterAll(() => cleanupOrg(orgId))

  it('coversCamera equals has_capability_for(camera) and coversLocation equals has_capability_for(location) for every person', async () => {
    const mismatches: string[] = []
    for (const { name, u } of people) {
      const caps = await readCapabilities(u.client)
      expect(caps.failed, name).toBe(false)
      for (const c of cameras) {
        const db = (await u.client.rpc('has_capability_for', { p_cap: cap, p_kind: 'camera', p_id: c.id })).data === true
        if (coversCamera(caps, cap, c) !== db) mismatches.push(`${name}: camera ${c.id} page=${!db} db=${db}`)
      }
      for (const l of locations) {
        const db = (await u.client.rpc('has_capability_for', { p_cap: cap, p_kind: 'location', p_id: l })).data === true
        if (coversLocation(caps, cap, l) !== db) mismatches.push(`${name}: location ${l} page=${!db} db=${db}`)
      }
      const some = ((await u.client.rpc('capability_location_ids', { p_cap: cap })).data ?? []).length > 0
      if (coversSomeWholeLocation(caps, cap) !== some) mismatches.push(`${name}: some whole location page=${!some} db=${some}`)
    }
    expect(mismatches).toEqual([])
    // The matrix is not trivial: the organisation covers everything, "nothing" nothing, and the others something in between.
    const counts = await Promise.all(people.map(async ({ u }) => {
      const caps = await readCapabilities(u.client)
      return cameras.filter((c) => coversCamera(caps, cap, c)).length
    }))
    expect(counts[0]).toBe(cameras.length)
    expect(counts.at(-1)).toBe(0)
    expect(new Set(counts).size).toBeGreaterThan(4)
  })
})
