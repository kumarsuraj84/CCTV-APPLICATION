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
  return { from: () => self } as unknown as AdminClient
}

const ok = stub({ data: { id: 'g', name: 'G', created_by: null }, error: null })
const broken = stub({ data: null, error: { code: 'XX000', message: 'connection reset while reading camera_groups' } })
const agent: Actor = { id: 'u1', orgId: 'o1', role: 'agent' }
const GROUP = '11111111-1111-4111-8111-111111111111'
const CAMERA = '22222222-2222-4222-8222-222222222222'

afterEach(() => vi.restoreAllMocks())

describe('a database failure while looking up the group', () => {
  it('is a plain failure, not "Group not found."', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = [
      () => renameGroup({ admin: broken, rls: ok }, agent, GROUP, 'New'),
      () => deleteGroup({ admin: broken, rls: ok }, agent, GROUP),
      () => addCameras({ admin: broken, rls: ok }, agent, GROUP, [CAMERA]),
      () => addCamerasByKeyword({ admin: broken, rls: ok }, agent, GROUP, 'door'),
      () => removeCamera({ admin: broken, rls: ok }, agent, GROUP, CAMERA),
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
    const res = await renameGroup({ admin: ok, rls: broken }, agent, GROUP, 'New')
    expect(res).toEqual({ ok: false, error: 'Could not look up the group.' })
  })

  it('a malformed group id is simply "Group not found."', async () => {
    const malformed = stub({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    const res = await renameGroup({ admin: malformed, rls: ok }, agent, 'not-a-uuid', 'New')
    expect(res).toEqual({ ok: false, error: 'Group not found.' })
  })

  it('a missing group is "Group not found."', async () => {
    const none = stub({ data: null, error: null })
    expect(await renameGroup({ admin: none, rls: ok }, agent, GROUP, 'New')).toEqual({ ok: false, error: 'Group not found.' })
  })
})
