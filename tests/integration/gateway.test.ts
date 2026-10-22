import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createGateway, type GatewayEvent, type GatewayOptions, type GatewayServer } from '@/lib/streams/gateway'
import { signStreamToken, streamName, type StreamClaims } from '@/lib/streams/token'

// Everything runs on loopback: a fake go2rtc (http + WebSocket), the gateway on port 0 and a ws client. Never a real camera.

const SECRET = 'gateway-test-secret-0123456789'
const APP = 'http://app.test:3212'
const USER = '11111111-1111-4111-8111-111111111111'
const CAM = '22222222-2222-4222-8222-222222222222'
const STREAM_JS = '/* video-stream */ console.log("stream")\n'
const RTC_JS = '/* video-rtc */ console.log("rtc")\n'

type UpstreamConnection = { url: string; src: string | null; headers: http.IncomingHttpHeaders; closed: boolean; socket: WebSocket; received: { text: boolean; data: string }[] }
type FakeGo2rtc = {
  port: number
  url: string
  connections: UpstreamConnection[]
  requests: { url: string; headers: http.IncomingHttpHeaders }[]
  setBigScript(on: boolean): void
  close(): Promise<void>
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

async function startFakeGo2rtc(): Promise<FakeGo2rtc> {
  const connections: UpstreamConnection[] = []
  const requests: FakeGo2rtc['requests'] = []
  let big = false
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    if (req.url === '/video-stream.js' || req.url === '/video-rtc.js') {
      const body = big ? 'x'.repeat(2 * 1024 * 1024) : req.url === '/video-stream.js' ? STREAM_JS : RTC_JS
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Set-Cookie': 'go2rtc=1' })
      return res.end(body)
    }
    res.writeHead(404).end('nope')
  })
  const wss = new WebSocketServer({ server, path: '/api/ws' })
  wss.on('connection', (socket, req) => {
    const u = new URL(req.url ?? '', 'http://x')
    const conn: UpstreamConnection = { url: req.url ?? '', src: u.searchParams.get('src'), headers: req.headers, closed: false, socket, received: [] }
    connections.push(conn)
    socket.on('close', () => (conn.closed = true))
    socket.on('error', () => {})
    socket.on('message', (data, isBinary) => {
      const text = isBinary ? '' : data.toString()
      conn.received.push({ text: !isBinary, data: isBinary ? `${(data as Buffer).length}` : text })
      if (text === 'send-error') {
        socket.send(JSON.stringify({ type: 'error', value: 'streams: dial tcp rtsp://admin:hunter2@10.9.8.7:554/ch1: i/o timeout' }))
      } else if (text === 'flood') {
        const chunk = Buffer.alloc(64 * 1024, 7)
        for (let i = 0; i < 400; i++) socket.send(chunk, { binary: true })
      } else if (text === 'bye') {
        socket.close(1000)
      } else socket.send(data, { binary: isBinary })
    })
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
  const fake: FakeGo2rtc = {
    port,
    url: `http://127.0.0.1:${port}`,
    connections,
    requests,
    setBigScript: (on) => void (big = on),
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate())
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  cleanups.push(fake.close)
  return fake
}

type Started = { gateway: GatewayServer; port: number; events: GatewayEvent[]; clock: { t: number } }

async function startGateway(go2rtcUrl: string, extra: Partial<GatewayOptions> = {}): Promise<Started> {
  const events: GatewayEvent[] = []
  const clock = { t: 1_800_000_000_000 }
  const gateway = createGateway({
    go2rtcUrl,
    secret: SECRET,
    allowedOrigins: [APP],
    now: () => clock.t,
    log: (e) => events.push(e),
    ...extra,
  })
  const port = await new Promise<number>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve((gateway.address() as AddressInfo).port)))
  cleanups.push(() => gateway.shutdown(1000))
  return { gateway, port, events, clock }
}

const tokenFor = (clock: { t: number }, over: Partial<StreamClaims> = {}, secret = SECRET) =>
  signStreamToken({ u: USER, c: CAM, k: 'sub', exp: Math.floor(clock.t / 1000) + 600, ...over }, secret)

type Outcome = { code: number; reason: string } | { error: string }

function open(url: string, origin: string | null = APP) {
  const ws = new WebSocket(url, { origin: origin ?? undefined, headers: origin === null ? {} : undefined })
  const opened = new Promise<boolean>((resolve) => {
    ws.on('open', () => resolve(true))
    ws.on('error', () => resolve(false))
    ws.on('unexpected-response', () => resolve(false))
  })
  const closed = new Promise<Outcome>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      resolve({ error: `http ${res.statusCode}` })
    })
    ws.on('error', (e) => resolve({ error: e.message }))
  })
  cleanups.push(async () => ws.terminate())
  return { ws, opened, closed }
}

const wsUrl = (port: number, token: string, extra = '') => `ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(token)}${extra}`

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition') {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const nextMessage = (ws: WebSocket) => new Promise<{ data: Buffer; isBinary: boolean }>((resolve) => ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary })))

async function get(port: number, path: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A WebSocket handshake written by hand (so headers can be repeated); returns what the gateway sent in the next 600 ms. */
function rawUpgrade(port: number, path: string, headerLines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    socket.on('data', (d) => chunks.push(d))
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(
        [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...headerLines, '', ''].join('\r\n'),
      )
    })
    setTimeout(() => {
      socket.destroy()
      resolve(Buffer.concat(chunks))
    }, 600)
  })
}

const noUpstream =(fake: FakeGo2rtc) => expect(fake.connections).toHaveLength(0)

describe('gateway: plain HTTP', () => {
  it('answers health and marks every response nosniff and no-store', async () => {
    const fake = await startFakeGo2rtc()
    const { port } = await startGateway(fake.url)
    const r = await get(port, '/g/health')
    expect(r.status).toBe(200)
    expect(r.body).toBe('ok')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('serves the two scripts from go2rtc with the right headers, passing nothing from the browser but the path', async () => {
    const fake = await startFakeGo2rtc()
    const { port } = await startGateway(fake.url)
    const a = await get(port, '/g/video-stream.js?src=evil&token=abc', { Cookie: 'session=secret', Authorization: 'Bearer abc', 'X-Forwarded-For': '9.9.9.9', Origin: APP })
    const b = await get(port, '/g/video-rtc.js')
    for (const [r, body] of [[a, STREAM_JS], [b, RTC_JS]] as const) {
      expect(r.status).toBe(200)
      expect(r.body).toBe(body)
      expect(r.headers['content-type']).toBe('text/javascript')
      expect(r.headers['cache-control']).toBe('public, max-age=300')
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(r.headers['set-cookie']).toBeUndefined() // go2rtc's headers are not copied
    }
    expect(fake.requests.map((q) => q.url)).toEqual(['/video-stream.js', '/video-rtc.js'])
    for (const q of fake.requests) {
      expect(q.headers.cookie).toBeUndefined()
      expect(q.headers.authorization).toBeUndefined()
      expect(q.headers['x-forwarded-for']).toBeUndefined()
      expect(q.headers.origin).toBeUndefined()
    }
  })

  it('answers 502 in plain text, without go2rtc address, when go2rtc is down or sends too much', async () => {
    const fake = await startFakeGo2rtc()
    const { port } = await startGateway(fake.url)
    fake.setBigScript(true)
    const big = await get(port, '/g/video-rtc.js')
    expect(big.status).toBe(502)
    await fake.close()
    const down = await get(port, '/g/video-stream.js')
    for (const r of [big, down]) {
      expect(r.status).toBe(502)
      expect(r.headers['content-type']).toContain('text/plain')
      expect(r.headers['cache-control']).toBe('no-store')
      expect(r.body).not.toContain('127.0.0.1')
      expect(r.body).not.toContain(String(fake.port))
      expect(r.body).not.toMatch(/ECONN|fetch failed/i)
    }
  })

  it('answers 404 for other paths, 405 for other methods and 426 for a plain request to the socket address', async () => {
    const fake = await startFakeGo2rtc()
    const { port } = await startGateway(fake.url)
    for (const p of ['/', '/g', '/g/', '/g/health/', '/G/health', '/g/nope', '/api', '/api/streams', '/g/video-stream.js/x', '//g/health', '/g/%76ideo-rtc.js']) {
      const r = await get(port, p)
      expect(r.status, p).toBe(404)
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(r.headers['cache-control']).toBe('no-store')
    }
    expect((await get(port, '/g/health', {}, 'POST')).status).toBe(405)
    expect((await get(port, '/g/video-rtc.js', {}, 'DELETE')).status).toBe(405)
    expect((await get(port, '/g/ws')).status).toBe(426)
    expect(fake.requests).toHaveLength(0)
  })
})

describe('gateway: who may connect', () => {
  it('closes with 1008 before any upstream connection: bad, expired, foreign, missing and oversize tokens', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const good = tokenFor(clock)
    const cases: [string, string][] = [
      ['garbage', wsUrl(port, 'not-a-token')],
      ['tampered', wsUrl(port, good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA'))],
      ['other secret', wsUrl(port, tokenFor(clock, {}, 'another-secret-0123456789-xyz'))],
      ['expired', wsUrl(port, tokenFor(clock, { exp: Math.floor(clock.t / 1000) - 5 }))],
      ['missing', `ws://127.0.0.1:${port}/g/ws`],
      ['empty', wsUrl(port, '')],
      ['two tokens', wsUrl(port, good, `&token=${encodeURIComponent(good)}`)],
      ['oversize', wsUrl(port, 'a'.repeat(1500))],
    ]
    for (const [label, url] of cases) {
      const c = open(url)
      expect(await c.closed, label).toEqual({ code: 1008, reason: 'Not allowed' })
    }
    noUpstream(fake)
  })

  it('closes with 1008 for a wrong, missing, repeated or malformed Origin', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const url = wsUrl(port, tokenFor(clock))
    for (const origin of [null, 'http://evil.test', 'https://app.test:3212', 'http://app.test:3213', 'http://app.test', 'http://sub.app.test:3212', 'http://app.test:3212.evil.test', 'http://app.test:3212/x', 'http://app.test:3212/', 'null', '*', 'app.test:3212', 'ftp://app.test:3212', 'http://user@app.test:3212']) {
      const c = open(url, origin)
      expect(await c.closed, String(origin)).toEqual({ code: 1008, reason: 'Not allowed' })
    }
    // Two Origin headers are ambiguous and refused even when one of them is right.
    const target = new URL(url)
    const reply = await rawUpgrade(port, target.pathname + target.search, [`Origin: ${APP}`, `Origin: ${APP}`])
    expect(reply.subarray(0, 12).toString()).toBe('HTTP/1.1 101')
    const frame = reply.subarray(reply.indexOf('\r\n\r\n') + 4)
    expect(frame[0]).toBe(0x88) // a close frame
    expect(frame.readUInt16BE(2)).toBe(1008)
    noUpstream(fake)
    // The same request with one Origin header is accepted.
    const single = await rawUpgrade(port, target.pathname + target.search, [`Origin: ${APP}`])
    expect(single.subarray(0, 12).toString()).toBe('HTTP/1.1 101')
    await waitFor(() => fake.connections.length === 1)
    fake.connections[0].socket.terminate()
  })

  it('compares origins after normalising scheme, host and port', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url, { allowedOrigins: ['http://localhost:3212/', 'HTTPS://Cams.Example.COM:443', 'not an origin', 'ftp://x.test'] })
    const url = wsUrl(port, tokenFor(clock))
    for (const origin of ['http://localhost:3212', 'HTTP://LOCALHOST:3212', 'https://cams.example.com', 'https://cams.example.com:443']) {
      const c = open(url, origin)
      expect(await c.opened, origin).toBe(true)
      await waitFor(() => fake.connections.length > 0)
      c.ws.close()
      fake.connections.length = 0
    }
    for (const origin of ['http://localhost:3212/x', 'https://localhost:3212', 'http://cams.example.com', 'https://cams.example.com:8443']) {
      const c = open(url, origin)
      expect(await c.closed, origin).toEqual({ code: 1008, reason: 'Not allowed' })
    }
    noUpstream(fake)
  })

  it('refuses everything when no valid origin is configured', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url, { allowedOrigins: [] })
    expect(await open(wsUrl(port, tokenFor(clock))).closed).toEqual({ code: 1008, reason: 'Not allowed' })
    noUpstream(fake)
  })

  it('only upgrades on /g/ws exactly', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const token = encodeURIComponent(tokenFor(clock))
    for (const p of ['/g/ws/', '/g/wsx', '/g/ws/x', '/ws', '/api/ws', '/', '/g/health', '/g/WS', '//g/ws', '/g/%77s']) {
      const c = open(`ws://127.0.0.1:${port}${p}?token=${token}&src=cam_x`)
      expect(await c.closed, p).toEqual({ error: 'http 404' })
    }
    noUpstream(fake)
  })

  it('refuses to start without a usable secret or with a bad go2rtc address', () => {
    expect(() => createGateway({ go2rtcUrl: 'http://127.0.0.1:1984', secret: 'short', allowedOrigins: [APP] })).toThrow(/secret/)
    expect(() => createGateway({ go2rtcUrl: 'not a url', secret: SECRET, allowedOrigins: [APP] })).toThrow(/address/)
    expect(() => createGateway({ go2rtcUrl: 'ftp://127.0.0.1', secret: SECRET, allowedOrigins: [APP] })).toThrow(/address/)
  })
})

describe('gateway: a valid session', () => {
  it('connects upstream with the stream name from the token only, even when the browser adds src', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const cases: [Partial<StreamClaims>, string][] = [
      [{}, `cam_${CAM}_sub`],
      [{ k: 'main' }, `cam_${CAM}_main`],
      [{ k: 'pb', s: 1_799_999_000, e: 1_799_999_600 }, `pb_${CAM}_1799999000`],
    ]
    for (const [claims, name] of cases) {
      const token = tokenFor(clock, claims)
      expect(streamName({ c: CAM, k: claims.k ?? 'sub', s: claims.s })).toBe(name)
      const c = open(wsUrl(port, token, '&src=evil&src=cam_other_main&Src=evil2'), APP)
      expect(await c.opened).toBe(true)
      await waitFor(() => fake.connections.length > 0)
      const conn = fake.connections.shift()!
      expect(conn.src).toBe(name)
      expect(conn.url).toBe(`/api/ws?src=${name}`) // one parameter, nothing else
      expect(conn.headers.origin).toBeUndefined()
      expect(conn.headers.cookie).toBeUndefined()
      expect(conn.headers.authorization).toBeUndefined()
      c.ws.close()
      await waitFor(() => conn.closed)
    }
  })

  it('passes text and binary frames both ways', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const c = open(wsUrl(port, tokenFor(clock)))
    await c.opened
    const text = nextMessage(c.ws)
    c.ws.send('{"type":"mse"}')
    const t = await text
    expect(t.isBinary).toBe(false)
    expect(t.data.toString()).toBe('{"type":"mse"}')
    const bin = nextMessage(c.ws)
    const payload = Buffer.from([0, 1, 2, 254, 255])
    c.ws.send(payload)
    const b = await bin
    expect(b.isBinary).toBe(true)
    expect(b.data.equals(payload)).toBe(true)
    // A message from go2rtc that nobody asked for also reaches the browser.
    const pushed = nextMessage(c.ws)
    fake.connections[0].socket.send(Buffer.from('fragment'), { binary: true })
    expect((await pushed).data.toString()).toBe('fragment')
  })

  it('keeps what the browser sends while go2rtc is still being reached', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const c = open(wsUrl(port, tokenFor(clock)))
    c.ws.on('open', () => c.ws.send('first-and-immediate'))
    await c.opened
    await waitFor(() => fake.connections.length === 1 && fake.connections[0].received.length === 1)
    expect(fake.connections[0].received[0]).toEqual({ text: true, data: 'first-and-immediate' })
  })

  it('closes upstream when the browser closes, and the browser when upstream closes', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const a = open(wsUrl(port, tokenFor(clock)))
    await a.opened
    await waitFor(() => fake.connections.length === 1)
    a.ws.close(1000)
    await a.closed
    await waitFor(() => fake.connections[0].closed, 3000, 'upstream to close')

    const b = open(wsUrl(port, tokenFor(clock)))
    await b.opened
    await waitFor(() => fake.connections.length === 2)
    b.ws.send('bye') // the fake closes its side
    expect(await b.closed).toMatchObject({ code: 1000 })
  })

  it('ends the session after maxSessionMs', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url, { maxSessionMs: 300 })
    const c = open(wsUrl(port, tokenFor(clock)))
    await c.opened
    const started = Date.now()
    expect(await c.closed).toEqual({ code: 1000, reason: 'Session ended' })
    expect(Date.now() - started).toBeLessThan(2500)
    await waitFor(() => fake.connections[0].closed)
  })

  it('answers 1011 with a plain reason when go2rtc is down', async () => {
    const fake = await startFakeGo2rtc()
    const url = fake.url
    await fake.close()
    const { port, clock } = await startGateway(url)
    const c = open(wsUrl(port, tokenFor(clock)))
    const r = (await c.closed) as { code: number; reason: string }
    expect(r.code).toBe(1011)
    expect(r.reason).toBe('The video is not available.')
    expect(r.reason).not.toContain('127.0.0.1')
    expect(r.reason).not.toContain(String(fake.port))
  })

  it('replaces go2rtc error messages (which can carry camera passwords) with a fixed sentence', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const c = open(wsUrl(port, tokenFor(clock)))
    await c.opened
    const msg = nextMessage(c.ws)
    c.ws.send('send-error')
    const m = await msg
    expect(JSON.parse(m.data.toString())).toEqual({ type: 'error', value: 'The video is not available.' })
    expect(m.data.toString()).not.toMatch(/hunter2|10\.9\.8\.7|rtsp/)
  })

  it('refuses a browser message above 4 MB (close 1009)', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url)
    const c = open(wsUrl(port, tokenFor(clock)))
    await c.opened
    c.ws.send(Buffer.alloc(5 * 1024 * 1024, 1))
    expect(await c.closed).toMatchObject({ code: 1009 })
    await waitFor(() => fake.connections[0].closed)
    expect(fake.connections[0].received).toHaveLength(0)
  })
})

describe('gateway: limits', () => {
  it('refuses sockets beyond maxSockets with 1013 and takes them again when some close', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url, { maxSockets: 3 })
    const open3 = [open(wsUrl(port, tokenFor(clock))), open(wsUrl(port, tokenFor(clock))), open(wsUrl(port, tokenFor(clock)))]
    await Promise.all(open3.map((c) => c.opened))
    await waitFor(() => fake.connections.length === 3)
    const extra = open(wsUrl(port, tokenFor(clock)))
    expect(await extra.closed).toMatchObject({ code: 1013 })
    expect(fake.connections).toHaveLength(3)
    open3[0].ws.close()
    await open3[0].closed
    await waitFor(() => fake.connections[0].closed)
    const again = open(wsUrl(port, tokenFor(clock)))
    expect(await again.opened).toBe(true)
    await waitFor(() => fake.connections.length === 4)
  })

  it('limits upgrade attempts per address per minute (1013), counting failed ones, and recovers with time', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url, { maxUpgradesPerMinute: 4 })
    const good = wsUrl(port, tokenFor(clock))
    for (let i = 0; i < 2; i++) expect(await open(wsUrl(port, 'bad')).closed).toMatchObject({ code: 1008 })
    for (let i = 0; i < 2; i++) {
      const c = open(good)
      expect(await c.opened).toBe(true)
      c.ws.close()
    }
    const blocked = open(good)
    expect(await blocked.closed).toEqual({ code: 1013, reason: 'Too many attempts. Try again in a minute.' })
    const blockedOrigin = open(good, 'http://evil.test')
    expect(await blockedOrigin.closed).toMatchObject({ code: 1013 })
    clock.t += 61_000
    const later = open(wsUrl(port, tokenFor(clock)))
    expect(await later.opened).toBe(true)
    later.ws.close()
    await later.closed
  })

  it('answers 429 in plain text when the scripts are asked for too often, but never limits health', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock } = await startGateway(fake.url, { maxUpgradesPerMinute: 2 })
    expect((await get(port, '/g/video-rtc.js')).status).toBe(200)
    expect((await get(port, '/g/video-rtc.js')).status).toBe(200)
    const r = await get(port, '/g/video-rtc.js')
    expect(r.status).toBe(429)
    expect(r.headers['content-type']).toContain('text/plain')
    expect(r.headers['retry-after']).toBe('60')
    for (let i = 0; i < 5; i++) expect((await get(port, '/g/health')).status).toBe(200)
    clock.t += 61_000
    expect((await get(port, '/g/video-rtc.js')).status).toBe(200)
    expect(fake.requests).toHaveLength(3)
  })

  it('pauses a fast sender and cuts a session whose receiver stays far behind', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock, events } = await startGateway(fake.url, { backpressureBytes: 200_000, backpressureStallMs: 500 })
    const c = open(wsUrl(port, tokenFor(clock)))
    await c.opened
    await waitFor(() => fake.connections.length === 1)
    // The browser stops reading from its socket, then go2rtc floods it with 25 MB.
    ;(c.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    c.ws.send('flood')
    await waitFor(() => fake.connections[0].closed, 8000, 'the gateway to cut the stalled session')
    await waitFor(() => events.some((e) => e.outcome === 'stalled'))
  })
})

describe('gateway: privacy and shutdown', () => {
  it('logs only outcomes and a short camera hash, never the token, stream name, ids or address', async () => {
    const fake = await startFakeGo2rtc()
    const { port, clock, events } = await startGateway(fake.url)
    const token = tokenFor(clock)
    const c = open(wsUrl(port, token))
    await c.opened
    await waitFor(() => fake.connections.length === 1)
    c.ws.close()
    await waitFor(() => events.some((e) => e.outcome === 'ended'))
    await open(wsUrl(port, 'bad')).closed
    await open(wsUrl(port, token), 'http://evil.test').closed
    const logged = JSON.stringify(events)
    for (const secretBit of [token, token.split('.')[0], SECRET, USER, CAM, `cam_${CAM}`, '_sub', '127.0.0.1', String(fake.port)]) expect(logged, secretBit).not.toContain(secretBit)
    expect(events.map((e) => e.outcome)).toEqual(['started', 'ended', 'denied_token', 'denied_origin'])
    expect(events[0].camera).toMatch(/^[0-9a-f]{8}$/)
  })

  it('shutdown closes every socket within 5 seconds', async () => {
    const fake = await startFakeGo2rtc()
    const { gateway, port, clock } = await startGateway(fake.url)
    const clients = [open(wsUrl(port, tokenFor(clock))), open(wsUrl(port, tokenFor(clock))), open(wsUrl(port, tokenFor(clock)))]
    await Promise.all(clients.map((c) => c.opened))
    await waitFor(() => fake.connections.length === 3)
    // One browser that never answers the close message must not hold the shutdown up.
    ;(clients[2].ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const started = Date.now()
    await gateway.shutdown()
    expect(Date.now() - started).toBeLessThan(5000)
    const results = await Promise.all(clients.slice(0, 2).map((c) => c.closed))
    for (const r of results) expect(r).toMatchObject({ code: 1001 })
    await waitFor(() => fake.connections.every((x) => x.closed))
    expect(gateway.listening).toBe(false)
  })
})
