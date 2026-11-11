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
async function fakeGo2rtc(mode: 'refuse' | 'once') {
  const connections: string[] = []
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ server, path: '/api/ws' })
  wss.on('connection', (socket, req) => {
    connections.push(req.url ?? '')
    socket.on('error', () => {})
    socket.on('message', () => {
      if (mode === 'refuse') socket.send(JSON.stringify({ type: 'error', value: 'streams: wrong user/pass' }))
      else socket.send(Buffer.alloc(32, 1), { binary: true })
    })
  })
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))
  cleanups.push(() => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections(); server.close(() => r()) }))
  return { url: `http://127.0.0.1:${port}`, connections }
}

function registry(decision: 'go' | 'refused') {
  const refusedFor: string[] = []
  const r: RegistryClient = {
    open: async (_sid, e) => ({ ok: true, kind: e.kind, stream: e.stream }),
    stillValid: async () => new Map(),
    close: async () => {},
    loginCheck: async () => decision,
    loginRefused: async (sid) => void refusedFor.push(sid),
  }
  return { r, refusedFor }
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

  it('a picture whose video stopped is ended (so go2rtc stops retrying the NVR behind it)', async () => {
    const up = await fakeGo2rtc('once')
    const { r } = registry('go')
    const g = await gateway(up.url, r, { upstreamSilenceMs: 300 })
    const t = tile(g.port)
    expect(await t.closed).toBe(1011)
    expect(g.events.some((e) => e.outcome === 'upstream_silent')).toBe(true)
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
