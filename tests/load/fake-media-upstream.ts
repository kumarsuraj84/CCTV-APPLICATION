// P5.5 media-path load test: a fake go2rtc video endpoint (/api/ws) on loopback that behaves like go2rtc's MSE socket closely enough for
// the gateway: when the player's first message ({"type":"mse",...}) arrives it answers with the codec line and then sends binary
// "fragments" at a fixed bitrate and frame rate, a bigger one every 2 seconds (the key frame). Sub-streams and main streams have their own
// bitrate (stream name ending _sub / _main). No camera, no NVR, no real video: the bytes are filler.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { WebSocketServer, type WebSocket } from 'ws'

export type MediaProfile = { kbps: number; fps: number }
export type FakeMediaUpstream = {
  url: string
  /** Every upstream socket the gateway opened, with the bytes sent on it. */
  streams: { name: string; bytes: number; frames: number; closed: boolean }[]
  close: () => Promise<void>
}

export async function startFakeMediaUpstream(o: { sub: MediaProfile; main: MediaProfile; keyEverySec?: number; keyFactor?: number }): Promise<FakeMediaUpstream> {
  const keyEvery = o.keyEverySec ?? 2
  const keyFactor = o.keyFactor ?? 5
  const streams: FakeMediaUpstream['streams'] = []
  const timers = new Set<NodeJS.Timeout>()
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ server, path: '/api/ws', perMessageDeflate: false })
  wss.on('connection', (socket: WebSocket, req) => {
    const name = new URL(req.url ?? '', 'http://x').searchParams.get('src') ?? ''
    const p = name.endsWith('_main') ? o.main : o.sub
    const entry = { name, bytes: 0, frames: 0, closed: false }
    streams.push(entry)
    // Bytes per ordinary frame so that the average over a key-frame period is the profile's bitrate.
    const perPeriod = (p.kbps * 1000 * keyEvery) / 8
    const framesPerPeriod = Math.round(p.fps * keyEvery)
    const plain = Math.max(64, Math.round(perPeriod / (framesPerPeriod - 1 + keyFactor)))
    const frame = Buffer.alloc(plain, 0x11)
    const key = Buffer.alloc(plain * keyFactor, 0x22)
    let timer: NodeJS.Timeout | undefined
    socket.on('error', () => {})
    socket.on('close', () => {
      entry.closed = true
      if (timer) {
        clearInterval(timer)
        timers.delete(timer)
      }
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary || timer) return
      let type = ''
      try {
        type = String((JSON.parse(data.toString()) as { type?: unknown }).type ?? '')
      } catch {
        return
      }
      if (type !== 'mse') return
      socket.send(JSON.stringify({ type: 'mse', value: name.endsWith('_main') ? 'video/mp4; codecs="avc1.640028"' : 'video/mp4; codecs="avc1.4d401e"' }))
      // Frames are sent by the clock (as many as are due), not one per timer tick: Windows timers tick every ~15.6 ms, which would
      // otherwise lower the frame rate and the bitrate below the profile.
      let n = 0
      const startedAt = performance.now()
      timer = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return
        const due = Math.floor(((performance.now() - startedAt) / 1000) * p.fps)
        while (n < due) {
          const b = n % framesPerPeriod === 0 ? key : frame
          n++
          entry.frames++
          entry.bytes += b.length
          socket.send(b, { binary: true })
        }
      }, 10)
      timers.add(timer)
    })
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
  return {
    url: `http://127.0.0.1:${port}`,
    streams,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t)
        wss.clients.forEach((c) => c.terminate())
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
