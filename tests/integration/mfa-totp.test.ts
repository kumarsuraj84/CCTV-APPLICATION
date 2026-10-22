import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createUser, grant, type TestUser } from '../setup/fixtures'
import { mfaClient, totpCode, totpEnabled, totpSuiteMode, TOTP_SKIP_REASON } from '../helpers/totp'

// P3-1 brief item 1, the real authenticator flow: set-up with QR code and key, confirming with a code, the sign-in step, the shared count
// of codes, "Confirm it's you" with a code and with the password, the super administrator's reset (audited, every sign-in ended, a new
// set-up forced where required) and removing one's own app. Real Server Actions, real auth server, real database; only the Next request
// plumbing is replaced. Needs TOTP on in the auth server (supabase/config.toml, after the local stack restarts) or MFA_TEST_AUTH_URL
// (tests/helpers/totp.ts); without either the whole file is skipped and says so.

const m = vi.hoisted(() => ({ client: null as unknown, userId: '' }))
vi.mock('next/headers', async () => {
  const { signVerifiedUser, VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER } = await import('@/lib/auth/verified-user')
  return {
    headers: async () => {
      const h = new Headers({ 'x-request-path': '/admin/users' })
      const sig = signVerifiedUser(m.userId)
      if (sig && m.userId) {
        h.set(VERIFIED_USER_HEADER, m.userId)
        h.set(VERIFIED_USER_SIG_HEADER, sig)
      }
      return h
    },
    cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.client as SupabaseClient<Database> }))
// React's per-request cache would keep the first answer for the whole file: each call here is its own request.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(f: T) => f }))

const admin = () => adminClient()
const digest = (e: unknown) => String((e as { digest?: string })?.digest ?? e)
async function outcome(call: () => Promise<unknown>): Promise<{ redirect: string | null; value: unknown }> {
  try {
    return { redirect: null, value: await call() }
  } catch (e) {
    const d = digest(e)
    if (!d.includes('NEXT_REDIRECT')) throw e
    return { redirect: d.split(';')[2] ?? d, value: null }
  }
}
const actAs = (u: TestUser, c: SupabaseClient<Database>) => {
  m.client = c
  m.userId = u.id
}
const status = async (c: SupabaseClient<Database>) => ((await c.rpc('my_session_status')).data as { aal2: boolean; has_factor: boolean; last_auth_at: string }[])[0]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}

const setup = await (async () => {
  const org = await createOrg()
  const probe = await createUser(org, 'user')
  const enabled = await totpEnabled(await mfaClient(probe.email, probe.password))
  // Review I-6: without TOTP the file skips with the reason PRINTED, or fails when MULTI_FACTOR_TEST=required.
  const mode = totpSuiteMode(process.env, enabled)
  if (mode === 'skip') {
    console.warn(TOTP_SKIP_REASON)
    await cleanupOrg(org) // nothing will run; leave nothing behind
  }
  return { org, enabled, mode }
})()

describe.skipIf(setup.mode === 'skip')('two-step sign-in with an authenticator app (P3-1, real auth server)', () => {
  it('TOTP is available on the auth server the tests reach (with MULTI_FACTOR_TEST=required its absence fails here)', () => {
    if (setup.mode === 'fail') throw new Error(TOTP_SKIP_REASON)
    expect(setup.enabled).toBe(true)
  })

  const org = setup.org
  let owner: TestUser, adminUser: TestUser, viewer: TestUser, guesser: TestUser, plain: TestUser
  const secrets = new Map<string, string>()
  const usedCodes = new Map<string, string>()

  beforeAll(async () => {
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users'])
    adminUser = await createUser(org, 'admin')
    await grant(org, adminUser.id, ['admin.users', 'cctv.live'])
    viewer = await createUser(org, 'user')
    await grant(org, viewer.id, ['cctv.live'])
    guesser = await createUser(org, 'user')
    plain = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  async function enrol(u: TestUser): Promise<SupabaseClient<Database>> {
    const c = await mfaClient(u.email, u.password)
    actAs(u, c)
    const mfa = await import('@/lib/actions/mfa')
    const s = (await outcome(() => mfa.startEnrolmentAction())).value as { ok: boolean; factorId: string; qrCode: string; secret: string }
    expect(s.ok).toBe(true)
    expect(s.qrCode.startsWith('data:image/svg+xml')).toBe(true)
    expect(s.secret).toMatch(/^[A-Z2-7]{16,}$/)
    secrets.set(u.id, s.secret)
    expect((await outcome(() => mfa.confirmEnrolmentAction(s.factorId, totpCode(s.secret)))).value).toEqual({ ok: true })
    return c
  }

  it('set-up: QR code and key, a wrong code is refused and audited, the right one finishes it (aal2), audited', async () => {
    const c = await mfaClient(adminUser.email, adminUser.password)
    actAs(adminUser, c)
    const mfa = await import('@/lib/actions/mfa')
    const { MSG_BAD_CODE } = await import('@/lib/auth/mfa')
    const s = (await outcome(() => mfa.startEnrolmentAction())).value as { ok: boolean; factorId: string; secret: string }
    expect(s.ok).toBe(true)
    const wrong = totpCode(s.secret) === '000000' ? '111111' : '000000'
    expect((await outcome(() => mfa.confirmEnrolmentAction(s.factorId, wrong))).value).toEqual({ ok: false, error: MSG_BAD_CODE })
    expect((await outcome(() => mfa.confirmEnrolmentAction(s.factorId, totpCode(s.secret)))).value).toEqual({ ok: true })
    secrets.set(adminUser.id, s.secret)
    expect(await status(c)).toMatchObject({ aal2: true, has_factor: true })
    const events = ((await admin().from('auth_events').select('event').eq('user_id', adminUser.id)).data ?? []).map((r) => r.event)
    expect(events).toEqual(expect.arrayContaining(['mfa_failed', 'mfa_enrolled']))
    // Nothing of the secret is in the audit.
    expect(JSON.stringify((await admin().from('auth_events').select('*').eq('user_id', adminUser.id)).data)).not.toContain(s.secret)
    // Review I-4: the people screen knows when the app was set up (from the sign-in audit).
    const { twoStepSummary } = await import('@/lib/admin/sessions')
    const summary = await twoStepSummary(admin(), org)
    expect(summary?.get(adminUser.id)).toMatchObject({ factors: 1 })
    expect(Math.abs(Date.now() - Date.parse(summary!.get(adminUser.id)!.enrolledAt!))).toBeLessThan(5 * 60_000)
    // One app per person: a second set-up is refused while one exists.
    expect(((await outcome(() => mfa.startEnrolmentAction())).value as { ok: boolean }).ok).toBe(false)
  })

  it('the next sign-in asks for the code before anything else; the code finishes it', async () => {
    const c = await mfaClient(adminUser.email, adminUser.password)
    actAs(adminUser, c)
    const { requireAdministration } = await import('@/lib/auth/profile')
    expect((await outcome(() => requireAdministration('admin.users'))).redirect).toBe('/mfa?next=%2Fadmin%2Fusers')
    const mfa = await import('@/lib/actions/mfa')
    await sleep(31_000) // the set-up used this window's code; a code counts once (review M-9)
    const code = totpCode(secrets.get(adminUser.id)!)
    usedCodes.set(adminUser.id, code)
    expect((await outcome(() => mfa.verifyCodeAction({}, fd({ code, next: '/admin/users' })))).redirect).toBe('/admin/users')
    expect((await status(c)).aal2).toBe(true)
    expect(((await outcome(() => requireAdministration('admin.users'))).value as { id: string }).id).toBe(adminUser.id)
  }, 70_000)

  it('review M-9: a code is accepted once: the same code in another sign-in (within its window) is refused', async () => {
    const mfa = await import('@/lib/actions/mfa')
    const { MSG_CODE_USED } = await import('@/lib/auth/mfa')
    const code = usedCodes.get(adminUser.id)!
    // The code the previous test used (still in, or next to, its window): GoTrue alone would accept it again (measured in review round 1).
    const second = await mfaClient(adminUser.email, adminUser.password)
    actAs(adminUser, second)
    expect((await outcome(() => mfa.verifyCodeAction({}, fd({ code, next: '/home' })))).value).toEqual({ error: MSG_CODE_USED })
    expect((await status(second)).aal2).toBe(false)
    const events = ((await admin().from('auth_events').select('event, detail').eq('user_id', adminUser.id).eq('event', 'mfa_failed')).data ?? [])
    expect(events.some((e) => (e.detail as { reason?: string }).reason === 'code_reused')).toBe(true)
  })

  it('codes are counted: six codes per person in five minutes (the set-up code counts too), then even the right one waits', async () => {
    await enrol(guesser) // code 1 of 6
    const again = await mfaClient(guesser.email, guesser.password)
    actAs(guesser, again)
    const mfa = await import('@/lib/actions/mfa')
    const { MSG_BAD_CODE } = await import('@/lib/auth/mfa')
    const { MSG_TOO_MANY_CODES } = await import('@/lib/auth/auth-limits')
    const right = totpCode(secrets.get(guesser.id)!)
    // Five different wrong codes (one code counts once since review M-9, so a repeated wrong code would be "used already").
    const wrongs = ['111111', '222222', '333333', '444444', '555555', '666666'].filter((c) => c !== right).slice(0, 5)
    for (const [i, wrong] of wrongs.entries()) expect((await outcome(() => mfa.verifyCodeAction({}, fd({ code: wrong, next: '/home' })))).value, `try ${i + 2}`).toEqual({ error: MSG_BAD_CODE })
    expect((await outcome(() => mfa.verifyCodeAction({}, fd({ code: right, next: '/home' })))).value).toEqual({ error: MSG_TOO_MANY_CODES })
    expect((await status(again)).aal2).toBe(false)
  })

  it('"Confirm it’s you" with a code moves the last authentication to now (fresh sign-in)', async () => {
    const c = await enrol(viewer)
    const before = Date.parse((await status(c)).last_auth_at)
    await sleep(31_000) // the next 30-second code
    actAs(viewer, c)
    const mfa = await import('@/lib/actions/mfa')
    expect((await outcome(() => mfa.confirmIdentityAction({}, fd({ code: totpCode(secrets.get(viewer.id)!) })))).value).toEqual({ done: true })
    expect(Date.parse((await status(c)).last_auth_at)).toBeGreaterThan(before + 25_000)
  }, 70_000)

  it('"Confirm it’s you" with the password (no app): a new sign-in, the old one ended', async () => {
    const c = await mfaClient(plain.email, plain.password)
    const oldRefresh = (await c.auth.getSession()).data.session!.refresh_token
    actAs(plain, c)
    const mfa = await import('@/lib/actions/mfa')
    const { MSG_WRONG_PASSWORD } = await import('@/lib/auth/mfa')
    expect((await outcome(() => mfa.confirmIdentityAction({}, fd({ password: 'not-it' })))).value).toEqual({ error: MSG_WRONG_PASSWORD })
    expect((await outcome(() => mfa.confirmIdentityAction({}, fd({ password: plain.password, next: '/admin/users' })))).redirect).toBe('/admin/users')
    const other = await mfaClient(plain.email, plain.password)
    expect((await other.auth.refreshSession({ refresh_token: oldRefresh })).error).not.toBeNull()
    const events = ((await admin().from('auth_events').select('event').eq('user_id', plain.id)).data ?? []).map((r) => r.event)
    expect(events).toEqual(expect.arrayContaining(['reauth_failed', 'reauth']))
  })

  it('removing one’s own app: refused where it is required (switched on, administrator), allowed for a viewer', async () => {
    const { error } = await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: true })
    expect(error).toBeNull()
    try {
      const mfa = await import('@/lib/actions/mfa')
      const { MSG_REQUIRED } = await import('@/lib/auth/mfa')
      await sleep(31_000) // codes not used yet
      const a = await mfaClient(adminUser.email, adminUser.password)
      actAs(adminUser, a)
      expect((await outcome(() => mfa.verifyCodeAction({}, fd({ code: totpCode(secrets.get(adminUser.id)!), next: '/home' })))).redirect).toBe('/home')
      expect((await outcome(() => mfa.removeOwnFactorAction())).value).toEqual({ ok: false, error: MSG_REQUIRED })
      // The viewer (optional for them) enrolled above; with this aal2 session and a fresh sign-in they may remove it.
      const v = await mfaClient(viewer.email, viewer.password)
      actAs(viewer, v)
      expect((await outcome(() => mfa.verifyCodeAction({}, fd({ code: totpCode(secrets.get(viewer.id)!), next: '/home' })))).redirect).toBe('/home')
      expect((await outcome(() => mfa.removeOwnFactorAction())).value).toEqual({ ok: true })
      expect((await status(v)).has_factor).toBe(false)
    } finally {
      await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: false })
    }
  }, 70_000)

  it('a super administrator resets an administrator’s app: audited, apps gone, every sign-in ended, a new set-up forced where required', async () => {
    const victim = await mfaClient(adminUser.email, adminUser.password)
    const ownerClient = await mfaClient(owner.email, owner.password)
    actAs(owner, ownerClient)
    const sessions = await import('@/lib/actions/admin/sessions')
    expect((await outcome(() => sessions.resetFactorsAction(adminUser.id, 'lost phone'))).value).toEqual({ ok: true, removed: 1 })
    expect((await admin().rpc('mfa_factor_people', { p_org: org })).data).not.toContainEqual(expect.objectContaining({ user_id: adminUser.id }))
    expect((await victim.auth.refreshSession()).error).not.toBeNull()
    expect((await admin().from('admin_audit_log').select('detail').eq('entity_id', adminUser.id).eq('action', 'mfa_factor_reset')).data).toEqual([
      { detail: { reason: 'lost phone', factors: 1, verified: 1 } },
    ])
    expect((await admin().from('auth_events').select('event, actor_id').eq('user_id', adminUser.id).eq('event', 'mfa_factor_reset')).data).toEqual([{ event: 'mfa_factor_reset', actor_id: owner.id }])
    await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: true })
    try {
      const fresh = await mfaClient(adminUser.email, adminUser.password)
      actAs(adminUser, fresh)
      const { requireAdministration } = await import('@/lib/auth/profile')
      expect((await outcome(() => requireAdministration('admin.users'))).redirect).toBe('/mfa/enrol?next=%2Fadmin%2Fusers')
    } finally {
      await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: false })
    }
  })
})

describe.skipIf(setup.mode !== 'skip')('two-step sign-in with an authenticator app (skipped)', () => {
  it.skip(TOTP_SKIP_REASON, () => {})
})
