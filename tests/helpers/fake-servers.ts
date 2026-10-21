// Fake network for tests and for the local demo. Everything listens on 127.0.0.1 only.
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

export type Running = { port: number; close: () => Promise<void> }

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function closer(server: net.Server | http.Server, sockets: Set<net.Socket>) {
  return () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy())
      server.close(() => resolve())
    })
}

/** Accepts a connection and closes it at once: enough for a TCP "is it there" check. */
export async function startFakeTcp(fixedPort = 0): Promise<Running> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.end()
  })
  const port = await new Promise<number>((resolve) => server.listen(fixedPort, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, close: closer(server, sockets) }
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
  port?: number
}
export type FakeNvr = Running & {
  requests: string[]
  /** Every Authorization header received, in order. */
  authorizations: string[]
  setStatuses: (s: Record<number, boolean>) => void
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

  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
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
    if (options.delayMs) setTimeout(() => handle(req, res), options.delayMs)
    else handle(req, res)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const port = await new Promise<number>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return { port, requests, authorizations, setStatuses: (s) => (statuses = s), close: closer(server, sockets) }
}

// ── Fake RTSP camera endpoint ────────────────────────────────────────────────
/**
 * open: 200 at once. refuse: 404. always-401: always asks for a login. needs-auth: asks (Digest), then checks the Digest answer properly.
 * needs-auth-basic-first / needs-auth-digest-first: the 401 lists both Basic and Digest, in that order (two WWW-Authenticate headers).
 * Basic is never accepted by the fake.
 */
export type FakeRtspMode = 'open' | 'needs-auth' | 'refuse' | 'always-401' | 'needs-auth-basic-first' | 'needs-auth-digest-first'
export type FakeRtsp = Running & {
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
  return { port, requests, authorizations, close: closer(server, sockets) }
}
