import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSecret, usableSecret } from '@/lib/secrets'
import { isFastSpeed, type FastSpeed } from '@/lib/streams/speed'

// P4-L2 (decision D-L1): the token that opens ONE fast playback stream. It names one media session of kind playback (sid), one person (u),
// one camera (c) and one span of recording as shown-time epoch seconds (s, e), and expires after the 90 s connect window (exp, epoch
// seconds) like the gateway's tokens (P2-4). It is signed with the `stream_token` secret under its OWN purpose, so a gateway stream token
// is never a fast token and a fast token never opens a gateway socket. The stream route also requires u to be the signed-in person.

// Review round 1 (I-1): the speed (sp: 2, 4, 8 or 16) is signed too; the server paces the stream to it.
export type FastClaims = { sid: string; u: string; c: string; s: number; e: number; sp: FastSpeed; exp: number }

export const FAST_TOKEN_LIFETIME_SEC = 90
/** The longest span one token may name: 30 minutes (lib/streams/speed.ts MAX_FAST_MINUTES). */
export const MAX_FAST_SEC = 30 * 60
const MAX_TOKEN_LENGTH = 1024
const CLOCK_SKEW_SEC = 60
const DOMAIN = 'fastpb.v1.'
const KEYS = ['sid', 'u', 'c', 's', 'e', 'sp', 'exp']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

const resolveSecret = (secret: string | null | undefined): string | null => (secret === undefined ? getSecret('stream_token') : usableSecret(secret))
const mac = (payload: string, secret: string) => createHmac('sha256', secret).update(DOMAIN + payload).digest('base64url')
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** Signs the claims as given (verification decides whether they are acceptable). Throws without a usable secret: never a fallback key. */
export function signFastToken(claims: FastClaims, secret?: string | null): string {
  const key = resolveSecret(secret)
  if (!key) throw new Error('stream_token secret is not set')
  const payload = Buffer.from(JSON.stringify({ sid: claims.sid, u: claims.u, c: claims.c, s: claims.s, e: claims.e, sp: claims.sp, exp: claims.exp })).toString('base64url')
  return `${payload}.${mac(payload, key)}`
}

/** The claims when the token is genuine, unexpired and well formed; null for anything else. Never throws. */
export function verifyFastToken(token: string, nowMs: number = Date.now(), secret?: string | null): FastClaims | null {
  try {
    const key = resolveSecret(secret)
    if (!key || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !Number.isFinite(nowMs)) return null
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payload, sig] = parts
    if (!BASE64URL.test(payload) || !BASE64URL.test(sig)) return null
    const given = Buffer.from(sig)
    const expected = Buffer.from(mac(payload, key))
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    const raw: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length !== KEYS.length || !keys.every((k) => KEYS.includes(k))) return null
    if (typeof o.sid !== 'string' || !UUID.test(o.sid) || typeof o.u !== 'string' || !UUID.test(o.u) || typeof o.c !== 'string' || !UUID.test(o.c)) return null
    if (!isWhole(o.exp) || o.exp * 1000 <= nowMs || o.exp * 1000 > nowMs + (FAST_TOKEN_LIFETIME_SEC + CLOCK_SKEW_SEC) * 1000) return null
    if (!isWhole(o.s) || !isWhole(o.e) || o.e <= o.s || o.e - o.s > MAX_FAST_SEC) return null
    if (!isFastSpeed(o.sp)) return null
    return { sid: o.sid, u: o.u, c: o.c, s: o.s, e: o.e, sp: o.sp, exp: o.exp }
  } catch {
    return null
  }
}

/** The media session's stream name, from the signed claims only: `fpb_<camera>_<start>_<end>`. Throws for a camera id that is not a UUID. */
export function fastStreamName(claims: Pick<FastClaims, 'c' | 's' | 'e'>): string {
  if (typeof claims.c !== 'string' || !UUID.test(claims.c) || !isWhole(claims.s) || !isWhole(claims.e)) throw new Error('Invalid fast playback stream')
  return `fpb_${claims.c}_${claims.s}_${claims.e}`
}
