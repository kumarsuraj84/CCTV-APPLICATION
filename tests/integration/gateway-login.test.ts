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
async function fakeGo2rtc(mode: 'refuse' | 'once' | 'odd' | 'dead' | 'network' | 'drop') {
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
      // dead (round 3): the camera behind one channel is gone; the NVR answers that channel with 404, every time.
      else if (mode === 'dead') socket.send(JSON.stringify({ type: 'error', value: 'streams: rtsp: 404 Not Found' }))
      // network (round 3): the branch's WAN link dropped.
      else if (mode === 'network') socket.send(JSON.stringify({ type: 'error', value: 'streams: dial tcp 10.9.8.7:554: i/o timeout' }))
      else if (mode === 'drop') socket.terminate()
      else socket.send(Buffer.alloc(32, 1), { binary: true })
    })
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))
  cleanups.push(() => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); server.close(() => r()) }))
  return { url: `http://127.0.0.1:${port}`, connections }
}

function registry(decision: 'go' | 'refused') {
  const refusedFor: string[] = []
  const reports: { sid: string; kind: string; hash?: string; camera?: string }[] = []
  const cameraOf = new Map<string, string>()
  let seen: { hash: string; cameras: Set<string> } | null = null
  let videoAt = 0
  const r: RegistryClient = {
    open: async (sid, e) => {
      cameraOf.set(sid, e.camera)
      return { ok: true, kind: e.kind, stream: e.stream }
    },
    stillValid: async () => new Map(),
    close: async () => {},
    loginCheck: async () => decision,
    loginRefused: async (sid) => void refusedFor.push(sid),
    // Like media_session_login_report (round 3): network failures are their own; video clears; the same unexplained failure from two
    // DIFFERENT cameras of the NVR (never proven, no video lately) is the fail-safe.
    loginReport: async (sid, kind, hash) => {
      const camera = cameraOf.get(sid)
      reports.push({ sid, kind, hash, camera })
      if (kind === 'network') return 'network'
      if (kind === 'video') {
        videoAt = Date.now()
        seen = null
        return 'cleared'
      }
      if (Date.now() - videoAt < 600_000) return 'camera'
      if (!seen || seen.hash !== hash) seen = { hash: hash!, cameras: new Set() }
      seen.cameras.add(camera!)
      return seen.cameras.size >= 2 ? 'unexplained' : 'counted'
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

function tile(port: number, sid = randomUUID(), camera = randomUUID()) {
  const token = signStreamToken({ sid, u: randomUUID(), c: camera, k: 'sub', exp: Math.floor(Date.now() / 1000) + 90 }, SECRET)
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

  // Round 2 (review M-8; NB-12) and round 3 (pre-handover review I-1): a failure text the gateway does not know is reported (hashed,
  // never the text); the same one from a SECOND camera of the NVR is the fail-safe and the tile is told, so an unknown wording for a
  // wrong password cannot keep go2rtc dialling.
  it('unknown go2rtc failures are reported hashed; the same one from a second camera ends as the fail-safe (logged for the pilot)', async () => {
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
    expect(g.events.filter((e) => e.outcome === 'login_refused').map((e) => e.reason)).toEqual(['unexplained_failsafe'])
  })

  // Round 3 (pre-handover review I-1, scenario 1): one dead camera channel. Its tile reconnects every few seconds and fails the same
  // way each time; that is the camera's failure: the tile is told "not available" (and retries on its own back-off), the NVR is not.
  it('one dead camera failing again and again never ends as the fail-safe: every close is the plain one', async () => {
    const up = await fakeGo2rtc('dead')
    const { r, reports } = registry('go')
    const g = await gateway(up.url, r)
    const camera = randomUUID()
    const codes: number[] = []
    for (let i = 0; i < 4; i++) {
      const t = tile(g.port, randomUUID(), camera)
      codes.push(await t.closed)
      expect(t.texts.map((x) => JSON.parse(x).value)).toEqual(['The video is not available.'])
    }
    expect(codes).toEqual([1011, 1011, 1011, 1011])
    expect(reports.map((x) => x.kind)).toEqual(['unexplained', 'unexplained', 'unexplained', 'unexplained'])
    expect(g.events.some((e) => e.outcome === 'login_refused')).toBe(false)
  })

  // Round 3 (pre-handover review I-1, scenario 2): the branch WAN drops. go2rtc's dial timeout (or a reset, an unreachable host, a DNS
  // or TLS failure, a connection cut without a word) is a network failure: reported as such (no hash needed), never "unexplained".
  it('network failures are reported as network failures, from any number of cameras, and never end as the fail-safe', async () => {
    for (const mode of ['network', 'drop'] as const) {
      const up = await fakeGo2rtc(mode)
      const { r, reports } = registry('go')
      const g = await gateway(up.url, r)
      const codes = [await tile(g.port).closed, await tile(g.port).closed, await tile(g.port).closed]
      expect(codes.every((c) => c === 1011), mode).toBe(true)
      expect(reports.map((x) => x.kind), mode).toEqual(['network', 'network', 'network'])
      expect(reports.every((x) => x.hash === undefined), mode).toBe(true)
      expect(g.events.some((e) => e.outcome === 'login_refused'), mode).toBe(false)
    }
  })

  it('a real wrong password (go2rtc\'s "wrong user/pass") still counts as a refused login at once', async () => {
    const up = await fakeGo2rtc('refuse')
    const { r, refusedFor, reports } = registry('go')
    const g = await gateway(up.url, r)
    const t = tile(g.port)
    expect(await t.closed).toBe(CLOSE_LOGIN_REFUSED)
    expect(refusedFor).toEqual([t.sid])
    expect(reports).toEqual([])
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
