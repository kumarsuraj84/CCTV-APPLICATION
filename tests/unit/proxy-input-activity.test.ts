import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clockOffset, INPUT_COOKIE, inputCookieValue } from '@/lib/auth/input-activity'
import { ACTIVITY_COOKIE, decodeActivity, encodeActivity } from '@/lib/auth/session-activity'

// P4-L1 fix round 2, re-review N-3: the idle rule driven through proxy.ts itself (the real function with real request objects), not
// only its helpers. Only real input keeps a sign-in alive: a background request (the wall's renewal, the 60 s refresh) carries an old
// input time and never moves the session's activity forward, so an unattended wall ends at the idle limit; real input does move it.
// N-2: the input time is written in the SERVER's clock (the page learns the server's time when it loads), so a browser clock that is
// wrong neither signs a working person out nor keeps an unattended sign-in alive.

const KEY = 'activity-input-test-key-'.padEnd(48, 'x')
const now = () => Math.floor(Date.now() / 1000)
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

const m = vi.hoisted(() => ({ user: null as null | { id: string }, token: '', role: 'operator', signedOut: 0, events: [] as string[] }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: m.user } }),
      getSession: async () => ({ data: { session: m.user ? { access_token: m.token } : null } }),
      signOut: async () => { m.signedOut++; return { error: null } },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: m.role, org_id: 'org-1' } }) }) }) }),
  }),
}))
vi.mock('@/lib/streams/registry', () => ({ revokeMediaSessions: async () => true }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/auth/auth-events', () => ({ recordAuthEvent: async (e: { event: string }) => { m.events.push(e.event); return true } }))

const { proxy } = await import('@/proxy')

const SID = 'sess-input'
const signedIn = (role = 'operator', signedInAgo = 3 * 3600) => {
  m.user = { id: '22222222-2222-4222-8222-222222222222' }
  m.role = role
  const t = now() - signedInAgo
  m.token = jwt({ session_id: SID, aal: 'aal1', amr: [{ method: 'password', timestamp: t }] })
}
const record = (seenAgo: number, idle: number) => `${ACTIVITY_COOKIE}=${encodeActivity({ sid: SID, seen: now() - seenAgo, idle }, KEY)}`
const input = (value: string) => `${INPUT_COOKIE}=${value}`
function request(cookies: string[]) {
  const url = new URL('/live', 'http://10.0.0.47:3212')
  return proxy(new NextRequest(url, { headers: { host: url.host, cookie: cookies.join('; ') } }))
}
const seenAfter = (res: Response & { cookies: { get(n: string): { value: string } | undefined } }) => decodeActivity(res.cookies.get(ACTIVITY_COOKIE)?.value, KEY)?.seen ?? null
const endedIdle = (res: Response) => (res.headers.get('location') ?? '').includes('reason=idle')

beforeEach(() => {
  vi.stubEnv('VERIFIED_USER_SECRET', KEY)
  vi.stubEnv('NEXT_PUBLIC_STREAM_GATEWAY_URL', '')
  vi.stubEnv('NEXT_PUBLIC_STREAM_GATEWAY_PORT', '')
  vi.stubEnv('CSP_REPORT_ONLY', '')
  vi.stubEnv('CSP_CONNECT_EXTRA', '')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://10.0.0.47:3212')
  m.user = null
  m.signedOut = 0
  m.events = []
})
afterEach(() => vi.unstubAllEnvs())

describe('proxy.ts dates activity from the last real input (re-review N-3)', () => {
  it('a background request with an old input time does not move the activity: no new record, the old one stands', async () => {
    signedIn()
    const res = await request([record(30 * 60, 480), input(String(now() - 2 * 3600))])
    expect(endedIdle(res)).toBe(false)
    expect(res.cookies.get(ACTIVITY_COOKIE)).toBeUndefined() // nothing renewed: the activity is still 30 minutes old
  })

  it('an unattended wall ends at the idle limit (8 hours for an operator), however many background requests it makes', async () => {
    signedIn('operator', 10 * 3600)
    const lastInput = String(now() - 8 * 3600 - 120)
    // Every minute a renewal: each carries the same old input time, so the record never moves.
    for (const ago of [8 * 3600 - 120, 8 * 3600 - 60]) {
      const res = await request([record(ago, 480), input(lastInput)])
      expect(endedIdle(res)).toBe(false)
      expect(res.cookies.get(ACTIVITY_COOKIE)).toBeUndefined()
    }
    const res = await request([record(8 * 3600 + 1, 480), input(lastInput)])
    expect(endedIdle(res)).toBe(true)
    expect(m.signedOut).toBe(1)
    expect(m.events).toEqual(['session_expired_idle'])
  })

  it('real input moves the activity forward to the input time', async () => {
    signedIn()
    const res = await request([record(30 * 60, 480), input(String(now() - 5))])
    expect(seenAfter(res)).toBeGreaterThanOrEqual(now() - 6)
  })

  it('an input time in the future counts as this request at most (never later)', async () => {
    signedIn()
    const res = await request([record(30 * 60, 480), input(String(now() + 3 * 3600))])
    expect(seenAfter(res)).toBeLessThanOrEqual(now())
  })
})

describe('a wrong browser clock (re-review N-2)', () => {
  // What the page writes after real input, as components/layout/input-tracker.ts does: its clock moved by the server's offset.
  const written = (browserSkewMs: number, inputAgoMs: number) => {
    const serverAtLoad = Date.now() - 60_000
    const browserAtLoad = serverAtLoad + browserSkewMs
    const offset = clockOffset(serverAtLoad, browserAtLoad)
    return inputCookieValue(Date.now() + browserSkewMs - inputAgoMs, offset)
  }

  for (const [label, skew] of [['2 hours behind', -2 * 3600_000], ['3 hours ahead', 3 * 3600_000], ['a day behind', -86_400_000], ['right', 0]] as const) {
    it(`browser clock ${label}: a person working now keeps the sign-in, an unattended one does not`, async () => {
      signedIn()
      const working = await request([record(30 * 60, 480), input(written(skew, 5_000))])
      expect(endedIdle(working)).toBe(false)
      expect(seenAfter(working)).toBeGreaterThanOrEqual(now() - 7)
      const away = await request([record(30 * 60, 480), input(written(skew, 40 * 60_000))])
      expect(away.cookies.get(ACTIVITY_COOKIE)).toBeUndefined()
    })
  }

  it('why: the raw browser clock 2 hours behind dates input made now 2 hours ago, so a working person\'s activity would never move', async () => {
    signedIn()
    const raw = String(Math.floor((Date.now() - 2 * 3600_000 - 5_000) / 1000))
    const res = await request([record(30 * 60, 480), input(raw)])
    expect(res.cookies.get(ACTIVITY_COOKIE)).toBeUndefined()
  })
})
