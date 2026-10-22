import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetTargetsForTest, registerEndpoints } from '@/lib/security/targets'
import { Go2rtcClient, pruneStreams } from '@/lib/streams/go2rtc'
import { probeGo2rtcLogin } from '@/lib/streams/go2rtc-auth'
import { demoSource } from '@/lib/streams/source'
import { closedPort } from '../helpers/fake-servers'

// P2-6 (D-13): go2rtc accepts only sources of registered recorder endpoints; the NVR these tests use is registered as the database
// loaders would register it.
beforeEach(() => {
  forgetTargetsForTest()
  registerEndpoints([{ host: '192.168.1.10', port: 554 }])
})

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
async function startGo2rtc(change: number, applies: boolean, o: { listStatus?: number } = {}): Promise<Fake & { streams: Map<string, string>; watched: Set<string> }> {
  const streams = new Map<string, string>()
  const watched = new Set<string>()
  const entry = (k: string, v: string) => ({ producers: [{ url: v }], consumers: watched.has(k) ? [{ id: 1 }] : null })
  const f = await startFake((req, res, s) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      const one = s.query.get('src')
      if (one !== null) {
        // GET /api/streams?src=<name>: only that stream, 404 when go2rtc does not have it.
        if (o.listStatus) res.statusCode = o.listStatus
        else if (!streams.has(one)) res.statusCode = 404
        return void res.end(streams.has(one) && !o.listStatus ? JSON.stringify(entry(one, streams.get(one)!)) : 'stream not found')
      }
      res.statusCode = o.listStatus ?? 200
      return void res.end(JSON.stringify(Object.fromEntries([...streams].map(([k, v]) => [k, entry(k, v)]))))
    }
    if (applies) {
      if (req.method === 'PUT') streams.set(s.query.get('name') ?? '', s.query.get('src') ?? '')
      else streams.delete(s.query.get('src') ?? '')
    }
    res.statusCode = change
    res.end(`failed for ${SRC} at 127.0.0.1`)
  })
  return Object.assign(f, { streams, watched })
}

describe('Go2rtcClient.register', () => {
  it('looks at that one stream, sends PUT /api/streams with the name and source percent-encoded, then reads that stream back', async () => {
    const f = await startGo2rtc(200, true)
    await new Go2rtcClient(f.base).register(NAME, SRC)
    expect(f.seen.map((s) => s.method)).toEqual(['GET', 'PUT', 'GET'])
    const put = f.seen[1]
    expect(put.url).toBe('/api/streams')
    expect(put.query.get('name')).toBe(NAME)
    expect(put.query.get('src')).toBe(SRC)
    // Encoded on the wire: no raw :// or @ in the query string.
    expect(put.rawQuery).toBe(`?name=${encodeURIComponent(NAME)}&src=${encodeURIComponent(SRC)}`)
    // Never the whole list (it holds every camera's source): only this stream.
    for (const i of [0, 2]) expect(f.seen[i]).toMatchObject({ method: 'GET', url: '/api/streams', rawQuery: `?src=${encodeURIComponent(NAME)}` })
  })

  it('works when the whole list would be far bigger than one megabyte (it is not read)', async () => {
    const f = await startGo2rtc(400, true)
    for (let i = 0; i < 6000; i++) f.streams.set(`cam_${String(i).padStart(36, '0')}_sub`, `rtsp://viewer:${'p'.repeat(200)}@10.0.0.1:554/x`)
    await new Go2rtcClient(f.base).register(NAME, SRC)
    expect(f.streams.get(NAME)).toBe(SRC)
    expect(f.seen.every((s) => s.method !== 'GET' || s.query.has('src'))).toBe(true)
  })

  it('a changed source (password rotation) must be listed with the new source: a 400 that did not apply fails the registration', async () => {
    const f = await startGo2rtc(400, false)
    f.streams.set(NAME, SRC)
    const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC.replace('p%40ss', 'newpass')))
    expect(m).toBe(PLAIN)
    expectNoLeak(m, f.base)
    expect(f.streams.get(NAME)).toBe(SRC) // still the old one: nothing pretended it worked
    const g = await startGo2rtc(400, true)
    g.streams.set(NAME, SRC)
    await new Go2rtcClient(g.base).register(NAME, SRC.replace('p%40ss', 'newpass'))
    expect(g.streams.get(NAME)).toContain('newpass')
  })

  it('requests for the same stream at the same moment share one registration, and the next one starts again', async () => {
    const f = await startGo2rtc(400, true)
    const a = new Go2rtcClient(f.base)
    const b = new Go2rtcClient(f.base)
    await Promise.all([a.register(NAME, SRC), b.register(NAME, SRC), a.register(NAME, SRC)])
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(1)
    expect(f.seen.filter((s) => s.method === 'GET')).toHaveLength(2) // one registration: look, PUT, look
    // A different source for the same name is its own registration.
    await a.register(NAME, SRC + 'a')
    await b.register(NAME, SRC + 'b')
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(3)
    // Failures are shared too, and do not stay behind.
    const bad = await startGo2rtc(500, false)
    const results = await Promise.allSettled([new Go2rtcClient(bad.base).register(NAME, SRC), new Go2rtcClient(bad.base).register(NAME, SRC)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(bad.seen.filter((s) => s.method === 'PUT')).toHaveLength(1)
    await expect(new Go2rtcClient(bad.base).register(NAME, SRC)).rejects.toThrow()
    expect(bad.seen.filter((s) => s.method === 'PUT')).toHaveLength(2)
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
      if (req.method === 'GET') return void res.end(JSON.stringify({ producers: [{ id: 1, source: SRC }, null, 5, {}], consumers: [] }))
      res.statusCode = 200
      res.end()
    })
    // The source field is not trusted as the address, so the stream counts as having another source: it is registered again, and that
    // cannot be confirmed here (the fake never lists a url), which is a failure, as it must be for a source that may not have changed.
    await expect(new Go2rtcClient(f.base).register(NAME, SRC)).rejects.toThrow(PLAIN)
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(1)
  })

  it('does not register when it cannot read the stream first, with the plain message', async () => {
    const f = await startGo2rtc(200, true, { listStatus: 500 })
    const m = await messageOf(new Go2rtcClient(f.base).register(NAME, SRC))
    expect(m).toBe(PLAIN)
    expect(f.seen.filter((s) => s.method === 'PUT')).toHaveLength(0)
  })

  // P2-6 (D-13) replaces "carries a source with spaces, braces and an ampersand intact": an ffmpeg: source with extra text is now refused
  // (only the exact demo picture outside production, and rtsp:// to a registered NVR). What must still arrive intact is a playback source
  // with a query (an ampersand) and the demo picture with its own query.
  it('carries an rtsp playback source with a query, and the demo picture, intact', async () => {
    const f = await startGo2rtc(200, true)
    const playback = 'rtsp://viewer:p%40ss@192.168.1.10:554/Streaming/tracks/301?starttime=20261020T100000Z&endtime=20261020T101000Z'
    await new Go2rtcClient(f.base).register(NAME, playback)
    const put = f.seen.find((s) => s.method === 'PUT')!
    expect(put.query.get('src')).toBe(playback)
    expect(put.query.get('endtime')).toBeNull()
    const demo = demoSource(1, '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a')
    await new Go2rtcClient(f.base).register('cam_0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a_sub', demo)
    expect(f.seen.filter((s) => s.method === 'PUT').at(-1)!.query.get('src')).toBe(demo)
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

  it('throws the plain message when a 2xx answer is not borne out by what is read back', async () => {
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

  it('throws the plain message when the stream cannot be read back after a 400', async () => {
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
    const fetchImpl = (async (_u: string, i?: RequestInit) => { init ??= i; return new Response(JSON.stringify({ producers: [{ url: SRC }] })) }) as unknown as typeof fetch
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
  it('reads GET /api/streams?src=<name>: present on 200, absent on 404', async () => {
    const f = await startGo2rtc(200, true)
    f.streams.set(NAME, SRC)
    const c = new Go2rtcClient(f.base)
    expect(await c.has(NAME)).toBe(true)
    expect(await c.has('cam_other_sub')).toBe(false)
    expect(f.seen[0]).toMatchObject({ method: 'GET', url: '/api/streams', rawQuery: `?src=${encodeURIComponent(NAME)}` })
  })

  it('does not call out for a name that is not a plain identifier', async () => {
    const f = await startGo2rtc(200, true)
    const c = new Go2rtcClient(f.base)
    for (const name of ['', 'a b', '../x', 'a&src=b']) expect(await c.has(name), name).toBe(false)
    expect(f.seen).toHaveLength(0)
  })

  it('throws a plain message for a broken answer', async () => {
    for (const body of ['not json', '[]', 'null', '"x"']) {
      const f = await startFake((_q, res) => { res.end(body) })
      const m = await messageOf(new Go2rtcClient(f.base).has(NAME))
      expect(m, body).not.toBe('')
      expectNoLeak(m, f.base)
    }
  })

  it('refuses a stream entry bigger than 1 MB, whether or not it says how long it is', async () => {
    const big = JSON.stringify({ producers: [{ url: 'x'.repeat(1024 * 1024 + 10) }] })
    const declared = await startFake((_q, res) => { res.setHeader('content-length', String(big.length)); res.end(big) })
    expect(await messageOf(new Go2rtcClient(declared.base).has(NAME))).toBe('The video server did not answer.')
    const chunked = await startFake((_q, res) => { res.write(big.slice(0, 600_000)); res.write(big.slice(600_000)); res.end() })
    expect(await messageOf(new Go2rtcClient(chunked.base).has(NAME))).toBe('The video server did not answer.')
    // A body that lies about being small is still capped while it is read.
    const lying = (async () => new Response(big, { headers: { 'content-length': '10' } })) as unknown as typeof fetch
    expect(await messageOf(new Go2rtcClient('http://127.0.0.1:1984', lying).has(NAME))).toBe('The video server did not answer.')
  })

  it('reads an entry just under the cap', async () => {
    const body = JSON.stringify({ producers: [{ url: 'x'.repeat(900 * 1024) }] })
    const f = await startFake((_q, res) => { res.end(body) })
    expect(await new Go2rtcClient(f.base).has(NAME)).toBe(true)
  })

  it('throws a plain message on a non-2xx, non-404 answer or no server', async () => {
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
    expect(f.seen[1]).toMatchObject({ method: 'GET', rawQuery: `?src=${encodeURIComponent(NAME)}` })
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

describe('pruneStreams', () => {
  const id = (n: number) => `${'0'.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
  const cam = (n: number, kind = 'sub') => `cam_${id(n)}_${kind}`
  const MIN = 60_000
  const T0 = 1_000_000_000_000
  const none = { everyMs: 0 }

  it('first sees a stream (the clock starts), then removes it once it has been idle long enough', async () => {
    const f = await startGo2rtc(400, true)
    f.streams.set(cam(1), SRC)
    f.streams.set(`pb_${id(2)}_1760000000`, SRC)
    const c = new Go2rtcClient(f.base)
    expect(await pruneStreams(c, { now: T0, idleMs: 30 * MIN, ...none })).toBe(0)
    expect(f.streams.size).toBe(2)
    expect(await pruneStreams(c, { now: T0 + 29 * MIN, idleMs: 30 * MIN, ...none })).toBe(0)
    expect(await pruneStreams(c, { now: T0 + 31 * MIN, idleMs: 30 * MIN, ...none })).toBe(2)
    expect(f.streams.size).toBe(0)
  })

  it('never removes a stream somebody is watching, and watching restarts its clock', async () => {
    const f = await startGo2rtc(400, true)
    f.streams.set(cam(1), SRC)
    f.watched.add(cam(1))
    const c = new Go2rtcClient(f.base)
    await pruneStreams(c, { now: T0, ...none })
    expect(await pruneStreams(c, { now: T0 + 5 * 60 * MIN, ...none })).toBe(0)
    f.watched.clear() // the viewer leaves: idle time counts from the last time it was seen watched
    expect(await pruneStreams(c, { now: T0 + 5 * 60 * MIN + 10 * MIN, ...none })).toBe(0)
    expect(await pruneStreams(c, { now: T0 + 5 * 60 * MIN + 31 * MIN, ...none })).toBe(1)
  })

  it('never removes a name that is not one of ours', async () => {
    const f = await startGo2rtc(400, true)
    const foreign = ['camera1', 'cam_x_sub', 'cam_' + id(1), `cam_${id(1)}_other`, `cam_${id(1)}_sub_extra`, `xcam_${id(1)}_sub`, `pb_${id(1)}_sub1`, 'main', 'cam_ABCDEFAB-0000-4000-8000-000000000001_sub']
    for (const n of foreign) f.streams.set(n, SRC)
    f.streams.set(cam(3, 'main'), SRC)
    const c = new Go2rtcClient(f.base)
    await pruneStreams(c, { now: T0, ...none })
    expect(await pruneStreams(c, { now: T0 + 99 * MIN, ...none })).toBe(1)
    expect([...f.streams.keys()].sort()).toEqual([...foreign].sort())
  })

  it('removes at most 50 in one pass (or the given number); the rest wait for the next pass', async () => {
    const f = await startGo2rtc(400, true)
    for (let i = 0; i < 120; i++) f.streams.set(cam(i), SRC)
    const c = new Go2rtcClient(f.base)
    await pruneStreams(c, { now: T0, ...none })
    expect(await pruneStreams(c, { now: T0 + 40 * MIN, ...none })).toBe(50)
    expect(f.streams.size).toBe(70)
    expect(await pruneStreams(c, { now: T0 + 41 * MIN, max: 5, ...none })).toBe(5)
    expect(f.streams.size).toBe(65)
  })

  it('a stream registered again meanwhile is not idle', async () => {
    const f = await startGo2rtc(400, true)
    f.streams.set(cam(1), SRC)
    const c = new Go2rtcClient(f.base)
    await pruneStreams(c, { now: T0, ...none })
    await c.register(cam(1), SRC) // used just now (the real clock): the clock for it is restarted
    expect(await pruneStreams(c, { now: Date.now() + 10 * MIN, idleMs: 30 * MIN, ...none })).toBe(0)
    expect(f.streams.has(cam(1))).toBe(true)
  })

  it('runs at most once a minute by default', async () => {
    const f = await startGo2rtc(400, true)
    f.streams.set(cam(1), SRC)
    const c = new Go2rtcClient(f.base)
    await pruneStreams(c, { now: T0 })
    const gets = f.seen.length
    expect(await pruneStreams(c, { now: T0 + 30_000 })).toBe(0)
    expect(f.seen).toHaveLength(gets) // did not even ask
    await pruneStreams(c, { now: T0 + 61_000 })
    expect(f.seen.length).toBeGreaterThan(gets)
  })

  it('ignores failures: no list, a removal that does not work, a list that is too big', async () => {
    const down = await startGo2rtc(400, true, { listStatus: 500 })
    expect(await pruneStreams(new Go2rtcClient(down.base), { now: T0, ...none })).toBe(0)
    const stuck = await startGo2rtc(500, false)
    stuck.streams.set(cam(1), SRC)
    const s = new Go2rtcClient(stuck.base)
    await pruneStreams(s, { now: T0, ...none })
    expect(await pruneStreams(s, { now: T0 + 99 * MIN, ...none })).toBe(0)
    expect(stuck.streams.size).toBe(1)
    const huge = await startFake((_q, res) => { res.setHeader('content-length', String(17 * 1024 * 1024)); res.write('{}'); res.destroy() })
    expect(await pruneStreams(new Go2rtcClient(huge.base), { now: T0, ...none })).toBe(0)
    expect(await new Go2rtcClient('http://127.0.0.1:1984', (async () => new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } })) as unknown as typeof fetch).list().catch((e) => (e as Error).message)).toBe('The video server did not answer.')
  })

  it('reads a list far bigger than the old 1 MB cap (it is capped at 16 MB now)', async () => {
    const f = await startGo2rtc(400, true)
    for (let i = 0; i < 12000; i++) f.streams.set(cam(i), `rtsp://viewer:${'p'.repeat(200)}@10.0.0.1:554/x`)
    const c = new Go2rtcClient(f.base)
    expect((await c.list()).length).toBe(12000)
    await pruneStreams(c, { now: T0, ...none })
    expect(await pruneStreams(c, { now: T0 + 40 * MIN, ...none })).toBe(50)
  })

  it('what list() hands back holds names and whether they are watched, never a source', async () => {
    const f = await startGo2rtc(400, true)
    f.streams.set(cam(1), SRC)
    f.watched.add(cam(1))
    const l = await new Go2rtcClient(f.base).list()
    expect(l).toEqual([{ name: cam(1), busy: true }])
    expect(JSON.stringify(l)).not.toContain('viewer')
  })
})

// P2-6 (D-13, addendum): go2rtc's API is protected by its own credentials (GO2RTC_API_USERNAME / GO2RTC_API_PASSWORD: the go2rtc config
// reads the same two, deploy/go2rtc.yaml), so its stream list — which holds NVR sources with their passwords — is shown to nobody else;
// and only sources this server may use are ever sent (no exec:, echo:, expr:, other ffmpeg: inputs, unregistered or special addresses).
describe('Go2rtcClient: API credentials and sources (P2-6, D-13)', () => {
  const AUTH = { username: 'drishti-app', password: 'g'.repeat(40) }
  const basic = `Basic ${Buffer.from(`${AUTH.username}:${AUTH.password}`).toString('base64')}`

  /** A go2rtc that answers only requests with its credentials (go2rtc 1.9.9 with api.username/password: 401 otherwise). */
  async function lockedGo2rtc() {
    const streams = new Map<string, string>()
    const headers: (string | undefined)[] = []
    const f = await startFake((req, res, s) => {
      headers.push(req.headers.authorization)
      if (req.headers.authorization !== basic) {
        res.statusCode = 401
        return void res.end('Unauthorized')
      }
      if (req.method === 'PUT') streams.set(s.query.get('name') ?? '', s.query.get('src') ?? '')
      res.setHeader('content-type', 'application/json')
      const one = s.query.get('src')
      if (req.method === 'GET' && one !== null) {
        if (!streams.has(one)) res.statusCode = 404
        return void res.end(streams.has(one) ? JSON.stringify({ producers: [{ url: streams.get(one) }], consumers: null }) : 'not found')
      }
      res.end(JSON.stringify(Object.fromEntries([...streams].map(([k, v]) => [k, { producers: [{ url: v }], consumers: null }]))))
    })
    return Object.assign(f, { streams, headers })
  }

  it('sends its credentials with every request; without them the API answers nothing', async () => {
    const f = await lockedGo2rtc()
    await new Go2rtcClient(f.base, undefined, undefined, AUTH).register(NAME, SRC)
    expect(f.streams.get(NAME)).toBe(SRC)
    expect(f.headers.every((h) => h === basic)).toBe(true)
    expect(await messageOf(new Go2rtcClient(f.base, undefined, undefined, null).register('cam_x_sub', SRC))).toBe(PLAIN)
  })

  it('a /api/streams dump holds no credentials for anybody without the API password, and the app never hands a source on', async () => {
    const f = await lockedGo2rtc()
    const c = new Go2rtcClient(f.base, undefined, undefined, AUTH)
    await c.register(NAME, SRC)
    const anonymous = await fetch(`${f.base}/api/streams`)
    const text = await anonymous.text()
    expect(anonymous.status).toBe(401)
    expect(text).not.toContain('viewer')
    expect(text).not.toContain('p%40ss')
    const listed = JSON.stringify(await c.list())
    expect(listed).not.toContain('viewer')
    expect(listed).not.toContain('rtsp://')
    expect(JSON.stringify(await c.inspect(NAME))).not.toContain('rtsp://')
  })

  it.each([
    'exec:ffmpeg -i rtsp://192.168.1.10/x -f rtsp {output}', 'echo:/bin/sh -c id', 'expr:1+1', 'ffmpeg:rtsp://192.168.1.10:554/x',
    'rtsp://viewer:p@192.168.99.99:554/Streaming/Channels/101', 'rtsp://viewer:p@169.254.169.254:554/x', 'rtsp://viewer:p@192.168.1.10:8554/x',
    'http://192.168.1.10/ISAPI/Streaming/channels/101/picture', 'rtsp://viewer:p@192.168.1.10:554/x#raw=-i /etc/passwd',
  ])('refuses %j without any request to go2rtc and with the plain message', async (src) => {
    const f = await startGo2rtc(200, true)
    expect(await messageOf(new Go2rtcClient(f.base).register(NAME, src))).toBe(PLAIN)
    expect(f.seen).toHaveLength(0)
  })

  it('takes its credentials from the environment (both or neither)', async () => {
    const f = await lockedGo2rtc()
    const before = { u: process.env.GO2RTC_API_USERNAME, p: process.env.GO2RTC_API_PASSWORD }
    try {
      process.env.GO2RTC_API_USERNAME = AUTH.username
      process.env.GO2RTC_API_PASSWORD = AUTH.password
      await new Go2rtcClient(f.base).register(NAME, SRC)
      expect(f.streams.get(NAME)).toBe(SRC)
      delete process.env.GO2RTC_API_PASSWORD
      expect(await messageOf(new Go2rtcClient(f.base).register('cam_y_sub', SRC))).toBe(PLAIN) // a user name alone is no credential
    } finally {
      if (before.u === undefined) delete process.env.GO2RTC_API_USERNAME
      else process.env.GO2RTC_API_USERNAME = before.u
      if (before.p === undefined) delete process.env.GO2RTC_API_PASSWORD
      else process.env.GO2RTC_API_PASSWORD = before.p
    }
  })
})

// P2-6 review round 1, I-2 / M-12: in production the login is not optional. The client refuses to work without it, and the start-up
// probe proves that go2rtc itself enforces it (an unauthenticated GET /api/streams must be refused), which also catches a container that
// was never recreated with the login.
describe('go2rtc login required in production (review I-2, M-12)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('production mode without the login: the client refuses before any request', async () => {
    vi.stubEnv('DRISHTI_ENV', 'production')
    const f = await startGo2rtc(200, true)
    expect(() => new Go2rtcClient(f.base, undefined, undefined, null)).toThrow('The video server login is not set up.')
    expect(f.seen).toHaveLength(0)
    expect(() => new Go2rtcClient(f.base, undefined, undefined, { username: 'drishti', password: 'g'.repeat(40) })).not.toThrow()
  })

  it('development keeps working without it (as before)', () => {
    vi.stubEnv('DRISHTI_ENV', '')
    expect(() => new Go2rtcClient('http://127.0.0.1:1984', undefined, undefined, null)).not.toThrow()
  })

  it('the start-up probe passes only when go2rtc refuses a request without the login', async () => {
    const locked = await startFake((_q, res) => { res.statusCode = 401; res.end('Unauthorized') })
    expect(await probeGo2rtcLogin(locked.base)).toEqual({ ok: true })
    const open = await startFake((_q, res) => { res.setHeader('content-type', 'application/json'); res.end('{}') })
    expect(await probeGo2rtcLogin(open.base)).toEqual({ ok: false, error: expect.stringContaining('without its login') })
    expect(await probeGo2rtcLogin(`http://127.0.0.1:${await closedPort()}`)).toEqual({ ok: false, error: expect.stringContaining('could not be reached') })
    // Never a non-loopback go2rtc.
    expect((await probeGo2rtcLogin('http://192.168.1.5:1984')).ok).toBe(false)
  })
})
