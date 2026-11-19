import { createHash } from 'node:crypto'
import http from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { isGo2rtcLoginRefusal } from '@/lib/nvr/login-guard'
import { usableSecret } from '@/lib/secrets'
import { basicAuthHeader, type Go2rtcAuth } from '@/lib/streams/go2rtc-auth'
import { REGISTRY_TIMEOUT_MS, type RegistryClient } from '@/lib/streams/registry'
import { streamName, verifyStreamToken, type StreamClaims } from '@/lib/streams/token'

// The video gateway: the only video endpoint a browser can reach. A browser opens a WebSocket with a signed stream token; the
// gateway checks the Origin and the token, opens the token's media session in the registry, and then pipes the socket to go2rtc. The
// go2rtc stream name comes from the signed claims only, so nothing the browser sends can choose a stream, and go2rtc's address and
// error texts (which can contain camera addresses and passwords) never reach a browser.
//
// P2-4 (decision D-3, directive AC-14): revocation within a minute. Before anything is connected upstream the registry must open the
// token's session (media_session_open: that person's, that camera, kind and stream, once, within the 90 s connect window, still
// allowed) — so a token issued before a revocation cannot open a new socket. Every `validateEveryMs` (15 s) ONE batched call
// (media_sessions_still_valid) re-checks every open socket; a socket that lost access closes with 4403 "Access changed". If the
// registry cannot be asked, a socket whose last good check is `failClosedAfterMs` (45 s) old is closed with 1013 "Cannot verify
// access" (fail closed). Worst case for a revocation: 15 s + the 5 s call = 20 s; with the database unreachable: 45 s + 5 s.

export type GatewayEvent = {
  event: 'gateway_session'
  outcome:
    | 'started' | 'ended' | 'denied_origin' | 'denied_token' | 'denied_message' | 'rate_limited' | 'full' | 'upstream_failed' | 'backpressure' | 'stalled'
    | 'denied_session' | 'unverified' | 'revoked' | 'fail_closed' | 'check_failed' | 'login_refused' | 'upstream_silent'
    // Round 2 (review M-8): go2rtc failed before any video in a way the gateway cannot read (reported hashed, the tile is closed).
    | 'upstream_unexplained'
    // Round 3 (pre-handover review I-1): go2rtc's source failed before any video for a network reason (reported as such, never a login).
    | 'upstream_network'
  /** First 8 hex characters of the SHA-256 of the camera id; never the id, the stream name, the person or the token. */
  camera?: string
  kind?: StreamClaims['k']
  durationMs?: number
  /** The registry's reason code for a refusal or revocation (access_changed, deactivated, …): no personal data. */
  reason?: string
  /** How many sockets a check covered, and how long it took. */
  sessions?: number
}

export type GatewayHealth = {
  status: 'ok' | 'not_verifying'
  registry: 'ok' | 'failing'
  openSessions: number
  /** Seconds since the last check that succeeded (or found nothing to check); null before the first one. */
  lastValidationAgeSec: number | null
  validateEverySec: number
  failClosedAfterSec: number
}

export type GatewayOptions = {
  go2rtcUrl: string
  /**
   * go2rtc's API credentials (P2-6, D-13), sent on the upstream video socket and the player-script requests (server → loopback only).
   * Left out or null: none (go2rtc without API credentials).
   */
  go2rtcAuth?: Go2rtcAuth | null
  secret: string
  allowedOrigins: string[]
  /** The media session registry (required: without it nothing can be verified, so nothing would be allowed). */
  registry: RegistryClient
  /** How often every open socket is re-checked (default 15 s). */
  validateEveryMs?: number
  /** Sockets whose last good check is this old are closed when the registry cannot be asked (default 45 s). */
  failClosedAfterMs?: number
  /** Run the checks on a timer (default true). Tests turn it off and call validateNow() with a fake clock. */
  autoValidate?: boolean
  /** The longest one check may take before it counts as failed (default the larger of validateEveryMs and 5 s). */
  checkDeadlineMs?: number
  /** A session ends after this long (default 30 minutes); the browser asks for a new token and reconnects. */
  maxSessionMs?: number
  /** The clock for token expiry and the rate limit (default Date.now). */
  now?: () => number
  /** Open browser sockets allowed at once (default 300); more are closed with 1013. */
  maxSockets?: number
  /** Open browser sockets allowed at once from one address (default 100); more are closed with 1013. */
  maxSocketsPerIp?: number
  /** Upgrade attempts per address per minute (default 240); more are closed with 1013. */
  maxUpgradesPerMinute?: number
  /**
   * P5.5: reverse proxies in front of the gateway on this computer (TRUSTED_PROXY_HOPS; 1 behind Caddy, runbook-tls.md). The per-address
   * limits then count the client address the proxy adds instead of the proxy's own. Default 0: X-Forwarded-For is ignored.
   */
  trustedProxyHops?: number
  /** How long a request may take to arrive before the connection is dropped (default 10 s; headers and body). */
  requestTimeoutMs?: number
  /** When the receiving side has this many bytes waiting, the sending side is paused (default 1 MB). */
  backpressureBytes?: number
  /** If the receiving side stays that far behind for this long, the session is cut (default 10 s). */
  backpressureStallMs?: number
  /** Where outcomes go (no personal data, see GatewayEvent). Default: nowhere. */
  log?: (e: GatewayEvent) => void
  /** A picture that played and then sent no video for this long is ended (default 30 s; final fix X). */
  upstreamSilenceMs?: number
}

export type GatewayServer = http.Server & {
  shutdown(timeoutMs?: number): Promise<void>
  /** One re-check of every open socket now (the timer calls this every validateEveryMs). */
  validateNow(): Promise<void>
  health(): GatewayHealth
}

export const DEFAULT_VALIDATE_EVERY_MS = 15_000
export const DEFAULT_FAIL_CLOSED_AFTER_MS = 45_000
/** The close code for a socket whose access was taken away while it was open. */
export const CLOSE_ACCESS_CHANGED = 4403
const CLOSE_CANNOT_VERIFY = 1013
const MSG_ACCESS_CHANGED = 'Access changed'
/** Asked when no socket is open (review m-2): a session id no session can have (it is answered "not_found"). */
const PING_SID = '00000000-0000-4000-8000-000000000000'
const MSG_CANNOT_VERIFY = 'Cannot verify access'

export const DEFAULT_MAX_SESSION_MS = 30 * 60_000
export const DEFAULT_MAX_SOCKETS = 300
export const DEFAULT_MAX_SOCKETS_PER_IP = 100
export const DEFAULT_MAX_UPGRADES_PER_MINUTE = 240
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
export const MAX_HTTP_CONNECTIONS = 1000
/** The only messages a browser may send to go2rtc: the player's request to start a stream, as JSON text. */
export const BROWSER_MESSAGE_TYPES: readonly string[] = ['mse', 'mp4', 'mjpeg']
const MAX_BROWSER_TEXT = 4096
/**
 * Largest message accepted from a browser: its small JSON text (MAX_BROWSER_TEXT). Final fix Y (final review B minor 6): was 4 MB per
 * frame, which let 300 sockets make the server hold about 1.2 GB before the registry answered; a bigger frame now closes the socket (1009).
 */
export const MAX_BROWSER_PAYLOAD = MAX_BROWSER_TEXT
/** Largest message accepted from go2rtc (a video fragment can be bigger than anything a browser sends). */
export const MAX_UPSTREAM_PAYLOAD = 16 * 1024 * 1024
export const SHUTDOWN_MS = 5000

const WS_PATH = '/g/ws'
const UPSTREAM_CONNECT_MS = 5000
/** Messages from the browser that arrive while go2rtc is still being reached are held; a browser only sends a few small ones. */
const MAX_HELD_MESSAGES = 32
const MAX_HELD_BYTES = 64 * 1024
/** A refused socket is given this long to take the close message before it is cut. */
const REFUSED_LINGER_MS = 2000
/** True for a text message like {"type":"mse","value":"..."}: JSON object whose type is on the allow-list. Anything else is refused. */
function allowedBrowserMessage(data: Buffer, isBinary: boolean): boolean {
  if (isBinary || data.length === 0 || data.length > MAX_BROWSER_TEXT) return false
  try {
    const o: unknown = JSON.parse(data.toString('utf8'))
    return typeof o === 'object' && o !== null && !Array.isArray(o) && typeof (o as { type?: unknown }).type === 'string' && BROWSER_MESSAGE_TYPES.includes((o as { type: string }).type)
  } catch {
    return false
  }
}

const GENERIC_STREAM_ERROR = 'The video is not available.'
/** Final fix X: the close of a socket whose NVR's login stands refused, and the one error value the tile understands for it. */
export const CLOSE_LOGIN_REFUSED = 4401
// Round 2 (review M-7, NB-12): what reaches the browser names no NVR and no login; the gateway cannot tell a CCTV-only viewer from the
// IT view. The IT view reads the NVR's login state on the Monitoring page instead.
export const LOGIN_REFUSED_VALUE = 'camera_not_available'
const MSG_LOGIN_REFUSED = 'Camera not available'
/** Round 2 (review M-8): video is reported at most once a minute per stream (it clears the count of unexplained failures). */
const VIDEO_REPORT_MS = 60_000
export const DEFAULT_UPSTREAM_SILENCE_MS = 30_000
/** How long one answer of the NVR login question is reused for the same stream. */
const LOGIN_ANSWER_MS = 5_000

/** go2rtc's error message for a refused RTSP login (lib/nvr/login-guard.ts isGo2rtcLoginRefusal), read before it is replaced. */
function upstreamLoginRefusal(data: Buffer): boolean {
  if (data.length === 0 || data.length > 8192 || data[0] !== 0x7b) return false
  try {
    const o: unknown = JSON.parse(data.toString('utf8'))
    return typeof o === 'object' && o !== null && (o as { type?: unknown }).type === 'error' && typeof (o as { value?: unknown }).value === 'string' && isGo2rtcLoginRefusal((o as { value: string }).value)
  } catch {
    return false
  }
}

/** go2rtc's error text from an upstream text message ({"type":"error","value":"..."}), or null for anything else. */
function upstreamErrorText(data: Buffer): string | null {
  if (data.length === 0 || data.length > 8192 || data[0] !== 0x7b) return null
  try {
    const o: unknown = JSON.parse(data.toString('utf8'))
    if (typeof o !== 'object' || o === null || (o as { type?: unknown }).type !== 'error') return null
    const v = (o as { value?: unknown }).value
    return typeof v === 'string' ? v : ''
  } catch {
    return null
  }
}

/**
 * Round 3 (pre-handover review I-1; NB-12 as revised): go2rtc's words for a failure of the network between it and the NVR (a dial or
 * read timeout, a reset or refused connection, an unreachable host or network, a DNS or TLS failure, a connection cut short). These are
 * network failures, never "unexplained": they never count towards the fail-safe, never pause an NVR and never list it as a login problem.
 */
const NETWORK_FAILURE = /timeout|timed out|deadline exceeded|connection reset|reset by peer|connection refused|broken pipe|no route to host|network is unreachable|host is unreachable|unreachable|no such host|lookup |dns|tls|x509|certificate|handshake|\beof\b|use of closed network connection|dial tcp|dial udp/i
export const isNetworkFailureText = (text: string) => NETWORK_FAILURE.test(text)

const shortHash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8)
/** Round 2 (review M-8): an unexplained failure is reported as this hash only, never its text (it may carry an address). */
const failureHash = (text: string) => createHash('sha256').update(text).digest('hex')

/** The part of the request target before any `?`, exactly as sent; null for anything that is not an origin-form target. */
function pathOf(url: string | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null
  const q = url.indexOf('?')
  return q < 0 ? url : url.slice(0, q)
}

/** `scheme://host[:port]` in one spelling (lower case, default port dropped), or null when the text is not an origin. */
export function normalizeOrigin(value: string, strict = false): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300 || /[\s,]/.test(value)) return null
  if (strict && value.endsWith('/')) return null // a browser never sends a trailing slash
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || u.pathname !== '/') return null
  return u.origin
}

/** Counts attempts per key in a sliding window. Refused attempts are not counted, so waiting always frees a slot. */
class WindowLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  allow(key: string): boolean {
    const t = this.now()
    if (this.hits.size > 10_000) this.sweep(t)
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs)
    const ok = recent.length < this.limit
    if (ok) recent.push(t)
    this.hits.set(key, recent)
    return ok
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k)
    // Still too many addresses: forget the oldest ones rather than grow without limit.
    for (const k of this.hits.keys()) {
      if (this.hits.size <= 50_000) break
      this.hits.delete(k)
    }
  }
}

const clientAddress = (socket: Duplex & { remoteAddress?: string }) => (socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
const LOOPBACK_PEER = /^(127(\.\d{1,3}){3}|::1)$/

/**
 * P5.5 (load test finding): the address the per-address limits count. Behind the one TLS address (Caddy on this computer, GATEWAY_HOST=
 * 127.0.0.1) every socket comes from 127.0.0.1, so with `hops` trusted proxies (TRUSTED_PROXY_HOPS, as the web app) the address is the
 * hops-th X-Forwarded-For entry from the right, the one the proxy wrote. It is believed only for a socket from this computer (the proxy):
 * a client reaching the gateway directly cannot pick its own bucket. No such entry, or one that is not an address: the socket's own.
 */
function limitAddress(req: http.IncomingMessage, socket: Duplex & { remoteAddress?: string }, hops: number): string {
  const peer = clientAddress(socket)
  if (hops < 1 || !LOOPBACK_PEER.test(peer)) return peer
  const header = req.headersDistinct['x-forwarded-for']
  const parts = (header ?? []).join(',').split(',').map((s) => s.trim()).filter(Boolean)
  const entry = parts.length >= hops ? parts[parts.length - hops].replace(/^::ffff:/, '') : ''
  return isIP(entry) !== 0 ? entry : peer
}

/** go2rtc error messages can contain camera addresses and passwords; the browser only ever gets a fixed sentence. */
function cleanUpstreamText(data: Buffer): Buffer {
  if (data.length === 0 || data.length > 8192 || data[0] !== 0x7b) return data
  try {
    const o: unknown = JSON.parse(data.toString('utf8'))
    if (typeof o === 'object' && o !== null && (o as { type?: unknown }).type === 'error') {
      return Buffer.from(JSON.stringify({ type: 'error', value: GENERIC_STREAM_ERROR }))
    }
  } catch {
    // not JSON: pass it on as it is
  }
  return data
}

const toBuffer = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d))

export function createGateway(opts: GatewayOptions): GatewayServer {
  if (!usableSecret(opts.secret)) throw new Error('The gateway needs a stream token secret of at least 16 characters.')
  let upstreamBase: URL
  try {
    upstreamBase = new URL(opts.go2rtcUrl)
  } catch {
    throw new Error('The video server address is not valid.')
  }
  if (upstreamBase.protocol !== 'http:' && upstreamBase.protocol !== 'https:') throw new Error('The video server address is not valid.')
  if (!opts.registry || typeof opts.registry.open !== 'function' || typeof opts.registry.stillValid !== 'function') {
    throw new Error('The gateway needs the media session registry (it verifies every video connection).')
  }

  const secret = opts.secret
  const upstreamAuth: Record<string, string> = opts.go2rtcAuth ? { Authorization: basicAuthHeader(opts.go2rtcAuth) } : {}
  const now = opts.now ?? Date.now
  const maxSessionMs = opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS
  const maxSockets = opts.maxSockets ?? DEFAULT_MAX_SOCKETS
  const highWater = opts.backpressureBytes ?? 1024 * 1024
  const stallMs = opts.backpressureStallMs ?? 10_000
  const log = opts.log ?? (() => {})
  const allowed = new Set(opts.allowedOrigins.map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null))
  const perMinute = opts.maxUpgradesPerMinute ?? DEFAULT_MAX_UPGRADES_PER_MINUTE
  const upgradeLimiter = new WindowLimiter(perMinute, 60_000, now)
  const maxPerIp = opts.maxSocketsPerIp ?? DEFAULT_MAX_SOCKETS_PER_IP
  const socketsPerIp = new Map<string, number>()
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const hops = opts.trustedProxyHops ?? 0
  const upstreamSilenceMs = opts.upstreamSilenceMs ?? DEFAULT_UPSTREAM_SILENCE_MS
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error('The number of trusted proxies (TRUSTED_PROXY_HOPS) must be a whole number from 0 to 5.')

  const origin = upstreamBase.origin
  const wsOrigin = origin.replace(/^http/, 'ws')
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_PAYLOAD, perMessageDeflate: false })
  type Session = { sid: string; validatedAt: number; end: (code: number, reason: string, outcome?: GatewayEvent['outcome'], why?: string) => void }
  /** Sockets whose registry session is open (they are re-checked). */
  const sessions = new Set<Session>()
  /** Sockets still waiting for the registry's answer (closed on shutdown). */
  const pending = new Set<Session>()
  let closing = false

  // ── the registry checks ────────────────────────────────────────────────────
  const registry = opts.registry
  const validateEveryMs = opts.validateEveryMs ?? DEFAULT_VALIDATE_EVERY_MS
  const failClosedAfterMs = opts.failClosedAfterMs ?? DEFAULT_FAIL_CLOSED_AFTER_MS
  let lastGoodCheck: number | null = null
  let registryFailing = false
  let checking: Promise<void> | null = null

  // Review m-3: the gateway's own deadline for one check, whatever the registry client does (a check that never settles is a failure).
  const checkDeadlineMs = opts.checkDeadlineMs ?? Math.max(validateEveryMs, REGISTRY_TIMEOUT_MS)
  const withDeadline = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The access check took too long.')), checkDeadlineMs)
      t.unref?.()
      p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)))
    })
  /** Fail closed: every socket whose last good check is failClosedAfterMs old is closed. */
  const sweep = () => {
    const cutoff = now() - failClosedAfterMs
    for (const s of [...sessions]) if (s.validatedAt <= cutoff) s.end(CLOSE_CANNOT_VERIFY, MSG_CANNOT_VERIFY, 'fail_closed')
  }

  async function check(): Promise<void> {
    const list = [...sessions]
    const askedAt = now()
    let invalid: Map<string, string>
    try {
      // Review m-2: with no socket open the registry is still asked (a session id that cannot exist), so a broken key or an
      // unreachable database shows on the health page instead of a green "checked 0 seconds ago".
      invalid = await withDeadline(registry.stillValid(list.length > 0 ? list.map((s) => s.sid) : [PING_SID]))
    } catch {
      registryFailing = true
      log({ event: 'gateway_session', outcome: 'check_failed', sessions: list.length })
      sweep()
      return
    }
    registryFailing = false
    lastGoodCheck = askedAt
    for (const s of list) {
      if (!sessions.has(s)) continue
      const why = invalid.get(s.sid)
      if (why !== undefined) s.end(CLOSE_ACCESS_CHANGED, MSG_ACCESS_CHANGED, 'revoked', why)
      else s.validatedAt = askedAt // the time the question was asked: never later than the answer
    }
  }
  /** One check at a time; a call while one runs waits for that one, and the fail-closed time is applied on every call. */
  const validateNow = (): Promise<void> => {
    if (checking) {
      sweep() // a check still in flight never keeps a socket open past its fail-closed time
      return checking
    }
    checking = check().finally(() => (checking = null))
    return checking
  }
  // Final fix X: the NVR login question is asked once per stream for a few seconds (a wall's sockets for one camera, or a burst of
  // reconnects, share one answer; a question in flight is shared too). A failure is not kept: the next socket asks again.
  const loginAnswers = new Map<string, { at: number; answer: Promise<'go' | 'refused'> }>()
  const loginCheckFor = (stream: string, sid: string): Promise<'go' | 'refused'> => {
    const t = Date.now()
    const hit = loginAnswers.get(stream)
    if (hit && t - hit.at < LOGIN_ANSWER_MS) return hit.answer
    if (loginAnswers.size > 5000) loginAnswers.clear()
    const answer = withDeadline(registry.loginCheck!(sid))
    loginAnswers.set(stream, { at: t, answer })
    answer.catch(() => {
      if (loginAnswers.get(stream)?.answer === answer) loginAnswers.delete(stream)
    })
    return answer
  }
  const forgetLoginAnswer = (stream: string) => loginAnswers.delete(stream)
  // Round 2 (review M-8): the last time video was reported per stream (at most once a minute).
  const videoReportedAt = new Map<string, number>()
  const reportVideo = (stream: string, sid: string) => {
    if (!registry.loginReport) return
    const t = Date.now()
    const last = videoReportedAt.get(stream)
    if (last !== undefined && t - last < VIDEO_REPORT_MS) return
    if (videoReportedAt.size > 5000) videoReportedAt.clear()
    videoReportedAt.set(stream, t)
    void registry.loginReport(sid, 'video').catch(() => {})
  }
  const checkTimer = opts.autoValidate === false ? null : setInterval(() => void validateNow().catch(() => {}), validateEveryMs)
  checkTimer?.unref()

  const health = (): GatewayHealth => ({
    status: registryFailing ? 'not_verifying' : 'ok',
    registry: registryFailing ? 'failing' : 'ok',
    openSessions: sessions.size,
    lastValidationAgeSec: lastGoodCheck === null ? null : Math.max(0, Math.round((now() - lastGoodCheck) / 1000)),
    validateEverySec: Math.round(validateEveryMs / 1000),
    failClosedAfterSec: Math.round(failClosedAfterMs / 1000),
  })

  // ── plain HTTP ─────────────────────────────────────────────────────────────
  const baseHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
  const sendText = (res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...baseHeaders, ...extra })
    res.end(text)
  }

  // Final clean-up (FY-10, B minor 5): the old player-script route (/g/video-stream.js, /g/video-rtc.js fetched from go2rtc) is gone;
  // the web app loads its pinned copy from its own origin with a subresource integrity hash (public/vendor/go2rtc-1.9.9). The plain
  // HTTP side answers only /g/health (this computer) and 426 on the socket address.
  const server = http.createServer({ connectionsCheckingInterval: 2000, keepAliveTimeout: 5000, headersTimeout: requestTimeoutMs, requestTimeout: requestTimeoutMs }, (req, res) => {
    const path = pathOf(req.url)
    const known = path === '/g/health' || path === WS_PATH
    if (!known) return sendText(res, 404, 'Not found')
    if (path === WS_PATH) return sendText(res, 426, 'This address is for video connections only.', { Upgrade: 'websocket', Connection: 'Upgrade' })
    // Anything but GET is 405, including a CORS preflight (nothing here needs one).
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed', { Allow: 'GET' })
    // /g/health. Final fix Y (final review B minor 8): only a request made on this computer directly (the web app's Health page reads
    // it there, GATEWAY_HEALTH_URL). Through the TLS proxy (which adds X-Forwarded-For / Forwarded) or from another computer it is "Not
    // found": the open connections and whether access checks fail are nobody else's business.
    const peer = clientAddress(req.socket)
    const proxied = req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined
    if (proxied || !(peer === '127.0.0.1' || peer === '::1')) return sendText(res, 404, 'Not found')
    // P2-4: counts and ages only (no session id, person, camera or address).
    const body = JSON.stringify(health())
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...baseHeaders })
    res.end(body)
  }) as GatewayServer
  // Slow or half-finished requests are dropped (checked every 2 s); this does not affect an upgraded video socket.
  server.maxConnections = MAX_HTTP_CONNECTIONS

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function refuseRaw(socket: Duplex, status: number, text: string) {
    socket.on('error', () => {})
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\n` +
        `X-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n\r\n${text}`,
    )
  }

  /** Closes a socket with a code and a fixed sentence; cuts it if it does not take the message. */
  function closeSocket(ws: WebSocket, code: number, reason: string) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(code, reason)
      } catch {
        ws.terminate()
      }
      setTimeout(() => ws.terminate(), REFUSED_LINGER_MS).unref()
    }
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    if (closing) return refuseRaw(socket, 503, 'Service unavailable')
    if (pathOf(req.url) !== WS_PATH) return refuseRaw(socket, 404, 'Not found')
    const ip = limitAddress(req, socket, hops)
    const limited = !upgradeLimiter.allow(ip)
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {})
      const mine = (socketsPerIp.get(ip) ?? 0) + 1
      socketsPerIp.set(ip, mine)
      ws.on('close', () => {
        const left = (socketsPerIp.get(ip) ?? 1) - 1
        if (left <= 0) socketsPerIp.delete(ip)
        else socketsPerIp.set(ip, left)
      })
      if (limited) {
        log({ event: 'gateway_session', outcome: 'rate_limited' })
        return closeSocket(ws, 1013, 'Too many attempts. Try again in a minute.')
      }
      if (mine > maxPerIp) {
        log({ event: 'gateway_session', outcome: 'full' })
        return closeSocket(ws, 1013, 'Too many open videos from this address.')
      }
      if (wss.clients.size > maxSockets) {
        log({ event: 'gateway_session', outcome: 'full' })
        return closeSocket(ws, 1013, 'The video server is busy. Try again soon.')
      }
      accept(ws, req)
    })
  })

  function accept(client: WebSocket, req: http.IncomingMessage) {
    const deny = (outcome: 'denied_origin' | 'denied_token') => {
      log({ event: 'gateway_session', outcome })
      closeSocket(client, 1008, 'Not allowed')
    }

    // Origin: exactly one header, in the allowed list after normalising scheme, host and port.
    const origins = req.headersDistinct.origin
    const origin = origins && origins.length === 1 ? normalizeOrigin(origins[0], true) : null
    if (origin === null || !allowed.has(origin)) return deny('denied_origin')

    // Token: exactly one `token` parameter that verifies. Any `src` (or anything else) in the query is ignored.
    const query = (req.url ?? '').split('?')[1] ?? ''
    const tokens = new URLSearchParams(query).getAll('token')
    const claims = tokens.length === 1 ? verifyStreamToken(tokens[0], now(), secret) : null
    if (!claims) return deny('denied_token')
    let name: string
    try {
      name = streamName(claims)
    } catch {
      return deny('denied_token')
    }

    const camera = shortHash(claims.c)
    const kind = claims.k
    const sid = claims.sid
    const startedAt = Date.now()
    let upstream: WebSocket | null = null

    let ended = false
    let opened = false // the registry opened the session: it is re-checked, and closed in the registry at the end
    let upstreamOpen = false
    let reportedBackpressure = false
    let held: { data: Buffer; isBinary: boolean }[] = []
    let heldBytes = 0
    const stops: (() => void)[] = []
    let sessionTimer: NodeJS.Timeout | undefined
    let toUpstream: ((data: Buffer, isBinary: boolean) => void) | null = null
    // Final fix X (review C I-2): a picture that played and then got no video for upstreamSilenceMs is ended, so the viewer's tile
    // reconnects through the login check instead of go2rtc retrying the NVR (with a login that may now be wrong) behind an open socket.
    let lastVideoAt = 0
    let failureReported = false
    let silenceTimer: NodeJS.Timeout | undefined
    const watchSilence = () => {
      if (silenceTimer || ended) return
      silenceTimer = setInterval(() => {
        if (Date.now() - lastVideoAt > upstreamSilenceMs) end(1011, 'The video stopped.', 'upstream_silent')
      }, Math.min(5000, upstreamSilenceMs))
      silenceTimer.unref?.()
    }

    const session: Session = { sid, validatedAt: now(), end: (code, reason, outcome, why) => end(code, reason, outcome, why) }
    pending.add(session)

    function end(code: number, reason: string, outcome: GatewayEvent['outcome'] = 'ended', why?: string) {
      if (ended) return
      ended = true
      clearTimeout(sessionTimer)
      if (silenceTimer) clearInterval(silenceTimer)
      pending.delete(session)
      sessions.delete(session)
      held = []
      stops.forEach((s) => s())
      if (outcome === 'stalled') client.terminate() // a client that cannot read cannot be told either
      else closeSocket(client, code, reason)
      if (upstream?.readyState === WebSocket.OPEN) {
        const u = upstream
        try {
          u.close(1000)
        } catch {
          u.terminate()
        }
        setTimeout(() => u.terminate(), REFUSED_LINGER_MS).unref()
      } else if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate()
      if (opened) void registry.close(sid).catch(() => {})
      log({ event: 'gateway_session', outcome, camera, kind, durationMs: Date.now() - startedAt, ...(why ? { reason: why } : {}) })
    }

    // The browser's side is listened to at once: a player sends its first request as soon as the socket is open, before the registry
    // has answered; that request is held (and checked) like one that arrives while go2rtc is being reached.
    client.on('message', (raw: RawData, isBinary: boolean) => {
      if (ended) return
      const data = toBuffer(raw)
      if (!allowedBrowserMessage(data, isBinary)) return end(1008, 'Not allowed', 'denied_message')
      if (upstreamOpen && toUpstream) return toUpstream(data, isBinary)
      held.push({ data, isBinary })
      heldBytes += data.length
      if (held.length > MAX_HELD_MESSAGES || heldBytes > MAX_HELD_BYTES) end(1008, 'Not allowed')
    })
    client.on('close', () => end(1000, ''))

    // The token's own session must open in the registry before anything is connected upstream (P2-4).
    registry.open(sid, { user: claims.u, camera: claims.c, kind: kind === 'pb' ? 'playback' : 'live', stream: name }).then(
      (answer) => {
        registryFailing = false // the registry answered (review m-2)
        if (answer.ok) opened = true
        if (ended) {
          // The browser left (or the gateway is stopping) while the registry was asked: nothing upstream; the session is closed.
          if (opened) void registry.close(sid).catch(() => {})
          return
        }
        pending.delete(session)
        if (!answer.ok) {
          log({ event: 'gateway_session', outcome: 'denied_session', reason: answer.reason })
          ended = true // logged above; close without a second line
          held = []
          return closeSocket(client, 1008, 'Not allowed')
        }
        session.validatedAt = now()
        sessions.add(session)
        sessionTimer = setTimeout(() => end(1000, 'Session ended'), maxSessionMs)
        // Final fix X (review C I-2, NB-2): go2rtc dials the NVR when this socket connects upstream, so an NVR whose login stands
        // refused is not dialled at all; the tile is told so and does not keep reconnecting.
        if (!registry.loginCheck) return connectUpstream()
        loginCheckFor(name, sid).then(
          (decision) => {
            if (ended) return
            if (decision === 'refused') return refuseLogin()
            connectUpstream()
          },
          () => {
            if (ended) return
            end(CLOSE_CANNOT_VERIFY, MSG_CANNOT_VERIFY, 'unverified')
          },
        )
      },
      () => {
        registryFailing = true // review m-2: a broken key or an unreachable database shows on the health page
        if (ended) return
        pending.delete(session)
        log({ event: 'gateway_session', outcome: 'unverified' })
        ended = true
        held = []
        closeSocket(client, CLOSE_CANNOT_VERIFY, MSG_CANNOT_VERIFY)
      },
    )

    /** The NVR's login stands refused: one fixed message the player understands, then the close (no NVR detail, no go2rtc text). */
    function refuseLogin(why?: string) {
      if (ended) return
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', value: LOGIN_REFUSED_VALUE }))
      end(CLOSE_LOGIN_REFUSED, MSG_LOGIN_REFUSED, 'login_refused', why)
    }

    /**
     * Round 2 (review M-8, NB-12) and round 3 (pre-handover review I-1): go2rtc's source failed before any video. A network failure
     * (isNetworkFailureText, or go2rtc cutting the connection without a word) is reported as 'network': the database only notes it.
     * Any other text the gateway cannot read is reported as a hash (never the text). The database decides whether it is that camera's
     * own failure ('counted', 'camera': a dead channel, an NVR proven or playing lately) or, the same failure from a second camera of
     * an NVR never proven, the fail-safe ('unexplained': every path waits for the window, so an unknown wording for a wrong password
     * cannot keep go2rtc dialling). The tile is closed either way, with the neutral words; the fail-safe is logged
     * ('unexplained_failsafe') for the pilot check.
     */
    function sourceFailure(text: string | null) {
      if (ended || failureReported) return
      failureReported = true // one report per socket (go2rtc's error is usually followed by its close)
      const network = text === null || isNetworkFailureText(text)
      const outcome: GatewayEvent['outcome'] = network ? 'upstream_network' : 'upstream_unexplained'
      if (!registry.loginReport) return end(1011, GENERIC_STREAM_ERROR, outcome)
      const asked = (network ? registry.loginReport(sid, 'network') : registry.loginReport(sid, 'unexplained', failureHash(text))).catch(() => 'ignored')
      // The socket is ended once the database has answered (a few hundred ms at most), either way.
      void withDeadline(asked).then(
        (answer) => {
          if (answer === 'unexplained') {
            forgetLoginAnswer(name)
            return refuseLogin('unexplained_failsafe')
          }
          end(1011, GENERIC_STREAM_ERROR, outcome)
        },
        () => end(1011, GENERIC_STREAM_ERROR, outcome),
      )
    }

    /** Sends one message across; if the other side falls behind, the source is paused until it catches up, or the session is cut. */
    function makePipe(src: WebSocket, dst: WebSocket, clean: (b: Buffer) => Buffer = (b) => b) {
      let paused = false
      let poll: NodeJS.Timeout | undefined
      let stall: NodeJS.Timeout | undefined
      const stop = () => {
        if (poll) clearInterval(poll)
        if (stall) clearTimeout(stall)
        poll = stall = undefined
        paused = false
      }
      stops.push(stop)
      return (data: Buffer, isBinary: boolean) => {
        if (ended || dst.readyState !== WebSocket.OPEN) return
        dst.send(isBinary ? data : clean(data), { binary: isBinary }, () => {})
        if (paused || dst.bufferedAmount <= highWater) return
        paused = true
        if (!reportedBackpressure) {
          reportedBackpressure = true
          log({ event: 'gateway_session', outcome: 'backpressure', camera, kind })
        }
        src.pause()
        stall = setTimeout(() => end(1013, 'Too slow', 'stalled'), stallMs)
        poll = setInterval(() => {
          if (dst.bufferedAmount > highWater / 2) return
          stop()
          src.resume()
        }, 50)
      }
    }
    function connectUpstream() {
      const target = new URL(`${wsOrigin}/api/ws`)
      target.searchParams.set('src', name)
      const up = new WebSocket(target.toString(), {
        handshakeTimeout: UPSTREAM_CONNECT_MS,
        maxPayload: MAX_UPSTREAM_PAYLOAD,
        perMessageDeflate: false,
        followRedirects: false,
        headers: upstreamAuth,
      })
      upstream = up
      up.on('error', () => {})
      const send = makePipe(client, up)
      toUpstream = send
      const toClient = makePipe(up, client, cleanUpstreamText)

      up.on('open', () => {
        if (ended) return
        upstreamOpen = true
        log({ event: 'gateway_session', outcome: 'started', camera, kind })
        const queue = held
        held = []
        for (const m of queue) send(m.data, m.isBinary)
      })
      up.on('message', (raw: RawData, isBinary: boolean) => {
        const data = toBuffer(raw)
        if (isBinary) {
          // Round 2 (M-8), round 3 (I-1): video is reported while it plays (at most once a minute per stream), so an NVR whose
          // cameras play is never taken for one with a wrong password because one of its channels fails.
          reportVideo(name, sid)
          lastVideoAt = Date.now()
          watchSilence()
        } else if (upstreamLoginRefusal(data)) {
          // go2rtc's "wrong user/pass": a refused NVR login for this session's camera (the shared back-off starts for every path).
          void registry.loginRefused?.(sid)
          forgetLoginAnswer(name)
          return refuseLogin()
        } else if (lastVideoAt === 0) {
          // Round 2 (M-8), round 3 (I-1): any other go2rtc error before video is a source failure (network or unexplained).
          // The tile still gets the fixed sentence (never go2rtc's text), then the socket ends once the database has answered.
          const text = upstreamErrorText(data)
          if (text !== null) {
            toClient(data, isBinary)
            return sourceFailure(text)
          }
        }
        toClient(data, isBinary)
      })
      up.on('error', () => {
        if (!upstreamOpen) end(1011, 'The video is not available.', 'upstream_failed')
      })
      up.on('close', (code) => {
        if (!upstreamOpen) end(1011, 'The video is not available.', 'upstream_failed')
        // Round 3 (I-1): go2rtc broke the stream off (not a normal close) before any video, without a word: a network failure, never
        // an unexplained one. A normal close (1000/1001) is go2rtc ending the stream on purpose and is passed on as before.
        else if (lastVideoAt === 0 && !ended && code !== 1000 && code !== 1001) sourceFailure(null)
        else end(code === 1000 || code === 1001 ? 1000 : 1011, code === 1000 || code === 1001 ? 'Video ended' : 'The video is not available.')
      })
    }
  }

  // ── shutdown ───────────────────────────────────────────────────────────────
  server.shutdown = (timeoutMs = SHUTDOWN_MS) =>
    new Promise<void>((resolve) => {
      closing = true
      let done = false
      const timers: NodeJS.Timeout[] = []
      const finish = () => {
        if (done) return
        done = true
        timers.forEach(clearTimeout)
        resolve()
      }
      const cutAll = () => {
        for (const ws of wss.clients) ws.terminate()
        server.closeAllConnections()
      }
      if (checkTimer) clearInterval(checkTimer)
      server.close(() => finish()) // the callback also runs (with an error) when the server was not listening
      server.closeIdleConnections()
      for (const s of [...sessions, ...pending]) s.end(1001, 'Server stopping')
      for (const ws of wss.clients) closeSocket(ws, 1001, 'Server stopping')
      timers.push(setTimeout(cutAll, Math.min(1500, timeoutMs / 2)))
      timers.push(
        setTimeout(() => {
          cutAll()
          finish()
        }, timeoutMs),
      )
    })
  server.validateNow = validateNow
  server.health = health

  return server
}
