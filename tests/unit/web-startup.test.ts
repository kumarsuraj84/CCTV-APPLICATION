import { describe, expect, it, vi } from 'vitest'
import { signServiceJwt } from '@/scripts/lib/service-jwt.mjs'
import { webStartupProblems } from '@/lib/startup-web'

// P2-6 review round 1, M-16 / M-3 / I-2: the web app checks itself once when the server starts (instrumentation.ts register()). In
// production mode it refuses to start when its keys or shared secrets are missing, when go2rtc answers without its login, or while an
// active organisation has not locked the service key out of NVR logins (security_unlocked_organizations()). Development: no check.

const SECRET = 'a-test-jwt-secret-that-is-long-enough-1234567890'
const prod = () => ({
  DRISHTI_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  SUPABASE_APP_WEB_KEY: signServiceJwt(SECRET, 'app_web'), SUPABASE_MEDIA_SERVICE_KEY: signServiceJwt(SECRET, 'media_service'),
  STREAM_TOKEN_SECRET: 's'.repeat(43), ACCESS_PREVIEW_SECRET: 'p'.repeat(43), MERGE_CONFIRM_SECRET: 'm'.repeat(43), VERIFIED_USER_SECRET: 'v'.repeat(43),
  GO2RTC_API_USERNAME: 'drishti', GO2RTC_API_PASSWORD: 'g'.repeat(43),
})
const deps = (unlocked: number | Error, probe: { ok: true } | { ok: false; error: string } = { ok: true }) => ({
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
})
