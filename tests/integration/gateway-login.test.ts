import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { CLOSE_LOGIN_REFUSED, createGateway, LOGIN_REFUSED_VALUE, type GatewayEvent } from '@/lib/streams/gateway'
import type { RegistryClient } from '@/lib/streams/registry'
import { signStreamToken } from '@/lib/streams/token'

// Final fix X (release 1 review C I-2; ruling NB-2): the video gateway never dials an NVR whose login stands refused (it asks the
// registry, media_session_login_check), passes go2rtc's "wrong user/pass" on as a refused login (media_session_login_refused) and tells
// the tile with one fixed value, and ends a picture whose video stopped, so go2rtc does not keep retrying the NVR behind an open socket.
// Loopback only: a fake go2rtc and a fake registry.

const SECRET = 'gateway-login-test-secret-0123456789'
const APP = 'http://app.test:3212'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

/** go2rtc: `refuse` sends go2rtc's refused-login error as soon as a viewer asks for the stream; `once` sends one video frame, then nothing. */
async function fakeGo2rtc(mode: 'refuse' | 'once' | 'odd') {
  const connections: string[] = []
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ server, path: '/api/ws' })
  wss.on('connection', (socket, req) => {
    connections.push(req.url ?? '')
    socket.on('error', () => {})
    socket.on('message', () => {
      if (mode === 'refuse') socket.send(JSON.stringify({ type: 'error', value: 'streams: wrong user/pass' }))
      // odd (round 2, M-8): a failure text the gateway does not know (another go2rtc build's wording for a refused login, say).
      else if (mode === 'odd') socket.send(JSON.stringify({ type: 'error', value: 'streams: rtsp: unexpected answer to the login (build x)' }))
      else socket.send(Buffer.alloc(32, 1), { binary: true })
    })
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))
  cleanups.push(() => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); server.close(() => r()) }))
  return { url: `http://127.0.0.1:${port}`, connections }
}

function registry(decision: 'go' | 'refused') {
  const refusedFor: string[] = []
  const reports: { sid: string; kind: string; hash?: string }[] = []
  let unexplained = 0
  const r: RegistryClient = {
    open: async (_sid, e) => ({ ok: true, kind: e.kind, stream: e.stream }),
    stillValid: async () => new Map(),
    close: async () => {},
    loginCheck: async () => decision,
    loginRefused: async (sid) => void refusedFor.push(sid),
    // Like media_session_login_report: the second identical unexplained failure counts as a refused login.
    loginReport: async (sid, kind, hash) => {
      reports.push({ sid, kind, hash })
      if (kind === 'video') {
        unexplained = 0
        return 'cleared'
      }
      return ++unexplained >= 2 ? 'refused' : 'counted'
    },
  }
  return { r, refusedFor, reports }
}

async function gateway(go2rtcUrl: string, reg: RegistryClient, extra: { upstreamSilenceMs?: number } = {}) {
  const events: GatewayEvent[] = []
  const g = createGateway({ go2rtcUrl, secret: SECRET, allowedOrigins: [APP], registry: reg, autoValidate: false, log: (e) => events.push(e), ...extra })
  const port = await new Promise<number>((r) => g.listen(0, '127.0.0.1', () => r((g.address() as AddressInfo).port)))
  cleanups.push(() => g.shutdown(1000))
  return { port, events }
}

function tile(port: number, sid = randomUUID()) {
  const token = signStreamToken({ sid, u: randomUUID(), c: randomUUID(), k: 'sub', exp: Math.floor(Date.now() / 1000) + 90 }, SECRET)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(token)}`, { origin: APP })
  const texts: string[] = []
  ws.on('message', (d, bin) => { if (!bin) texts.push(d.toString()) })
  ws.on('open', () => ws.send(JSON.stringify({ type: 'mse', value: 'avc1' })))
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  ws.on('error', () => {})
  cleanups.push(async () => ws.terminate())
  return { sid, texts, closed }
}

describe('the gateway and refused NVR logins', () => {
  it('an NVR whose login stands refused is not dialled: no go2rtc connection, the tile is told and closed (16 tiles: 0 dials)', async () => {
    const up = await fakeGo2rtc('once')
    const { r } = registry('refused')
    const g = await gateway(up.url, r)
    const tiles = Array.from({ length: 16 }, () => tile(g.port))
    const codes = await Promise.all(tiles.map((t) => t.closed))
    expect(codes.every((c) => c === CLOSE_LOGIN_REFUSED)).toBe(true)
    expect(tiles.every((t) => t.texts.some((x) => JSON.parse(x).value === LOGIN_REFUSED_VALUE))).toBe(true)
    expect(up.connections).toEqual([])
    expect(g.events.filter((e) => e.outcome === 'login_refused')).toHaveLength(16)
  })

  it('go2rtc says "wrong user/pass": reported as a refused login for that session, the tile gets the fixed value, never go2rtc\'s text', async () => {
    const up = await fakeGo2rtc('refuse')
    const { r, refusedFor } = registry('go')
    const g = await gateway(up.url, r)
    const t = tile(g.port)
    expect(await t.closed).toBe(CLOSE_LOGIN_REFUSED)
    expect(refusedFor).toEqual([t.sid])
    expect(t.texts.map((x) => JSON.parse(x).value)).toEqual([LOGIN_REFUSED_VALUE])
    expect(t.texts.join('')).not.toContain('user/pass')
  })

  // Round 2 (review M-7): the gateway cannot tell a CCTV-only viewer from the IT view, so what reaches every browser is neutral.
  it('the close reason and the error value a browser sees name no NVR and no login', async () => {
    const up = await fakeGo2rtc('once')
    const { r } = registry('refused')
    const g = await gateway(up.url, r)
    const token = signStreamToken({ sid: randomUUID(), u: randomUUID(), c: randomUUID(), k: 'sub', exp: Math.floor(Date.now() / 1000) + 90 }, SECRET)
    const ws = new WebSocket(`ws://127.0.0.1:${g.port}/g/ws?token=${encodeURIComponent(token)}`, { origin: APP })
    const texts: string[] = []
    ws.on('message', (d, bin) => { if (!bin) texts.push(d.toString()) })
    ws.on('error', () => {})
    cleanups.push(async () => ws.terminate())
    const reason = await new Promise<string>((res) => ws.on('close', (_c, why) => res(why.toString())))
    expect(`${reason} ${texts.join(' ')}`).not.toMatch(/nvr|login|password|refused/i)
  })

  // Round 2 (review M-8; NB-12): a failure text the gateway does not know is reported (hashed, never the text); the second identical one
  // without video in between counts as a refused login and the tile is told, so an unknown wording cannot keep go2rtc dialling.
  it('unknown go2rtc failures are reported hashed; the second identical one ends as a refused login', async () => {
    const up = await fakeGo2rtc('odd')
    const { r, reports } = registry('go')
    const g = await gateway(up.url, r)
    const first = tile(g.port)
    expect(await first.closed).not.toBe(CLOSE_LOGIN_REFUSED)
    const second = tile(g.port)
    expect(await second.closed).toBe(CLOSE_LOGIN_REFUSED)
    expect(reports.map((x) => x.kind)).toEqual(['unexplained', 'unexplained'])
    expect(reports[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(reports[0].hash).toBe(reports[1].hash)
    expect(JSON.stringify(reports)).not.toMatch(/unexpected answer/)
  })

  it('video from a stream is reported (at most once a minute per stream), which clears the count', async () => {
    const up = await fakeGo2rtc('once')
    const { r, reports } = registry('go')
    const g = await gateway(up.url, r, { upstreamSilenceMs: 300 })
    await tile(g.port).closed
    expect(reports.map((x) => x.kind)).toEqual(['video'])
  })

  it('a picture whose video stopped is ended (so go2rtc stops retrying the NVR behind it)', async () => {
    const up = await fakeGo2rtc('once')
    const { r } = registry('go')
    const g = await gateway(up.url, r, { upstreamSilenceMs: 300 })
    const t = tile(g.port)
    expect(await t.closed).toBe(1011)
    expect(g.events.some((e) => e.outcome === 'upstream_silent')).toBe(true)
  })

  it('sockets of one stream share one answer for a few seconds (a burst of 300 sockets must not double the registry calls)', async () => {
    const up = await fakeGo2rtc('once')
    const { r } = registry('refused')
    let asked = 0
    const check = r.loginCheck!
    r.loginCheck = async (sid) => { asked++; return check(sid) }
    const g = await gateway(up.url, r)
    const cam = randomUUID()
    const token = (sid: string) => signStreamToken({ sid, u: randomUUID(), c: cam, k: 'sub', exp: Math.floor(Date.now() / 1000) + 90 }, SECRET)
    const codes = await Promise.all(Array.from({ length: 8 }, () => {
      const ws = new WebSocket(`ws://127.0.0.1:${g.port}/g/ws?token=${encodeURIComponent(token(randomUUID()))}`, { origin: APP })
      ws.on('error', () => {})
      cleanups.push(async () => ws.terminate())
      return new Promise<number>((res) => ws.on('close', (c) => res(c)))
    }))
    expect(codes.every((c) => c === CLOSE_LOGIN_REFUSED)).toBe(true)
    expect(asked).toBe(1)
  })

  it('a registry that cannot answer the login question: nothing is dialled (fail closed)', async () => {
    const up = await fakeGo2rtc('once')
    const { r } = registry('go')
    r.loginCheck = async () => { throw new Error('down') }
    const g = await gateway(up.url, r)
    expect(await tile(g.port).closed).toBe(1013)
    expect(up.connections).toEqual([])
  })
})
