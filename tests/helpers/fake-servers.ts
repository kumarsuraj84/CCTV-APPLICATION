// Fake network for tests and for the local demo. Everything listens on 127.0.0.1 only.
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

export type Running = { port: number; close: () => Promise<void> }
/** A fake server that says which address it really listens on (always 127.0.0.1; a test checks it). */
export type Bound = Running & { host: string }

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function closer(server: net.Server | http.Server, sockets: Set<net.Socket>) {
  return () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy())
      server.close(() => resolve())
    })
}

/** Accepts a connection and closes it at once: enough for a TCP "is it there" check. */
export async function startFakeTcp(fixedPort = 0): Promise<Bound> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.end()
  })
  const port = await new Promise<number>((resolve) => server.listen(fixedPort, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, host: (server.address() as net.AddressInfo).address, close: closer(server, sockets) }
}

/**
 * P2-5b: a listener that only COUNTS connections (each is closed at once). Used as an NVR's web and video port to prove that nothing —
 * worker, live, playback, fast playback or discovery — opens a single socket to a switched-off or unmapped NVR.
 */
export async function startCountingTcp(): Promise<Bound & { connections: () => number }> {
  const sockets = new Set<net.Socket>()
  let count = 0
  const server = net.createServer((s) => {
    count++
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.destroy()
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, host: (server.address() as net.AddressInfo).address, close: closer(server, sockets), connections: () => count }
}

/** A port nothing listens on: open a server, remember its port, close it. */
export async function closedPort(): Promise<number> {
  const s = await startFakeTcp()
  const port = s.port
  await s.close()
  return port
}

// ── Fake Hikvision NVR (ISAPI over HTTP Digest) ──────────────────────────────
export type FakeNvrOptions = {
  username?: string
  password?: string
  statuses?: Record<number, boolean>
  channels?: { channel: number; name: string; ip?: string }[]
  /**
   * ok: normal. forbidden: 403 after login. garbage: not XML. slow: never answers at all.
   * stall-body: headers, then the body stops. reset-body: headers, then the connection is cut mid-body.
   * huge: an answer larger than any real ISAPI answer.
   */
  mode?: 'ok' | 'forbidden' | 'garbage' | 'slow' | 'stall-body' | 'reset-body' | 'huge'
  /** Which login methods the 401 offers (repeated WWW-Authenticate headers, in this order). */
  challenge?: 'digest' | 'basic-only' | 'basic-then-digest' | 'digest-then-basic' | 'sha256-only'
  /** Every request, including the login challenge, is answered this many milliseconds late. */
  delayMs?: number
  /** The newer channel list: ok, an empty list, or not found. */
  inputProxy?: 'ok' | 'empty' | 'missing'
  /** The older channel list: ok or an empty list. */
  videoInputs?: 'ok' | 'empty'
  /**
   * Recordings in NVR-local terms: ISO times that the fake writes out with a Z, as an NVR does, and compares as they are.
   * `channel` limits one to a camera (all cameras when left out). Serves the recording search and the calendar (derived from these).
   */
  recordings?: { start: string; end: string; channel?: number }[]
  /** Items per page of the recording search (tests use a small page so paging is exercised). Default 2. */
  searchPageSize?: number
  /** Takes over the whole search answer (for hostile and odd answers). `position` and `maxResults` are what the request asked for. */
  searchAnswer?: (o: { position: number; maxResults: number; body: string }) => string
  /** Takes over the whole calendar answer. */
  dailyAnswer?: (o: { year: number; month: number; body: string }) => string
  /** What a download sends instead of FAKE_DOWNLOAD_BYTES (default: those). */
  downloadBytes?: Buffer
  /**
   * How a download goes. ok: the bytes at once. endless: the first bytes, then more every 20 ms until the client goes away (counted in
   * downloadsEnded). xml: 200 with an XML status document instead of a recording. stall: headers and a few bytes, then nothing.
   */
  download?: 'ok' | 'endless' | 'xml' | 'stall'
  port?: number
}
export type FakeNvr = Bound & {
  requests: string[]
  /** Every Authorization header received, in order. */
  authorizations: string[]
  /** Test-only record of every POST that passed the Digest login and reached a known endpoint: path, body and content type. Bounded by the 64 KB body cap. */
  posts: { path: string; body: string; contentType: string }[]
  /** Test-only: the bodies of the POSTs to /ISAPI/ContentMgmt/download that passed the login (each at most 64 KB). */
  downloadBodies: string[]
  /** Test-only: how many endless downloads have been ended by the client going away. */
  downloadsEnded: { count: number }
  setStatuses: (s: Record<number, boolean>) => void
}

/** What the fake NVR answers to a download request: always these bytes. */
export const FAKE_DOWNLOAD_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42FAKE-RECORDING', 'latin1')])
const MAX_FAKE_BODY = 64 * 1024
const SEARCH_PATH = '/ISAPI/ContentMgmt/search'
const DOWNLOAD_PATH = '/ISAPI/ContentMgmt/download'
const DAILY_PATH = /^\/ISAPI\/ContentMgmt\/record\/tracks\/(\d+)\/dailyDistribution$/
const GET_PATHS = new Set(['/ISAPI/ContentMgmt/InputProxy/channels/status', '/ISAPI/ContentMgmt/InputProxy/channels', '/ISAPI/System/Video/inputs/channels'])

type Recording = { start: string; end: string; channel?: number }
const isoMs = (s: string) => Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(s) ? s : `${s}Z`)
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const tagNumber = (body: string, tag: string) => Number(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`).exec(body)?.[1] ?? Number.NaN)
const forChannel = (list: Recording[], channel: number) => list.filter((r) => r.channel === undefined || r.channel === channel)

function searchXml(list: Recording[], body: string, pageSize: number): string {
  const channel = Math.floor(tagNumber(body, 'trackID') / 100)
  const from = isoMs(/<startTime>([^<]*)</.exec(body)?.[1] ?? '')
  const to = isoMs(/<endTime>([^<]*)</.exec(body)?.[1] ?? '')
  const position = Math.max(0, tagNumber(body, 'searchResultPostion') || 0)
  const asked = tagNumber(body, 'maxResults')
  const size = Math.min(pageSize, Number.isFinite(asked) && asked > 0 ? asked : pageSize)
  const matches = forChannel(list, channel)
    .map((r) => ({ s: isoMs(r.start), e: isoMs(r.end) }))
    .filter((r) => r.e > from && r.s < to)
    .sort((a, b) => a.s - b.s)
  const page = matches.slice(position, position + size)
  const more = position + page.length < matches.length
  const items = page
    .map((r) => `<searchMatchItem><sourceID>{00000000-0000-0000-0000-000000000000}</sourceID><trackID>${channel}01</trackID><timeSpan><startTime>${stamp(r.s)}</startTime><endTime>${stamp(r.e)}</endTime></timeSpan><mediaSegmentDescriptor><contentType>video</contentType><codecType>H.264-BP</codecType><playbackURI>rtsp://127.0.0.1/Streaming/tracks/${channel}01?starttime=${stamp(r.s)}&amp;endtime=${stamp(r.e)}</playbackURI></mediaSegmentDescriptor></searchMatchItem>`)
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8"?><CMSearchResult version="2.0" ${NS}><searchID>fake</searchID><responseStatus>true</responseStatus>` +
    `<responseStatusStrg>${more ? 'MORE' : page.length ? 'OK' : 'NO MATCHES'}</responseStatusStrg><numOfMatches>${page.length}</numOfMatches><matchList>${items}</matchList></CMSearchResult>`
  )
}

function dailyXml(list: Recording[], channel: number, year: number, month: number): string {
  const recorded = new Set<number>()
  for (const r of forChannel(list, channel)) {
    const s = isoMs(r.start)
    const e = isoMs(r.end)
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue
    const last = Math.max(s, e - 1)
    for (let day = Date.UTC(new Date(s).getUTCFullYear(), new Date(s).getUTCMonth(), new Date(s).getUTCDate()), n = 0; day <= last && n < 400; day += 86_400_000, n++) {
      const d = new Date(day)
      if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month) recorded.add(d.getUTCDate())
    }
  }
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
  let days = ''
  for (let d = 1; d <= length; d++) days += `<day><dayOfMonth>${d}</dayOfMonth><record>${recorded.has(d)}</record><recordType>CMR</recordType></day>`
  return `<?xml version="1.0" encoding="UTF-8"?><trackDailyDistribution version="2.0" ${NS}><dayList>${days}</dayList></trackDailyDistribution>`
}

const NS = 'xmlns="http://www.hikvision.com/ver20/XMLSchema"'

const statusXml = (s: Record<number, boolean>) =>
  `<?xml version="1.0" encoding="UTF-8"?><InputProxyChannelStatusList version="2.0" ${NS}>` +
  Object.entries(s)
    .map(([ch, on]) => `<InputProxyChannelStatus><id>${ch}</id><sourceInputPortDescriptor><ipAddress>192.0.2.${ch}</ipAddress></sourceInputPortDescriptor><online>${on}</online></InputProxyChannelStatus>`)
    .join('') +
  '</InputProxyChannelStatusList>'

const channelsXml = (list: { channel: number; name: string; ip?: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><InputProxyChannelList version="2.0" ${NS}>` +
  list
    .map((c) => `<InputProxyChannel><id>${c.channel}</id><name>${c.name}</name>${c.ip ? `<sourceInputPortDescriptor><ipAddress>${c.ip}</ipAddress></sourceInputPortDescriptor>` : ''}</InputProxyChannel>`)
    .join('') +
  '</InputProxyChannelList>'

const videoInputXml = (list: { channel: number; name: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><VideoInputChannelList version="2.0" ${NS}>` +
  list.map((c) => `<VideoInputChannel><id>${c.channel}</id><name>${c.name}</name></VideoInputChannel>`).join('') +
  '</VideoInputChannelList>'

function parseAuth(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/([a-z]+)=(?:"([^"]*)"|([^\s,]+))/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3]
  return out
}

/** Does this Authorization header carry a correct Digest answer (MD5, qop=auth) for this request? Shared by the fake NVR and the fake RTSP camera. */
function verifyDigest(header: string, o: { user: string; pass: string; realm: string; method: string; uri: string; nonces: Set<string> }): boolean {
  if (!/^Digest /i.test(header)) return false
  const p = parseAuth(header)
  const ha1 = md5(`${o.user}:${o.realm}:${o.pass}`)
  const ha2 = md5(`${o.method}:${p.uri}`)
  const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`)
  return p.uri === o.uri && p.username === o.user && o.nonces.has(p.nonce) && p.response === expected
}

export async function startFakeNvr(options: FakeNvrOptions = {}): Promise<FakeNvr> {
  const user = options.username ?? 'viewer'
  const pass = options.password ?? 'secret-pass'
  const realm = 'fake-nvr'
  let statuses = options.statuses ?? {}
  const channels = options.channels ?? Object.keys(statuses).map((n) => ({ channel: Number(n), name: `Camera ${n}` }))
  const requests: string[] = []
  const authorizations: string[] = []
  const nonces = new Set<string>()
  const sockets = new Set<net.Socket>()

  const posts: FakeNvr['posts'] = []
  const downloadBodies: string[] = []
  const downloadsEnded = { count: 0 }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => {
    const challenge = () => {
      const nonce = randomBytes(8).toString('hex')
      nonces.add(nonce)
      const digest = `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="op"`
      const sha256 = `Digest realm="${realm}", qop="auth", algorithm=SHA-256, nonce="${nonce}"`
      const basic = `Basic realm="${realm}"`
      const offered = {
        digest: [digest],
        'basic-only': [basic],
        'basic-then-digest': [basic, digest],
        'digest-then-basic': [digest, basic],
        'sha256-only': [sha256],
      }[options.challenge ?? 'digest']
      res.setHeader('WWW-Authenticate', offered) // several values are sent as repeated headers
      res.writeHead(401)
      res.end()
    }
    const auth = req.headers.authorization
    if (!auth || !/^Digest /i.test(auth)) return challenge()
    if (!verifyDigest(auth, { user, pass, realm, method: req.method ?? 'GET', uri: req.url ?? '', nonces })) return challenge()
    if (options.mode === 'forbidden') {
      res.writeHead(403)
      return res.end()
    }
    const path = (req.url ?? '').split('?')[0]
    const send = (xml: string) => {
      if (options.mode === 'stall-body') {
        res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': String(xml.length + 1000) })
        res.write(xml.slice(0, 8)) // the rest never comes
        return
      }
      if (options.mode === 'reset-body') {
        res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': String(xml.length + 1000) })
        res.write(xml.slice(0, 8))
        setTimeout(() => res.socket?.destroy(), 20)
        return
      }
      if (options.mode === 'huge') {
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        return res.end('a'.repeat(1024 * 1024 + 16))
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(xml)
    }
    if (options.mode === 'garbage') return send('this is not xml')
    const daily = DAILY_PATH.exec(path)
    if (path === SEARCH_PATH || path === DOWNLOAD_PATH || daily) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' })
        return res.end()
      }
      posts.push({ path, body, contentType: String(req.headers['content-type'] ?? '') })
      if (path === DOWNLOAD_PATH) {
        downloadBodies.push(body)
        const bytes = options.downloadBytes ?? FAKE_DOWNLOAD_BYTES
        if (options.download === 'xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml' })
          return res.end('<ResponseStatus><statusCode>4</statusCode></ResponseStatus>')
        }
        if (options.download === 'stall') {
          res.writeHead(200, { 'Content-Type': 'video/mp4' })
          res.write(bytes.subarray(0, 8))
          return
        }
        if (options.download === 'endless') {
          res.writeHead(200, { 'Content-Type': 'video/mp4' })
          res.write(bytes)
          const timer = setInterval(() => res.write(Buffer.alloc(1024, 1)), 20)
          res.on('close', () => {
            clearInterval(timer)
            downloadsEnded.count++
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) })
        return res.end(bytes)
      }
      if (path === SEARCH_PATH) {
        const asked = tagNumber(body, 'maxResults')
        const position = tagNumber(body, 'searchResultPostion') || 0
        return send(options.searchAnswer ? options.searchAnswer({ position, maxResults: asked, body }) : searchXml(options.recordings ?? [], body, options.searchPageSize ?? 2))
      }
      const year = tagNumber(body, 'year')
      const month = tagNumber(body, 'monthOfYear')
      return send(options.dailyAnswer ? options.dailyAnswer({ year, month, body }) : dailyXml(options.recordings ?? [], Math.floor(Number(daily![1]) / 100), year, month))
    }
    if (GET_PATHS.has(path) && req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' })
      return res.end()
    }
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels/status') return send(statusXml(statuses))
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels' && options.inputProxy !== 'missing') return send(channelsXml(options.inputProxy === 'empty' ? [] : channels))
    if (path === '/ISAPI/System/Video/inputs/channels') return send(videoInputXml(options.videoInputs === 'empty' ? [] : channels))
    res.writeHead(404)
    res.end()
  }
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.headers.authorization) authorizations.push(req.headers.authorization)
    if (options.mode === 'slow') return // never answers
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_FAKE_BODY) {
        refused = true
        res.writeHead(413)
        res.end()
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (refused) return
      const body = Buffer.concat(chunks).toString('utf8')
      if (options.delayMs) setTimeout(() => handle(req, res, body), options.delayMs)
      else handle(req, res, body)
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const port = await new Promise<number>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, host: (server.address() as net.AddressInfo).address, requests, authorizations, posts, downloadBodies, downloadsEnded, setStatuses: (s) => (statuses = s), close: closer(server, sockets) }
}

// ── Fake RTSP camera endpoint ────────────────────────────────────────────────
/**
 * open: 200 at once. refuse: 404. always-401: always asks for a login. needs-auth: asks (Digest), then checks the Digest answer properly.
 * needs-auth-basic-first / needs-auth-digest-first: the 401 lists both Basic and Digest, in that order (two WWW-Authenticate headers).
 * Basic is never accepted by the fake.
 */
export type FakeRtspMode = 'open' | 'needs-auth' | 'refuse' | 'always-401' | 'needs-auth-basic-first' | 'needs-auth-digest-first'
export type FakeRtsp = Bound & {
  requests: string[]
  /** Every Authorization header received, in order. */
  authorizations: string[]
}

export async function startFakeRtsp(mode: FakeRtspMode, fixedPort = 0, credentials: { username: string; password: string } = { username: 'viewer', password: 'pw' }): Promise<FakeRtsp> {
  const requests: string[] = []
  const authorizations: string[] = []
  const nonces = new Set<string>()
  const realm = 'fake-cam'
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\r\n\r\n')) return
      const requestLine = buf.split('\r\n')[0]
      requests.push(requestLine)
      const auth = /\r\nAuthorization:[ \t]*([^\r\n]*)/i.exec(buf)?.[1]
      if (auth !== undefined) authorizations.push(auth)
      const challenge = () => {
        const nonce = randomBytes(8).toString('hex')
        nonces.add(nonce)
        const digest = `WWW-Authenticate: Digest realm="${realm}", qop="auth", nonce="${nonce}"\r\n`
        const basic = `WWW-Authenticate: Basic realm="${realm}"\r\n`
        const lines = mode === 'needs-auth-basic-first' ? basic + digest : mode === 'needs-auth-digest-first' ? digest + basic : digest
        return `RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n${lines}\r\n`
      }
      const [method, uri] = requestLine.split(' ')
      const authorised = auth !== undefined && verifyDigest(auth, { user: credentials.username, pass: credentials.password, realm, method, uri, nonces })
      if (mode === 'open') s.end('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n')
      else if (mode === 'refuse') s.end('RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n')
      else if (mode === 'always-401') s.end(challenge())
      else s.end(authorised ? 'RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n' : challenge())
    })
  })
  const port = await new Promise<number>((resolve) => server.listen(fixedPort, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, host: (server.address() as net.AddressInfo).address, requests, authorizations, close: closer(server, sockets) }
}
