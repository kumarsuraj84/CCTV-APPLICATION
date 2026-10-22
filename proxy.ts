import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { recordAuthEvent } from '@/lib/auth/auth-events'
import { ACTIVITY_COOKIE, activityKey, decodeActivity, encodeActivity } from '@/lib/auth/session-activity'
import { claimsOf, idleMinutesFor, sessionExpiry, sessionPolicy } from '@/lib/auth/session-policy'
import { VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER, signVerifiedUser } from '@/lib/auth/verified-user'
import { buildCsp, cspHeaderName, cspReportOnly, makeNonce, REDIRECT_CSP } from '@/lib/web/csp'
import type { PageAddress } from '@/lib/streams/wall'

// Public pages and routes are an exact-match list. Every other path needs a signed-in person.
const PUBLIC_PAGES = new Set(['/login', '/forgot-password'])
const PUBLIC_API = new Set(['/api/health', '/api/version', '/api/csp-report'])
/** The activity record is written again when it is older than this (seconds), not on every request. */
const RENEW_ACTIVITY_AFTER_SEC = 60

function stamp(headers: Headers, request: NextRequest) {
  headers.set('x-request-id', crypto.randomUUID())
  headers.set('x-request-path', request.nextUrl.pathname)
  headers.set('x-request-method', request.method)
}

// A client may send any copy of the verified-user headers; it is always removed here and only set again below, signed.
// P3-1: the request also carries this request's nonce and policy, from which Next.js takes the nonce for its own scripts.
function cleanHeaders(request: NextRequest, csp: { name: string; value: string; nonce: string }): Headers {
  const h = new Headers(request.headers)
  h.delete(VERIFIED_USER_HEADER)
  h.delete(VERIFIED_USER_SIG_HEADER)
  h.delete('content-security-policy')
  h.delete('content-security-policy-report-only')
  h.set('x-nonce', csp.nonce)
  h.set(csp.name, csp.value)
  stamp(h, request)
  return h
}

const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/

/** Where the browser opened the page: the Host it asked for, and https when the site is served over https (behind the proxy too). */
function pageOf(request: NextRequest, https: boolean): PageAddress {
  const given = request.headers.get('host') ?? ''
  const host = HOST.test(given) ? given : request.nextUrl.host
  let hostname = request.nextUrl.hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    // keep the URL's own
  }
  return { protocol: https ? 'https:' : request.nextUrl.protocol, host, hostname }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const https = (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')
  // P3-1 (D-12, SO-8): the Content Security Policy of this request, with its own nonce (lib/web/csp.ts).
  const nonce = makeNonce()
  const csp = {
    nonce,
    name: cspHeaderName(cspReportOnly()),
    value: buildCsp({
      nonce, dev: process.env.NODE_ENV === 'development', page: pageOf(request, https), https,
      gateway: process.env.NEXT_PUBLIC_STREAM_GATEWAY_URL, gatewayPort: process.env.NEXT_PUBLIC_STREAM_GATEWAY_PORT,
      extraConnect: process.env.CSP_CONNECT_EXTRA,
    }),
  }
  const withPolicy = <T extends NextResponse>(res: T, value = csp.value): T => {
    res.headers.set(csp.name, value)
    return res
  }

  // Image files at the top level of public/ and directly inside public/brand/ (the logo shown on the sign-in page, P3-0).
  const isAsset = pathname.startsWith('/_next') || pathname === '/favicon.ico' || /^\/(?:brand\/)?[A-Za-z0-9._-]+\.(svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname)
  if (isAsset || PUBLIC_API.has(pathname) || pathname === '/auth/callback') {
    return withPolicy(NextResponse.next({ request: { headers: cleanHeaders(request, csp) } }))
  }

  const forwarded = cleanHeaders(request, csp)
  let refreshed: { name: string; value: string; options: CookieOptions }[] = []

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        refreshed = list
        list.forEach(({ name, value }) => request.cookies.set(name, value))
      },
    },
  })
  let { data: { user } } = await supabase.auth.getUser()

  // P3-1 brief item 7: idle timeout and absolute lifetime of a sign-in (lib/auth/session-policy.ts). The session's own claims (its id
  // and sign-in time) come from the token getUser() just had verified by the auth server.
  const policy = sessionPolicy()
  const key = activityKey()
  let activity: { value: string; maxAge: number } | null = null
  let ended: 'idle' | 'expired' | null = null
  if (user && key) {
    const claims = claimsOf((await supabase.auth.getSession()).data.session?.access_token)
    const now = Math.floor(Date.now() / 1000)
    const sid = claims.sessionId ?? 'none'
    const record = decodeActivity(request.cookies.get(ACTIVITY_COOKIE)?.value, key)
    const known = record && record.sid === sid ? record : null
    let idle = known?.idle
    if (idle === undefined) {
      const { data } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
      idle = idleMinutesFor((data as { role?: string } | null)?.role, policy)
    }
    const expiry = sessionExpiry({ now, signedInAt: claims.signedInAt, lastSeen: known?.seen ?? null, idleMinutes: idle, maxHours: policy.maxHours })
    if (expiry) {
      await supabase.auth.signOut({ scope: 'local' })
      await recordAuthEvent({ event: expiry === 'idle' ? 'session_expired_idle' : 'session_expired_absolute', userId: user.id, detail: { idle_minutes: idle, max_hours: policy.maxHours } })
      ended = expiry === 'idle' ? 'idle' : 'expired'
      user = null
      activity = { value: '', maxAge: 0 }
    } else if (!known || now - known.seen >= RENEW_ACTIVITY_AFTER_SEC) {
      activity = { value: encodeActivity({ sid, seen: now, idle }, key), maxAge: policy.maxHours * 3600 }
    }
  }

  // Auth cookies: http-only (no browser code reads them; P3-1) and secure when the site is https.
  const finish = <T extends NextResponse>(res: T): T => {
    refreshed.forEach(({ name, value, options }) => res.cookies.set(name, value, { ...options, httpOnly: true, ...(https ? { secure: true } : {}) }))
    if (activity) res.cookies.set(ACTIVITY_COOKIE, activity.value, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: activity.maxAge, ...(https ? { secure: true } : {}) })
    return res
  }

  if (!user && !PUBLIC_PAGES.has(pathname) && pathname !== '/reset-password') {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', pathname + request.nextUrl.search)
    if (ended) url.searchParams.set('reason', ended)
    return finish(withPolicy(NextResponse.redirect(url), REDIRECT_CSP))
  }

  const sig = signVerifiedUser(user?.id ?? '')
  if (sig) {
    forwarded.set(VERIFIED_USER_HEADER, user?.id ?? '')
    forwarded.set(VERIFIED_USER_SIG_HEADER, sig)
  }
  forwarded.set('cookie', request.cookies.toString())

  return finish(withPolicy(NextResponse.next({ request: { headers: forwarded } })))
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
