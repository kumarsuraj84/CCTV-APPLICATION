import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient, atCamera, atCluster, atLocation, atRecorder, atRegion, cleanupOrg, createAsset, createCamera, createCluster, createLocation, createOrg,
  createRecorder, createRegion, createUser, grant, ORG_SCOPE, type TestUser,
} from '../setup/fixtures'

// P2-5a, ruling C-1 CONFIRMED: Organization → Region → Cluster → Location → NVR → Camera, a strict tree. Grant scope kinds
// organization, region, cluster, location, recorder, camera, asset; expansion is dynamic (items added later are included, moves take
// effect at once for everybody), archived nodes grant nothing, the union rule is unchanged and a CCTV scope never reveals IT assets.
// Every visibility check is made by a real signed-in person (their own JWT) through row security and the access functions.

const admin = () => adminClient()
const ids = (rows: { id: string }[] | null | undefined) => (rows ?? []).map((r) => r.id).sort()
const camsOf = async (u: TestUser) => ids((await u.client.from('cameras').select('id')).data)
const capIds = async (u: TestUser, fn: 'capability_camera_ids' | 'capability_location_ids' | 'capability_asset_ids', cap: string) =>
  ((await u.client.rpc(fn, { p_cap: cap })).data as unknown as string[] ?? []).map(String).sort()
const version = async (user: string) => (await admin().from('profiles').select('access_version').eq('id', user).single()).data!.access_version

describe('regions, clusters and recorder scopes (P2-5a, ruling C-1)', () => {
  let orgId: string
  let east: string, west: string
  const cl: Record<string, string> = {}
  const loc: Record<string, string> = {}
  const cams: Record<string, string[]> = {}
  const assets: Record<string, string> = {}
  let regionViewer: TestUser, clusterViewer: TestUser, clusterIt: TestUser, liveOnly: TestUser, mixed: TestUser, outsider: TestUser
  let clusterAdmin: TestUser, regionAdmin: TestUser, target: TestUser

  // Region EAST: clusters E1, E2, E3 with two locations each; region WEST: cluster W1 with two locations. Each location has two NVRs
  // with two cameras each (the same channel numbers on both NVRs) and one IT asset.
  const build = async (code: string, cluster: string | null) => {
    const l = await createLocation(orgId, { code, clusterId: cluster })
    const r1 = await createRecorder(orgId, l)
    const r2 = await createRecorder(orgId, l)
    cams[code] = []
    for (const r of [r1, r2]) for (const ch of [1, 2]) cams[code].push(await createCamera(orgId, { locationId: l, recorderId: r, channel: ch }))
    assets[code] = await createAsset(orgId, { locationId: l, type: 'switch', name: `Switch ${code}` })
    loc[code] = l
    return { l, r1, r2 }
  }
  const camsAt = (...codes: string[]) => codes.flatMap((c) => cams[c]).sort()
  let rec: Record<string, { l: string; r1: string; r2: string }> = {}

  beforeAll(async () => {
    orgId = await createOrg()
    east = await createRegion(orgId, { code: 'EAST' })
    west = await createRegion(orgId, { code: 'WEST' })
    for (const c of ['E1', 'E2', 'E3']) cl[c] = await createCluster(orgId, east, { code: c })
    cl.W1 = await createCluster(orgId, west, { code: 'W1' })
    rec = {}
    for (const [code, c] of [['E1A', 'E1'], ['E1B', 'E1'], ['E2A', 'E2'], ['E2B', 'E2'], ['E3A', 'E3'], ['E3B', 'E3'], ['W1A', 'W1'], ['W1B', 'W1']] as const) {
      rec[code] = await build(code, cl[c])
    }
    rec.LOOSE = await build('LOOSE', null) // not yet assigned to a cluster (migration/import only)
    regionViewer = await createUser(orgId, 'user')
    clusterViewer = await createUser(orgId, 'user')
    clusterIt = await createUser(orgId, 'user')
    liveOnly = await createUser(orgId, 'user')
    mixed = await createUser(orgId, 'user')
    outsider = await createUser(orgId, 'user')
    clusterAdmin = await createUser(orgId, 'admin')
    regionAdmin = await createUser(orgId, 'admin')
    target = await createUser(orgId, 'user')
    await grant(orgId, regionViewer.id, ['cctv.live', 'cctv.playback'], atRegion(east))
    await grant(orgId, clusterViewer.id, ['cctv.live', 'cctv.playback'], atCluster(cl.E1))
    await grant(orgId, clusterIt.id, ['it.inventory.view'], atCluster(cl.E2))
    await grant(orgId, liveOnly.id, 'cctv.live', atRegion(west))
    await grant(orgId, mixed.id, 'cctv.live', [atCluster(cl.E3), atCamera(cams.W1A[0]), atRecorder(rec.W1B.r2)])
    await grant(orgId, outsider.id, 'cctv.live', atLocation(loc.LOOSE))
    for (const a of [clusterAdmin, regionAdmin]) await grant(orgId, a.id, ['admin.access'], ORG_SCOPE)
    await grant(orgId, clusterAdmin.id, ['cctv.live'], atCluster(cl.E1))
    await grant(orgId, regionAdmin.id, ['cctv.live'], atRegion(east))
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
  })

  it('a region-scoped person sees exactly the cameras of every location in its clusters, and nothing outside the region', async () => {
    const expected = camsAt('E1A', 'E1B', 'E2A', 'E2B', 'E3A', 'E3B')
    expect(await camsOf(regionViewer)).toEqual(expected)
    expect(await capIds(regionViewer, 'capability_camera_ids', 'cctv.playback')).toEqual(expected)
    expect(ids((await regionViewer.client.from('locations').select('id')).data)).toEqual([loc.E1A, loc.E1B, loc.E2A, loc.E2B, loc.E3A, loc.E3B].sort())
    expect((await regionViewer.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: loc.W1A })).data).toBe(false)
    // The navigation rows: its region and the region's clusters, nothing of WEST.
    expect(ids((await regionViewer.client.from('regions').select('id')).data)).toEqual([east])
    expect(ids((await regionViewer.client.from('clusters').select('id')).data)).toEqual([cl.E1, cl.E2, cl.E3].sort())
  })

  it('dynamic: a location added to a cluster later is included at once', async () => {
    const late = await build('E2LATE', cl.E2)
    rec.E2LATE = late
    expect(await camsOf(regionViewer)).toEqual(camsAt('E1A', 'E1B', 'E2A', 'E2B', 'E3A', 'E3B', 'E2LATE'))
    expect(await camsOf(clusterViewer)).toEqual(camsAt('E1A', 'E1B'))
    expect((await regionViewer.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: late.l })).data).toBe(true)
  })

  it('a cluster-scoped person sees exactly the cluster\'s locations and ALL cameras of each (every NVR), and no IT assets', async () => {
    expect(await camsOf(clusterViewer)).toEqual(camsAt('E1A', 'E1B'))
    expect(ids((await clusterViewer.client.from('locations').select('id')).data)).toEqual([loc.E1A, loc.E1B].sort())
    // A CCTV scope never reveals IT: no assets, no recorders, no mappings, no addresses, no IT functions.
    expect((await clusterViewer.client.from('assets').select('id')).data ?? []).toEqual([])
    expect((await clusterViewer.client.from('recorders').select('id')).data ?? []).toEqual([])
    expect((await clusterViewer.client.from('camera_channel_mappings').select('id')).data ?? []).toEqual([])
    expect((await clusterViewer.client.from('camera_endpoints').select('camera_id')).data ?? []).toEqual([])
    expect(await capIds(clusterViewer, 'capability_asset_ids', 'it.inventory.view')).toEqual([])
    expect(((await clusterViewer.client.rpc('it_view_location_ids')).data as unknown as string[] ?? [])).toEqual([])
  })

  it('live, playback and IT rights expand separately', async () => {
    expect(await capIds(liveOnly, 'capability_camera_ids', 'cctv.live')).toEqual(camsAt('W1A', 'W1B'))
    expect(await capIds(liveOnly, 'capability_camera_ids', 'cctv.playback')).toEqual([])
    // IT at cluster E2: the assets (incl. the NVRs' own assets) of E2's locations, but no camera rows.
    const itAssets = await capIds(clusterIt, 'capability_asset_ids', 'it.inventory.view')
    const e2 = [rec.E2A, rec.E2B, rec.E2LATE].flatMap((x) => [x.r1, x.r2]).concat([assets.E2A, assets.E2B, assets.E2LATE]).sort()
    expect(itAssets).toEqual(e2)
    expect(ids((await clusterIt.client.from('assets').select('id')).data)).toEqual(e2)
    expect(await camsOf(clusterIt)).toEqual([])
    expect(ids((await clusterIt.client.from('recorders').select('id')).data)).toEqual([rec.E2A, rec.E2B, rec.E2LATE].flatMap((x) => [x.r1, x.r2]).sort())
  })

  it('the union never narrows: a cluster, one camera elsewhere and one NVR elsewhere add up', async () => {
    expect(await camsOf(mixed)).toEqual([...camsAt('E3A', 'E3B'), cams.W1A[0], ...cams.W1B.slice(2)].sort())
    const has = async (kind: string, id: string) => (await mixed.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: kind, p_id: id })).data
    expect(await has('location', loc.E3A)).toBe(true) // covered whole by the cluster
    expect(await has('cluster', cl.E3)).toBe(true)
    expect(await has('region', east)).toBe(false)
    expect(await has('location', loc.W1A)).toBe(false) // a camera grant never covers its location
    expect(await has('location', loc.W1B)).toBe(false) // nor does a recorder grant
    expect(await has('recorder', rec.W1B.r2)).toBe(true)
    expect(await has('camera', cams.W1B[3])).toBe(true)
    // cameras_with_capability over a large mixed list equals the expansion.
    const all = Object.values(cams).flat()
    const allowed = ((await mixed.client.rpc('cameras_with_capability', { p_cap: 'cctv.live', p_ids: all })).data as unknown as string[]).map(String).sort()
    expect(allowed).toEqual(await capIds(mixed, 'capability_camera_ids', 'cctv.live'))
  })

  it('my_access_summary returns the region, cluster and recorder scopes and the locations they cover', async () => {
    const { data, error } = await mixed.client.rpc('my_access_summary')
    expect(error).toBeNull()
    const live = (data ?? []).find((r) => r.capability === 'cctv.live')!
    expect(live.cluster_ids).toEqual([cl.E3])
    expect(live.recorder_ids).toEqual([rec.W1B.r2])
    expect(live.camera_ids).toEqual([cams.W1A[0]])
    expect([...live.covered_location_ids].sort()).toEqual([loc.E3A, loc.E3B].sort())
    expect([...live.recorder_camera_ids].sort()).toEqual(cams.W1B.slice(2).sort())
    const r = ((await regionViewer.client.rpc('my_access_summary')).data ?? []).find((x) => x.capability === 'cctv.live')!
    expect(r.region_ids).toEqual([east])
    expect(r.covered_location_ids).toHaveLength(7)
  })

  it('renaming a location (its display name) keeps its id, code, grants and history', async () => {
    const id = loc.LOOSE
    const before = (await admin().from('locations').select('id, code').eq('id', id).single()).data!
    await admin().from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: cams.LOOSE[0], status: 'up' })
    expect((await admin().from('locations').update({ name: 'Jamshedpur City Centre' }).eq('id', id)).error).toBeNull()
    expect((await admin().from('locations').select('id, code, name').eq('id', id).single()).data).toEqual({ ...before, name: 'Jamshedpur City Centre' })
    expect(await camsOf(outsider)).toEqual(camsAt('LOOSE'))
    expect((await admin().from('check_state').select('target_id').eq('target_id', cams.LOOSE[0])).data).toHaveLength(1)
    expect((await outsider.client.from('locations').select('name').eq('id', id).single()).data).toEqual({ name: 'Jamshedpur City Centre' })
  })

  // Owner amendment to R-1: regions and clusters are optional for a location (permanently, not only during migration).
  it('a location without a cluster is covered by organisation, location, recorder or camera grants only', async () => {
    expect(await camsOf(outsider)).toEqual(camsAt('LOOSE'))
    expect(await camsOf(regionViewer)).toEqual(camsAt('E1A', 'E1B', 'E2A', 'E2B', 'E3A', 'E3B', 'E2LATE'))
    const h = (await admin().from('location_hierarchy').select('location_id, unassigned').eq('location_id', loc.LOOSE).single()).data
    expect(h).toEqual({ location_id: loc.LOOSE, unassigned: true })
  })

  it('moving a location between clusters changes access at once for both sides, bumps their access version and is audited', async () => {
    const moved = rec.E1B.l
    const holderNew = await createUser(orgId, 'user')
    await grant(orgId, holderNew.id, 'cctv.live', atCluster(cl.W1))
    const preview = (await admin().rpc('preview_hierarchy_change', { p_org: orgId, p_kind: 'location', p_id: moved, p_new_parent: cl.W1 })).data as {
      people: { user_id: string; capability: string; before: number; after: number }[]
    }
    const p = (u: string, cap = 'cctv.live') => preview.people.find((x) => x.user_id === u && x.capability === cap)
    expect(p(clusterViewer.id)).toMatchObject({ before: 4, after: 0 })
    expect(p(holderNew.id)).toMatchObject({ before: 0, after: 4 })
    expect(p(regionViewer.id)).toMatchObject({ before: 4, after: 0 })
    const v1 = await version(clusterViewer.id)
    const v2 = await version(holderNew.id)
    const before = (await camsOf(clusterViewer)).length

    // Final fix Y (review A M-2): the move checks the actor's admin.inventory in SQL too (before: any active person of the organisation).
    await grant(orgId, regionAdmin.id, 'admin.inventory')
    expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: moved, p_cluster: cl.W1, p_actor: regionAdmin.id })).error).toBeNull()

    expect((await camsOf(clusterViewer)).length).toBe(before - 4)
    expect(await camsOf(holderNew)).toEqual(camsAt('W1A', 'W1B', 'E1B'))
    expect(await camsOf(regionViewer)).toEqual(camsAt('E1A', 'E2A', 'E2B', 'E3A', 'E3B', 'E2LATE'))
    expect(await version(clusterViewer.id)).toBeGreaterThan(v1)
    expect(await version(holderNew.id)).toBeGreaterThan(v2)
    const audit = (await admin().from('admin_audit_log').select('action, actor_id, detail').eq('org_id', orgId).eq('entity_id', moved).eq('action', 'hierarchy_moved')).data!
    expect(audit).toHaveLength(1)
    expect(audit[0].actor_id).toBe(regionAdmin.id)
    // Exactly the holders of a cluster or region grant at the old or new parent (E1 / W1 and EAST / WEST).
    expect([...(audit[0].detail as { affected_people: string[] }).affected_people].sort())
      .toEqual([clusterViewer.id, clusterAdmin.id, holderNew.id, regionViewer.id, regionAdmin.id, liveOnly.id].sort())
    // A direct update by the service role takes the same path (trigger).
    await admin().from('locations').update({ cluster_id: cl.E1 }).eq('id', moved)
    expect(await camsOf(clusterViewer)).toEqual(camsAt('E1A', 'E1B'))
    expect((await admin().from('admin_audit_log').select('id').eq('entity_id', moved).eq('action', 'hierarchy_moved')).data).toHaveLength(2)
  })

  it('moving a cluster between regions changes access at once', async () => {
    expect(await camsOf(liveOnly)).toEqual(camsAt('W1A', 'W1B'))
    const v = await version(liveOnly.id)
    expect((await admin().rpc('inventory_move_cluster', { p_org: orgId, p_cluster: cl.E3, p_region: west })).error).toBeNull()
    expect(await camsOf(liveOnly)).toEqual(camsAt('W1A', 'W1B', 'E3A', 'E3B'))
    expect(await camsOf(regionViewer)).toEqual(camsAt('E1A', 'E1B', 'E2A', 'E2B', 'E2LATE'))
    expect(await version(liveOnly.id)).toBeGreaterThan(v)
    await admin().rpc('inventory_move_cluster', { p_org: orgId, p_cluster: cl.E3, p_region: east })
    expect(await camsOf(regionViewer)).toEqual(camsAt('E1A', 'E1B', 'E2A', 'E2B', 'E3A', 'E3B', 'E2LATE'))
  })

  it('archiving a cluster or region that still has active children is refused (DR007); an emptied node can be archived, grants nothing, and comes back', async () => {
    // Review M7: archiving a node with live children would silently take access from everybody holding the node.
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'cluster', p_id: cl.E1 })).error?.code).toBe('DR007')
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'region', p_id: west })).error?.code).toBe('DR007')
    expect(await camsOf(clusterViewer)).toEqual(camsAt('E1A', 'E1B'))
    expect(await camsOf(liveOnly)).toEqual(camsAt('W1A', 'W1B'))
    // A spare cluster (no region) with one location: archive the location first, then the cluster.
    const spare = await createCluster(orgId, null, { code: 'SPARE' })
    const holder = await createUser(orgId, 'user')
    await grant(orgId, holder.id, 'cctv.live', atCluster(spare))
    const s1 = await build('SPARE1', spare)
    expect(await camsOf(holder)).toEqual(camsAt('SPARE1'))
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'cluster', p_id: spare })).error?.code).toBe('DR007')
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: s1.l })).error).toBeNull()
    expect(await camsOf(holder)).toEqual([])
    const v = await version(holder.id)
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'cluster', p_id: spare })).error).toBeNull()
    expect(await version(holder.id)).toBeGreaterThan(v)
    expect((await admin().from('access_grants').select('revoked_at').eq('user_id', holder.id).eq('scope_kind', 'cluster')).data).toEqual([{ revoked_at: null }])
    // A grant at an archived node is refused.
    expect((await admin().rpc('grant_access', { p_org: orgId, p_user: target.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'cluster', scope_id: spare }] })).error?.message)
      .toMatch(/scope outside organisation/)
    expect((await admin().from('clusters').delete().eq('id', spare)).error?.code).toBe('DR003')
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'cluster', p_id: spare })).error).toBeNull()
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'location', p_id: s1.l })).error).toBeNull()
    expect(await camsOf(holder)).toEqual(camsAt('SPARE1'))
    // An empty region can be archived and restored.
    const spareRegion = await createRegion(orgId, { code: 'SPARER' })
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'region', p_id: spareRegion })).error).toBeNull()
    expect((await admin().from('regions').delete().eq('id', spareRegion)).error?.code).toBe('DR003')
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'region', p_id: spareRegion })).error).toBeNull()
  })

  it('an archived location hides its cameras for every scope, and its restore brings them back', async () => {
    const mixedAll = [...camsAt('E3A', 'E3B'), cams.W1A[0], ...cams.W1B.slice(2)].sort()
    expect(await camsOf(mixed)).toEqual(mixedAll)
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: loc.E3B })).error).toBeNull()
    expect(await camsOf(mixed)).toEqual([...camsAt('E3A'), cams.W1A[0], ...cams.W1B.slice(2)].sort())
    expect(await camsOf(regionViewer)).toEqual(camsAt('E1A', 'E1B', 'E2A', 'E2B', 'E3A', 'E2LATE'))
    expect(ids((await regionViewer.client.from('locations').select('id')).data)).toEqual([loc.E1A, loc.E1B, loc.E2A, loc.E2B, loc.E3A, loc.E2LATE].sort())
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'location', p_id: loc.E3B })).error).toBeNull()
    expect(await camsOf(mixed)).toEqual(mixedAll)
  })

  it('scope ids of another organisation are refused for region, cluster and recorder grants', async () => {
    const otherOrg = await createOrg()
    try {
      const r = await createRegion(otherOrg)
      const c = await createCluster(otherOrg, r)
      const l = await createLocation(otherOrg, { clusterId: c })
      const x = await createRecorder(otherOrg, l)
      for (const [kind, id] of [['region', r], ['cluster', c], ['recorder', x], ['location', l]] as const) {
        const res = await admin().rpc('grant_access', { p_org: orgId, p_user: target.id, p_grants: [{ capability: 'cctv.live', scope_kind: kind, scope_id: id }] })
        expect(res.error?.message, kind).toMatch(/scope outside organisation/)
        const viaEditor = await admin().rpc('apply_access_change', { p_org: orgId, p_user: target.id, p_actor: regionAdmin.id, p_changes: [{ op: 'grant', capability: 'cctv.live', scope_kind: kind, scope_id: id }] })
        expect(viaEditor.error, `${kind} via the editor`).not.toBeNull()
      }
      expect((await admin().from('access_grants').select('id').eq('user_id', target.id).in('scope_id', [r, c, x, l])).data).toEqual([])
    } finally {
      await cleanupOrg(otherOrg)
    }
  })

  it('the scope-kind matrix of the catalogue: refused and accepted pairs; the typed column mirrors the scope id', async () => {
    const g = (capability: string, scope_kind: string, scope_id: string | null) =>
      admin().rpc('grant_access', { p_org: orgId, p_user: target.id, p_grants: [{ capability, scope_kind, scope_id }] })
    for (const [cap, kind, id] of [
      ['admin.users', 'region', east], ['it.inventory.view', 'camera', cams.E1A[0]], ['cctv.live', 'asset', assets.E1A], ['wifi.inventory.view', 'recorder', rec.E1A.r1],
      ['admin.inventory', 'cluster', cl.E1],
    ] as const) {
      expect((await g(cap, kind, id)).error?.message, `${cap} at ${kind}`).toMatch(/scope kind not allowed/)
    }
    for (const [cap, kind, id] of [
      ['cctv.live', 'region', east], ['cctv.playback', 'cluster', cl.E2], ['cctv.live', 'recorder', rec.E2A.r1], ['it.monitoring.view', 'recorder', rec.E2A.r2],
      ['it.inventory.view', 'region', west], ['wifi.inventory.view', 'cluster', cl.W1],
    ] as const) {
      expect((await g(cap, kind, id)).error, `${cap} at ${kind}`).toBeNull()
    }
    const rows = (await admin().from('access_grants').select('scope_kind, scope_id, region_id, cluster_id, recorder_id, location_id').eq('user_id', target.id)).data!
    for (const r of rows) {
      expect(r[`${r.scope_kind}_id` as 'region_id' | 'cluster_id' | 'recorder_id'], r.scope_kind).toBe(r.scope_id)
      expect(r.location_id).toBeNull()
    }
    const caps = (await admin().from('capabilities').select('key, scope_kinds')).data!
    const kinds = new Map(caps.map((c) => [c.key, c.scope_kinds]))
    expect(kinds.get('cctv.live')).toEqual(['organization', 'region', 'cluster', 'location', 'recorder', 'camera'])
    expect(kinds.get('it.os.deploy')).toEqual(['organization', 'region', 'cluster', 'location', 'recorder', 'asset'])
    expect(kinds.get('wifi.profile.edit')).toEqual(['organization', 'region', 'cluster', 'location', 'asset'])
    expect(kinds.get('admin.audit.read')).toEqual(['organization'])
  })

  it('grantor rule: a cluster holder gives inside the cluster only, never a region; a region holder gives clusters of the region', async () => {
    const put = (actor: TestUser, scope_kind: string, scope_id: string) =>
      admin().rpc('apply_access_change', { p_org: orgId, p_user: target.id, p_actor: actor.id, p_changes: [{ op: 'grant', capability: 'cctv.live', scope_kind, scope_id }] })
    expect((await put(clusterAdmin, 'location', loc.E1A)).error).toBeNull()
    expect((await put(clusterAdmin, 'camera', cams.E1B[3])).error).toBeNull()
    expect((await put(clusterAdmin, 'recorder', rec.E1A.r2)).error).toBeNull()
    expect((await put(clusterAdmin, 'cluster', cl.E1)).error).toBeNull()
    expect((await put(clusterAdmin, 'location', loc.E2A)).error?.message).toMatch(/not held by the acting person/)
    expect((await put(clusterAdmin, 'cluster', cl.E2)).error?.message).toMatch(/not held by the acting person/)
    expect((await put(clusterAdmin, 'region', east)).error?.message).toMatch(/not held by the acting person/)
    expect((await put(regionAdmin, 'cluster', cl.E3)).error).toBeNull()
    expect((await put(regionAdmin, 'region', east)).error).toBeNull()
    expect((await put(regionAdmin, 'cluster', cl.W1)).error?.message).toMatch(/not held by the acting person/)
    expect((await put(regionAdmin, 'location', loc.LOOSE)).error?.message).toMatch(/not held by the acting person/)
  })

  it('the preview counts cluster and region grants by their expansion', async () => {
    const other = await createUser(orgId, 'user')
    const r = (await admin().rpc('preview_access_change', { p_org: orgId, p_user: other.id, p_changes: [{ op: 'grant', capability: 'cctv.live', scope_kind: 'cluster', scope_id: cl.W1 }] })).data as {
      capabilities: Record<string, { added_count: number; target: string }>
    }
    expect(r.capabilities['cctv.live']).toMatchObject({ added_count: cams.W1A.length + cams.W1B.length, target: 'camera' })
    const ancestry = (await admin().rpc('access_target_ancestry', { p_org: orgId, p_targets: [{ kind: 'camera', id: cams.W1A[0] }, { kind: 'cluster', id: cl.W1 }] })).data as {
      kind: string; id: string; region_id: string | null; cluster_id: string | null; location_id: string | null
    }[]
    expect(ancestry.find((a) => a.kind === 'camera')).toMatchObject({ region_id: west, cluster_id: cl.W1, location_id: loc.W1A })
    expect(ancestry.find((a) => a.kind === 'cluster')).toMatchObject({ region_id: west, cluster_id: cl.W1, location_id: null })
  })
})
