import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGroup, addCameras } from '@/lib/groups/service'
import { getVisibleGroup, listStoreCamerasForGroups, listVisibleGroups } from '@/lib/queries/groups'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()

async function addStore(orgId: string, code: string, isActive = true): Promise<string> {
  const { data, error } = await admin().from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'viewer', is_active: isActive }).select('id').single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}
async function addCamera(orgId: string, storeId: string, channel: number, name: string, isActive = true): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, store_id: storeId, channel, name, is_active: isActive }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}
async function grant(userId: string, stores: string[]) {
  const { error } = await admin().rpc('replace_user_access', { p_user: userId, p_stores: stores, p_zones: [], p_cameras: [] })
  if (error) throw new Error(`grant: ${error.message}`)
}

describe('group queries', () => {
  let orgId: string, otherOrg: string
  let sA: string, sB: string, sOff: string
  let a1: string, a2: string, b1: string, offCam: string, offStoreCam: string
  let adminUser: TestUser, viewerA: TestUser, viewerNone: TestUser, outsider: TestUser, agent: TestUser
  let wide: string, empty: string

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    sA = await addStore(orgId, 'QA')
    sB = await addStore(orgId, 'QB')
    sOff = await addStore(orgId, 'QOFF', false)
    a1 = await addCamera(orgId, sA, 2, 'Till')
    a2 = await addCamera(orgId, sA, 1, 'Door')
    b1 = await addCamera(orgId, sB, 1, 'Yard')
    offCam = await addCamera(orgId, sA, 3, 'Switched off', false)
    offStoreCam = await addCamera(orgId, sOff, 1, 'Closed store camera')
    adminUser = await createUser(orgId, 'admin')
    agent = await createUser(orgId, 'agent')
    viewerA = await createUser(orgId, 'user')
    viewerNone = await createUser(orgId, 'user')
    outsider = await createUser(otherOrg, 'admin')
    await grant(viewerA.id, [sA, sOff])
    await grant(agent.id, [sA])
    const actor = { id: adminUser.id, orgId, role: 'admin' as const }
    const deps = { admin: admin(), rls: adminUser.client }
    const g = await createGroup(deps, actor, 'Wide')
    if (!g.ok) throw new Error(g.error)
    wide = g.groupId
    const add = await addCameras(deps, actor, wide, [a1, a2, b1, offCam, offStoreCam])
    if (!add.ok) throw new Error(add.error)
    const e = await createGroup({ admin: admin(), rls: agent.client }, { id: agent.id, orgId, role: 'agent' }, 'Empty one')
    if (!e.ok) throw new Error(e.error)
    empty = e.groupId
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('lists the groups a person may see with the number of working cameras they can see', async () => {
    expect(await listVisibleGroups(adminUser.client)).toEqual([
      { id: empty, name: 'Empty one', created_by: agent.id, camera_count: 0 },
      { id: wide, name: 'Wide', created_by: adminUser.id, camera_count: 3 }, // switched-off camera and closed store left out
    ])
    // Store A only: the viewer also holds the closed store, whose camera is not counted.
    expect(await listVisibleGroups(viewerA.client)).toEqual([{ id: wide, name: 'Wide', created_by: adminUser.id, camera_count: 2 }])
    // An operator sees the group they made while it is still empty, and the wide group through store A.
    expect((await listVisibleGroups(agent.client)).map((g) => [g.name, g.camera_count])).toEqual([['Empty one', 0], ['Wide', 2]])
    expect(await listVisibleGroups(viewerNone.client)).toEqual([])
    expect(await listVisibleGroups(outsider.client)).toEqual([])
  })

  it('shows one group with its cameras in store and channel order; nothing for a stranger or a bad id', async () => {
    const asAdmin = await getVisibleGroup(adminUser.client, wide)
    expect(asAdmin?.name).toBe('Wide')
    expect(asAdmin?.cameras.map((c) => [c.store_code, c.channel, c.name])).toEqual([['QA', 1, 'Door'], ['QA', 2, 'Till'], ['QB', 1, 'Yard']])
    expect(asAdmin?.cameras.map((c) => c.id)).toEqual([a2, a1, b1])
    const asViewer = await getVisibleGroup(viewerA.client, wide)
    expect(asViewer?.cameras.map((c) => c.id)).toEqual([a2, a1])
    expect((await getVisibleGroup(agent.client, empty))?.cameras).toEqual([])
    expect(await getVisibleGroup(viewerNone.client, wide)).toBeNull()
    expect(await getVisibleGroup(outsider.client, wide)).toBeNull()
    expect(await getVisibleGroup(adminUser.client, 'not-a-uuid')).toBeNull()
    expect(await getVisibleGroup(adminUser.client, '00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('lists the visible, working cameras of one store, marking the ones already in the group', async () => {
    const list = await listStoreCamerasForGroups(agent.client, sA, wide)
    expect(list?.map((c) => [c.channel, c.name, c.in_group])).toEqual([[1, 'Door', true], [2, 'Till', true]])
    const other = await listStoreCamerasForGroups(agent.client, sA, empty)
    expect(other?.map((c) => c.in_group)).toEqual([false, false])
    // A store the person cannot see, a switched-off store and a bad id give nothing, not an error.
    expect(await listStoreCamerasForGroups(agent.client, sB, wide)).toBeNull()
    expect(await listStoreCamerasForGroups(viewerA.client, sOff, wide)).toBeNull()
    expect(await listStoreCamerasForGroups(agent.client, 'nope', wide)).toBeNull()
  })
})
