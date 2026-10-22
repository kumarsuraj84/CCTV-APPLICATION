import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSecret, usableSecret } from '@/lib/secrets'

// A stream token names one media session (sid), one person (u), one camera (c) and one kind (k), and is signed with the `stream_token`
// secret. exp, s and e are epoch SECONDS. s and e (the playback range) exist only on 'pb' tokens.
// P2-4 (decision D-3, AC-14): the session id is required. The gateway opens exactly that session in the registry (media_session_open,
// which also checks that it belongs to u and c), so a token is good for one socket, within its connect window, while access lasts.
export type StreamKind = 'sub' | 'main' | 'pb'
export type StreamClaims = { sid: string; u: string; c: string; k: StreamKind; exp: number; s?: number; e?: number }

/** The connect window: a token opens a socket within 90 seconds (it was 10 minutes before P2-4); the socket then lives on its own. */
export const TOKEN_LIFETIME_SEC = 90
export const MAX_PLAYBACK_SEC = 86_400

const KINDS: readonly string[] = ['sub', 'main', 'pb']
// Lower-case only: one spelling per id, so a token never names the same camera two ways.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const LIVE_KEYS = ['sid', 'u', 'c', 'k', 'exp']
const PB_KEYS = ['sid', 'u', 'c', 'k', 'exp', 's', 'e']
export const MAX_TOKEN_LENGTH = 1024
/** Allowed clock difference between the signer and the checker, on top of the lifetime. */
const CLOCK_SKEW_SEC = 60
/** Mixed into every signature so a token made for another purpose with the same secret can never verify as a stream token. */
const DOMAIN = 'stream.v1.'

// A secret that is missing, blank or shorter than the minimum counts as not set (never a fallback).
const resolveSecret = (secret: string | null | undefined): string | null => (secret === undefined ? getSecret('stream_token') : usableSecret(secret))

const mac = (payloadSegment: string, secret: string) => createHmac('sha256', secret).update(DOMAIN + payloadSegment).digest('base64url')

/** Signs the claims as given. Verification, not signing, decides whether they are acceptable. */
export function signStreamToken(claims: StreamClaims, secret?: string | null): string {
  const key = resolveSecret(secret)
  if (!key) throw new Error('stream_token secret is not set')
  const body: Record<string, unknown> = { sid: claims.sid, u: claims.u, c: claims.c, k: claims.k, exp: claims.exp }
  if (claims.s !== undefined) body.s = claims.s
  if (claims.e !== undefined) body.e = claims.e
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${payload}.${mac(payload, key)}`
}

const isEpoch = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** The claims when the token is genuine, unexpired and well formed; null for anything else. Never throws. */
export function verifyStreamToken(token: string, nowMs: number = Date.now(), secret?: string | null): StreamClaims | null {
  try {
    const key = resolveSecret(secret)
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
    if (!key || !Number.isFinite(nowMs)) return null
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
    const isPb = o.k === 'pb'
    const allowed = isPb ? PB_KEYS : LIVE_KEYS
    const keys = Object.keys(o)
    if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) return null

    if (typeof o.sid !== 'string' || !UUID.test(o.sid)) return null
    if (typeof o.u !== 'string' || !UUID.test(o.u)) return null
    if (typeof o.c !== 'string' || !UUID.test(o.c)) return null
    if (typeof o.k !== 'string' || !KINDS.includes(o.k)) return null
    // Expired, or further ahead than a token can ever be issued for (catches an exp in milliseconds by mistake).
    if (!isEpoch(o.exp) || o.exp * 1000 <= nowMs || o.exp * 1000 > nowMs + (TOKEN_LIFETIME_SEC + CLOCK_SKEW_SEC) * 1000) return null

    if (!isPb) return { sid: o.sid, u: o.u, c: o.c, k: o.k as StreamKind, exp: o.exp }
    if (!isWhole(o.s) || !isWhole(o.e) || o.e <= o.s || o.e - o.s > MAX_PLAYBACK_SEC) return null
    return { sid: o.sid, u: o.u, c: o.c, k: 'pb', exp: o.exp, s: o.s, e: o.e }
  } catch {
    return null
  }
}

/** The go2rtc stream name for a token, derived from the signed claims only. Throws for a camera id that is not a UUID. */
export function streamName(claims: Pick<StreamClaims, 'c' | 'k' | 's'>): string {
  if (typeof claims.c !== 'string' || !UUID.test(claims.c)) throw new Error('Invalid camera id for a stream name')
  if (claims.k === 'sub' || claims.k === 'main') return `cam_${claims.c}_${claims.k}`
  if (claims.k === 'pb') {
    if (!isWhole(claims.s)) throw new Error('A playback stream needs a start time')
    return `pb_${claims.c}_${claims.s}`
  }
  throw new Error('Invalid stream kind')
}
