import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { closedPort } from '../helpers/fake-servers'

type Seen = { method: string; url: string; query: URLSearchParams; rawQuery: string }
type Fake = { base: string; seen: Seen[]; close: () => Promise<void> }

const open: Fake[] = []
afterEach(async () => {
  while (open.length) await open.pop()!.close()
})

async function startFake(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void): Promise<Fake> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const s = { method: req.method ?? '', url: u.pathname, query: u.searchParams, rawQuery: u.search }
    seen.push(s)
    handler(req, res, s)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const fake: Fake = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
  open.push(fake)
  return fake
}

const SRC = "rtsp://viewer:p%40ss%3Aw%2Frd%23@192.168.1.10:554/Streaming/Channels/302"
const NAME = 'cam_9a1d4e7c-2b36-4f58-8e0a-6c5d3b2a1f09_sub'
const PLAIN = 'The video server did not accept the stream.'

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return (e as Error).message
  }
  return ''
}
function expectNoLeak(text: string, base: string) {
  for (const needle of [base, '127.0.0.1', 'rtsp://', 'viewer', 'p%40ss', 'p@ss', '/api/streams', 'src=', 'name=', NAME]) expect(text).not.toContain(needle)
}

describe('Go2rtcClient.register', () => {
  it('sends PUT /api/streams with the name and source percent-encoded', async () => {
    const f = await startFake((_q, res) => { res.statusCode = 200; res.end('{}') })
    await new Go2rtcClient(f.base).register(NAME, SRC)
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0].method).toBe('PUT')
    expect(f.seen[0].url).toBe('/api/streams')
    expect(f.seen[0].query.get('name')).toBe(NAME)
    expect(f.seen[0].query.get('src')).toBe(SRC)
    // Encoded on the wire: no raw :// or @ in the query string.
    expect(f.seen[0].rawQuery).toBe(`?name=${encodeURIComponent(NAME)}&src=${encodeURIComponent(SRC)}`)
  })

  it('carries an exec source with spaces, braces and an ampersand intact', async () => {
    const f = await startFake((_q, res) => { res.end('{}') })
    const exec = 'exec:ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=10 -f rtsp {output}&x=1#frag'
    await new Go2rtcClient(f.base).register(NAME, exec)
    expect(f.seen[0].query.get('src')).toBe(exec)
    expect(f.seen[0].query.get('x')).toBeNull()
  })

  it('tolerates a trailing slash on the base address', async () => {
    const f = await startFake((_q, res) => { res.end('{}') })
    await new Go2rtcClient(`${f.base}/`).register(NAME, SRC)
    expect(f.seen[0].url).toBe('/api/streams')
  })

  it('throws the plain message, without the address or the source, on a non-2xx answer', async () => {
    for (const status of [400, 401, 404, 500, 503]) {
      const f = await startFake((_q, res) => { res.statusCode = status; res.end(`failed for ${SRC} at ${'127.0.0.1'}`) })
      const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))
      expect(m, String(status)).toBe(PLAIN)
      expectNoLeak(m, f.base)
    }
  })

  it('does not follow a redirect (the source must not go to another address)', async () => {
    const other = await startFake((_q, res) => { res.end('{}') })
    const f = await startFake((_q, res) => { res.statusCode = 307; res.setHeader('location', `${other.base}/api/streams`); res.end() })
    expect(await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))).toBe(PLAIN)
    expect(other.seen).toHaveLength(0)
  })

  it('throws the plain message when nothing listens, without the address', async () => {
    const base = `http://127.0.0.1:${await closedPort()}`
    const m = await messageOf(new Go2rtcClient(base).register(NAME, SRC))
    expect(m).toBe(PLAIN)
    expectNoLeak(m, base)
  })

  it('throws the plain message, without a cause that carries the address, when fetch fails', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED ${SRC}`) })
    }) as unknown as typeof fetch
    let err: unknown
    try {
      await new Go2rtcClient('http://127.0.0.1:1984', fetchImpl).register(NAME, SRC)
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toBe(PLAIN)
    expect((err as Error).cause).toBeUndefined()
    expect(String((err as Error).stack)).not.toContain('viewer')
  })

  it('gives up after the timeout', async () => {
    const f = await startFake(() => { /* never answers */ })
    const started = Date.now()
    const m = await messageOf(new Go2rtcClient(f.base, undefined, 150).register(NAME, SRC))
    expect(m).toBe(PLAIN)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('passes an abort signal to fetch, five seconds by default', async () => {
    let init: RequestInit | undefined
    const fetchImpl = (async (_u: string, i?: RequestInit) => { init = i; return new Response('{}') }) as unknown as typeof fetch
    await new Go2rtcClient('http://127.0.0.1:1984', fetchImpl).register(NAME, SRC)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
    expect(init?.redirect).toBe('manual')
  })

  it('refuses a stream name that is not a plain identifier, without calling the server', async () => {
    const f = await startFake((_q, res) => { res.end('{}') })
    const c = new Go2rtcClient(f.base)
    for (const name of ['', 'a b', 'x&src=evil', '../x', 'a#b', 'a\n']) expect(await messageOf(c.register(name, SRC)), name).toBe(PLAIN)
    expect(await messageOf(c.register(NAME, ''))).toBe(PLAIN)
    expect(f.seen).toHaveLength(0)
  })
})

describe('Go2rtcClient.has', () => {
  it('reads GET /api/streams and checks the name', async () => {
    const f = await startFake((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ [NAME]: { producers: [], consumers: null } })) })
    const c = new Go2rtcClient(f.base)
    expect(await c.has(NAME)).toBe(true)
    expect(await c.has('cam_other_sub')).toBe(false)
    expect(f.seen[0].method).toBe('GET')
    expect(f.seen[0].url).toBe('/api/streams')
  })

  it('does not mistake an inherited property for a stream', async () => {
    const f = await startFake((_q, res) => { res.end('{}') })
    const c = new Go2rtcClient(f.base)
    expect(await c.has('toString')).toBe(false)
    expect(await c.has('constructor')).toBe(false)
    expect(await c.has('__proto__')).toBe(false)
  })

  it('is false for an empty list and throws a plain message for a broken answer', async () => {
    const empty = await startFake((_q, res) => { res.end('{}') })
    expect(await new Go2rtcClient(empty.base).has(NAME)).toBe(false)
    for (const body of ['not json', '[]', 'null', '"x"']) {
      const f = await startFake((_q, res) => { res.end(body) })
      const m = await messageOf(new Go2rtcClient(f.base).has(NAME))
      expect(m, body).not.toBe('')
      expectNoLeak(m, f.base)
    }
  })

  it('throws a plain message on a non-2xx answer or no server', async () => {
    const f = await startFake((_q, res) => { res.statusCode = 500; res.end('boom') })
    const m = await messageOf(new Go2rtcClient(f.base).has(NAME))
    expect(m).not.toBe('')
    expectNoLeak(m, f.base)
    const base = `http://127.0.0.1:${await closedPort()}`
    const m2 = await messageOf(new Go2rtcClient(base).has(NAME))
    expect(m2).not.toBe('')
    expectNoLeak(m2, base)
  })
})

describe('Go2rtcClient.remove', () => {
  it('sends DELETE /api/streams?src=<name>', async () => {
    const f = await startFake((_q, res) => { res.end('{}') })
    await new Go2rtcClient(f.base).remove(NAME)
    expect(f.seen[0].method).toBe('DELETE')
    expect(f.seen[0].url).toBe('/api/streams')
    expect(f.seen[0].rawQuery).toBe(`?src=${encodeURIComponent(NAME)}`)
  })

  it('throws a plain message on a non-2xx answer or no server, never with the address', async () => {
    const f = await startFake((_q, res) => { res.statusCode = 500; res.end('boom') })
    const m = await messageOf(new Go2rtcClient(f.base).remove(NAME))
    expect(m).not.toBe('')
    expectNoLeak(m, f.base)
    const base = `http://127.0.0.1:${await closedPort()}`
    const m2 = await messageOf(new Go2rtcClient(base).remove(NAME))
    expect(m2).not.toBe('')
    expectNoLeak(m2, base)
  })

  it('refuses a name that is not a plain identifier, without calling the server', async () => {
    const f = await startFake((_q, res) => { res.end('{}') })
    expect(await messageOf(new Go2rtcClient(f.base).remove('a&b'))).not.toBe('')
    expect(f.seen).toHaveLength(0)
  })
})
