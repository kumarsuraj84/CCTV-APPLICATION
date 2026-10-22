import http from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  CLOSE_ACCESS_CHANGED, createGateway, DEFAULT_FAIL_CLOSED_AFTER_MS, DEFAULT_VALIDATE_EVERY_MS, type GatewayEvent, type GatewayOptions, type GatewayServer,
} from '@/lib/streams/gateway'
import type { OpenAnswer, RegistryClient } from '@/lib/streams/registry'
import { signStreamToken, type StreamClaims } from '@/lib/streams/token'
import { openSocket, startFakeGo2rtcWs, waitFor, type FakeGo2rtcWs, type Outcome } from '../helpers/fake-go2rtc-ws'

// P2-4 (D-3, AC-14): the gateway asks the session registry before it connects anything upstream, re-checks every open socket in one
// call every 15 seconds, closes the ones that lost access with 4403 "Access changed", and closes everything when it has not been able
// to check for 45 seconds (fail closed). Here with a stub registry and a fake clock (the real database: media-revocation.test.ts).
// Loopback only: a fake go2rtc, the gateway on port 0, ws clients.

const SECRET = 'gateway-session-secret-0123456789'
const APP = 'http://app.test:3212'
const USER = '11111111-1111-4111-8111-111111111111'
const CAM = '22222222-2222-4222-8222-222222222222'

type Stub = RegistryClient & {
  opens: { sid: string; expect: Parameters<RegistryClient['open']>[1] }[]
  checks: string[][]
  closed: string[]
  invalid: Map<string, string>
  refuse: Map<string, string>
  failOpen: boolean
  failCheck: boolean
  openDelayMs: number
}

function stubRegistry(): Stub {
  const s: Stub = {
    opens: [], checks: [], closed: [], invalid: new Map(), refuse: new Map(), failOpen: false, failCheck: false, openDelayMs: 0,
    async open(sid, expect): Promise<OpenAnswer> {
      s.opens.push({ sid, expect })
      if (s.openDelayMs) await new Promise((r) => setTimeout(r, s.openDelayMs))
      if (s.failOpen) throw new Error('registry down')
      const why = s.refuse.get(sid)
      return why ? { ok: false, reason: why } : { ok: true, kind: expect.kind, stream: expect.stream }
    },
    async stillValid(sids) {
      s.checks.push([...sids])
      if (s.failCheck) throw new Error('registry down')
      return new Map([...s.invalid].filter(([sid]) => sids.includes(sid)))
    },
    async close(sid) {
      s.closed.push(sid)
    },
  }
  return s
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})

type Started = { gateway: GatewayServer; port: number; events: GatewayEvent[]; clock: { t: number }; registry: Stub; fake: FakeGo2rtcWs }

async function start(extra: Partial<GatewayOptions> = {}): Promise<Started> {
  const fake = await startFakeGo2rtcWs()
  cleanups.push(fake.close)
  const events: GatewayEvent[] = []
  const clock = { t: 1_800_000_000_000 }
  const registry = stubRegistry()
  const gateway = createGateway({
    go2rtcUrl: fake.url, secret: SECRET, allowedOrigins: [APP], now: () => clock.t, log: (e) => events.push(e), registry,
    autoValidate: false, ...extra,
  })
  const port = await new Promise<number>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve((gateway.address() as AddressInfo).port)))
  cleanups.push(() => gateway.shutdown(1000))
  return { gateway, port, events, clock, registry, fake }
}

const token = (clock: { t: number }, over: Partial<StreamClaims> = {}) =>
  signStreamToken({ sid: randomUUID(), u: USER, c: CAM, k: 'sub', exp: Math.floor(clock.t / 1000) + 90, ...over }, SECRET)
const sidOf = (t: string) => (JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()) as StreamClaims).sid
const url = (port: number, t: string) => `ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(t)}`
function connect(s: Started, over: Partial<StreamClaims> = {}) {
  const t = token(s.clock, over)
  const c = openSocket(url(s.port, t), APP)
  cleanups.push(async () => c.ws.terminate())
  return { ...c, sid: sidOf(t), token: t }
}
const settle = () => new Promise((r) => setTimeout(r, 100))

async function getHealth(port: number) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/g/health', agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }))
    }).on('error', reject)
  })
}

describe('gateway and the session registry (P2-4)', () => {
  it('has the agreed timings: a check at least every 15 seconds, everything closed after 45 seconds without one', () => {
    expect(DEFAULT_VALIDATE_EVERY_MS).toBeLessThanOrEqual(15_000)
    expect(DEFAULT_VALIDATE_EVERY_MS).toBe(15_000)
    expect(DEFAULT_FAIL_CLOSED_AFTER_MS).toBe(45_000)
    expect(CLOSE_ACCESS_CHANGED).toBe(4403)
  })

  // P2-6 (D-13): go2rtc's API is protected by its own credentials; the gateway sends them on its upstream video socket (server → loopback).
  it('sends go2rtc\'s API credentials on the upstream socket when they are configured, and nothing when they are not', async () => {
    const auth = { username: 'drishti-gw', password: 'k'.repeat(40) }
    const s = await start({ go2rtcAuth: auth })
    const live = connect(s)
    expect(await live.opened).toBe(true)
    await waitFor(() => s.fake.connections.length === 1)
    expect(s.fake.connections[0].authorization).toBe(`Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`)
    const plain = await start({ go2rtcAuth: null })
    const other = connect(plain)
    expect(await other.opened).toBe(true)
    await waitFor(() => plain.fake.connections.length === 1)
    expect(plain.fake.connections[0].authorization).toBeUndefined()
  })

  it('refuses to start without a registry', () => {
    expect(() => createGateway({ go2rtcUrl: 'http://127.0.0.1:1984', secret: SECRET, allowedOrigins: [APP] } as unknown as GatewayOptions)).toThrow(/registry/)
  })

  it('opens the token’s own session before connecting upstream, with its person, camera, kind and stream', async () => {
    const s = await start()
    const live = connect(s)
    expect(await live.opened).toBe(true)
    await waitFor(() => s.fake.connections.length === 1)
    const pb = connect(s, { k: 'pb', s: 1_799_999_000, e: 1_799_999_600 })
    await pb.opened
    await waitFor(() => s.fake.connections.length === 2)
    expect(s.registry.opens).toEqual([
      { sid: live.sid, expect: { user: USER, camera: CAM, kind: 'live', stream: `cam_${CAM}_sub` } },
      { sid: pb.sid, expect: { user: USER, camera: CAM, kind: 'playback', stream: `pb_${CAM}_1799999000` } },
    ])
  })

  it('a refused session closes with 1008 before anything upstream (a revoked person’s earlier token, a forged or reused sid)', async () => {
    const s = await start()
    const t = token(s.clock)
    s.registry.refuse.set(sidOf(t), 'access_changed')
    const c = openSocket(url(s.port, t), APP)
    cleanups.push(async () => c.ws.terminate())
    expect(await c.closed).toEqual({ code: 1008, reason: 'Not allowed' })
    await settle()
    expect(s.fake.connections).toHaveLength(0)
    expect(s.events.find((e) => e.outcome === 'denied_session')).toMatchObject({ reason: 'access_changed' })
  })

  it('cannot verify (registry down when the socket arrives): closes with 1013, nothing upstream', async () => {
    const s = await start()
    s.registry.failOpen = true
    const c = connect(s)
    expect(await c.closed).toEqual({ code: 1013, reason: 'Cannot verify access' })
    await settle()
    expect(s.fake.connections).toHaveLength(0)
  })

  it('a token without a session id never reaches the registry (1008)', async () => {
    const s = await start()
    // Correctly signed, in the shape tokens had before P2-4.
    const old = Buffer.from(JSON.stringify({ u: USER, c: CAM, k: 'sub', exp: Math.floor(s.clock.t / 1000) + 90 })).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`stream.v1.${old}`).digest('base64url')
    const c = openSocket(url(s.port, `${old}.${sig}`), APP)
    expect(await c.closed).toEqual({ code: 1008, reason: 'Not allowed' })
    expect(s.registry.opens).toHaveLength(0)
  })

  it('keeps what the browser sends while the registry is being asked, and passes it on afterwards', async () => {
    const s = await start()
    s.registry.openDelayMs = 300
    const c = connect(s)
    c.ws.on('open', () => c.ws.send(JSON.stringify({ type: 'mse', value: 'early' })))
    await c.opened
    await waitFor(() => s.fake.connections.length === 1 && s.fake.connections[0].received.length === 1, 3000, 'the early message upstream')
    expect(s.fake.connections[0].received[0]).toBe(JSON.stringify({ type: 'mse', value: 'early' }))
  })

  it('a browser that goes away while the registry is asked leaves nothing open, and its session is closed', async () => {
    const s = await start()
    s.registry.openDelayMs = 300
    const c = connect(s)
    await c.opened
    c.ws.terminate()
    await new Promise((r) => setTimeout(r, 600))
    expect(s.fake.connections).toHaveLength(0)
    expect(s.registry.closed).toContain(c.sid)
  })

  it('one batched check for every open socket; the invalid ones close with 4403, the others stay', async () => {
    const s = await start()
    const sockets = [connect(s), connect(s), connect(s)]
    await Promise.all(sockets.map((x) => x.opened))
    await waitFor(() => s.fake.connections.length === 3)
    s.registry.invalid.set(sockets[1].sid, 'access_changed')
    await s.gateway.validateNow()
    expect(s.registry.checks).toHaveLength(1)
    expect(new Set(s.registry.checks[0])).toEqual(new Set(sockets.map((x) => x.sid)))
    expect(await sockets[1].closed).toEqual({ code: 4403, reason: 'Access changed' })
    await waitFor(() => s.fake.connections.filter((x) => x.closed).length === 1, 3000, 'the upstream of the revoked socket to close')
    expect(sockets[0].ws.readyState).toBe(WebSocket.OPEN)
    expect(sockets[2].ws.readyState).toBe(WebSocket.OPEN)
    expect(s.registry.closed).toEqual([sockets[1].sid])
    expect(s.events.find((e) => e.outcome === 'revoked')).toMatchObject({ reason: 'access_changed', kind: 'sub' })
    // The next check asks only for the ones still open.
    await s.gateway.validateNow()
    expect(new Set(s.registry.checks[1])).toEqual(new Set([sockets[0].sid, sockets[2].sid]))
  })

  it('fails closed: when the registry cannot be asked for 45 seconds every socket closes, and nothing stays open (fake clock)', async () => {
    const s = await start()
    const sockets = [connect(s), connect(s)]
    await Promise.all(sockets.map((x) => x.opened))
    await waitFor(() => s.fake.connections.length === 2)
    s.registry.failCheck = true
    for (const step of [15_000, 15_000]) {
      s.clock.t += step
      await s.gateway.validateNow()
    }
    await settle()
    expect(sockets.every((x) => x.ws.readyState === WebSocket.OPEN)).toBe(true) // 30 s without a check: still open
    s.clock.t += 15_000 // 45 s
    await s.gateway.validateNow()
    const results = await Promise.all(sockets.map((x) => x.closed))
    for (const r of results) expect(r).toEqual({ code: 1013, reason: 'Cannot verify access' })
    await waitFor(() => s.fake.connections.every((x) => x.closed), 3000, 'every upstream to close')
    expect(JSON.parse((await getHealth(s.port)).body)).toMatchObject({ openSessions: 0, registry: 'failing' })
    expect(s.events.filter((e) => e.outcome === 'fail_closed')).toHaveLength(2)
  })

  it('a registry that comes back in time closes nothing', async () => {
    const s = await start()
    const c = connect(s)
    await c.opened
    s.registry.failCheck = true
    s.clock.t += 30_000
    await s.gateway.validateNow()
    s.registry.failCheck = false
    s.clock.t += 10_000
    await s.gateway.validateNow()
    s.registry.failCheck = true
    s.clock.t += 40_000 // 40 s after the last good check
    await s.gateway.validateNow()
    await settle()
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('checks by itself at the configured interval (real time, 100 ms)', async () => {
    const s = await start({ autoValidate: true, validateEveryMs: 100, now: Date.now })
    s.clock.t = Date.now() // the token's connect window is reckoned on the real clock here
    const c = connect(s)
    await c.opened
    s.registry.invalid.set(c.sid, 'deactivated')
    const started = Date.now()
    const r = (await c.closed) as Outcome
    expect(r).toEqual({ code: 4403, reason: 'Access changed' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('closes the session in the registry when the browser leaves', async () => {
    const s = await start()
    const c = connect(s)
    await c.opened
    await waitFor(() => s.fake.connections.length === 1)
    c.ws.close()
    await waitFor(() => s.registry.closed.includes(c.sid), 3000, 'the session to be closed')
  })

  it('300 open sockets: one registry call per check (brief 6h)', async () => {
    const s = await start({ maxSockets: 400, maxSocketsPerIp: 400, maxUpgradesPerMinute: 1000 })
    // In groups of 50: 300 connection attempts at the same instant overflow the loopback listen queue on Windows (ECONNREFUSED).
    const sockets: ReturnType<typeof connect>[] = []
    for (let i = 0; i < 6; i++) {
      const group = Array.from({ length: 50 }, () => connect(s))
      expect((await Promise.all(group.map((x) => x.opened))).every(Boolean)).toBe(true)
      sockets.push(...group)
    }
    await waitFor(() => s.fake.connections.length === 300, 20_000, '300 upstream connections')
    s.registry.invalid.set(sockets[7].sid, 'access_changed')
    const t0 = performance.now()
    await s.gateway.validateNow()
    const ms = performance.now() - t0
    expect(s.registry.checks).toHaveLength(1)
    expect(s.registry.checks[0]).toHaveLength(300)
    expect(await sockets[7].closed).toMatchObject({ code: 4403 })
    console.log(JSON.stringify({ gateway_check_stub: { sockets: 300, calls: s.registry.checks.length, ms: Math.round(ms * 10) / 10 } }))
  }, 60_000)

  it('review m-3: a check that never answers still lets the fail-closed time run out (gateway-side deadline)', async () => {
    const s = await start({ checkDeadlineMs: 100 })
    const sockets = [connect(s), connect(s)]
    await Promise.all(sockets.map((x) => x.opened))
    await waitFor(() => s.fake.connections.length === 2)
    s.registry.stillValid = () => new Promise(() => {}) // never settles
    for (const step of [15_000, 15_000, 15_000]) {
      s.clock.t += step
      await s.gateway.validateNow()
    }
    const results = await Promise.all(sockets.map((x) => x.closed))
    for (const r of results) expect(r).toEqual({ code: 1013, reason: 'Cannot verify access' })
    expect(s.gateway.health()).toMatchObject({ registry: 'failing', openSessions: 0 })
  })

  it('review m-2: an idle gateway asks the registry too, so a broken key or database shows as failing, and recovers', async () => {
    const s = await start()
    await s.gateway.validateNow()
    expect(s.registry.checks).toHaveLength(1) // a ping, although no socket is open
    expect(s.gateway.health()).toMatchObject({ status: 'ok', registry: 'ok', lastValidationAgeSec: 0 })
    s.registry.failCheck = true
    s.clock.t += 15_000
    await s.gateway.validateNow()
    expect(s.gateway.health()).toMatchObject({ status: 'not_verifying', registry: 'failing', lastValidationAgeSec: 15 })
    s.registry.failCheck = false
    s.clock.t += 15_000
    await s.gateway.validateNow()
    expect(s.gateway.health()).toMatchObject({ registry: 'ok', lastValidationAgeSec: 0 })
  })

  it('review m-2: a registry that refuses to open sessions (broken key) shows as failing; a good open clears it', async () => {
    const s = await start()
    await s.gateway.validateNow()
    s.registry.failOpen = true
    expect(await connect(s).closed).toEqual({ code: 1013, reason: 'Cannot verify access' })
    expect(s.gateway.health()).toMatchObject({ registry: 'failing' })
    s.registry.failOpen = false
    const c = connect(s)
    await c.opened
    await waitFor(() => s.fake.connections.length === 1)
    expect(s.gateway.health()).toMatchObject({ registry: 'ok' })
  })

  it('health says how many sessions are open and how old the last check is, and nothing else', async () => {
    const s = await start()
    const c = connect(s)
    await c.opened
    await waitFor(() => s.fake.connections.length === 1)
    await s.gateway.validateNow()
    s.clock.t += 7_000
    const h = await getHealth(s.port)
    expect(h.status).toBe(200)
    expect(h.type).toContain('application/json')
    const body = JSON.parse(h.body)
    expect(body).toEqual({ status: 'ok', registry: 'ok', openSessions: 1, lastValidationAgeSec: 7, validateEverySec: 15, failClosedAfterSec: 45 })
    for (const secret of [c.sid, USER, CAM, c.token, SECRET]) expect(h.body).not.toContain(secret)
  })
})
