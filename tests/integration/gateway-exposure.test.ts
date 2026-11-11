import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createGateway, MAX_BROWSER_PAYLOAD } from '@/lib/streams/gateway'
import type { RegistryClient } from '@/lib/streams/registry'
import { signStreamToken } from '@/lib/streams/token'

// Final fix Y (final review B minors 6 and 8), with a fake go2rtc on loopback:
//   minor 6  a browser may send only small JSON text (4 KB); a bigger frame is refused by the socket itself before anything is buffered
//            (was 4 MB per frame: about 1.2 GB across 300 sockets before the registry answered).
//   minor 8  /g/health (open video connections, whether access checks fail) answers only a request made on this computer directly (the
//            web app's Health page, GATEWAY_HEALTH_URL); through the TLS proxy (X-Forwarded-For / Forwarded) it is "Not found".

const SECRET = 'gateway-exposure-test-secret-0123456789abcdef'
const APP = 'http://app.test:3212'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()))
})
const allowAll: RegistryClient = { open: async (_s, e) => ({ ok: true, kind: e.kind, stream: e.stream }), stillValid: async () => new Map(), close: async () => {} }

async function start() {
  const up = http.createServer((_q, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ server: up, path: '/api/ws' })
  wss.on('connection', (s) => s.on('message', (d, bin) => s.send(d, { binary: bin })))
  const upPort = await new Promise<number>((r) => up.listen(0, '127.0.0.1', () => r((up.address() as AddressInfo).port)))
  const clock = { t: 1_800_000_000_000 }
  const gateway = createGateway({ go2rtcUrl: `http://127.0.0.1:${upPort}`, secret: SECRET, allowedOrigins: [APP], now: () => clock.t, log: () => {}, registry: allowAll, autoValidate: false })
  const port = await new Promise<number>((r) => gateway.listen(0, '127.0.0.1', () => r((gateway.address() as AddressInfo).port)))
  cleanups.push(async () => {
    await gateway.shutdown(500)
    wss.clients.forEach((c) => c.terminate())
    up.closeAllConnections()
    await new Promise<void>((r) => up.close(() => r()))
  })
  return { port, clock }
}

const get = (port: number, path: string, headers: http.OutgoingHttpHeaders = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

describe('gateway exposure (final fix Y)', () => {
  it('minor 8: health answers a direct request from this computer only; through the proxy it is not found', async () => {
    const { port } = await start()
    const direct = await get(port, '/g/health')
    expect(direct.status).toBe(200)
    expect(JSON.parse(direct.body)).toMatchObject({ openSessions: 0 })
    for (const h of [{ 'X-Forwarded-For': '10.1.2.3' }, { Forwarded: 'for=10.1.2.3' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
      const r = await get(port, '/g/health', h)
      expect(r.status, JSON.stringify(h)).toBe(404)
      expect(r.body).not.toMatch(/openSessions/)
    }
  })

  it('minor 6: the largest browser message is 4 KB; a bigger one closes the socket (1009) and never reaches go2rtc', async () => {
    expect(MAX_BROWSER_PAYLOAD).toBe(4 * 1024)
    const { port, clock } = await start()
    const token = signStreamToken({ sid: randomUUID(), u: '11111111-1111-4111-8111-111111111111', c: '22222222-2222-4222-8222-222222222222', k: 'sub', exp: Math.floor(clock.t / 1000) + 90 }, SECRET)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(token)}`, { origin: APP })
    cleanups.push(async () => ws.terminate())
    await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j) })
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify({ type: 'mse', value: 'x'.repeat(8 * 1024) }))
    expect(await closed).toBe(1009)
  })
})
