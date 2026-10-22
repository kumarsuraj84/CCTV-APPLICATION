import { beforeEach, describe, expect, it, vi } from 'vitest'

// P2-3 Server Actions of the access editor, the review and reactivation (lib/actions/admin/access.ts, lib/actions/admin/users.ts):
// the gate first (role + admin.access / admin.users, nothing else runs when it refuses), input validation, a rate limit per
// administrator, the service with the acting administrator from the session, and no throw to the client.

const m = vi.hoisted(() => ({
  refuse: false, asked: [] as string[], limited: false, mayAccess: true, revalidated: [] as string[],
  calls: [] as { fn: string; args: unknown[] }[], result: { ok: true } as Record<string, unknown>,
}))
vi.mock('@/lib/auth/profile', () => ({
  requireAdministration: async (cap: string) => {
    m.asked.push(cap)
    if (m.refuse) throw new Error('REDIRECT:/home')
    return { id: 'a1', org_id: 'o1', role: 'admin' }
  },
  mayAdminister: () => m.mayAccess,
}))
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => m.revalidated.push(p) }))
// P2-6: the user-administration actions use the web app's role plus GoTrue's admin API (createUserAdminClient).
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }), createUserAdminClient: () => ({ tag: 'admin' }) }))
// P2-6 (D-11): the per-administrator counts are shared (lib/rate-limit-shared.ts); here the answer is the test's.
vi.mock('@/lib/rate-limit-shared', async (orig) => {
  const real = await orig<typeof import('@/lib/rate-limit-shared')>()
  const answer = async () => (m.limited ? real.MSG_SLOW_DOWN : null)
  return { ...real, refusalFor: answer, adminRefusalFor: answer }
})
const record = (fn: string) => async (...args: unknown[]) => (m.calls.push({ fn, args }), m.result)
vi.mock('@/lib/admin/access', () => ({
  previewChange: record('previewChange'), applyChange: record('applyChange'), keepReviewed: record('keepReviewed'),
  revokeAll: record('revokeAll'), selfConfirmReview: record('selfConfirmReview'), reviewBeforeReactivation: record('reviewBeforeReactivation'), MSG_CONFLICT: 'conflict',
}))
vi.mock('@/lib/admin/users', () => ({ updateUser: record('updateUser'), createUser: record('createUser'), resetUserPassword: record('resetUserPassword') }))

const U = '7d0a4c38-6c3a-4d55-9b1e-0f3c1d2a9e11'
beforeEach(() => {
  Object.assign(m, { refuse: false, asked: [], limited: false, mayAccess: true, revalidated: [], calls: [], result: { ok: true } })
})

describe('access actions', () => {
  it('pass the acting administrator from the session and the input to the service', async () => {
    const a = await import('@/lib/actions/admin/access')
    await a.previewAccessAction(U, { changes: [{ op: 'revoke' }], expectedVersion: 3 })
    expect(m.calls[0]).toEqual({ fn: 'previewChange', args: [{ tag: 'admin' }, { id: 'a1', orgId: 'o1', role: 'admin' }, U, { changes: [{ op: 'revoke' }], expectedVersion: 3 }] })
    expect(m.asked).toEqual(['admin.access'])
  })

  it('refuse bad ids, versions and tokens before the service, without throwing', async () => {
    const a = await import('@/lib/actions/admin/access')
    expect(await a.previewAccessAction('not-a-uuid', { changes: [], expectedVersion: 0 })).toEqual({ ok: false, error: 'Check the changes and try again.' })
    expect(await a.previewAccessAction(U, { changes: [], expectedVersion: -1 })).toMatchObject({ ok: false })
    expect(await a.applyAccessAction(U, { changes: [], expectedVersion: 1, token: 5 as unknown as string })).toMatchObject({ ok: false })
    expect(m.calls).toEqual([])
  })

  it('are rate limited per administrator', async () => {
    const a = await import('@/lib/actions/admin/access')
    m.limited = true
    for (const res of [await a.previewAccessAction(U, { changes: [], expectedVersion: 0 }), await a.applyAccessAction(U, { changes: [], expectedVersion: 0, token: 't' }), await a.keepReviewedAction({ grantIds: [U] })]) {
      expect(res).toEqual({ ok: false, error: 'Too many requests in a short time. Wait a minute and try again.' })
    }
    expect(m.calls).toEqual([])
  })

  it('refresh the pages only after a successful save, and hand the conflict back as it is', async () => {
    const a = await import('@/lib/actions/admin/access')
    await a.applyAccessAction(U, { changes: [], expectedVersion: 0, token: 't' })
    expect(m.revalidated).toEqual([`/admin/users/${U}/access`, '/admin/users', '/admin/access-review'])
    m.revalidated = []
    m.result = { ok: false, error: 'conflict', conflict: true }
    expect(await a.applyAccessAction(U, { changes: [], expectedVersion: 0, token: 't' })).toEqual({ ok: false, error: 'conflict', conflict: true })
    expect(m.revalidated).toEqual([])
  })

  it('do nothing at all when the gate refuses (operator, manager, viewer, or an administrator without admin.access)', async () => {
    const a = await import('@/lib/actions/admin/access')
    m.refuse = true
    await expect(a.previewAccessAction(U, { changes: [], expectedVersion: 0 })).rejects.toThrow('REDIRECT:/home')
    await expect(a.applyAccessAction(U, { changes: [], expectedVersion: 0, token: 't' })).rejects.toThrow('REDIRECT:/home')
    await expect(a.keepReviewedAction({ grantIds: [U] })).rejects.toThrow('REDIRECT:/home')
    expect(m.calls).toEqual([])
  })
})

describe('reactivation', () => {
  it('review M-1: the grant list is asked with whether the administrator may read access (admin.access)', async () => {
    const u = await import('@/lib/actions/admin/users')
    m.result = { ok: false, error: 'This person is active; their access is shown on the access screen.' }
    for (const may of [false, true]) {
      m.calls = []
      m.mayAccess = may
      expect(await u.reactivationReviewAction(U)).toEqual({ ok: false, error: 'This person is active; their access is shown on the access screen.' })
      expect(m.calls[0]).toMatchObject({ fn: 'reviewBeforeReactivation', args: [{ tag: 'admin' }, { id: 'a1', orgId: 'o1', role: 'admin' }, U, { mayReadAccess: may }] })
    }
  })

  it('revoking old grants on reactivation needs admin.access as well, and happens before the activation', async () => {
    const u = await import('@/lib/actions/admin/users')
    m.mayAccess = false
    expect(await u.setActiveAction(U, true, { revokeAll: { grantIds: [U], reason: 'Reviewed', expectedVersion: 1 } })).toEqual({ error: 'Removing access needs the right to change access (admin.access).' })
    expect(m.calls).toEqual([])
    m.mayAccess = true
    expect(await u.setActiveAction(U, true, { revokeAll: { grantIds: [U], reason: 'Reviewed', expectedVersion: 1 } })).toEqual({ ok: true })
    expect(m.calls.map((c) => c.fn)).toEqual(['revokeAll', 'updateUser'])
    // A failed revocation leaves the person deactivated.
    m.calls = []
    m.result = { ok: false, error: 'conflict' }
    expect(await u.setActiveAction(U, true, { revokeAll: { grantIds: [U], reason: 'Reviewed', expectedVersion: 1 } })).toEqual({ error: 'conflict', conflict: true })
    expect(m.calls.map((c) => c.fn)).toEqual(['revokeAll'])
  })
})
