// P2-5c-1 brief item 6 (ruling C-1, Release 1 item 3): camera groups with DYNAMIC rules (region / cluster / location / NVR / name)
// next to the static camera list. A rule is resolved when the group is read and is always intersected with what the reader may see:
// a dynamic group never widens anybody's access. Adding a rule for a place needs live view of that WHOLE place (as adding a camera
// needs live view of that camera), so a rule can neither probe nor reveal places the editor cannot see.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { addGroupRule, createGroup, listGroupRules, removeGroupRule } from '@/lib/groups/service'
import { getVisibleGroup, listVisibleGroups } from '@/lib/queries/groups'
import { readCapabilities } from '@/lib/auth/capabilities'
import {
  adminClient, atLocation, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion, createUser, grant, type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: string[]) => [...a].sort()
const ids = (g: { cameras: { id: string }[] } | null) => sorted((g?.cameras ?? []).map((c) => c.id))

describe('camera groups with dynamic rules', () => {
  let orgId: string
  let otherOrg: string
  let regionId: string, clusterId: string
  let L1: string, L2: string, L3: string, rec3: string
  let l1e: string, l1t: string, l2e: string, l2t: string, l3e: string, l3t: string
  let boss: TestUser, viewer1: TestUser, viewer3: TestUser, nobody: TestUser, opL1: TestUser
  let bossActor: Actor
  const deps = (u: TestUser) => ({ admin: admin(), rls: u.client })

  async function site(code: string, cluster: string | null) {
    const loc = await createLocation(orgId, { code, clusterId: cluster })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 1000 + Math.floor(Math.random() * 50000) })
    const e = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1, name: `${code} Entrance` })
    const t = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2, name: `${code} Till` })
    return { loc, rec, e, t }
  }

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    regionId = await createRegion(orgId)
    clusterId = await createCluster(orgId, regionId)
    const s1 = await site('DG1', clusterId)
    const s2 = await site('DG2', clusterId)
    const s3 = await site('DG3', null)
    ;[L1, l1e, l1t] = [s1.loc, s1.e, s1.t]
    ;[L2, l2e, l2t] = [s2.loc, s2.e, s2.t]
    ;[L3, rec3, l3e, l3t] = [s3.loc, s3.rec, s3.e, s3.t]
    boss = await createUser(orgId, 'admin')
    await grant(orgId, boss.id, ['cctv.live', 'cctv.playback', 'admin.inventory', 'it.inventory.view'])
    bossActor = { id: boss.id, orgId, role: 'admin' }
    viewer1 = await createUser(orgId, 'user')
    await grant(orgId, viewer1.id, ['cctv.live'], atLocation(L1))
    viewer3 = await createUser(orgId, 'user')
    await grant(orgId, viewer3.id, ['cctv.live'], atLocation(L3))
    nobody = await createUser(orgId, 'user')
    opL1 = await createUser(orgId, 'operator')
    await grant(orgId, opL1.id, ['cctv.live'], atLocation(L1))
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('a cluster rule shows every camera of the cluster to the administrator, and to a viewer only the cameras they may see', async () => {
    const g = await createGroup(deps(boss), bossActor, 'Cluster wall')
    expect(g.ok).toBe(true)
    const groupId = g.ok ? g.groupId : ''
    const r = await addGroupRule(deps(boss), bossActor, groupId, { kind: 'cluster', refId: clusterId })
    expect(r.ok).toBe(true)
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual(sorted([l1e, l1t, l2e, l2t]))
    // Never wider than the reader's own access: viewer1 holds L1 only.
    expect(ids(await getVisibleGroup(viewer1.client, groupId))).toEqual(sorted([l1e, l1t]))
    // A person who may see none of the members does not even see the group.
    expect(await getVisibleGroup(viewer3.client, groupId)).toBeNull()
    expect(await getVisibleGroup(nobody.client, groupId)).toBeNull()
    expect((await listVisibleGroups(viewer3.client)).map((x) => x.id)).not.toContain(groupId)
    const counted = await listVisibleGroups(viewer1.client, { capabilities: await readCapabilities(viewer1.client), capability: 'cctv.live' })
    expect(counted.find((x) => x.id === groupId)?.camera_count).toBe(2)
    // Dynamic: a camera added to the cluster later is a member at once; a location moved out of the cluster stops being one.
    const added = await createCamera(orgId, { locationId: L2, channel: 3, name: 'DG2 Stock' })
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual(sorted([l1e, l1t, l2e, l2t, added]))
    expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: L2, p_cluster: null as unknown as string })).error).toBeNull()
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual(sorted([l1e, l1t]))
    expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: L2, p_cluster: clusterId })).error).toBeNull()
  })

  it('region, location, NVR and name rules (a name filter narrows a place rule); several rules add up', async () => {
    const g = await createGroup(deps(boss), bossActor, 'Mixed rules')
    const groupId = g.ok ? g.groupId : ''
    expect((await addGroupRule(deps(boss), bossActor, groupId, { kind: 'location', refId: L1, nameContains: 'entr' })).ok).toBe(true)
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual([l1e])
    expect((await addGroupRule(deps(boss), bossActor, groupId, { kind: 'recorder', refId: rec3 })).ok).toBe(true)
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual(sorted([l1e, l3e, l3t]))
    const tills = await createGroup(deps(boss), bossActor, 'All tills')
    const tillsId = tills.ok ? tills.groupId : ''
    expect((await addGroupRule(deps(boss), bossActor, tillsId, { kind: 'name', nameContains: 'TILL' })).ok).toBe(true)
    expect(ids(await getVisibleGroup(boss.client, tillsId))).toEqual(sorted([l1t, l2t, l3t]))
    expect(ids(await getVisibleGroup(viewer3.client, tillsId))).toEqual([l3t])
    const region = await createGroup(deps(boss), bossActor, 'Region wall')
    const regionGroup = region.ok ? region.groupId : ''
    expect((await addGroupRule(deps(boss), bossActor, regionGroup, { kind: 'region', refId: regionId, nameContains: 'till' })).ok).toBe(true)
    expect(ids(await getVisibleGroup(boss.client, regionGroup))).toEqual(sorted([l1t, l2t]))
    // The rules as the editor sees them, in plain words.
    const rules = await listGroupRules(deps(boss), bossActor, groupId)
    expect(rules.ok && rules.rules.map((x) => [x.kind, x.nameContains])).toEqual([['location', 'entr'], ['recorder', null]])
    // Removing a rule removes its members (the static list is untouched).
    const recRule = rules.ok ? rules.rules.find((x) => x.kind === 'recorder')!.id : ''
    expect(await removeGroupRule(deps(boss), bossActor, groupId, recRule)).toEqual({ ok: true })
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual([l1e])
  })

  // Final fix Y (review A M-5): removing a place rule needs the same right as adding it (live view of the whole place); before, any editor
  // who could see one camera of a shared group could delete a region rule another administrator had added. Name rules: as before.
  it('removing a place rule needs live view of that whole place, as adding it does', async () => {
    const g = await createGroup(deps(boss), bossActor, 'Shared wall')
    const groupId = g.ok ? g.groupId : ''
    expect((await addGroupRule(deps(boss), bossActor, groupId, { kind: 'region', refId: regionId })).ok).toBe(true)
    expect((await addGroupRule(deps(boss), bossActor, groupId, { kind: 'name', nameContains: 'till' })).ok).toBe(true)
    const op: Actor = { id: opL1.id, orgId, role: 'operator' }
    const rules = await listGroupRules(deps(opL1), op, groupId)
    expect(rules.ok).toBe(true)
    const regionRule = rules.ok ? rules.rules.find((x) => x.kind === 'region')!.id : ''
    const nameRule = rules.ok ? rules.rules.find((x) => x.kind === 'name')!.id : ''
    expect(await removeGroupRule(deps(opL1), op, groupId, regionRule)).toEqual({ ok: false, error: 'You can only remove a rule for a place where you may watch every camera live.' })
    expect((await admin().from('camera_group_rules').select('id').eq('id', regionRule)).data).toHaveLength(1)
    expect(await removeGroupRule(deps(opL1), op, groupId, nameRule)).toEqual({ ok: true })
    expect(await removeGroupRule(deps(boss), bossActor, groupId, regionRule)).toEqual({ ok: true })
  })

  it('adding a rule needs live view of the whole place; a viewer cannot change groups; ids of other organisations are not found', async () => {
    const g = await createGroup(deps(opL1), { id: opL1.id, orgId, role: 'operator' }, 'Operator group')
    const groupId = g.ok ? g.groupId : ''
    const op: Actor = { id: opL1.id, orgId, role: 'operator' }
    expect(await addGroupRule(deps(opL1), op, groupId, { kind: 'cluster', refId: clusterId })).toEqual({ ok: false, error: 'You can only add a rule for a place where you may watch every camera live.' })
    expect(await addGroupRule(deps(opL1), op, groupId, { kind: 'location', refId: L3 })).toEqual({ ok: false, error: 'You can only add a rule for a place where you may watch every camera live.' })
    expect((await addGroupRule(deps(opL1), op, groupId, { kind: 'location', refId: L1 })).ok).toBe(true)
    expect(ids(await getVisibleGroup(opL1.client, groupId))).toEqual(sorted([l1e, l1t]))
    expect((await addGroupRule(deps(viewer1), { id: viewer1.id, orgId, role: 'user' }, groupId, { kind: 'location', refId: L1 })).ok).toBe(false)
    const foreign = await createLocation(otherOrg)
    expect(await addGroupRule(deps(boss), bossActor, groupId, { kind: 'location', refId: foreign })).toEqual({ ok: false, error: 'You can only add a rule for a place where you may watch every camera live.' })
    expect(await addGroupRule(deps(boss), bossActor, groupId, { kind: 'name', nameContains: '' })).toEqual({ ok: false, error: 'Enter a word to look for in the camera names.' })
    expect(await addGroupRule(deps(boss), bossActor, groupId, { kind: 'castle' as never, refId: L1 })).toEqual({ ok: false, error: 'Choose what the rule includes.' })
  })

  it('a group with only rules is visible as empty to its maker while the rules match nothing, like an empty static group', async () => {
    const g = await createGroup(deps(boss), bossActor, 'Nothing yet')
    const groupId = g.ok ? g.groupId : ''
    expect((await addGroupRule(deps(boss), bossActor, groupId, { kind: 'name', nameContains: 'no-camera-has-this-name' })).ok).toBe(true)
    expect(ids(await getVisibleGroup(boss.client, groupId))).toEqual([])
    expect(await getVisibleGroup(viewer1.client, groupId)).toBeNull()
  })
})
