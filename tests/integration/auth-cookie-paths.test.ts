import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'
import { authFetch, mfaClient, totpCode, totpEnabled, totpSuiteMode, TOTP_SKIP_REASON } from '../helpers/totp'

// P3-1 review I-1 with the REAL cookie client (lib/supabase/server.ts) and the real auth server: every sign-in path writes its cookies
// HttpOnly and SameSite=Lax (and Secure when the site is https) — the sign-in, "Confirm it's you" by password, the password change, and
// (when TOTP is on) the code step and the set-up. Only Next's cookie store is replaced by a jar that records every write.

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>(), writes: [] as { name: string; options: Record<string, unknown> }[] }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    getAll: () => [...jar.cookies].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.writes.push({ name, options })
      if (options?.maxAge === 0 || value === '') jar.cookies.delete(name)
      else jar.cookies.set(name, value)
    },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
// Auth calls go to MFA_TEST_AUTH_URL when it is set (a TOTP-enabled auth server on the same database), as in mfa-totp.test.ts.
vi.mock('@/lib/supabase/resilient-fetch', () => ({ resilientFetch: (...a: Parameters<typeof fetch>) => authFetch(...a) }))
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(f: T) => f }))

const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const digest = (e: unknown) => String((e as { digest?: string })?.digest ?? e)
async function quietly(call: () => Promise<unknown>) {
  try {
    return await call()
  } catch (e) {
    if (!digest(e).includes('NEXT_REDIRECT')) throw e
    return 'redirect'
  }
}
const authWrites = () => jar.writes.filter((w) => w.name.startsWith('sb-'))
function expectHardened(what: string, https = false) {
  const w = authWrites()
  expect(w.length, `${what}: auth cookies written`).toBeGreaterThan(0)
  for (const x of w) {
    expect(x.options.httpOnly, `${what}: ${x.name} HttpOnly`).toBe(true)
    expect(x.options.sameSite, `${what}: ${x.name} SameSite`).toBe('lax')
    if (https) expect(x.options.secure, `${what}: ${x.name} Secure`).toBe(true)
  }
}

describe('sign-in cookies on every path (review I-1)', () => {
  let org: string
  let person: TestUser

  beforeAll(async () => {
    org = await createOrg()
    person = await createUser(org, 'admin')
  })
  afterAll(() => cleanupOrg(org))

  it('the sign-in, "Confirm it’s you" by password and the password change write HttpOnly, Lax cookies; Secure on https', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://drishti.citykart.local')
    const auth = await import('@/lib/actions/auth')
    const mfa = await import('@/lib/actions/mfa')
    jar.cookies.clear()
    jar.writes = []
    expect(await quietly(() => auth.signIn({}, fd({ email: person.email, password: person.password, next: '/home' })))).toBe('redirect')
    expectHardened('sign-in', true)
    jar.writes = []
    expect(await quietly(() => mfa.confirmIdentityAction({}, fd({ password: person.password })))).toEqual({ done: true })
    expectHardened('confirm it is you', true)
    jar.writes = []
    const next = `${person.password}x9!`
    expect(await quietly(() => auth.changePassword({}, fd({ password: next, confirm: next })))).toBe('redirect')
    expectHardened('password change', true)
    vi.unstubAllEnvs()
  })
})

const probe = await (async () => {
  const org = await createOrg()
  const u = await createUser(org, 'user')
  const enabled = await totpEnabled(await mfaClient(u.email, u.password))
  return { org, u, mode: totpSuiteMode(process.env, enabled) }
})()
if (probe.mode === 'skip') console.warn(TOTP_SKIP_REASON)

describe.skipIf(probe.mode === 'skip')('sign-in cookies of the code step and the set-up (review I-1, needs TOTP)', () => {
  afterAll(() => cleanupOrg(probe.org))

  it('TOTP is available (MULTI_FACTOR_TEST=required makes its absence a failure)', () => {
    if (probe.mode === 'fail') throw new Error(TOTP_SKIP_REASON)
  })

  it('setting up an app and the code step write HttpOnly, Lax cookies', async () => {
    const auth = await import('@/lib/actions/auth')
    const mfa = await import('@/lib/actions/mfa')
    jar.cookies.clear()
    jar.writes = []
    await quietly(() => auth.signIn({}, fd({ email: probe.u.email, password: probe.u.password, next: '/home' })))
    const s = (await quietly(() => mfa.startEnrolmentAction())) as { ok: boolean; factorId: string; secret: string }
    expect(s.ok).toBe(true)
    jar.writes = []
    expect(await quietly(() => mfa.confirmEnrolmentAction(s.factorId, totpCode(s.secret)))).toEqual({ ok: true })
    expectHardened('set-up')
    // A new sign-in, then the code step (the next 30-second code: a code counts once).
    jar.cookies.clear()
    await quietly(() => auth.signIn({}, fd({ email: probe.u.email, password: probe.u.password, next: '/home' })))
    jar.writes = []
    await new Promise((r) => setTimeout(r, 31_000))
    expect(await quietly(() => mfa.verifyCodeAction({}, fd({ code: totpCode(s.secret), next: '/home' })))).toBe('redirect')
    expectHardened('code step')
  }, 70_000)
})

if (probe.mode === 'skip') afterAll(() => cleanupOrg(probe.org))
