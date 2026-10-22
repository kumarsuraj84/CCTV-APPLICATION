import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Go2rtcClient } from '@/lib/streams/go2rtc'

// A fake go2rtc on loopback for the stream tests (moved here from open-streams.test.ts in P2-5b so the multi-NVR test can share it).
// Like the real one with a read-only config, it answers 400 to a change it has applied.

export type Seen = { method: string; name: string | null; src: string | null }
export type FakeGo2rtc = {
  client: Go2rtcClient; seen: Seen[]; streams: Map<string, string>; failNames: Set<string>; failAll: boolean; applies: boolean; wholeListReads: number
  close: () => Promise<void>
}

export async function startFakeGo2rtc(): Promise<FakeGo2rtc> {
  const seen: Seen[] = []
  const streams = new Map<string, string>()
  const fake = { failNames: new Set<string>(), failAll: false, applies: true, wholeListReads: 0 }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      const one = u.searchParams.get('src')
      if (one === null) {
        fake.wholeListReads++ // the list holds every stream's source: only the pruner may read it
        return void res.end(JSON.stringify(Object.fromEntries([...streams].map(([k, v]) => [k, { producers: [{ url: v }], consumers: null }]))))
      }
      if (!streams.has(one)) {
        res.statusCode = 404
        return void res.end('not found')
      }
      return void res.end(JSON.stringify({ producers: [{ url: streams.get(one) }], consumers: null }))
    }
    const name = u.searchParams.get('name')
    seen.push({ method: req.method ?? '', name, src: u.searchParams.get('src') })
    if (fake.failAll || (name && fake.failNames.has(name))) {
      res.statusCode = 500
      return void res.end('boom')
    }
    if (req.method === 'PUT' && name && fake.applies) streams.set(name, u.searchParams.get('src') ?? '')
    res.statusCode = 400
    res.end('read-only')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return Object.assign(fake, {
    client: new Go2rtcClient(`http://127.0.0.1:${port}`),
    seen,
    streams,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  })
}
