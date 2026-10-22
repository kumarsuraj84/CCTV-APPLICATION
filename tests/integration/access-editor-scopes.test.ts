// P2-5c-1 brief item 5 (ruling C-1): the access editor's scope modes "A region", "A cluster" and "NVR(s)" next to locations and
// cameras, through the same preview (preview_access_change) and save (apply_access_change) as every other grant. A plain administrator
// may give a region / cluster / NVR scope only when they hold the right at an equal or wider scope (checked by the editor, the Server
// Action and the database; the refusal is a plain sentence).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyChange, loadEditor, previewChange, type AccessChange } from '@/lib/admin/access'
import type { Actor } from '@/lib/admin/types'
import {
  adminClient, atCluster, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion, createUser, grant, type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const versionOf = async (id: string) => Number((await admin().from('profiles').select('access_version').eq('id', id).single()).data!.access_version)
type Kind = 'organization' | 'region' | 'cluster' | 'location' | 'recorder' | 'camera' | 'asset'
const g = (capability: string, scope_kind: Kind, scope_id: string | null): AccessChange => ({ op: 'grant', capability, scope_kind, scope_id, valid_until: null, reason: '' })

describe('access editor: region, cluster and NVR scopes', () => {
  let org: string
  let R: string, C: string, L1: string, L2: string, rec1: string, rec1b: string
  let c1: string, c2: string, c3: string, c4: string
  let owner: Actor, clusterAdmin: Actor
  let viewer: TestUser, viewer2: TestUser

  async function save(actor: Actor, userId: string, changes: AccessChange[]) {
    const p = await previewChange(admin(), actor, userId, { changes, expectedVersion: await versionOf(userId) })
    if (!p.ok) return p
    return applyChange(admin(), actor, userId, { changes, expectedVersion: p.version, token: p.token })
  }
  const can = async (u: TestUser, kind: 'camera' | 'location', id: string) => (await u.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: kind, p_id: id })).data

  beforeAll(async () => {
    org = await createOrg()
    R = await createRegion(org, { name: 'East' })
    C = await createCluster(org, R, { name: 'Patna' })
    L1 = await createLocation(org, { code: 'SC1', clusterId: C })
    L2 = await createLocation(org, { code: 'SC2' })
    rec1 = await createRecorder(org, L1, { name: 'Ground', host: '192.0.2.21' })
    rec1b = await createRecorder(org, L1, { name: 'First floor', host: '192.0.2.22' })
    c1 = await createCamera(org, { locationId: L1, recorderId: rec1, channel: 1 })
    c2 = await createCamera(org, { locationId: L1, recorderId: rec1b, channel: 1 })
    c3 = await createCamera(org, { locationId: L2, recorderId: await createRecorder(org, L2, { host: '192.0.2.23' }), channel: 1 })
    c4 = await createCamera(org, { locationId: L1, recorderId: rec1, channel: 2 })
    const o = await createUser(org, 'platform_owner')
    await grant(org, o.id, ['admin.access', 'admin.users'])
    owner = { id: o.id, orgId: org, role: 'platform_owner' }
    const ca = await createUser(org, 'admin')
    await grant(org, ca.id, ['admin.access', 'admin.users'])
    await grant(org, ca.id, ['cctv.live'], atCluster(C))
    clusterAdmin = { id: ca.id, orgId: org, role: 'admin' }
    viewer = await createUser(org, 'user')
    viewer2 = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  it('the editor offers the regions, clusters and NVRs of the organisation, with plain labels', async () => {
    const data = await loadEditor(admin(), owner, viewer.id)
    expect(data).not.toBeNull()
    expect(data!.regions.map((x) => [x.id, x.name])).toEqual([[R, 'East']])
    expect(data!.clusters.map((x) => [x.id, x.name, x.region_id])).toEqual([[C, 'Patna', R]])
    expect(data!.recorders.filter((x) => x.location_id === L1).map((x) => [x.id, x.name]).sort()).toEqual([[rec1, 'Ground'], [rec1b, 'First floor']].sort())
  })

  it('a region grant previews and saves like any other grant and covers every camera below it', async () => {
    const p = await previewChange(admin(), owner, viewer.id, { changes: [g('cctv.live', 'region', R)], expectedVersion: await versionOf(viewer.id) })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.capabilities.find((x) => x.capability === 'cctv.live')?.added).toBe(3)
    const code = (await admin().from('regions').select('code').eq('id', R).single()).data!.code
    expect(p.lines).toEqual([expect.objectContaining({ op: 'grant', scopeKind: 'region', scopeLabel: `Region ${code} · East` })])
    expect((await applyChange(admin(), owner, viewer.id, { changes: [g('cctv.live', 'region', R)], expectedVersion: p.version, token: p.token })).ok).toBe(true)
    expect([await can(viewer, 'camera', c1), await can(viewer, 'camera', c2), await can(viewer, 'camera', c4), await can(viewer, 'camera', c3)]).toEqual([true, true, true, false])
  })

  it('an NVR grant covers exactly the cameras on that NVR; a cluster grant the cluster’s locations', async () => {
    expect((await save(owner, viewer2.id, [g('cctv.live', 'recorder', rec1)])).ok).toBe(true)
    expect([await can(viewer2, 'camera', c1), await can(viewer2, 'camera', c4), await can(viewer2, 'camera', c2)]).toEqual([true, true, false])
    expect(await can(viewer2, 'location', L1)).toBe(false)
    expect((await save(owner, viewer2.id, [g('cctv.playback', 'cluster', C)])).ok).toBe(true)
    expect((await viewer2.client.rpc('has_capability_for', { p_cap: 'cctv.playback', p_kind: 'location', p_id: L1 })).data).toBe(true)
  })

  it('a plain administrator gives a cluster, its locations or its NVRs (held at the cluster) but not the region above it', async () => {
    const someone = await createUser(org, 'user')
    expect((await save(clusterAdmin, someone.id, [g('cctv.live', 'cluster', C)])).ok).toBe(true)
    expect((await save(clusterAdmin, someone.id, [g('cctv.live', 'recorder', rec1b)])).ok).toBe(true)
    expect(await save(clusterAdmin, someone.id, [g('cctv.live', 'region', R)])).toEqual({ ok: false, error: 'You can only give rights you hold yourself, for the same places: “Watch live video”.' })
    expect(await save(clusterAdmin, someone.id, [g('cctv.live', 'location', L2)])).toEqual({ ok: false, error: 'You can only give rights you hold yourself, for the same places: “Watch live video”.' })
  })
})
