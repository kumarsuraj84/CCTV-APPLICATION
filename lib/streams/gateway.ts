import { createHash } from 'node:crypto'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { usableSecret } from '@/lib/secrets'
import { streamName, verifyStreamToken, type StreamClaims } from '@/lib/streams/token'

// The video gateway: the only video endpoint a browser can reach. A browser opens a WebSocket with a signed stream token; the
// gateway checks the Origin and the token and then pipes the socket to go2rtc. The go2rtc stream name comes from the signed
// claims only, so nothing the browser sends can choose a stream, and go2rtc's address and error texts (which can contain camera
// addresses and passwords) never reach a browser.

export type GatewayEvent = {
  event: 'gateway_session'
  outcome: 'started' | 'ended' | 'denied_origin' | 'denied_token' | 'denied_message' | 'rate_limited' | 'full' | 'upstream_failed' | 'backpressure' | 'stalled'
  /** First 8 hex characters of the SHA-256 of the camera id; never the id, the stream name, the person or the token. */
  camera?: string
  kind?: StreamClaims['k']
  durationMs?: number
}

export type GatewayOptions = {
  go2rtcUrl: string
  secret: string
  allowedOrigins: string[]
  /** A session ends after this long (default 30 minutes); the browser asks for a new token and reconnects. */
  maxSessionMs?: number
  /** The clock for token expiry and the rate limit (default Date.now). */
  now?: () => number
  /** Open browser sockets allowed at once (default 300); more are closed with 1013. */
  maxSockets?: number
  /** Open browser sockets allowed at once from one address (default 100); more are closed with 1013. */
  maxSocketsPerIp?: number
  /** Upgrade attempts per address per minute (default 240); more are closed with 1013 (HTTP script requests get a 429). */
  maxUpgradesPerMinute?: number
  /** How long a request may take to arrive before the connection is dropped (default 10 s; headers and body). */
  requestTimeoutMs?: number
  /** When the receiving side has this many bytes waiting, the sending side is paused (default 1 MB). */
  backpressureBytes?: number
  /** If the receiving side stays that far behind for this long, the session is cut (default 10 s). */
  backpressureStallMs?: number
  /** Where outcomes go (no personal data, see GatewayEvent). Default: nowhere. */
  log?: (e: GatewayEvent) => void
}

export type GatewayServer = http.Server & { shutdown(timeoutMs?: number): Promise<void> }

export const DEFAULT_MAX_SESSION_MS = 30 * 60_000
export const DEFAULT_MAX_SOCKETS = 300
export const DEFAULT_MAX_SOCKETS_PER_IP = 100
export const DEFAULT_MAX_UPGRADES_PER_MINUTE = 240
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
export const MAX_HTTP_CONNECTIONS = 1000
/** The only messages a browser may send to go2rtc: the player's request to start a stream, as JSON text. */
export const BROWSER_MESSAGE_TYPES: readonly string[] = ['mse', 'mp4', 'mjpeg']
const MAX_BROWSER_TEXT = 4096
/** Largest message accepted from a browser. */
export const MAX_BROWSER_PAYLOAD = 4 * 1024 * 1024
/** Largest message accepted from go2rtc (a video fragment can be bigger than anything a browser sends). */
export const MAX_UPSTREAM_PAYLOAD = 16 * 1024 * 1024
export const SHUTDOWN_MS = 5000

const WS_PATH = '/g/ws'
const SCRIPT_PATHS: Record<string, string> = { '/g/video-stream.js': '/video-stream.js', '/g/video-rtc.js': '/video-rtc.js' }
const SCRIPT_TIMEOUT_MS = 5000
const MAX_SCRIPT_BYTES = 1024 * 1024
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

const shortHash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8)

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

  const secret = opts.secret
  const now = opts.now ?? Date.now
  const maxSessionMs = opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS
  const maxSockets = opts.maxSockets ?? DEFAULT_MAX_SOCKETS
  const highWater = opts.backpressureBytes ?? 1024 * 1024
  const stallMs = opts.backpressureStallMs ?? 10_000
  const log = opts.log ?? (() => {})
  const allowed = new Set(opts.allowedOrigins.map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null))
  const perMinute = opts.maxUpgradesPerMinute ?? DEFAULT_MAX_UPGRADES_PER_MINUTE
  const upgradeLimiter = new WindowLimiter(perMinute, 60_000, now)
  const scriptLimiter = new WindowLimiter(perMinute, 60_000, now)
  const maxPerIp = opts.maxSocketsPerIp ?? DEFAULT_MAX_SOCKETS_PER_IP
  const socketsPerIp = new Map<string, number>()
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  const origin = upstreamBase.origin
  const wsOrigin = origin.replace(/^http/, 'ws')
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_PAYLOAD, perMessageDeflate: false })
  const sessions = new Set<{ end: (code: number, reason: string, outcome?: GatewayEvent['outcome']) => void }>()
  let closing = false

  // ── plain HTTP ─────────────────────────────────────────────────────────────
  const baseHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
  const sendText = (res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...baseHeaders, ...extra })
    res.end(text)
  }

  async function readCapped(res: Response): Promise<Buffer | null> {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SCRIPT_BYTES) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    if (!res.body) return Buffer.alloc(0)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_SCRIPT_BYTES) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    } catch {
      await reader.cancel().catch(() => {})
      return null
    }
    return Buffer.concat(chunks)
  }

  /** The player scripts are loaded cross-origin by the web app: answer with that exact origin when it is on the list, never with *. */
  function scriptCors(req: http.IncomingMessage): Record<string, string> {
    const given = req.headersDistinct.origin
    const o = given && given.length === 1 ? normalizeOrigin(given[0], true) : null
    return o !== null && allowed.has(o) ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin' } : { Vary: 'Origin' }
  }

  async function serveScript(req: http.IncomingMessage, res: http.ServerResponse, upstreamPath: string) {
    const cors = scriptCors(req)
    try {
      // Nothing from the browser's request goes along: not its headers, not its query, only a fixed path.
      const r = await fetch(`${origin}${upstreamPath}`, { redirect: 'manual', signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS) })
      const body = r.ok ? await readCapped(r) : (await r.body?.cancel().catch(() => {}), null)
      if (!body) return sendText(res, 502, 'The video server is not available.', cors)
      res.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        ...cors,
      })
      res.end(body)
    } catch {
      sendText(res, 502, 'The video server is not available.', cors)
    }
  }

  const server = http.createServer({ connectionsCheckingInterval: 2000, keepAliveTimeout: 5000, headersTimeout: requestTimeoutMs, requestTimeout: requestTimeoutMs }, (req, res) => {
    const path = pathOf(req.url)
    const known = path === '/g/health' || path === WS_PATH || (path !== null && Object.hasOwn(SCRIPT_PATHS, path))
    if (!known) return sendText(res, 404, 'Not found')
    if (path === WS_PATH) return sendText(res, 426, 'This address is for video connections only.', { Upgrade: 'websocket', Connection: 'Upgrade' })
    // Anything but GET is 405, including a CORS preflight: the player scripts are simple GETs and need none.
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed', { Allow: 'GET' })
    if (path === '/g/health') return sendText(res, 200, 'ok')
    if (!scriptLimiter.allow(clientAddress(req.socket))) {
      log({ event: 'gateway_session', outcome: 'rate_limited' })
      return sendText(res, 429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60', ...scriptCors(req) })
    }
    void serveScript(req, res, SCRIPT_PATHS[path as string])
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
    const limited = !upgradeLimiter.allow(clientAddress(socket))
    const ip = clientAddress(socket)
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
    const startedAt = Date.now()
    const target = new URL(`${wsOrigin}/api/ws`)
    target.searchParams.set('src', name)
    const upstream = new WebSocket(target.toString(), {
      handshakeTimeout: UPSTREAM_CONNECT_MS,
      maxPayload: MAX_UPSTREAM_PAYLOAD,
      perMessageDeflate: false,
      followRedirects: false,
    })
    upstream.on('error', () => {})

    let ended = false
    let upstreamOpen = false
    let reportedBackpressure = false
    let held: { data: Buffer; isBinary: boolean }[] = []
    let heldBytes = 0
    const stops: (() => void)[] = []

    const sessionTimer = setTimeout(() => end(1000, 'Session ended'), maxSessionMs)
    const session = { end: (code: number, reason: string, outcome?: GatewayEvent['outcome']) => end(code, reason, outcome) }
    sessions.add(session)

    function end(code: number, reason: string, outcome: GatewayEvent['outcome'] = 'ended') {
      if (ended) return
      ended = true
      clearTimeout(sessionTimer)
      sessions.delete(session)
      held = []
      stops.forEach((s) => s())
      if (outcome === 'stalled') client.terminate() // a client that cannot read cannot be told either
      else closeSocket(client, code, reason)
      if (upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.close(1000)
        } catch {
          upstream.terminate()
        }
        setTimeout(() => upstream.terminate(), REFUSED_LINGER_MS).unref()
      } else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
      log({ event: 'gateway_session', outcome, camera, kind, durationMs: Date.now() - startedAt })
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
    const toUpstream = makePipe(client, upstream)
    const toClient = makePipe(upstream, client, cleanUpstreamText)

    client.on('message', (raw: RawData, isBinary: boolean) => {
      if (ended) return
      const data = toBuffer(raw)
      if (!allowedBrowserMessage(data, isBinary)) return end(1008, 'Not allowed', 'denied_message')
      if (upstreamOpen) return toUpstream(data, isBinary)
      held.push({ data, isBinary })
      heldBytes += data.length
      if (held.length > MAX_HELD_MESSAGES || heldBytes > MAX_HELD_BYTES) end(1008, 'Not allowed')
    })
    client.on('close', () => end(1000, ''))

    upstream.on('open', () => {
      if (ended) return
      upstreamOpen = true
      log({ event: 'gateway_session', outcome: 'started', camera, kind })
      const queue = held
      held = []
      for (const m of queue) toUpstream(m.data, m.isBinary)
    })
    upstream.on('message', (raw: RawData, isBinary: boolean) => toClient(toBuffer(raw), isBinary))
    upstream.on('error', () => {
      if (!upstreamOpen) end(1011, 'The video is not available.', 'upstream_failed')
    })
    upstream.on('close', (code) => {
      if (!upstreamOpen) end(1011, 'The video is not available.', 'upstream_failed')
      else end(code === 1000 || code === 1001 ? 1000 : 1011, code === 1000 || code === 1001 ? 'Video ended' : 'The video is not available.')
    })
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
      server.close(() => finish()) // the callback also runs (with an error) when the server was not listening
      server.closeIdleConnections()
      for (const s of [...sessions]) s.end(1001, 'Server stopping')
      for (const ws of wss.clients) closeSocket(ws, 1001, 'Server stopping')
      timers.push(setTimeout(cutAll, Math.min(1500, timeoutMs / 2)))
      timers.push(
        setTimeout(() => {
          cutAll()
          finish()
        }, timeoutMs),
      )
    })

  return server
}
