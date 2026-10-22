import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Actor, AdminClient } from '@/lib/admin/types'
import { addCameras, addCamerasByKeyword, deleteGroup, removeCamera, renameGroup } from '@/lib/groups/service'

// A database stand-in whose every read ends in the given answer. Any chain of select/eq/in/... works, then maybeSingle or await.
function stub(answer: { data: unknown; error: { code?: string; message?: string } | null }): AdminClient {
  const chain: Record<string, unknown> = {}
  const self = new Proxy(chain, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(answer)
      if (prop === 'maybeSingle' || prop === 'single') return async () => answer
      return () => self
    },
  })
  // P2-2: the service asks the person's summary (my_access_summary) for cctv.live; these stand-ins hold it for the whole organisation.
  const summary = { data: [{ capability: 'cctv.live', organization_wide: true, location_ids: [], camera_ids: [], asset_ids: [] }], error: null }
  return { from: () => self, rpc: async () => summary } as unknown as AdminClient
}

const ok = stub({ data: { id: 'g', name: 'G', created_by: null }, error: null })
const broken = stub({ data: null, error: { code: 'XX000', message: 'connection reset while reading camera_groups' } })
const operator: Actor = { id: 'u1', orgId: 'o1', role: 'operator' }
const GROUP = '11111111-1111-4111-8111-111111111111'
const CAMERA = '22222222-2222-4222-8222-222222222222'

afterEach(() => vi.restoreAllMocks())

describe('a database failure while looking up the group', () => {
  it('is a plain failure, not "Group not found."', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = [
      () => renameGroup({ admin: broken, rls: ok }, operator, GROUP, 'New'),
      () => deleteGroup({ admin: broken, rls: ok }, operator, GROUP),
      () => addCameras({ admin: broken, rls: ok }, operator, GROUP, [CAMERA]),
      () => addCamerasByKeyword({ admin: broken, rls: ok }, operator, GROUP, 'door'),
      () => removeCamera({ admin: broken, rls: ok }, operator, GROUP, CAMERA),
    ]
    for (const call of calls) {
      const res = await call()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).not.toBe('Group not found.')
        expect(res.error).toBe('Could not look up the group.')
        expect(res.error).not.toMatch(/connection|camera_groups/i) // the raw error is never shown
      }
    }
  })

  it('is also a plain failure when the second lookup (the person\'s own view) fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await renameGroup({ admin: ok, rls: broken }, operator, GROUP, 'New')
    expect(res).toEqual({ ok: false, error: 'Could not look up the group.' })
  })

  it('a malformed group id is simply "Group not found."', async () => {
    const malformed = stub({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    const res = await renameGroup({ admin: malformed, rls: ok }, operator, 'not-a-uuid', 'New')
    expect(res).toEqual({ ok: false, error: 'Group not found.' })
  })

  it('a missing group is "Group not found."', async () => {
    const none = stub({ data: null, error: null })
    expect(await renameGroup({ admin: none, rls: ok }, operator, GROUP, 'New')).toEqual({ ok: false, error: 'Group not found.' })
  })
})

// P2-2: the role is only half of it; without cctv.live (read from the database as the person) nothing is looked up or written.
describe('without cctv.live', () => {
  it('every change is refused before the group is looked up, and a summary that cannot be read is a plain failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const from = vi.fn()
    const admin = { from } as unknown as AdminClient
    const playbackOnly = { from, rpc: async () => ({ data: [{ capability: 'cctv.playback', organization_wide: true, location_ids: [], camera_ids: [], asset_ids: [] }], error: null }) } as unknown as AdminClient
    const unreadable = { from, rpc: async () => ({ data: null, error: { code: '57014' } }) } as unknown as AdminClient
    const denied = { ok: false, error: 'Changing camera groups needs live view of cameras and the operator or administrator role.' }
    expect(await renameGroup({ admin, rls: playbackOnly }, operator, GROUP, 'New')).toEqual(denied)
    expect(await deleteGroup({ admin, rls: playbackOnly }, operator, GROUP)).toEqual(denied)
    expect(await addCameras({ admin, rls: playbackOnly }, operator, GROUP, [CAMERA])).toEqual(denied)
    expect(await addCamerasByKeyword({ admin, rls: playbackOnly }, operator, GROUP, 'door')).toEqual(denied)
    expect(await removeCamera({ admin, rls: playbackOnly }, operator, GROUP, CAMERA)).toEqual(denied)
    expect(await renameGroup({ admin, rls: unreadable }, operator, GROUP, 'New')).toEqual({ ok: false, error: 'Could not check your access. Please try again.' })
    expect(from).not.toHaveBeenCalled()
  })
})
