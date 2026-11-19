import { createHash, randomBytes } from 'node:crypto'

// HTTP Digest login (RFC 2617, MD5, qop=auth) for Hikvision NVRs, and the same header for RTSP.
// Digest is the only login this module will ever perform: a password is never sent in clear (no Basic fallback).
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

/** The server offered no Digest challenge this module can answer (Basic only, SHA-256 only, auth-int only, ...). No credentials were sent. */
export class DigestUnsupportedError extends Error {
  constructor() {
    super('no supported login method offered')
    this.name = 'DigestUnsupportedError'
  }
}

/** A value that cannot be put safely into a Digest header (quote, backslash or control character). The value is never echoed. */
export class DigestInputError extends Error {
  constructor() {
    super('a login value cannot be used in a header')
    this.name = 'DigestInputError'
  }
}

/** True when the text holds no double quote, backslash or control character (CR, LF, NUL, DEL, ...). */
export function isHeaderSafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || c === 0x22 || c === 0x5c) return false
  }
  return true
}

export type DigestChallenge = { realm: string; nonce: string; qop: 'auth' | null; opaque: string | null; algorithm: 'MD5' }

// A new challenge starts at an auth scheme token (not followed by "="), which tells it apart from an auth-param like nonce="x".
const SCHEME_START = /^[A-Za-z][\w.~+-]*(?![\w.~+-])(?!\s*=)/

/** Splits a WWW-Authenticate value (repeated headers arrive joined with ", ") into its challenges. Commas inside quoted values do not split. */
function splitChallenges(header: string): string[] {
  const out: string[] = []
  let start = 0
  let inQuote = false
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]
    if (inQuote) {
      if (ch === '\\') i++
      else if (ch === '"') inQuote = false
      continue
    }
    if (ch === '"') {
      inQuote = true
    } else if (ch === ',') {
      let j = i + 1
      while (j < header.length && (header[j] === ' ' || header[j] === '\t')) j++
      if (SCHEME_START.test(header.slice(j, j + 128))) {
        out.push(header.slice(start, i))
        start = j
        i = j - 1
      }
    }
  }
  out.push(header.slice(start))
  return out
}

function parseOneDigest(challenge: string): DigestChallenge | null {
  const m = /^\s*Digest\s+([\s\S]*)$/i.exec(challenge)
  if (!m) return null
  const f: Record<string, string> = {}
  for (const p of m[1].matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/gi)) f[p[1].toLowerCase()] = p[2] ?? p[3]
  if (!f.realm || !f.nonce) return null
  if (f.algorithm && f.algorithm.toUpperCase() !== 'MD5') return null
  const offered = (f.qop ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (offered.length > 0 && !offered.includes('auth')) return null // only auth-int offered: not supported
  const opaque = f.opaque ?? null
  if (!isHeaderSafe(f.realm) || !isHeaderSafe(f.nonce) || (opaque !== null && !isHeaderSafe(opaque))) return null
  return { realm: f.realm, nonce: f.nonce, qop: offered.length ? 'auth' : null, opaque, algorithm: 'MD5' }
}

/** The first usable Digest challenge (MD5, qop auth or none) in a WWW-Authenticate value, whatever else is offered beside it. */
export function parseDigestChallenge(header: string): DigestChallenge | null {
  for (const part of splitChallenges(header)) {
    const c = parseOneDigest(part)
    if (c) return c
  }
  return null
}

export type DigestCredentials = { username: string; password: string; method: string; uri: string; nc?: number; cnonce?: string }

export function buildDigestHeader(c: DigestChallenge, o: DigestCredentials): string {
  const opaque = c.opaque
  if (!isHeaderSafe(o.username) || !isHeaderSafe(c.realm) || !isHeaderSafe(c.nonce) || (opaque !== null && !isHeaderSafe(opaque))) throw new DigestInputError()
  const nc = (o.nc ?? 1).toString(16).padStart(8, '0')
  const cnonce = o.cnonce ?? randomBytes(8).toString('hex')
  const ha1 = md5(`${o.username}:${c.realm}:${o.password}`)
  const ha2 = md5(`${o.method}:${o.uri}`)
  const response = c.qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${c.qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`)
  const parts = [`username="${o.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${o.uri}"`, `response="${response}"`]
  if (c.qop) parts.push(`qop=${c.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (opaque) parts.push(`opaque="${opaque}"`)
  return `Digest ${parts.join(', ')}`
}

export type DigestRequest = {
  method?: string
  headers?: Record<string, string>
  body?: string
  username: string
  password: string
  /** Used only when no signal is given: one deadline for the whole exchange (both requests). */
  timeoutMs?: number
  /** One deadline shared by both requests (and by reading the answer, when the caller reads it under the same signal). */
  signal?: AbortSignal
}

/** Final fix X round 2 (review I-2): set on a response that answered a request carrying the Digest login (the password was sent). */
const CREDENTIALS_SENT = Symbol('drishti.credentialsSent')
/** True when this response came after the password was sent (the second request of a Digest exchange). */
export const credentialsSent = (res: Response): boolean => (res as unknown as Record<symbol, boolean>)[CREDENTIALS_SENT] === true

/**
 * One request with Digest login: asks, answers the challenge once, and returns the final response.
 * Never sends credentials in clear: when no usable Digest challenge is offered it throws DigestUnsupportedError.
 * A response to the first, unauthenticated request (anything but 401) comes back as it is: credentialsSent(res) is then false.
 */
export async function digestFetch(url: string, req: DigestRequest, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (!isHeaderSafe(req.username)) throw new DigestInputError()
  const u = new URL(url)
  const uri = u.pathname + u.search
  const method = req.method ?? 'GET'
  const signal = req.signal ?? AbortSignal.timeout(req.timeoutMs ?? 8000)
  const call = (headers?: Record<string, string>) => fetchImpl(url, { method, headers: { ...req.headers, ...headers }, body: req.body, signal, redirect: 'manual' })

  const first = await call()
  if (first.status !== 401) return first
  const header = first.headers.get('www-authenticate') ?? ''
  await first.body?.cancel().catch(() => {})
  const challenge = parseDigestChallenge(header)
  if (!challenge) throw new DigestUnsupportedError()
  const second = await call({ Authorization: buildDigestHeader(challenge, { username: req.username, password: req.password, method, uri }) })
  Object.defineProperty(second, CREDENTIALS_SENT, { value: true, enumerable: false })
  return second
}
