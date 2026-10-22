import { beforeEach, describe, expect, it, vi } from 'vitest'

// P2-2: getCurrentProfile carries the request's capability summary (one my_access_summary call per request); the page and action gates
// use it. requireCapability: any of the capabilities at any scope; requireAdministration: an administrative role AND the admin.*
// capability for the whole organisation. Everything else is sent home.

const m = vi.hoisted(() => ({
  profile: null as null | Record<string, unknown>,
  summary: [] as unknown[],
  summaryError: null as null | { code: string },
  rpcCalls: [] as string[],
  // P3-1: the session facts (my_session_status) read next to the summary.
  session: null as null | Record<string, unknown>,
}))

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(f: T) => f }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))
vi.mock('@/lib/auth/verified-user', () => ({ readVerifiedUserId: () => 'u1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.profile }) }) }) }),
    rpc: async (fn: string) => {
      m.rpcCalls.push(fn)
      if (fn === 'my_session_status') return { data: m.session ? [m.session] : [], error: null }
      return { data: m.summaryError ? null : m.summary, error: m.summaryError }
    },
  }),
}))

const base = { id: 'u1', org_id: 'o1', email: 'a@b.c', full_name: 'A', is_active: true, must_reset_password: false, store_id: null }
const row = (capability: string, organization_wide = false) => ({ capability, organization_wide, location_ids: organization_wide ? [] : ['l1'], camera_ids: [], asset_ids: [] })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  m.profile = { ...base, role: 'user' }
  m.summary = []
  m.summaryError = null
  m.rpcCalls = []
  m.session = { mfa_enforced: false, privileged: false, aal2: false, has_factor: false, session_id: null, signed_in_at: null, last_auth_at: null }
})

describe('getCurrentProfile', () => {
  it('carries the capability summary read through the person\'s own client', async () => {
    m.summary = [row('cctv.live'), row('it.monitoring.view', true)]
    const { getCurrentProfile } = await import('@/lib/auth/profile')
    const p = await getCurrentProfile()
    expect(p?.capabilities.failed).toBe(false)
    expect(Object.keys(p!.capabilities.grants)).toEqual(['cctv.live', 'it.monitoring.view'])
    // P3-1: the session facts are read once per request too (my_session_status), next to the summary.
    expect(m.rpcCalls.sort()).toEqual(['my_access_summary', 'my_session_status'])
  })

  it('reads no summary for a deactivated person (there is no profile)', async () => {
    m.profile = { ...base, role: 'admin', is_active: false }
    const { getCurrentProfile } = await import('@/lib/auth/profile')
    expect(await getCurrentProfile()).toBeNull()
    expect(m.rpcCalls).toEqual([])
  })

  it('a summary that cannot be read gives no capabilities and is marked failed (fail closed)', async () => {
    m.summaryError = { code: '57014' }
    const { getCurrentProfile } = await import('@/lib/auth/profile')
    const p = await getCurrentProfile()
    expect(p?.capabilities).toEqual({ failed: true, grants: {} })
  })
})

describe('requireCapability', () => {
  it('lets through a person holding one of the capabilities, at any scope', async () => {
    m.summary = [row('cctv.playback')]
    const { requireCapability } = await import('@/lib/auth/profile')
    expect((await requireCapability(['cctv.live', 'cctv.playback'])).id).toBe('u1')
    expect((await requireCapability('cctv.playback')).id).toBe('u1')
  })

  it('sends home a person holding only a different capability, whatever their role', async () => {
    for (const role of ['user', 'operator', 'manager', 'admin', 'platform_owner']) {
      m.profile = { ...base, role }
      m.summary = [row('cctv.playback'), row('admin.inventory', true)]
      const { requireCapability } = await import('@/lib/auth/profile')
      await expect(requireCapability('cctv.live'), role).rejects.toThrow('REDIRECT:/home')
    }
  })

  it('sends a signed-out person to sign in and a must-reset person to change their password first', async () => {
    const { requireCapability } = await import('@/lib/auth/profile')
    m.profile = null
    await expect(requireCapability('cctv.live')).rejects.toThrow('REDIRECT:/login')
    m.profile = { ...base, role: 'user', must_reset_password: true }
    m.summary = [row('cctv.live')]
    await expect(requireCapability('cctv.live')).rejects.toThrow('REDIRECT:/change-password')
  })
})

describe('requireAdministration and mayAdminister', () => {
  it('needs an administrative role AND the admin capability for the whole organisation', async () => {
    const { requireAdministration, mayAdminister, getCurrentProfile } = await import('@/lib/auth/profile')
    m.profile = { ...base, role: 'admin' }
    m.summary = [row('admin.users', true)]
    expect((await requireAdministration('admin.users')).id).toBe('u1')
    await expect(requireAdministration('admin.inventory')).rejects.toThrow('REDIRECT:/home')
    expect(mayAdminister((await getCurrentProfile())!, 'admin.users')).toBe(true)
    expect(mayAdminister((await getCurrentProfile())!, 'admin.access')).toBe(false)
  })

  it('the role alone is not enough, and the capability without the role is not enough', async () => {
    const { requireAdministration } = await import('@/lib/auth/profile')
    m.profile = { ...base, role: 'platform_owner' }
    m.summary = []
    await expect(requireAdministration('admin.users')).rejects.toThrow('REDIRECT:/home')
    for (const role of ['user', 'operator', 'manager']) {
      m.profile = { ...base, role }
      m.summary = [row('admin.users', true)]
      await expect(requireAdministration('admin.users'), role).rejects.toThrow('REDIRECT:/home')
    }
  })

  it('P3-1: a person with an authenticator app finishes the code first (before anything else, even choosing a password)', async () => {
    const { requireProfile, requireAdministration } = await import('@/lib/auth/profile')
    m.profile = { ...base, role: 'user', must_reset_password: true }
    m.session = { ...m.session, has_factor: true }
    await expect(requireProfile()).rejects.toThrow('REDIRECT:/mfa?next=%2Fhome')
    m.profile = { ...base, role: 'admin' }
    m.summary = [row('admin.users', true)]
    await expect(requireAdministration('admin.users')).rejects.toThrow('REDIRECT:/mfa')
    m.session = { ...m.session, has_factor: true, aal2: true }
    expect((await requireAdministration('admin.users')).id).toBe('u1')
  })

  it('P3-1: switched on, an administrator without an authenticator app must set one up; switched off, nobody must', async () => {
    const { requireProfile } = await import('@/lib/auth/profile')
    m.profile = { ...base, role: 'admin' }
    m.session = { ...m.session, privileged: true, mfa_enforced: true }
    await expect(requireProfile()).rejects.toThrow('REDIRECT:/mfa/enrol?next=%2Fhome')
    m.session = { ...m.session, privileged: true, mfa_enforced: false }
    expect((await requireProfile()).id).toBe('u1')
    m.profile = { ...base, role: 'user' }
    m.session = { ...m.session, privileged: false, mfa_enforced: true }
    expect((await requireProfile()).id).toBe('u1') // optional for viewers (D-10a)
  })

  it('P3-1: the session facts are on the profile (seconds), and unreadable facts mean no facts (the database still decides access)', async () => {
    const { getCurrentProfile, requireProfile } = await import('@/lib/auth/profile')
    m.session = { ...m.session, signed_in_at: '2026-10-23T00:00:00Z', last_auth_at: '2026-10-23T00:05:00Z', session_id: 's1' }
    expect((await getCurrentProfile())?.session).toMatchObject({ signedInAt: 1792713600, lastAuthAt: 1792713900, sessionId: 's1' })
    m.session = null
    expect((await getCurrentProfile())?.session).toBeNull()
    expect((await requireProfile()).id).toBe('u1')
  })

  it('requireAdmin (the role-only gate) is gone', async () => {
    const mod = await import('@/lib/auth/profile')
    expect('requireAdmin' in mod).toBe(false)
  })
})
