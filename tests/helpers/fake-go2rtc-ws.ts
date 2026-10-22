import http from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'

// A fake go2rtc WebSocket endpoint on loopback for the gateway session tests (P2-4): it records each upstream connection and echoes
// what it gets. Never a real camera. (tests/integration/gateway.test.ts keeps its own richer copy.)

/** `authorization`: the Authorization header the gateway sent (P2-6: go2rtc's API credentials), or undefined. */
export type FakeUpstream = { src: string | null; closed: boolean; socket: WebSocket; received: string[]; authorization?: string }
export type FakeGo2rtcWs = { url: string; connections: FakeUpstream[]; close: () => Promise<void> }

export async function startFakeGo2rtcWs(): Promise<FakeGo2rtcWs> {
  const connections: FakeUpstream[] = []
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ server, path: '/api/ws' })
  wss.on('connection', (socket, req) => {
    const conn: FakeUpstream = { src: new URL(req.url ?? '', 'http://x').searchParams.get('src'), closed: false, socket, received: [], authorization: req.headers.authorization }
    connections.push(conn)
    socket.on('close', () => (conn.closed = true))
    socket.on('error', () => {})
    socket.on('message', (data, isBinary) => {
      conn.received.push(isBinary ? `${(data as Buffer).length}` : data.toString())
      socket.send(data, { binary: isBinary })
    })
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
  return {
    url: `http://127.0.0.1:${port}`,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate())
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export type Outcome = { code: number; reason: string } | { error: string }

/** A browser-like client: resolves `opened` on open and `closed` with the close code and reason. */
export function openSocket(url: string, origin: string) {
  const ws = new WebSocket(url, { origin })
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
  return { ws, opened, closed }
}

export async function waitFor(cond: () => boolean, ms = 3000, what = 'condition') {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
