import { beforeEach, describe, expect, it, vi } from 'vitest'

// Final fix Y (final review B minor 7): changing one's own password ends the other sign-ins (scope others) AND their open video: a
// thief's open sockets would otherwise keep playing until the 30-minute limit, because the 15 s re-check validates access, not the
// sign-in. The person's own wall reconnects with new tokens.

const m = vi.hoisted(() => ({ revoked: [] as unknown[][], signOut: [] as unknown[], updateError: null as null | { message: string } }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to}` }) } }))
vi.mock('@/lib/auth/fresh', () => ({ requireFreshProfile: async () => ({ ok: true, profile: { id: 'u1', org_id: 'o1', must_reset_password: false } }) }))
vi.mock('@/lib/rate-limit-shared', async (orig) => ({ ...(await orig<typeof import('@/lib/rate-limit-shared')>()), refusalFor: async () => null }))
vi.mock('@/lib/auth/auth-events', () => ({ recordAuthEvent: async () => {} }))
vi.mock('@/lib/streams/registry', () => ({ revokeMediaSessions: async (...a: unknown[]) => { m.revoked.push(a) } }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ tag: 'admin', from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1' } } }),
      updateUser: async () => ({ error: m.updateError }),
      signOut: async (o: unknown) => (m.signOut.push(o), { error: null }),
    },
  }),
}))

const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const NEW = 'A-new-Passw0rd-that-is-long'

describe('changing one\'s own password (final fix Y, B minor 7)', () => {
  beforeEach(() => {
    m.revoked = []
    m.signOut = []
    m.updateError = null
  })

  it('ends the other sign-ins and every open video of the person, then goes home', async () => {
    const { changePassword } = await import('@/lib/actions/auth')
    await expect(changePassword({}, fd({ password: NEW, confirm: NEW }))).rejects.toThrow('NEXT_REDIRECT')
    expect(m.signOut).toEqual([{ scope: 'others' }])
    expect(m.revoked).toEqual([[expect.objectContaining({ tag: 'admin' }), 'o1', 'u1', 'password_changed']])
  })

  it('a refused change ends nothing', async () => {
    const { changePassword } = await import('@/lib/actions/auth')
    m.updateError = { message: 'weak' }
    expect(await changePassword({}, fd({ password: NEW, confirm: NEW }))).toHaveProperty('error')
    expect(m.revoked).toEqual([])
  })
})
