import { describe, expect, it, vi } from 'vitest'
import { signServiceJwt } from '@/scripts/lib/service-jwt.mjs'
import { webStartupProblems } from '@/lib/startup-web'

// P2-6 review round 1, M-16 / M-3 / I-2: the web app checks itself once when the server starts (instrumentation.ts register()). In
// production mode it refuses to start when its keys or shared secrets are missing, when go2rtc answers without its login, or while an
// active organisation has not locked the service key out of NVR logins (security_unlocked_organizations()). Development: no check.

const SECRET = 'a-test-jwt-secret-that-is-long-enough-1234567890'
const strong = (seed: string) => `${seed}-Qw7xK2pLm9Zr4Tb8Nc1Vh6Yd3Fs5Gj0Ek`.slice(0, 43)
const prod = () => ({
  // Release 1 (P3-1 re-review I-5 / R-1): the single-host layout, Supabase on this computer (a private-network name now needs the
  // owner's DRISHTI_AUTH_URL_PRIVATE_OK=firewalled; tests/unit/auth-url-check.test.ts).
  DRISHTI_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55321', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_APP_WEB_KEY: signServiceJwt(SECRET, 'app_web'), SUPABASE_MEDIA_SERVICE_KEY: signServiceJwt(SECRET, 'media_service'),
  // P5.4: production refuses weak secrets, so the fixtures are strong, distinct values (as gen-secrets makes).
  STREAM_TOKEN_SECRET: strong('st'), ACCESS_PREVIEW_SECRET: strong('ap'), MERGE_CONFIRM_SECRET: strong('mc'), VERIFIED_USER_SECRET: strong('vu'),
  GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: strong('go'),
})
const deps = (unlocked: number | Error, probe: { ok: true } | { ok: false; error: string } = { ok: true }, fixtures: boolean | Error = false) => ({
  testFixturesOn: vi.fn(async () => {
    if (fixtures instanceof Error) throw fixtures
    return fixtures
  }),
  unlockedOrganizations: vi.fn(async () => {
    if (unlocked instanceof Error) throw unlocked
    return unlocked
  }),
  probeGo2rtc: vi.fn(async () => probe),
})

describe('web app start-up check', () => {
  it('development: nothing is asked, nothing refused', async () => {
    const d = deps(5, { ok: false, error: 'x' })
    expect(await webStartupProblems({}, d)).toEqual([])
    expect(d.unlockedOrganizations).not.toHaveBeenCalled()
    expect(d.probeGo2rtc).not.toHaveBeenCalled()
  })

  it('production with everything in place: no problem', async () => {
    expect(await webStartupProblems(prod(), deps(0))).toEqual([])
  })

  it('production: the static problems (keys, secrets, go2rtc login) are reported without asking the database', async () => {
    const d = deps(0)
    const p = await webStartupProblems({ ...prod(), SUPABASE_APP_WEB_KEY: '' }, d)
    expect(p.join(' ')).toContain('SUPABASE_APP_WEB_KEY')
  })

  it('M-3: production refuses while an active organisation has not locked the service key out of NVR logins', async () => {
    expect((await webStartupProblems(prod(), deps(2))).join(' ')).toMatch(/2 organisations.*service_role_credential_reads/)
    expect((await webStartupProblems(prod(), deps(new Error('down')))).join(' ')).toContain('could not be checked')
  })

  it('I-2: production refuses when go2rtc answers without its login', async () => {
    expect((await webStartupProblems(prod(), deps(0, { ok: false, error: 'go2rtc answers without its login' }))).join(' ')).toContain('without its login')
  })

  // P5.4 fix round 2 (re-review N-2): a database whose test fixture switch is on was seeded for tests (supabase/seed.sql); the
  // production web app does not start on it, and says what to do. An unreadable switch refuses too.
  it('N-2: production refuses while the test fixture switch is on, or when it cannot be read', async () => {
    const on = (await webStartupProblems(prod(), deps(0, { ok: true }, true))).join(' ')
    expect(on).toMatch(/test fixture switch is on/)
    expect(on).toMatch(/seed.sql/)
    expect((await webStartupProblems(prod(), deps(0, { ok: true }, new Error('down')))).join(' ')).toMatch(/test fixture switch could not be checked/)
    const d = deps(0, { ok: true }, true)
    expect(await webStartupProblems({}, d)).toEqual([])
    expect(d.testFixturesOn).not.toHaveBeenCalled()
  })
})
