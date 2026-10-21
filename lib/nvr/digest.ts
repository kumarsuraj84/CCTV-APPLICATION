import { createHash, randomBytes } from 'node:crypto'

// HTTP Digest login (RFC 2617, MD5, qop=auth) for Hikvision NVRs, and the same header for RTSP.
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

export type DigestChallenge = { realm: string; nonce: string; qop: 'auth' | null; opaque: string | null; algorithm: 'MD5' }

export function parseDigestChallenge(header: string): DigestChallenge | null {
  const m = /^\s*Digest\s+(.*)$/i.exec(header)
  if (!m) return null
  const f: Record<string, string> = {}
  for (const p of m[1].matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/gi)) f[p[1].toLowerCase()] = p[2] ?? p[3]
  if (!f.realm || !f.nonce) return null
  if (f.algorithm && f.algorithm.toUpperCase() !== 'MD5') return null
  const offered = (f.qop ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (offered.length > 0 && !offered.includes('auth')) return null // only auth-int offered: not supported
  return { realm: f.realm, nonce: f.nonce, qop: offered.length ? 'auth' : null, opaque: f.opaque ?? null, algorithm: 'MD5' }
}

export type DigestCredentials = { username: string; password: string; method: string; uri: string; nc?: number; cnonce?: string }

export function buildDigestHeader(c: DigestChallenge, o: DigestCredentials): string {
  const nc = (o.nc ?? 1).toString(16).padStart(8, '0')
  const cnonce = o.cnonce ?? randomBytes(8).toString('hex')
  const ha1 = md5(`${o.username}:${c.realm}:${o.password}`)
  const ha2 = md5(`${o.method}:${o.uri}`)
  const response = c.qop ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${c.qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`)
  const parts = [`username="${o.username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${o.uri}"`, `response="${response}"`]
  if (c.qop) parts.push(`qop=${c.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (c.opaque) parts.push(`opaque="${c.opaque}"`)
  return `Digest ${parts.join(', ')}`
}

export type DigestRequest = { method?: string; headers?: Record<string, string>; body?: string; username: string; password: string; timeoutMs?: number }

/** One request with Digest login: asks, answers the challenge once, and returns the final response. Falls back to Basic if offered. */
export async function digestFetch(url: string, req: DigestRequest, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const u = new URL(url)
  const uri = u.pathname + u.search
  const method = req.method ?? 'GET'
  const timeout = req.timeoutMs ?? 8000
  const call = (headers?: Record<string, string>) =>
    fetchImpl(url, { method, headers: { ...req.headers, ...headers }, body: req.body, signal: AbortSignal.timeout(timeout), redirect: 'manual' })

  const first = await call()
  if (first.status !== 401) return first
  const header = first.headers.get('www-authenticate') ?? ''
  await first.body?.cancel()
  const challenge = parseDigestChallenge(header)
  if (challenge) return call({ Authorization: buildDigestHeader(challenge, { username: req.username, password: req.password, method, uri }) })
  if (/^\s*basic/i.test(header)) return call({ Authorization: 'Basic ' + Buffer.from(`${req.username}:${req.password}`).toString('base64') })
  return new Response(null, { status: 401 })
}
