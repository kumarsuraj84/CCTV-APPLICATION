import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSecret } from '@/lib/secrets'

// A stream token names one person (u), one camera (c) and one kind (k), and is signed with the `stream_token` secret.
// exp, s and e are epoch SECONDS. s and e (the playback range) exist only on 'pb' tokens.
export type StreamKind = 'sub' | 'main' | 'pb'
export type StreamClaims = { u: string; c: string; k: StreamKind; exp: number; s?: number; e?: number }

export const TOKEN_LIFETIME_SEC = 600
export const MAX_PLAYBACK_SEC = 86_400

const KINDS: readonly string[] = ['sub', 'main', 'pb']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64URL = /^[A-Za-z0-9_-]+$/
const LIVE_KEYS = ['u', 'c', 'k', 'exp']
const PB_KEYS = ['u', 'c', 'k', 'exp', 's', 'e']

const resolveSecret = (secret: string | null | undefined): string | null => {
  const v = secret === undefined ? getSecret('stream_token') : secret
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

const mac = (payloadSegment: string, secret: string) => createHmac('sha256', secret).update(payloadSegment).digest('base64url')

/** Signs the claims as given. Verification, not signing, decides whether they are acceptable. */
export function signStreamToken(claims: StreamClaims, secret?: string | null): string {
  const key = resolveSecret(secret)
  if (!key) throw new Error('stream_token secret is not set')
  const body: Record<string, unknown> = { u: claims.u, c: claims.c, k: claims.k, exp: claims.exp }
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
    if (!key || typeof token !== 'string' || !Number.isFinite(nowMs)) return null
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

    if (typeof o.u !== 'string' || !UUID.test(o.u)) return null
    if (typeof o.c !== 'string' || !UUID.test(o.c)) return null
    if (typeof o.k !== 'string' || !KINDS.includes(o.k)) return null
    if (!isEpoch(o.exp) || o.exp * 1000 <= nowMs) return null

    if (!isPb) return { u: o.u, c: o.c, k: o.k as StreamKind, exp: o.exp }
    if (!isWhole(o.s) || !isWhole(o.e) || o.e <= o.s || o.e - o.s > MAX_PLAYBACK_SEC) return null
    return { u: o.u, c: o.c, k: 'pb', exp: o.exp, s: o.s, e: o.e }
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
