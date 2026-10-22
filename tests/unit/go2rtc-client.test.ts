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

describe('Go2rtcClient address', () => {
  it('accepts only an http(s) address on this machine', () => {
    for (const ok of ['http://127.0.0.1:1984', 'http://localhost:1984', 'http://[::1]:1984', 'https://127.0.0.1:1984/', 'http://127.0.0.1']) {
      expect(() => new Go2rtcClient(ok), ok).not.toThrow()
    }
  })

  it('refuses any other address with a plain message that does not echo it', () => {
    const bad = [
      'http://192.168.1.5:1984', 'http://example.com:1984', 'http://127.0.0.1.evil.com:1984', 'http://localhost.evil.com', 'http://0.0.0.0:1984',
      'http://127.0.0.2:1984', 'ftp://127.0.0.1:1984', 'ws://127.0.0.1:1984', 'file:///etc/passwd', 'rtsp://127.0.0.1', 'javascript:alert(1)', 'not a url', '',
      '127.0.0.1:1984', 'http://user:pw@127.0.0.1:1984', 'http://127.0.0.1@evil.com:1984', 'http://evil.com#@127.0.0.1', 'http://[::2]:1984',
    ]
    for (const url of bad) {
      let message = ''
      try {
        new Go2rtcClient(url)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, url).toBe('The video server address is not valid.')
      for (const needle of ['evil', '192.168', 'example', 'user', 'pw', '1984']) expect(message).not.toContain(needle)
    }
  })

  it('never calls out for a refused address', () => {
    let called = false
    const fetchImpl = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
    expect(() => new Go2rtcClient('http://203.0.113.9:1984', fetchImpl)).toThrow()
    expect(called).toBe(false)
  })
})

/**
 * A fake go2rtc that keeps a stream list. `change` is the status it answers a PUT/DELETE with and `applies` says whether it really changes the
 * list: the real go2rtc 1.9.9 with a read-only config answers 400 and still applies the change.
 */
async function startGo2rtc(change: number, applies: boolean, o: { listStatus?: number } = {}): Promise<Fake & { streams: Map<string, string> }> {
  const streams = new Map<string, string>()
  const f = await startFake((req, res, s) => {
    if (req.method === 'GET') {
      res.statusCode = o.listStatus ?? 200
      res.setHeader('content-type', 'application/json')
      return void res.end(JSON.stringify(Object.fromEntries([...streams].map(([k, v]) => [k, { producers: [{ url: v }], consumers: null }]))))
    }
    if (applies) {
      if (req.method === 'PUT') streams.set(s.query.get('name') ?? '', s.query.get('src') ?? '')
      else streams.delete(s.query.get('src') ?? '')
    }
    res.statusCode = change
    res.end(`failed for ${SRC} at 127.0.0.1`)
  })
  return Object.assign(f, { streams })
}

describe('Go2rtcClient.register', () => {
  it('looks at the list, sends PUT /api/streams with the name and source percent-encoded, then reads the list back', async () => {
    const f = await startGo2rtc(200, true)
    await new Go2rtcClient(f.base).register(NAME, SRC)
    expect(f.seen.map((s) => s.method)).toEqual(['GET', 'PUT', 'GET'])
    const put = f.seen[1]
    expect(put.url).toBe('/api/streams')
    expect(put.query.get('name')).toBe(NAME)
    expect(put.query.get('src')).toBe(SRC)
    // Encoded on the wire: no raw :// or @ in the query string.
    expect(put.rawQuery).toBe(`?name=${encodeURIComponent(NAME)}&src=${encodeURIComponent(SRC)}`)
    expect(f.seen[2]).toMatchObject({ method: 'GET', url: '/api/streams' })
  })

  it('leaves a stream alone when go2rtc already has it from the same source (a second PUT would start a second camera connection)', async () => {
    const f = await startGo2rtc(200, true)
    const c = new Go2rtcClient(f.base)
    await c.register(NAME, SRC)
    await c.register(NAME, SRC)
    await c.register(NAME, SRC)
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(1)
  })

  it('registers again when the source has changed (a new password), and when the stream is gone (go2rtc restarted)', async () => {
    const f = await startGo2rtc(400, true)
    const c = new Go2rtcClient(f.base)
    await c.register(NAME, SRC)
    await c.register(NAME, SRC + 'x')
    expect(f.streams.get(NAME)).toBe(SRC + 'x')
    f.streams.clear()
    await c.register(NAME, SRC + 'x')
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(3)
  })

  it('with keepExisting leaves any stream of that name alone (go2rtc lists a running generated source without its address)', async () => {
    const f = await startGo2rtc(200, true)
    f.streams.set(NAME, 'something else')
    const c = new Go2rtcClient(f.base)
    await c.register(NAME, SRC, { keepExisting: true })
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(0)
    await c.register('cam_other_sub', SRC, { keepExisting: true }) // not there yet: registered
    expect(f.streams.get('cam_other_sub')).toBe(SRC)
  })

  it('reads a producer address only from the url field, and copes with producers that have none', async () => {
    const f = await startFake((req, res) => {
      if (req.method === 'GET') return void res.end(JSON.stringify({ [NAME]: { producers: [{ id: 1, source: SRC }, null, 5, {}], consumers: [] } }))
      res.statusCode = 200
      res.end()
    })
    await expect(new Go2rtcClient(f.base).register(NAME, SRC)).resolves.toBeUndefined()
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(1) // the source field is not trusted as the address
  })

  it('does not register when it cannot read the list, with the plain message', async () => {
    const f = await startGo2rtc(200, true, { listStatus: 500 })
    const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))
    expect(m).toBe(PLAIN)
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(0)
  })

  it('carries a source with spaces, braces and an ampersand intact', async () => {
    const f = await startGo2rtc(200, true)
    const odd = 'ffmpeg:virtual?video=testsrc&size=640x360#video=h264 {x}'
    await new Go2rtcClient(f.base).register(NAME, odd)
    const put = f.seen.find((s) => s.method === 'PUT')!
    expect(put.query.get('src')).toBe(odd)
    expect(put.query.get('size')).toBeNull()
  })

  it('tolerates a trailing slash on the base address', async () => {
    const f = await startGo2rtc(200, true)
    await new Go2rtcClient(`${f.base}/`).register(NAME, SRC)
    expect(f.seen.every((s) => s.url === '/api/streams')).toBe(true)
    expect(f.seen.some((s) => s.method === 'PUT')).toBe(true)
  })

  it('accepts a 400 answer when the stream is there afterwards (read-only config: applied in memory, not saved)', async () => {
    const f = await startGo2rtc(400, true)
    await new Go2rtcClient(f.base).register(NAME, SRC)
    expect(f.streams.get(NAME)).toBe(SRC)
    expect(f.seen.map((s) => s.method)).toEqual(['GET', 'PUT', 'GET'])
  })

  it('throws the plain message, without the address or the source, when go2rtc answers 400 and the stream is not there', async () => {
    const f = await startGo2rtc(400, false)
    const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))
    expect(m).toBe(PLAIN)
    expectNoLeak(m, f.base)
  })

  it('throws the plain message when a 2xx answer is not borne out by the list', async () => {
    const f = await startGo2rtc(200, false)
    expect(await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))).toBe(PLAIN)
  })

  it('throws the plain message on a 4xx/5xx other than 400, even if a stream of that name was already there (from another source), without reading the list again', async () => {
    for (const status of [401, 404, 500, 503]) {
      const f = await startGo2rtc(status, false)
      f.streams.set(NAME, 'old')
      const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))
      expect(m, String(status)).toBe(PLAIN)
      expectNoLeak(m, f.base)
      expect(f.seen.map((s) => s.method), String(status)).toEqual(['GET', 'PUT'])
    }
  })

  it('throws the plain message when the list cannot be read back after a 400', async () => {
    const f = await startGo2rtc(400, true, { listStatus: 500 })
    const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))
    expect(m).toBe(PLAIN)
    expectNoLeak(m, f.base)
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
    const fetchImpl = (async (_u: string, i?: RequestInit) => { init ??= i; return new Response(JSON.stringify({ [NAME]: {} })) }) as unknown as typeof fetch
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

  it('refuses an answer bigger than 1 MB, whether or not it says how long it is', async () => {
    const big = JSON.stringify({ [NAME]: 'x'.repeat(1024 * 1024 + 10) })
    const declared = await startFake((_q, res) => { res.setHeader('content-length', String(big.length)); res.end(big) })
    const m1 = await messageOf(new Go2rtcClient(declared.base).has(NAME))
    expect(m1).toBe('The video server did not answer.')
    const chunked = await startFake((_q, res) => { res.write(big.slice(0, 600_000)); res.write(big.slice(600_000)); res.end() })
    expect(await messageOf(new Go2rtcClient(chunked.base).has(NAME))).toBe('The video server did not answer.')
    // A body that lies about being small is still capped while it is read.
    const lying = (async () => new Response(big, { headers: { 'content-length': '10' } })) as unknown as typeof fetch
    expect(await messageOf(new Go2rtcClient('http://127.0.0.1:1984', lying).has(NAME))).toBe('The video server did not answer.')
  })

  it('reads an answer just under the cap', async () => {
    const body = JSON.stringify({ [NAME]: 'x'.repeat(900 * 1024) })
    const f = await startFake((_q, res) => { res.end(body) })
    expect(await new Go2rtcClient(f.base).has(NAME)).toBe(true)
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
  it('sends DELETE /api/streams?src=<name> and reads the list back', async () => {
    const f = await startGo2rtc(200, true)
    f.streams.set(NAME, SRC)
    await new Go2rtcClient(f.base).remove(NAME)
    expect(f.seen[0].method).toBe('DELETE')
    expect(f.seen[0].url).toBe('/api/streams')
    expect(f.seen[0].rawQuery).toBe(`?src=${encodeURIComponent(NAME)}`)
    expect(f.seen[1].method).toBe('GET')
  })

  it('accepts a 400 answer when the stream is gone afterwards (read-only config)', async () => {
    const f = await startGo2rtc(400, true)
    f.streams.set(NAME, SRC)
    await new Go2rtcClient(f.base).remove(NAME)
    expect(f.streams.has(NAME)).toBe(false)
  })

  it('throws a plain message when the stream is still listed afterwards (400 or 2xx that changed nothing)', async () => {
    for (const status of [400, 200]) {
      const f = await startGo2rtc(status, false)
      f.streams.set(NAME, SRC)
      const m = await messageOf(new Go2rtcClient(f.base).remove(NAME))
      expect(m, String(status)).toBe('The video server did not remove the stream.')
      expectNoLeak(m, f.base)
    }
  })

  it('throws a plain message on a 4xx/5xx other than 400 or no server, never with the address', async () => {
    const f = await startGo2rtc(500, false)
    const m = await messageOf(new Go2rtcClient(f.base).remove(NAME))
    expect(m).not.toBe('')
    expectNoLeak(m, f.base)
    expect(f.seen.map((s) => s.method)).toEqual(['DELETE'])
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
