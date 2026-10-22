import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireProfile = vi.fn()
const createClient = vi.fn(async () => ({ tag: 'rls' }))
const createAdminClient = vi.fn(() => ({ tag: 'admin' }))
const revalidatePath = vi.fn()
const service = {
  createGroup: vi.fn(),
  deleteGroup: vi.fn(),
  addCameras: vi.fn(),
  addCamerasByKeyword: vi.fn(),
  removeCamera: vi.fn(),
}

vi.mock('@/lib/auth/profile', () => ({ requireProfile: () => requireProfile() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))
vi.mock('@/lib/groups/service', () => ({
  createGroup: (...a: unknown[]) => service.createGroup(...a),
  deleteGroup: (...a: unknown[]) => service.deleteGroup(...a),
  addCameras: (...a: unknown[]) => service.addCameras(...a),
  addCamerasByKeyword: (...a: unknown[]) => service.addCamerasByKeyword(...a),
  removeCamera: (...a: unknown[]) => service.removeCamera(...a),
}))

import { addByKeywordAction, addCamerasAction, createGroupAction, deleteGroupAction, removeCameraAction } from '@/lib/actions/groups'

const LIVE = { failed: false, grants: { 'cctv.live': { organization: false, locations: ['l1'], cameras: [], assets: [] } } }
const person = (role: string, capabilities: unknown = LIVE) => ({ id: 'u1', org_id: 'o1', role, email: 'a@b.c', full_name: 'A', is_active: true, must_reset_password: false, store_id: null, capabilities })
const DENIED = 'Changing camera groups needs live view of cameras and the operator or administrator role.'
const form = (name: string) => {
  const f = new FormData()
  f.set('name', name)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('group actions check the caller first', () => {
  // P2-2: the role (operator, admin, platform owner) AND cctv.live somewhere; either alone is refused.
  it.each([
    ['user', LIVE],
    ['manager', LIVE],
    ['operator', { failed: false, grants: { 'cctv.playback': LIVE.grants['cctv.live'] } }],
    ['admin', { failed: false, grants: {} }],
    ['platform_owner', { failed: true, grants: {} }],
  ])('a %s without both is refused before any database client is made or any service is called', async (role, caps) => {
    requireProfile.mockResolvedValue(person(role, caps))
    const results = [
      await createGroupAction({}, form('X')),
      await deleteGroupAction('g'),
      await addCamerasAction('g', ['c']),
      await addByKeywordAction('g', 'door'),
      await removeCameraAction('g', 'c'),
    ]
    for (const r of results) expect(r).toEqual({ error: DENIED })
    expect(createClient).not.toHaveBeenCalled()
    expect(createAdminClient).not.toHaveBeenCalled()
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('a signed-out caller is sent to sign in (requireProfile redirects) and nothing runs', async () => {
    requireProfile.mockRejectedValue(new Error('NEXT_REDIRECT'))
    await expect(addCamerasAction('g', ['c'])).rejects.toThrow('NEXT_REDIRECT')
    expect(service.addCameras).not.toHaveBeenCalled()
  })
})

describe('group actions for an operator', () => {
  beforeEach(() => requireProfile.mockResolvedValue(person('operator')))

  it('create passes the person and both clients to the service and refreshes the group pages', async () => {
    service.createGroup.mockResolvedValue({ ok: true, groupId: 'g1' })
    const res = await createGroupAction({}, form('Doors'))
    expect(res).toMatchObject({ ok: true, groupId: 'g1' })
    expect(service.createGroup).toHaveBeenCalledWith({ admin: { tag: 'admin' }, rls: { tag: 'rls' } }, { id: 'u1', orgId: 'o1', role: 'operator' }, 'Doors')
    expect(revalidatePath).toHaveBeenCalledWith('/groups')
  })

  it('create keeps the typed name when the service refuses', async () => {
    service.createGroup.mockResolvedValue({ ok: false, error: 'That already exists.' })
    expect(await createGroupAction({}, form('Doors'))).toEqual({ error: 'That already exists.', values: { name: 'Doors' } })
  })

  it('adding chosen cameras says how many were added, or that they were already there', async () => {
    service.addCameras.mockResolvedValueOnce({ ok: true, added: 3 }).mockResolvedValueOnce({ ok: true, added: 1 }).mockResolvedValueOnce({ ok: true, added: 0 })
    expect((await addCamerasAction('g', ['a', 'b', 'c'])).message).toBe('Added 3 cameras to the group.')
    expect((await addCamerasAction('g', ['a'])).message).toBe('Added 1 camera to the group.')
    expect((await addCamerasAction('g', ['a'])).message).toBe('Those cameras are already in the group.')
  })

  it('adding with something that is not a list asks the service for nothing', async () => {
    service.addCameras.mockResolvedValue({ ok: false, error: 'Choose at least one camera.' })
    await addCamerasAction('g', 'oops' as unknown as string[])
    expect(service.addCameras).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'g', [])
  })

  it('adding by word says so when more than 500 matched', async () => {
    service.addCamerasByKeyword.mockResolvedValue({ ok: true, added: 500, truncated: true })
    const res = await addByKeywordAction('g', 'lane')
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/Added 500 cameras/)
    expect(res.message).toMatch(/More than 500 cameras matched/)
    service.addCamerasByKeyword.mockResolvedValue({ ok: true, added: 2, truncated: false })
    expect((await addByKeywordAction('g', 'door')).message).toBe('Added 2 cameras to the group.')
    service.addCamerasByKeyword.mockResolvedValue({ ok: true, added: 0, truncated: false })
    expect((await addByKeywordAction('g', 'zzz')).message).toMatch(/No new cameras found/)
  })

  it('shows the service error as it is', async () => {
    service.removeCamera.mockResolvedValue({ ok: false, error: 'That camera is not in this group.' })
    expect(await removeCameraAction('g', 'c')).toEqual({ error: 'That camera is not in this group.' })
    service.deleteGroup.mockResolvedValue({ ok: false, error: 'Group not found.' })
    expect(await deleteGroupAction('g')).toEqual({ error: 'Group not found.' })
  })

  it('never throws to the browser: an unexpected failure becomes a plain message', async () => {
    service.addCameras.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'))
    const res = await addCamerasAction('g', ['a'])
    expect(res).toEqual({ error: 'Something went wrong. Please try again.' })
    createClient.mockRejectedValueOnce(new Error('cookies unavailable'))
    expect(await removeCameraAction('g', 'c')).toEqual({ error: 'Something went wrong. Please try again.' })
  })
})
