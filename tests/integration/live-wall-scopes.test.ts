import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCapabilities } from '@/lib/auth/capabilities'
import { treeLocations } from '@/lib/live/tree'
import { getLiveScope } from '@/lib/queries/live'
import { loadLiveLanding } from '@/lib/queries/live-landing'
import {
  adminClient, atCluster, atLocation, atRegion, CCTV_VIEW, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion,
  createUser, grant, ORG_SCOPE, type TestUser,
} from '../setup/fixtures'

// P4-L1 brief items 1-3 and 5 (permission scenarios): walls for a region, a cluster, a location, an NVR, a saved group (static or
// dynamic) and one camera, and the Live landing's tree, each read as the person: a cluster viewer sees exactly that cluster's cameras
// and roll-ups; two people with different scopes see different things; a dynamic group never widens anybody's access; a CCTV-only
// viewer gets no NVR at all (no NVR wall, no NVR rows, no NVR names, no addresses) and "Recorder not reachable" in camera words;
// archived and switched-off places and cameras vanish. Nothing here contacts an NVR (the addresses are documentation addresses).

const admin = () => adminClient()

describe('Live walls and the Live landing, as the person (P4-L1)', () => {
  let orgId: string
  let R1: string, R2: string, C1: string, C2: string, C3: string, L1: string, L2: string, L3: string, L0: string, Loff: string
  let N1: string, N2: string, N3: string, N4: string, N5: string
  let c1: string, c2: string, c3: string, c4: string, c5: string, c6: string, cOff: string
  let clusterViewer: TestUser, regionTwo: TestUser, locIt: TestUser, everything: TestUser
  let dynGroup: string, staticGroup: string

  const caps = (u: TestUser) => readCapabilities(u.client)
  const ids = (s: Awaited<ReturnType<typeof getLiveScope>>) => (s ? s.cameras.map((c) => c.id) : null)

  beforeAll(async () => {
    orgId = await createOrg()
    R1 = await createRegion(orgId, { code: 'RONE', name: 'Region One' })
    R2 = await createRegion(orgId, { code: 'RTWO', name: 'Region Two' })
    C1 = await createCluster(orgId, R1, { code: 'CONE', name: 'Cluster One' })
    C2 = await createCluster(orgId, R1, { code: 'CTWO', name: 'Cluster Two' })
    C3 = await createCluster(orgId, R2, { code: 'CTHREE', name: 'Cluster Three' })
    L1 = await createLocation(orgId, { code: 'LONE', name: 'Location One', clusterId: C1 })
    L2 = await createLocation(orgId, { code: 'LTWO', name: 'Location Two', clusterId: C2 })
    L3 = await createLocation(orgId, { code: 'LTHREE', name: 'Location Three', clusterId: C3 })
    L0 = await createLocation(orgId, { code: 'LZERO', name: 'Head office' })
    Loff = await createLocation(orgId, { code: 'LOFF', name: 'Closed location', clusterId: C1, isActive: false })
    N1 = await createRecorder(orgId, L1, { host: '192.0.2.11', name: 'NVR alpha', username: 'alpha-login' })
    N2 = await createRecorder(orgId, L1, { host: '192.0.2.12', name: 'NVR beta' })
    N3 = await createRecorder(orgId, L2, { host: '192.0.2.13' })
    N4 = await createRecorder(orgId, L3, { host: '192.0.2.14' })
    N5 = await createRecorder(orgId, L0, { host: '192.0.2.15' })
    const nOff = await createRecorder(orgId, Loff, { host: '192.0.2.16' })
    c1 = await createCamera(orgId, { locationId: L1, recorderId: N1, channel: 1, name: 'Front door' })
    c2 = await createCamera(orgId, { locationId: L1, recorderId: N1, channel: 2, name: 'Cash desk' })
    c3 = await createCamera(orgId, { locationId: L1, recorderId: N2, channel: 1, name: 'Back door' })
    c4 = await createCamera(orgId, { locationId: L2, recorderId: N3, channel: 1, name: 'Door two' })
    c5 = await createCamera(orgId, { locationId: L3, recorderId: N4, channel: 1, name: 'Door three' })
    c6 = await createCamera(orgId, { locationId: L0, recorderId: N5, channel: 1, name: 'Reception' })
    cOff = await createCamera(orgId, { locationId: Loff, recorderId: nOff, channel: 1, name: 'Door closed' })
    const at = new Date().toISOString()
    for (const [id, status, method, error] of [
      [c1, 'up', null, null], [c2, 'down', 'rtsp', 'RTSP refused by 192.0.2.11 for alpha-login'], [c3, 'down', 'nvr_down', 'The NVR is not reachable.'],
      [N1, 'up', null, null], [N2, 'down', 'tcp', 'No answer from 192.0.2.12:80'],
    ] as const) {
      const type = id === N1 || id === N2 ? 'recorder' : 'camera'
      const { error: e } = await admin().from('check_state').insert({ org_id: orgId, target_type: type, target_id: id, status, last_checked_at: at, down_since: status === 'down' ? at : null, method, error })
      if (e) throw new Error(e.message)
    }
    clusterViewer = await createUser(orgId, 'operator')
    await grant(orgId, clusterViewer.id, CCTV_VIEW, atCluster(C1))
    regionTwo = await createUser(orgId, 'user')
    await grant(orgId, regionTwo.id, CCTV_VIEW, atRegion(R2))
    locIt = await createUser(orgId, 'user')
    await grant(orgId, locIt.id, [...CCTV_VIEW, 'it.monitoring.view'], atLocation(L1))
    everything = await createUser(orgId, 'admin')
    await grant(orgId, everything.id, ['cctv.live', 'cctv.playback', 'it.inventory.view', 'admin.inventory'], ORG_SCOPE)
    // A dynamic group (every camera of region One) and a static group (cameras of Location Two and Location Three), made by the admin.
    const g1 = await admin().from('camera_groups').insert({ org_id: orgId, name: 'Region One doors', created_by: everything.id }).select('id').single()
    dynGroup = g1.data!.id
    const rule = await admin().from('camera_group_rules').insert({ org_id: orgId, group_id: dynGroup, kind: 'region', ref_id: R1, created_by: everything.id })
    if (rule.error) throw new Error(rule.error.message)
    const g2 = await admin().from('camera_groups').insert({ org_id: orgId, name: 'Elsewhere', created_by: everything.id }).select('id').single()
    staticGroup = g2.data!.id
    const items = await admin().from('camera_group_items').insert([{ org_id: orgId, group_id: staticGroup, camera_id: c4 }, { org_id: orgId, group_id: staticGroup, camera_id: c5 }])
    if (items.error) throw new Error(items.error.message)
  })
  afterAll(() => cleanupOrg(orgId))

  it('a cluster viewer: region and cluster walls hold exactly their cluster\'s cameras; another cluster is "not found"', async () => {
    const s = clusterViewer.client
    // One order everywhere: location code, channel, name (two NVRs of one location both have a channel 1).
    expect(ids(await getLiveScope(s, { region: R1 }, 'cctv.live'))).toEqual([c3, c1, c2])
    expect(ids(await getLiveScope(s, { cluster: C1 }, 'cctv.live'))).toEqual([c3, c1, c2])
    expect(await getLiveScope(s, { cluster: C2 }, 'cctv.live')).toBeNull()
    expect(await getLiveScope(s, { region: R2 }, 'cctv.live')).toBeNull()
    expect(ids(await getLiveScope(s, { store: L1 }, 'cctv.live'))).toEqual([c3, c1, c2])
    expect(await getLiveScope(s, { store: L2 }, 'cctv.live')).toBeNull()
    expect(ids(await getLiveScope(s, { camera: c2 }, 'cctv.live'))).toEqual([c2])
    expect(await getLiveScope(s, { camera: c4 }, 'cctv.live')).toBeNull()
    const region = await getLiveScope(s, { region: R1 }, 'cctv.live')
    expect(region).toMatchObject({ kind: 'region', title: 'RONE · Region One', multiLocation: false })
    expect(region!.cameras.map((c) => c.locationId)).toEqual([L1, L1, L1])
  })

  it('two people with different scopes: the region wall of one is "not found" for the other', async () => {
    expect(ids(await getLiveScope(regionTwo.client, { region: R2 }, 'cctv.live'))).toEqual([c5])
    expect(await getLiveScope(regionTwo.client, { region: R1 }, 'cctv.live')).toBeNull()
    expect(await getLiveScope(clusterViewer.client, { region: R2 }, 'cctv.live')).toBeNull()
  })

  it('NVR walls need the IT view of that NVR: none for a CCTV-only viewer, exactly the NVR\'s cameras with it', async () => {
    expect(await getLiveScope(clusterViewer.client, { nvr: N1 }, 'cctv.live')).toBeNull()
    expect(ids(await getLiveScope(locIt.client, { nvr: N1 }, 'cctv.live'))).toEqual([c1, c2])
    expect(ids(await getLiveScope(locIt.client, { nvr: N2 }, 'cctv.live'))).toEqual([c3])
    expect(await getLiveScope(locIt.client, { nvr: N4 }, 'cctv.live')).toBeNull()
    expect((await getLiveScope(locIt.client, { nvr: N1 }, 'cctv.live'))?.title).toBe('LONE · NVR alpha')
  })

  it('a dynamic group never widens: its wall holds only the members the viewer may watch; a group with none is "not found"', async () => {
    expect(ids(await getLiveScope(clusterViewer.client, { group: dynGroup }, 'cctv.live'))).toEqual([c3, c1, c2])
    expect(ids(await getLiveScope(everything.client, { group: dynGroup }, 'cctv.live'))?.sort()).toEqual([c1, c2, c3, c4].sort())
    expect(await getLiveScope(regionTwo.client, { group: dynGroup }, 'cctv.live')).toBeNull()
    expect(await getLiveScope(clusterViewer.client, { group: staticGroup }, 'cctv.live')).toBeNull()
    expect(ids(await getLiveScope(regionTwo.client, { group: staticGroup }, 'cctv.live'))).toEqual([c5])
    // The chooser counts what the viewer can actually watch.
    const landing = await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), {})
    expect(landing.groups).toEqual([{ id: dynGroup, name: 'Region One doors', camera_count: 3, created_by: everything.id }])
  })

  it('the Live landing tree: the cluster viewer\'s own Region → Cluster → Location, with its roll-up; nothing else', async () => {
    const landing = await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), {})
    expect(landing.tree.regions.map((r) => r.code)).toEqual(['RONE'])
    expect(landing.tree.regions[0].clusters.map((c) => c.code)).toEqual(['CONE'])
    expect(landing.tree.regions[0].clusters[0].locations.map((l) => l.code)).toEqual(['LONE'])
    expect(landing.tree.clusters).toEqual([])
    expect(landing.tree.locations).toEqual([])
    expect(landing.tree.regions[0].counts).toMatchObject({ total: 3, live: 1, offline: 1, recorderUnreachable: 1 })
    expect(landing.tree.regions[0].recorders).toBeNull()
    expect(landing.totals).toMatchObject({ total: 3, live: 1, offline: 1, recorderUnreachable: 1 })
    // Everybody else's tree is their own.
    const other = await loadLiveLanding(regionTwo.client, await caps(regionTwo), {})
    expect(treeLocations(other.tree).map((l) => l.code)).toEqual(['LTHREE'])
    const all = await loadLiveLanding(everything.client, await caps(everything), {})
    expect(treeLocations(all.tree).map((l) => l.code).sort()).toEqual(['LONE', 'LTHREE', 'LTWO', 'LZERO'])
    expect(all.tree.locations.map((l) => l.code)).toEqual(['LZERO']) // no cluster: listed on its own, no bucket
  })

  it('search finds locations by code or name and cameras by name, only among what the viewer may watch', async () => {
    const byCode = await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), { q: 'lone' })
    expect(treeLocations(byCode.tree).map((l) => l.code)).toEqual(['LONE'])
    const doors = await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), { q: 'door' })
    expect(doors.cameraMatches.map((c) => c.name)).toEqual(['Back door', 'Front door'])
    expect(doors.cameraMatches.every((c) => c.locationCode === 'LONE')).toBe(true)
    const theirs = await loadLiveLanding(everything.client, await caps(everything), { q: 'door' })
    expect(theirs.cameraMatches.map((c) => c.name)).toEqual(['Back door', 'Door three', 'Door two', 'Front door'])
    const wild = await loadLiveLanding(everything.client, await caps(everything), { q: '%' })
    expect(wild.cameraMatches).toEqual([]) // a wildcard is a plain character
  })

  it('opening a location in the tree: its cameras with honest states; NVRs only with the IT view', async () => {
    const cctv = await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), { open: L1 })
    expect(cctv.branch?.recorders).toBeNull()
    expect(cctv.branch?.cameras.map((c) => [c.name, c.state])).toEqual([['Back door', 'unreachable'], ['Front door', 'live'], ['Cash desk', 'offline']])
    const it = await loadLiveLanding(locIt.client, await caps(locIt), { open: L1 })
    expect(it.branch?.recorders?.map((r) => [r.name, r.status, r.cameraIds.length])).toEqual([['NVR alpha', 'up', 2], ['NVR beta', 'down', 1]])
    expect(await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), { open: L2 }).then((l) => l.branch)).toBeNull()
  })

  it('a CCTV-only viewer is told nothing about NVRs: no NVR name, address, login or checker\'s words anywhere', async () => {
    const s = clusterViewer.client
    const texts = [
      JSON.stringify(await getLiveScope(s, { region: R1 }, 'cctv.live')),
      JSON.stringify(await getLiveScope(s, { group: dynGroup }, 'cctv.live')),
      JSON.stringify(await loadLiveLanding(s, await caps(clusterViewer), { open: L1, q: 'o' })),
    ]
    for (const t of texts) for (const secret of ['NVR alpha', 'NVR beta', '192.0.2.', 'alpha-login', 'RTSP refused', 'No answer from', N1, N2]) expect(t).not.toContain(secret)
  })

  it('archived cameras and switched-off locations vanish from every wall and the tree', async () => {
    expect(await getLiveScope(everything.client, { store: Loff }, 'cctv.live')).toBeNull()
    expect(await getLiveScope(everything.client, { camera: cOff }, 'cctv.live')).toBeNull()
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: c2 })).error).toBeNull()
    expect(ids(await getLiveScope(clusterViewer.client, { cluster: C1 }, 'cctv.live'))).toEqual([c3, c1])
    expect(ids(await getLiveScope(clusterViewer.client, { group: dynGroup }, 'cctv.live'))).toEqual([c3, c1])
    const landing = await loadLiveLanding(clusterViewer.client, await caps(clusterViewer), {})
    expect(landing.totals.total).toBe(2)
    expect(c6).toBeTruthy()
  })
})
