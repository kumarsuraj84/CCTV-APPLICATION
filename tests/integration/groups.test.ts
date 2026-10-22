import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { addCameras, addCamerasByKeyword, createGroup, deleteGroup, MSG_NAME_TAKEN, removeCamera, renameGroup } from '@/lib/groups/service'
import { ADMINISTRATOR_SET, adminClient, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant as grantTo, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()

async function addStore(orgId: string, code: string): Promise<string> {
  const { data, error } = await admin()
    .from('locations')
    .insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'viewer' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}

async function addCamera(orgId: string, storeId: string, channel: number, name: string): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: storeId, channel, name }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}

// P2-1: a store grant is now explicit live + playback grants for the store (AC-1, AC-5).
const grant = (orgId: string, userId: string, stores: string[]) => grantTo(orgId, userId, CCTV_VIEW, stores.map(atLocation))

const sorted = (a: string[]) => [...a].sort()
const actorOf = (u: TestUser, orgId: string, role: Actor['role']): Actor => ({ id: u.id, orgId, role })
const deps = (u: TestUser) => ({ admin: admin(), rls: u.client })

async function itemIds(user: TestUser, groupId: string): Promise<string[]> {
  const { data, error } = await user.client.from('camera_group_items').select('camera_id').eq('group_id', groupId)
  expect(error).toBeNull()
  return sorted((data ?? []).map((r) => r.camera_id))
}

async function groupIds(user: TestUser): Promise<string[]> {
  const { data, error } = await user.client.from('camera_groups').select('id')
  expect(error).toBeNull()
  return (data ?? []).map((r) => r.id)
}

describe('camera groups', () => {
  let orgId: string
  let otherOrg: string
  let sA: string, sB: string
  let a1: string, a2: string, a3: string, a4: string, b1: string, b2: string
  let foreignCam: string // a camera of the other organisation
  let viewerA: TestUser, viewerB: TestUser, viewerNone: TestUser, manager: TestUser, operator: TestUser, operator2: TestUser, adminUser: TestUser, outsider: TestUser
  let wide: string // a group holding cameras of both stores

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    sA = await addStore(orgId, 'GA')
    sB = await addStore(orgId, 'GB')
    a1 = await addCamera(orgId, sA, 1, 'Front Door')
    a2 = await addCamera(orgId, sA, 2, 'Back door')
    a3 = await addCamera(orgId, sA, 3, '100%_Till')
    a4 = await addCamera(orgId, sA, 4, 'Odd*Name')
    b1 = await addCamera(orgId, sB, 1, 'Entrance DOOR')
    b2 = await addCamera(orgId, sB, 2, 'Store room')
    viewerA = await createUser(orgId, 'user')
    viewerB = await createUser(orgId, 'user')
    viewerNone = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    operator = await createUser(orgId, 'operator')
    operator2 = await createUser(orgId, 'operator')
    adminUser = await createUser(orgId, 'admin')
    outsider = await createUser(otherOrg, 'admin')
    foreignCam = await addCamera(otherOrg, await addStore(otherOrg, 'OT'), 1, 'Other org door')
    await grant(orgId, viewerA.id, [sA])
    await grant(orgId, viewerB.id, [sB])
    await grant(orgId, operator.id, [sA])
    await grant(orgId, operator2.id, [sA])
    // AC-8: no role sees anything by itself. The manager here has the read grants a manager was migrated with (D-2a); the
    // administrator has the administrator set (organisation-wide CCTV, and admin.inventory for other people's empty groups).
    await grantTo(orgId, manager.id, READ_EVERYTHING)
    await grantTo(orgId, adminUser.id, ADMINISTRATOR_SET)
    // P2-2: the other organisation's administrator may edit groups in their own organisation (live view there), never ours.
    await grantTo(otherOrg, outsider.id, ADMINISTRATOR_SET)
    const made = await createGroup(deps(adminUser), actorOf(adminUser, orgId, 'admin'), 'Everything')
    if (!made.ok) throw new Error(made.error)
    wide = made.groupId
    const added = await addCameras(deps(adminUser), actorOf(adminUser, orgId, 'admin'), wide, [a1, a2, b1, b2])
    if (!added.ok) throw new Error(added.error)
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  describe('visibility', () => {
    // AC-8: through the explicit organisation-wide grants given above, not through the manager role.
    it('a manager with organisation-wide read grants sees the group and all its items', async () => {
      expect(await groupIds(manager)).toContain(wide)
      expect(await itemIds(manager, wide)).toEqual(sorted([a1, a2, b1, b2]))
    })
    it('a viewer with store A sees the group but only the store A items', async () => {
      expect(await groupIds(viewerA)).toEqual([wide])
      expect(await itemIds(viewerA, wide)).toEqual(sorted([a1, a2]))
    })
    it('a viewer with store B sees the group (it has a B camera) and only the B items', async () => {
      expect(await groupIds(viewerB)).toEqual([wide])
      expect(await itemIds(viewerB, wide)).toEqual(sorted([b1, b2]))
    })
    it('a viewer with no grants does not see the group at all', async () => {
      expect(await groupIds(viewerNone)).toEqual([])
      expect(await itemIds(viewerNone, wide)).toEqual([])
    })
    it('another organisation sees nothing', async () => {
      expect(await groupIds(outsider)).toEqual([])
      expect(await itemIds(outsider, wide)).toEqual([])
    })
    it('nobody can write the tables through the data API', async () => {
      for (const u of [viewerA, manager, operator, adminUser]) {
        const ins = await u.client.from('camera_groups').insert({ org_id: orgId, name: 'Sneaky' })
        expect(ins.error?.code).toBe('42501')
        const upd = await u.client.from('camera_groups').update({ name: 'Renamed' }).eq('id', wide)
        expect(upd.error?.code).toBe('42501')
        const del = await u.client.from('camera_groups').delete().eq('id', wide)
        expect(del.error?.code).toBe('42501')
        const insItem = await u.client.from('camera_group_items').insert({ org_id: orgId, group_id: wide, camera_id: a3 })
        expect(insItem.error?.code).toBe('42501')
        const delItem = await u.client.from('camera_group_items').delete().eq('group_id', wide)
        expect(delItem.error?.code).toBe('42501')
      }
      expect(await itemIds(manager, wide)).toEqual(sorted([a1, a2, b1, b2]))
    })
    it('the database refuses an item that mixes organisations', async () => {
      const foreign = await admin().from('locations').insert({ org_id: otherOrg, code: 'FOREIGN', name: 'F', nvr_ip: '127.0.0.1', nvr_username: 'v' }).select('id').single()
      const cam = await addCamera(otherOrg, foreign.data!.id, 1, 'Foreign')
      const res = await admin().from('camera_group_items').insert({ org_id: orgId, group_id: wide, camera_id: cam })
      expect(res.error?.code).toBe('23503')
    })
  })

  // P2-2 (brief item 2): group management needs the operator, admin or platform-owner role AND cctv.live for every camera added.
  describe('capabilities', () => {
    let pbOperator: TestUser, mixedOperator: TestUser, itOperator: TestUser
    beforeAll(async () => {
      pbOperator = await createUser(orgId, 'operator')
      mixedOperator = await createUser(orgId, 'operator')
      itOperator = await createUser(orgId, 'operator')
      await grantTo(orgId, pbOperator.id, 'cctv.playback', atLocation(sA))
      await grantTo(orgId, mixedOperator.id, 'cctv.live', atLocation(sA))
      await grantTo(orgId, mixedOperator.id, 'cctv.playback', atLocation(sB))
      await grantTo(orgId, itOperator.id, ['it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate'])
    })

    it('an operator without cctv.live anywhere cannot make a group, and nothing is written', async () => {
      for (const u of [pbOperator, itOperator]) {
        const res = await createGroup(deps(u), actorOf(u, orgId, 'operator'), 'No live view')
        expect(res).toEqual({ ok: false, error: 'Changing camera groups needs live view of cameras and the operator or administrator role.' })
      }
      expect((await admin().from('camera_groups').select('id').eq('org_id', orgId).eq('name', 'No live view')).data).toEqual([])
    })

    it('cameras the person may see but not watch live cannot be added: the whole request is refused', async () => {
      const actor = actorOf(mixedOperator, orgId, 'operator')
      const made = await createGroup(deps(mixedOperator), actor, 'Live only')
      if (!made.ok) throw new Error(made.error)
      expect(await addCameras(deps(mixedOperator), actor, made.groupId, [a1, b1])).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
      expect(await addCameras(deps(mixedOperator), actor, made.groupId, [b1])).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
      expect(await addCameras(deps(mixedOperator), actor, made.groupId, [a1])).toEqual({ ok: true, added: 1 })
    })

    it('adding by keyword takes only cameras the person may watch live', async () => {
      const actor = actorOf(mixedOperator, orgId, 'operator')
      const made = await createGroup(deps(mixedOperator), actor, 'Doors live')
      if (!made.ok) throw new Error(made.error)
      // "door" matches Front Door, Back door (store A, live) and Entrance DOOR (store B, playback only).
      const res = await addCamerasByKeyword(deps(mixedOperator), actor, made.groupId, 'door')
      expect(res).toEqual({ ok: true, added: 2, truncated: false })
      expect((await admin().from('camera_group_items').select('camera_id').eq('group_id', made.groupId)).data!.map((r) => r.camera_id).sort()).toEqual(sorted([a1, a2]))
    })

    // P2-2 fix M-1: renaming and removing need live view of the cameras concerned, not only seeing them.
    it('an operator with live on store A but only playback on store B cannot rename a B-only group or remove a B camera', async () => {
      const actor = actorOf(mixedOperator, orgId, 'operator')
      const bOnly = (await admin().from('camera_groups').insert({ org_id: orgId, name: `B only ${Math.random()}`, created_by: adminUser.id }).select('id').single()).data!.id
      await admin().from('camera_group_items').insert([b1, b2].map((camera_id) => ({ org_id: orgId, group_id: bOnly, camera_id })))
      expect(await groupIds(mixedOperator)).toContain(bOnly) // seen (playback), but not changeable
      expect(await renameGroup(deps(mixedOperator), actor, bOnly, 'Renamed by playback')).toEqual({ ok: false, error: 'Group not found.' })
      expect(await removeCamera(deps(mixedOperator), actor, wide, b1)).toEqual({ ok: false, error: 'That camera is not in this group.' })
      expect(await itemIds(manager, wide)).toContain(b1)
      expect((await admin().from('camera_groups').select('name').eq('id', bOnly).single()).data!.name).not.toBe('Renamed by playback')
      // Live on A: removing an A camera from the mixed group works.
      const own = await createGroup(deps(mixedOperator), actor, `Mine ${Math.random()}`)
      if (!own.ok) throw new Error(own.error)
      await addCameras(deps(mixedOperator), actor, own.groupId, [a1])
      expect(await removeCamera(deps(mixedOperator), actor, own.groupId, a1)).toEqual({ ok: true })
    })

    it('a playback-only viewer or operator cannot rename a group or remove a camera from it', async () => {
      const viewerPb = await createUser(orgId, 'user')
      await grantTo(orgId, viewerPb.id, 'cctv.playback', atLocation(sA))
      for (const [u, role] of [[viewerPb, 'user'], [pbOperator, 'operator']] as const) {
        expect((await renameGroup(deps(u), actorOf(u, orgId, role), wide, 'Nope')).ok).toBe(false)
        expect((await removeCamera(deps(u), actorOf(u, orgId, role), wide, a1)).ok).toBe(false)
      }
      expect(await itemIds(manager, wide)).toContain(a1)
    })

    // P2-2 fix M-1: deleting another person's group needs the administrator role AND admin.inventory; creators delete their own.
    it('deleting someone else\'s group needs the admin role and admin.inventory', async () => {
      const plainAdmin = await createUser(orgId, 'admin')
      await grantTo(orgId, plainAdmin.id, 'cctv.live') // live everywhere, but no admin.inventory
      const theirs = await createGroup(deps(mixedOperator), actorOf(mixedOperator, orgId, 'operator'), `Theirs ${Math.random()}`)
      if (!theirs.ok) throw new Error(theirs.error)
      await addCameras(deps(mixedOperator), actorOf(mixedOperator, orgId, 'operator'), theirs.groupId, [a1])
      expect(await deleteGroup(deps(plainAdmin), actorOf(plainAdmin, orgId, 'admin'), theirs.groupId)).toEqual({ ok: false, error: 'Only the person who made a group, or an administrator, can delete it.' })
      expect(await deleteGroup(deps(adminUser), actorOf(adminUser, orgId, 'admin'), theirs.groupId)).toEqual({ ok: true }) // ADMINISTRATOR_SET holds admin.inventory
      const mine = await createGroup(deps(mixedOperator), actorOf(mixedOperator, orgId, 'operator'), `Own ${Math.random()}`)
      if (!mine.ok) throw new Error(mine.error)
      expect(await deleteGroup(deps(mixedOperator), actorOf(mixedOperator, orgId, 'operator'), mine.groupId)).toEqual({ ok: true })
    })

    // P2-2 fix M-6: group audit entries carry the capability and the camera ids / counts.
    it('group audit entries carry the capability and the cameras', async () => {
      const actor = actorOf(mixedOperator, orgId, 'operator')
      const made = await createGroup(deps(mixedOperator), actor, `Audited ${Math.random()}`)
      if (!made.ok) throw new Error(made.error)
      await addCameras(deps(mixedOperator), actor, made.groupId, [a1, a2])
      await removeCamera(deps(mixedOperator), actor, made.groupId, a2)
      const rows = (await admin().from('admin_audit_log').select('action, entity_type, entity_id, detail').eq('entity_id', made.groupId).order('created_at')).data!
      expect(rows.map((r) => [r.action, r.entity_type])).toEqual([['group_created', 'camera_group'], ['group_cameras_added', 'camera_group'], ['group_camera_removed', 'camera_group']])
      expect(rows[1].detail).toMatchObject({ capability: 'cctv.live', cameraIds: [a1, a2].sort(), count: 2, added: 2 })
      expect(rows[2].detail).toMatchObject({ capability: 'cctv.live', cameraIds: [a2], count: 1 })
      expect(rows[0].detail).toMatchObject({ capability: 'cctv.live' })
    })

    it('a person who loses cctv.live can no longer change their group', async () => {
      const p = await createUser(orgId, 'operator')
      const [g] = await grantTo(orgId, p.id, 'cctv.live', atLocation(sA))
      await grantTo(orgId, p.id, 'cctv.playback', atLocation(sA))
      const actor = actorOf(p, orgId, 'operator')
      const made = await createGroup(deps(p), actor, 'Revoked later')
      if (!made.ok) throw new Error(made.error)
      expect((await addCameras(deps(p), actor, made.groupId, [a1])).ok).toBe(true)
      await admin().rpc('revoke_grant', { p_org: orgId, p_user: p.id, p_grant_ids: [g], p_reason: 'test' })
      expect((await addCameras(deps(p), actor, made.groupId, [a2])).ok).toBe(false)
      expect((await renameGroup(deps(p), actor, made.groupId, 'New name')).ok).toBe(false)
    })
  })

  describe('service', () => {
    it('a viewer and a manager cannot create groups', async () => {
      for (const [u, role] of [[viewerA, 'user'], [manager, 'manager']] as const) {
        const res = await createGroup(deps(u), actorOf(u, orgId, role), 'Not allowed')
        expect(res.ok).toBe(false)
      }
      const { data } = await admin().from('camera_groups').select('id').eq('org_id', orgId).eq('name', 'Not allowed')
      expect(data).toEqual([])
    })

    it('an operator can create a group and add cameras they can see; duplicates are ignored; the audit trail is written', async () => {
      const actor = actorOf(operator, orgId, 'operator')
      const made = await createGroup(deps(operator), actor, '  Doors  ')
      if (!made.ok) throw new Error(made.error)
      const { data: row } = await admin().from('camera_groups').select('name, created_by, org_id').eq('id', made.groupId).single()
      expect(row).toEqual({ name: 'Doors', created_by: operator.id, org_id: orgId })
      expect(await groupIds(operator)).toContain(made.groupId) // the creator sees it even while it is empty

      const first = await addCameras(deps(operator), actor, made.groupId, [a1, a2])
      expect(first).toEqual({ ok: true, added: 2 })
      const again = await addCameras(deps(operator), actor, made.groupId, [a2, a3])
      expect(again).toEqual({ ok: true, added: 1 })
      expect(await itemIds(operator, made.groupId)).toEqual(sorted([a1, a2, a3]))

      const { data: audit } = await admin().from('admin_audit_log').select('action, entity_id').eq('org_id', orgId).eq('entity_id', made.groupId)
      expect(audit?.map((r) => r.action).sort()).toEqual(['group_cameras_added', 'group_cameras_added', 'group_created'])
    })

    it('refuses the whole request, adding nothing, when any camera is not visible to the person', async () => {
      const actor = actorOf(operator, orgId, 'operator')
      const made = await createGroup(deps(operator), actor, 'Mixed')
      if (!made.ok) throw new Error(made.error)
      const res = await addCameras(deps(operator), actor, made.groupId, [a1, b1])
      expect(res).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
      expect(await itemIds(operator, made.groupId)).toEqual([])
      const { data } = await admin().from('camera_group_items').select('camera_id').eq('group_id', made.groupId)
      expect(data).toEqual([])
      // An id that does not exist at all gets the same answer, so nothing is revealed.
      const ghost = await addCameras(deps(operator), actor, made.groupId, [a1, '00000000-0000-4000-8000-000000000000'])
      expect(ghost).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
    })

    it('adds nothing and says so when no cameras are chosen', async () => {
      const res = await addCameras(deps(adminUser), actorOf(adminUser, orgId, 'admin'), wide, [])
      expect(res.ok).toBe(false)
    })

    it('adds by keyword only the visible cameras whose name matches, ignoring case, and returns how many', async () => {
      const actor = actorOf(operator2, orgId, 'operator')
      const made = await createGroup(deps(operator2), actor, 'By word')
      if (!made.ok) throw new Error(made.error)
      const res = await addCamerasByKeyword(deps(operator2), actor, made.groupId, 'DOOR')
      expect(res).toEqual({ ok: true, added: 2, truncated: false }) // Front Door and Back door; "Entrance DOOR" is in store B
      expect(await itemIds(operator2, made.groupId)).toEqual(sorted([a1, a2]))
      expect(await addCamerasByKeyword(deps(operator2), actor, made.groupId, 'door')).toEqual({ ok: true, added: 0, truncated: false })
      // Wildcard characters in the keyword are plain text.
      expect(await addCamerasByKeyword(deps(operator2), actor, made.groupId, '%')).toEqual({ ok: true, added: 1, truncated: false }) // only "100%_Till"
      expect(await addCamerasByKeyword(deps(operator2), actor, made.groupId, 'nothing like this')).toEqual({ ok: true, added: 0, truncated: false })
      expect((await addCamerasByKeyword(deps(operator2), actor, made.groupId, '   ')).ok).toBe(false)
    })

    it('treats * in the keyword as the character itself, not as "anything"', async () => {
      const actor = actorOf(operator2, orgId, 'operator')
      const made = await createGroup(deps(operator2), actor, 'Star word')
      if (!made.ok) throw new Error(made.error)
      // "d*r" would match "Front Door" if * were a wildcard; it must match nothing.
      expect(await addCamerasByKeyword(deps(operator2), actor, made.groupId, 'd*r')).toEqual({ ok: true, added: 0, truncated: false })
      expect(await itemIds(operator2, made.groupId)).toEqual([])
      expect(await addCamerasByKeyword(deps(operator2), actor, made.groupId, '*')).toEqual({ ok: true, added: 1, truncated: false }) // only "Odd*Name"
      expect(await itemIds(operator2, made.groupId)).toEqual([a4])
      // Other characters that mean something in patterns are plain text too.
      for (const word of ['.', '(', '[', '\\', '^', '$', '+', '?', '|', '{']) {
        expect(await addCamerasByKeyword(deps(operator2), actor, made.groupId, word)).toEqual({ ok: true, added: 0, truncated: false })
      }
    })

    it('adds at most 500 cameras by keyword and says when more matched', async () => {
      const store = await addStore(orgId, 'BIG')
      const rows = Array.from({ length: 520 }, (_, i) => ({ org_id: orgId, location_id: store, channel: i + 1, name: `Lane ${i + 1}` }))
      const { error } = await admin().from('cameras').insert(rows)
      expect(error).toBeNull()
      const actor = actorOf(adminUser, orgId, 'admin')
      const made = await createGroup(deps(adminUser), actor, 'Lanes')
      if (!made.ok) throw new Error(made.error)
      expect(await addCamerasByKeyword(deps(adminUser), actor, made.groupId, 'lane')).toEqual({ ok: true, added: 500, truncated: true })
      // A smaller match is not "more than 500".
      const fewer = await createGroup(deps(adminUser), actor, 'Fewer lanes')
      if (!fewer.ok) throw new Error(fewer.error)
      expect(await addCamerasByKeyword(deps(adminUser), actor, fewer.groupId, 'lane 1')).toEqual({ ok: true, added: 111, truncated: false }) // Lane 1, 10-19, 100-199 = 1 + 10 + 100
    })

    it('ids that differ only by capital letters, or are repeated, are one camera and do not cause a refusal', async () => {
      const actor = actorOf(operator, orgId, 'operator')
      const made = await createGroup(deps(operator), actor, 'Case twins')
      if (!made.ok) throw new Error(made.error)
      const res = await addCameras(deps(operator), actor, made.groupId, [a1.toUpperCase(), a1, a1.toLowerCase(), a2])
      expect(res).toEqual({ ok: true, added: 2 })
      expect(await itemIds(operator, made.groupId)).toEqual(sorted([a1, a2]))
    })

    it('a malformed camera id gets the same plain refusal and adds nothing', async () => {
      const actor = actorOf(operator, orgId, 'operator')
      const made = await createGroup(deps(operator), actor, 'Malformed')
      if (!made.ok) throw new Error(made.error)
      const res = await addCameras(deps(operator), actor, made.groupId, [a1, 'not-a-uuid'])
      expect(res).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
      expect(await itemIds(operator, made.groupId)).toEqual([])
    })

    it('a malformed group id is "Group not found."', async () => {
      const actor = actorOf(operator, orgId, 'operator')
      expect(await addCameras(deps(operator), actor, 'not-a-uuid', [a1])).toEqual({ ok: false, error: 'Group not found.' })
      expect(await removeCamera(deps(operator), actor, 'not-a-uuid', a1)).toEqual({ ok: false, error: 'Group not found.' })
    })

    it('cannot add cameras to a group of another organisation, and nothing changes there', async () => {
      // The other organisation's administrator uses the id of a group of ours, with a camera of their own.
      const stranger = actorOf(outsider, otherOrg, 'admin')
      const before = await itemIds(manager, wide)
      expect(await addCameras(deps(outsider), stranger, wide, [foreignCam])).toEqual({ ok: false, error: 'Group not found.' })
      expect(await addCamerasByKeyword(deps(outsider), stranger, wide, 'door')).toEqual({ ok: false, error: 'Group not found.' })
      expect(await itemIds(manager, wide)).toEqual(before)
      const { data } = await admin().from('camera_group_items').select('camera_id').eq('camera_id', foreignCam)
      expect(data).toEqual([])
      // And one of our own operators cannot put a camera of the other organisation into our group.
      const mine = actorOf(operator, orgId, 'operator')
      expect(await addCameras(deps(operator), mine, wide, [foreignCam])).toEqual({ ok: false, error: 'Some of those cameras are not available to you.' })
    })

    it('the audit action for keyword adds is separate from the one for chosen cameras', async () => {
      const actor = actorOf(operator2, orgId, 'operator')
      const made = await createGroup(deps(operator2), actor, 'Audit actions')
      if (!made.ok) throw new Error(made.error)
      await addCameras(deps(operator2), actor, made.groupId, [a3])
      await addCamerasByKeyword(deps(operator2), actor, made.groupId, 'front')
      await addCamerasByKeyword(deps(operator2), actor, made.groupId, 'front') // nothing new, nothing recorded
      const { data } = await admin().from('admin_audit_log').select('action, detail').eq('org_id', orgId).eq('entity_id', made.groupId)
      const byAction = Object.fromEntries((data ?? []).map((r) => [r.action, r.detail]))
      expect(Object.keys(byAction).sort()).toEqual(['group_cameras_added', 'group_cameras_added_by_keyword', 'group_created'])
      // P2-2 fix M-6: the capability and the cameras added are recorded too.
      expect(byAction.group_cameras_added_by_keyword).toEqual({ capability: 'cctv.live', cameraIds: [a1], count: 1, keyword: 'front', added: 1 })
      expect(byAction.group_cameras_added).toEqual({ capability: 'cctv.live', cameraIds: [a3], count: 1, added: 1 })
    })

    // AC-11 (P2-1): the taken name may belong to a group the person cannot see, so the answer never says it "exists".
    it('a duplicate group name gets the plain "cannot be used" message, also with spaces around it', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const actor = actorOf(adminUser, orgId, 'admin')
      const first = await createGroup(deps(adminUser), actor, 'Same name')
      expect(first.ok).toBe(true)
      const dup = await createGroup(deps(adminUser), actor, ' Same name ')
      logged.mockRestore()
      expect(dup).toEqual({ ok: false, error: MSG_NAME_TAKEN })
    })

    it('names are trimmed and must be 1 to 100 characters', async () => {
      const actor = actorOf(adminUser, orgId, 'admin')
      expect((await createGroup(deps(adminUser), actor, '   ')).ok).toBe(false)
      expect((await createGroup(deps(adminUser), actor, '')).ok).toBe(false)
      expect((await createGroup(deps(adminUser), actor, 'x'.repeat(101))).ok).toBe(false)
      const ok = await createGroup(deps(adminUser), actor, 'y'.repeat(100))
      expect(ok.ok).toBe(true)
      const padded = await createGroup(deps(adminUser), actor, `  ${'z'.repeat(100)}  `)
      expect(padded.ok).toBe(true)
    })

    it('renames a group, refuses a blank or duplicate name and records nothing for a stranger', async () => {
      const actor = actorOf(adminUser, orgId, 'admin')
      const made = await createGroup(deps(adminUser), actor, 'To rename')
      if (!made.ok) throw new Error(made.error)
      expect((await renameGroup(deps(adminUser), actor, made.groupId, ' Renamed ')).ok).toBe(true)
      const nameOf = async (id: string) => (await admin().from('camera_groups').select('name').eq('id', id).single()).data?.name
      const auditOf = async (id: string) => ((await admin().from('admin_audit_log').select('action').eq('org_id', orgId).eq('entity_id', id)).data ?? []).map((r) => r.action).sort()
      expect(await nameOf(made.groupId)).toBe('Renamed')
      expect(await auditOf(made.groupId)).toEqual(['group_created', 'group_renamed'])
      expect((await renameGroup(deps(adminUser), actor, made.groupId, '  ')).ok).toBe(false)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const dup = await renameGroup(deps(adminUser), actor, made.groupId, 'Everything')
      logged.mockRestore()
      expect(dup.ok).toBe(false)
      // Refused renames change nothing and record nothing.
      expect(await nameOf(made.groupId)).toBe('Renamed')
      expect(await auditOf(made.groupId)).toEqual(['group_created', 'group_renamed'])

      // A viewer cannot rename; an administrator of another organisation cannot find it.
      const wideAudit = await auditOf(wide)
      const viewerRes = await renameGroup(deps(viewerA), actorOf(viewerA, orgId, 'user'), wide, 'Mine')
      expect(viewerRes.ok).toBe(false)
      expect(await nameOf(wide)).toBe('Everything')
      const foreign = await renameGroup(deps(outsider), actorOf(outsider, otherOrg, 'admin'), made.groupId, 'Hijacked')
      expect(foreign).toEqual({ ok: false, error: 'Group not found.' })
      expect(await nameOf(made.groupId)).toBe('Renamed')
      expect(await auditOf(made.groupId)).toEqual(['group_created', 'group_renamed'])
      expect(await auditOf(wide)).toEqual(wideAudit)
      // Nothing was recorded in the other organisation's name either.
      const { data: strangerAudit } = await admin().from('admin_audit_log').select('id').eq('org_id', otherOrg).eq('entity_id', made.groupId)
      expect(strangerAudit).toEqual([])
    })

    it('removes a camera from a group; a camera the person cannot see stays', async () => {
      const actor = actorOf(operator, orgId, 'operator')
      const made = await createGroup(deps(operator), actor, 'Removal')
      if (!made.ok) throw new Error(made.error)
      await addCameras(deps(operator), actor, made.groupId, [a1, a2])
      expect((await removeCamera(deps(operator), actor, made.groupId, a1)).ok).toBe(true)
      expect(await itemIds(operator, made.groupId)).toEqual([a2])
      const hidden = await removeCamera(deps(operator), actor, wide, b1)
      expect(hidden.ok).toBe(false)
      const { data } = await admin().from('camera_group_items').select('camera_id').eq('group_id', wide).eq('camera_id', b1)
      expect(data).toHaveLength(1)
    })

    it('a viewer and a manager cannot remove a camera from a group', async () => {
      const before = await itemIds(adminUser, wide)
      for (const [u, role] of [[viewerA, 'user'], [manager, 'manager']] as const) {
        const res = await removeCamera(deps(u), actorOf(u, orgId, role), wide, a1)
        // P2-2: the message names both conditions (the role and live view of cameras).
        expect(res).toEqual({ ok: false, error: 'Changing camera groups needs live view of cameras and the operator or administrator role.' })
      }
      expect(await itemIds(adminUser, wide)).toEqual(before)
      const { data } = await admin().from('admin_audit_log').select('id').eq('org_id', orgId).eq('entity_id', wide).eq('action', 'group_camera_removed')
      expect(data).toEqual([])
    })

    it('deleting is allowed for the creator and for administrators only', async () => {
      const operatorActor = actorOf(operator, orgId, 'operator')
      const mine = await createGroup(deps(operator), operatorActor, 'Mine')
      if (!mine.ok) throw new Error(mine.error)
      await addCameras(deps(operator), operatorActor, mine.groupId, [a1])

      // Another operator who can even see the group may not delete it.
      const other = actorOf(operator2, orgId, 'operator')
      expect((await deleteGroup(deps(operator2), other, mine.groupId)).ok).toBe(false)
      // Viewers and managers may not either.
      expect((await deleteGroup(deps(viewerA), actorOf(viewerA, orgId, 'user'), mine.groupId)).ok).toBe(false)
      expect((await deleteGroup(deps(manager), actorOf(manager, orgId, 'manager'), mine.groupId)).ok).toBe(false)
      // An administrator of another organisation cannot find it.
      expect((await deleteGroup(deps(outsider), actorOf(outsider, otherOrg, 'admin'), mine.groupId)).ok).toBe(false)
      expect((await admin().from('camera_groups').select('id').eq('id', mine.groupId)).data).toHaveLength(1)

      expect((await deleteGroup(deps(operator), operatorActor, mine.groupId)).ok).toBe(true)
      expect((await admin().from('camera_groups').select('id').eq('id', mine.groupId)).data).toEqual([])
      expect((await admin().from('camera_group_items').select('camera_id').eq('group_id', mine.groupId)).data).toEqual([])

      const theirs = await createGroup(deps(operator), operatorActor, 'Theirs')
      if (!theirs.ok) throw new Error(theirs.error)
      expect((await deleteGroup(deps(adminUser), actorOf(adminUser, orgId, 'admin'), theirs.groupId)).ok).toBe(true)
      const { data: audit } = await admin().from('admin_audit_log').select('action').eq('org_id', orgId).in('entity_id', [mine.groupId, theirs.groupId]).eq('action', 'group_deleted')
      expect(audit).toHaveLength(2)
    })

    // P2-5a (brief item 2) replaces "deleting a camera removes it from its groups": cameras and locations are archived, never deleted,
    // and archiving keeps the group membership as history; the archived camera simply no longer shows in the group for anybody.
    it('archiving a location keeps its cameras\' group membership, and they no longer show in the group', async () => {
      const store = await addStore(orgId, 'TMP')
      const cam = await addCamera(orgId, store, 1, 'Temporary')
      const actor = actorOf(adminUser, orgId, 'admin')
      const made = await createGroup(deps(adminUser), actor, 'Temp group')
      if (!made.ok) throw new Error(made.error)
      expect((await addCameras(deps(adminUser), actor, made.groupId, [cam])).ok).toBe(true)
      expect((await adminUser.client.from('camera_group_items').select('camera_id').eq('group_id', made.groupId)).data).toEqual([{ camera_id: cam }])
      expect((await admin().from('locations').delete().eq('id', store)).error?.code).toBe('DR003')
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: store })).error).toBeNull()
      expect((await admin().from('camera_group_items').select('camera_id').eq('group_id', made.groupId)).data).toEqual([{ camera_id: cam }])
      expect((await adminUser.client.from('camera_group_items').select('camera_id').eq('group_id', made.groupId)).data).toEqual([])
    })
  })
})
