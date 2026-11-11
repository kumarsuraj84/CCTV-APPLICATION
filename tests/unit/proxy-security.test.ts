import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nextConfig from '../../next.config'
import { ACTIVITY_COOKIE, encodeActivity } from '@/lib/auth/session-activity'
import { parseCsp, REDIRECT_CSP } from '@/lib/web/csp'

// P3-1 brief items 2 and 7: the proxy puts the Content Security Policy on every answer it gives (pages, API routes, its own
// redirects) with a fresh nonce that Next.js also receives, and ends sign-ins that were idle too long or are older than their lifetime.

const KEY = 'activity-test-key-'.padEnd(48, 'x')
const now = () => Math.floor(Date.now() / 1000)
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

const m = vi.hoisted(() => ({
  user: null as null | { id: string },
  token: '' as string,
  role: 'admin' as string | null,
  setAll: [] as { name: string; value: string; options: Record<string, unknown> }[],
  signedOut: 0,
  events: [] as { event: string; userId?: string | null }[],
  revoked: [] as { org: string; user: string; reason: string }[],
  roleReads: 0,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_u: string, _k: string, o: { cookies: { setAll: (l: unknown[]) => void } }) => ({
    auth: {
      getUser: async () => {
        // A refreshed session writes its cookies, as @supabase/ssr does.
        if (m.user) o.cookies.setAll([{ name: 'sb-localhost-auth-token', value: 'refreshed', options: { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 100 } }])
        return { data: { user: m.user } }
      },
      getSession: async () => ({ data: { session: m.user ? { access_token: m.token } : null } }),
      signOut: async () => {
        m.signedOut++
        o.cookies.setAll([{ name: 'sb-localhost-auth-token', value: '', options: { path: '/', maxAge: 0 } }])
        return { error: null }
      },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { m.roleReads++; return { data: m.role ? { role: m.role, org_id: 'org-1' } : null } } }) }) }),
  }),
}))
// Review M-3: an ended sign-in also ends the person's open video.
vi.mock('@/lib/streams/registry', () => ({ revokeMediaSessions: async (_a: unknown, org: string, user: string, reason: string) => { m.revoked.push({ org, user, reason }); return true } }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/auth/auth-events', () => ({
  recordAuthEvent: async (e: { event: string; userId?: string | null }) => {
    m.events.push(e)
    return true
  },
}))

const { proxy } = await import('@/proxy')

function run(path: string, o: { host?: string; cookie?: string; method?: string } = {}) {
  const url = new URL(path, `http://${o.host ?? '10.0.0.47:3212'}`)
  return proxy(new NextRequest(url, { method: o.method ?? 'GET', headers: { host: url.host, ...(o.cookie ? { cookie: o.cookie } : {}) } }))
}
const signedIn = (o: { signedInAgo?: number; role?: string | null; sid?: string } = {}) => {
  m.user = { id: '11111111-1111-4111-8111-111111111111' }
  m.role = o.role === undefined ? 'admin' : o.role
  const t = now() - (o.signedInAgo ?? 60)
  m.token = jwt({ session_id: o.sid ?? 'sess-1', aal: 'aal1', amr: [{ method: 'password', timestamp: t }] })
}
const activity = (secondsAgo: number, idle: number, sid = 'sess-1') => `${ACTIVITY_COOKIE}=${encodeActivity({ sid, seen: now() - secondsAgo, idle }, KEY)}`
const csp = (res: Response) => res.headers.get('content-security-policy') ?? ''
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`)

beforeEach(() => {
  vi.stubEnv('VERIFIED_USER_SECRET', KEY)
  vi.stubEnv('NEXT_PUBLIC_STREAM_GATEWAY_URL', '')
  vi.stubEnv('NEXT_PUBLIC_STREAM_GATEWAY_PORT', '')
  vi.stubEnv('CSP_REPORT_ONLY', '')
  vi.stubEnv('CSP_CONNECT_EXTRA', '')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://10.0.0.47:3212')
  m.user = null
  m.setAll = []
  m.signedOut = 0
  m.events = []
  m.revoked = []
  m.roleReads = 0
})
afterEach(() => vi.unstubAllEnvs())

describe('P3-1 review round 1 in the proxy', () => {
  it('M-3: an ended sign-in also ends the person’s open video', async () => {
    signedIn({ signedInAgo: 13 * 3600 })
    await run('/live', { cookie: activity(5, 60) })
    expect(m.revoked).toEqual([{ org: 'org-1', user: m.user!.id, reason: 'session_expired' }])
  })

  it('M-6: each renewal of the activity record reads the role again (a person made administrator gets the shorter limit)', async () => {
    signedIn({ signedInAgo: 3 * 3600, role: 'admin' })
    const res = await run('/home', { cookie: activity(120, 480) })
    expect(m.roleReads).toBe(1)
    expect(res.cookies.get(ACTIVITY_COOKIE)?.value).toMatch(/^v1\.sess-1\.\d+\.60\./)
  })

  it('M-7: in production the policy and the sign-in redirect use the configured app address, not the Host the request names', async () => {
    vi.stubEnv('DRISHTI_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://drishti.citykart.local')
    const page = await run('/api/health', { host: 'evil.example:3212' })
    expect(parseCsp(csp(page))['connect-src']).toEqual(["'self'", 'https://drishti.citykart.local:3412', 'wss://drishti.citykart.local:3412'])
    const redirect = await run('/admin/users', { host: 'evil.example:3212' })
    expect(new URL(redirect.headers.get('location')!).host).toBe('drishti.citykart.local')
  })
})

describe('Content Security Policy on every kind of answer', () => {
  it('a page: the policy with a fresh nonce, which Next.js also receives in the request', async () => {
    signedIn()
    const a = await run('/home', { cookie: activity(10, 60) })
    const b = await run('/home', { cookie: activity(10, 60) })
    const p = parseCsp(csp(a))
    const nonce = /'nonce-([^']+)'/.exec(csp(a))?.[1]
    expect(nonce).toBeTruthy()
    expect(/'nonce-([^']+)'/.exec(csp(b))?.[1]).not.toBe(nonce)
    expect(forwarded(a, 'x-nonce')).toBe(nonce)
    expect(forwarded(a, 'content-security-policy')).toBe(csp(a))
    expect(p['frame-ancestors']).toEqual(["'none'"])
    // Opened from the hub PC: the gateway on the same host, port 3412, is the only extra connect target.
    expect(p['connect-src']).toEqual(["'self'", 'http://10.0.0.47:3412', 'ws://10.0.0.47:3412'])
  })

  it('opened on the hub itself (localhost): the gateway is localhost:3412', async () => {
    signedIn()
    const res = await run('/live', { host: 'localhost:3212', cookie: activity(10, 60) })
    expect(parseCsp(csp(res))['connect-src']).toEqual(["'self'", 'http://localhost:3412', 'ws://localhost:3412'])
  })

  it('API routes (public and signed-in) get it too', async () => {
    for (const p of ['/api/health', '/api/version']) expect(csp(await run(p)), p).toContain("frame-ancestors 'none'")
    signedIn()
    expect(csp(await run('/api/vod?x=1', { cookie: activity(10, 60) }))).toContain("default-src 'self'")
  })

  it('its own redirect to the sign-in page gets the empty policy', async () => {
    const res = await run('/admin/users')
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(csp(res)).toBe(REDIRECT_CSP)
  })

  it('the old-address redirects are the proxy’s own (permanent, the empty policy); every answer X-Frame-Options DENY', async () => {
    // Built-server finding: a next.config redirect is sent with no security header at all, so they moved into the proxy.
    for (const p of ['/stores', '/stores/abc?x=1', '/admin/stores']) {
      const res = await run(p)
      expect(res.status, p).toBe(308)
      expect(csp(res), p).toBe(REDIRECT_CSP)
    }
    expect(nextConfig.redirects).toBeUndefined()
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[]
    const all = rules.find((r) => r.source === '/:path*')
    expect(all?.headers.find((h) => h.key === 'X-Frame-Options')?.value).toBe('DENY')
    expect(all?.headers.some((h) => h.key === 'Content-Security-Policy')).toBe(false) // pages get theirs, with the nonce, from the proxy
  })

  it('report-only switch for the rollout', async () => {
    vi.stubEnv('CSP_REPORT_ONLY', '1')
    const res = await run('/api/health')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('content-security-policy-report-only')).toContain("frame-ancestors 'none'")
  })

  it('a configured gateway address and the allow-list are followed', async () => {
    vi.stubEnv('NEXT_PUBLIC_STREAM_GATEWAY_URL', 'http://10.0.0.9:3412')
    vi.stubEnv('CSP_CONNECT_EXTRA', 'https://maps.example.com')
    const res = await run('/api/health')
    expect(parseCsp(csp(res))['connect-src']).toEqual(["'self'", 'http://10.0.0.9:3412', 'ws://10.0.0.9:3412', 'https://maps.example.com'])
  })
})

describe('session hygiene (idle timeout and absolute lifetime)', () => {
  it('an active administrator goes on, and the activity record is renewed (signed, http-only)', async () => {
    signedIn()
    const res = await run('/home', { cookie: activity(120, 60) })
    expect(res.status).toBe(200)
    expect(m.signedOut).toBe(0)
    const set = res.cookies.get(ACTIVITY_COOKIE)
    expect(set?.value).toMatch(/^v1\.sess-1\.\d+\.60\./)
    expect(set?.httpOnly).toBe(true)
  })

  it('an administrator idle for more than 60 minutes is signed out and sent to sign in again, audited', async () => {
    signedIn({ signedInAgo: 3 * 3600 })
    const res = await run('/admin/users', { cookie: activity(61 * 60, 60) })
    expect(m.signedOut).toBe(1)
    expect(res.status).toBeGreaterThanOrEqual(300)
    const to = new URL(res.headers.get('location') ?? '', 'http://x')
    expect(to.pathname).toBe('/login')
    expect(to.searchParams.get('reason')).toBe('idle')
    expect(to.searchParams.get('next')).toBe('/admin/users')
    expect(m.events).toEqual([expect.objectContaining({ event: 'session_expired_idle', userId: m.user?.id })])
  })

  it('a viewer has the longer idle limit (8 hours): 61 minutes is fine', async () => {
    signedIn({ signedInAgo: 3 * 3600, role: 'user' })
    const res = await run('/live', { cookie: activity(61 * 60, 480) })
    expect(m.signedOut).toBe(0)
    expect(res.status).toBe(200)
  })

  it('older than 12 hours: signed out however active', async () => {
    signedIn({ signedInAgo: 12 * 3600 + 5, role: 'user' })
    const res = await run('/live', { cookie: activity(5, 480) })
    expect(m.signedOut).toBe(1)
    expect(new URL(res.headers.get('location') ?? '', 'http://x').searchParams.get('reason')).toBe('expired')
    expect(m.events[0]?.event).toBe('session_expired_absolute')
  })

  it('no record yet: a young sign-in starts one with its role’s limit; an old one counts as idle', async () => {
    signedIn({ signedInAgo: 30, role: 'user' })
    const fresh = await run('/home')
    expect(m.signedOut).toBe(0)
    expect(fresh.cookies.get(ACTIVITY_COOKIE)?.value).toMatch(/^v1\.sess-1\.\d+\.480\./)
    signedIn({ signedInAgo: 2 * 3600, role: 'admin' })
    await run('/home')
    expect(m.signedOut).toBe(1)
  })

  it('a record of another sign-in or with a wrong signature does not count', async () => {
    signedIn({ signedInAgo: 2 * 3600, sid: 'sess-2' })
    await run('/home', { cookie: activity(10, 60, 'sess-1') })
    expect(m.signedOut).toBe(1)
    signedIn({ signedInAgo: 2 * 3600 })
    await run('/home', { cookie: `${ACTIVITY_COOKIE}=${encodeActivity({ sid: 'sess-1', seen: now(), idle: 60 }, 'another-key-'.padEnd(48, 'y'))}` })
    expect(m.signedOut).toBe(2)
  })

  it('the sign-in page itself ends an expired session but shows the form (no loop)', async () => {
    signedIn({ signedInAgo: 13 * 3600 })
    const res = await run('/login', { cookie: activity(5, 60) })
    expect(m.signedOut).toBe(1)
    expect(res.status).toBe(200)
  })

  it('auth cookies are http-only (no browser code reads them)', async () => {
    signedIn()
    const res = await run('/home', { cookie: activity(10, 60) })
    expect(res.cookies.get('sb-localhost-auth-token')?.httpOnly).toBe(true)
    // Review I-1: the same rule as the cookie client: SameSite=Lax, Secure on https.
    expect(res.cookies.get('sb-localhost-auth-token')?.sameSite).toBe('lax')
    expect(res.cookies.get('sb-localhost-auth-token')?.secure).toBeFalsy()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://drishti.citykart.local')
    const tls = await run('/home', { cookie: activity(10, 60) })
    expect(tls.cookies.get('sb-localhost-auth-token')?.secure).toBe(true)
  })
})

// Final fix Y (final review B minor 2): body limits per page, before any session is looked up; the global limits are 6 MB.
describe('request body limits (final fix Y, B minor 2)', () => {
  const post = (path: string, length: number | null) => {
    const url = new URL(path, 'http://10.0.0.47:3212')
    const headers: Record<string, string> = { host: url.host, 'next-action': 'x', ...(length === null ? {} : { 'content-length': String(length) }) }
    return proxy(new NextRequest(url, { method: 'POST', headers }))
  }

  it('a large body on the sign-in page is refused (413) before the auth server is asked; the import page takes the 5 MB file', async () => {
    m.user = null
    const before = m.events.length
    const big = await post('/login', 2 * 1024 * 1024)
    expect(big.status).toBe(413)
    expect(big.headers.get('content-security-policy')).toBeTruthy()
    expect(m.events.length).toBe(before)
    expect((await post('/admin/users', 2 * 1024 * 1024)).status).toBe(413)
    expect((await post('/admin/users', null)).status).toBe(411)
    expect((await post('/admin/import', 5 * 1024 * 1024 + 200_000)).status).not.toBe(413)
  })

  it('next.config: 6 MB for Server Actions and the proxy buffer (was 30 MB)', () => {
    const exp = nextConfig.experimental as { serverActions?: { bodySizeLimit?: string }; proxyClientMaxBodySize?: string }
    expect(exp.serverActions?.bodySizeLimit).toBe('6mb')
    expect(exp.proxyClientMaxBodySize).toBe('6mb')
  })
})
