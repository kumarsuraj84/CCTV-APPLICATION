import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { addCameras, createGroup, previewCamerasByKeyword, removeCameras } from '@/lib/groups/service'
import { adminClient, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createSite, createUser, grant, type TestUser } from '../setup/fixtures'

// Release 1 final clean-up (review C M-20): "Add by name" shows what it would add before anything changes, adds exactly the cameras
// shown, and the addition can be undone at once (only the cameras that this addition put in the group are taken out again).

const admin = () => adminClient()
const deps = (u: TestUser) => ({ admin: admin(), rls: u.client })

async function addCamera(orgId: string, locationId: string, channel: number, name: string): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: locationId, channel, name }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}
const items = async (u: TestUser, groupId: string) =>
  ((await u.client.from('camera_group_items').select('camera_id').eq('group_id', groupId)).data ?? []).map((r) => r.camera_id).sort()

describe('camera groups: "Add by name" preview and undo (final clean-up, C M-20)', () => {
  let orgId: string
  let operator: TestUser, viewer: TestUser
  let actor: Actor
  let a1: string, a2: string, a3: string, b1: string
  beforeAll(async () => {
    orgId = await createOrg()
    const sA = (await createSite(orgId, { code: 'PVA', host: '127.0.0.1', username: 'viewer' })).locationId
    const sB = (await createSite(orgId, { code: 'PVB', host: '127.0.0.1', username: 'viewer' })).locationId
    a1 = await addCamera(orgId, sA, 1, 'Front Door')
    a2 = await addCamera(orgId, sA, 2, 'Back door')
    a3 = await addCamera(orgId, sA, 3, 'Till')
    b1 = await addCamera(orgId, sB, 1, 'Side door') // not visible to the operator
    operator = await createUser(orgId, 'operator')
    await grant(orgId, operator.id, CCTV_VIEW, [atLocation(sA)])
    viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, CCTV_VIEW, [atLocation(sA)])
    actor = { id: operator.id, orgId, role: 'operator' }
  })
  afterAll(() => cleanupOrg(orgId))

  it('the preview lists the cameras the person may watch live that are not in the group yet, and changes nothing', async () => {
    const made = await createGroup(deps(operator), actor, 'Preview group')
    if (!made.ok) throw new Error(made.error)
    await addCameras(deps(operator), actor, made.groupId, [a2])
    const p = await previewCamerasByKeyword(deps(operator), actor, made.groupId, 'DOOR')
    expect(p).toEqual({ ok: true, cameras: [{ id: a1, name: 'Front Door' }], truncated: false })
    expect(await items(operator, made.groupId)).toEqual([a2])
    expect(JSON.stringify(p)).not.toContain(b1)
    expect((await previewCamerasByKeyword(deps(operator), actor, made.groupId, '  ')).ok).toBe(false)
    expect((await previewCamerasByKeyword(deps(viewer), { id: viewer.id, orgId, role: 'user' }, made.groupId, 'door')).ok).toBe(false)
  })

  it('adding the previewed cameras says which ones went in; undo takes out exactly those (not the ones already there)', async () => {
    const made = await createGroup(deps(operator), actor, 'Undo group')
    if (!made.ok) throw new Error(made.error)
    await addCameras(deps(operator), actor, made.groupId, [a2])
    const added = await addCameras(deps(operator), actor, made.groupId, [a1, a2, a3], { returnIds: true })
    expect(added).toEqual({ ok: true, added: 2, ids: [a1, a3].sort() })
    expect(await items(operator, made.groupId)).toEqual([a1, a2, a3].sort())
    const undone = await removeCameras(deps(operator), actor, made.groupId, added.ok ? added.ids! : [])
    expect(undone).toEqual({ ok: true, removed: 2 })
    expect(await items(operator, made.groupId)).toEqual([a2])
    // Never a camera the person may not watch live (or another organisation's): nothing is taken out.
    expect(await removeCameras(deps(operator), actor, made.groupId, [a2, b1])).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
    expect(await items(operator, made.groupId)).toEqual([a2])
    const { data: audit } = await admin().from('admin_audit_log').select('action, detail').eq('org_id', orgId).eq('entity_id', made.groupId).eq('action', 'group_camera_removed')
    expect(audit).toHaveLength(1)
    expect(audit![0].detail).toMatchObject({ count: 2 })
  })
})
