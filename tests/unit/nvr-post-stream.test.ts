import { afterEach, describe, expect, it } from 'vitest'
import { MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_MS, MAX_REQUEST_BYTES, NvrClient, NvrError } from '@/lib/nvr/client'
import { closedPort, FAKE_DOWNLOAD_BYTES, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

let nvr: FakeNvr | null = null
afterEach(async () => {
  await nvr?.close()
  nvr = null
})
const PATH = '/ISAPI/ContentMgmt/download'
const BODY = "<?xml version='1.0'?><downloadRequest><playbackURI>rtsp://x/y</playbackURI></downloadRequest>"
const client = (port: number, password = 'secret-pass', timeoutMs = 2000) => new NvrClient({ host: '127.0.0.1', port, username: 'viewer', password }, { timeoutMs })

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(parts)
    parts.push(value)
  }
}
const rejection = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)
const waitFor = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('NvrClient.postStream', () => {
  it('has bounded defaults: 30 minutes and 2 GB', () => {
    expect(MAX_DOWNLOAD_MS).toBe(30 * 60_000)
    expect(MAX_DOWNLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('logs in with Digest, posts the XML, and returns the recording bytes as a stream', async () => {
    nvr = await startFakeNvr()
    const stream = await client(nvr.port).postStream(PATH, BODY)
    expect(await readAll(stream)).toEqual(FAKE_DOWNLOAD_BYTES)
    expect(nvr.downloadBodies).toEqual([BODY])
    expect(nvr.posts[0].contentType).toBe('application/xml')
    expect(nvr.authorizations.length).toBeGreaterThan(0)
    expect(nvr.authorizations.every((a) => /^Digest /.test(a))).toBe(true)
  })

  it('never uses Basic: an NVR that offers only Basic is refused before any credential is sent', async () => {
    nvr = await startFakeNvr({ challenge: 'basic-only' })
    const e = await rejection(client(nvr.port).postStream(PATH, BODY))
    expect(e).toMatchObject({ kind: 'bad_response', reason: 'unsupported_login' })
    expect(nvr.authorizations).toEqual([])
  })

  it('refuses a path that is not a plain ISAPI path and a body above 8 KB, with a plain error that does not echo them', async () => {
    nvr = await startFakeNvr()
    const c = client(nvr.port)
    for (const bad of ['/other', '/ISAPI/../x', '/ISAPI/a?b=1', '/ISAPI/a b', 'ISAPI/a', '//ISAPI/a', '/ISAPI/a\\b']) {
      const e = (await rejection(c.postStream(bad, BODY))) as Error
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(NvrError)
      expect(e.message).toBe('Invalid NVR request path.')
    }
    const big = (await rejection(c.postStream(PATH, 'x'.repeat(MAX_REQUEST_BYTES + 1)))) as Error
    expect(big.message).toBe('Invalid NVR request body.')
    expect(nvr.requests).toEqual([])
  })

  it('refuses nonsense limits', async () => {
    nvr = await startFakeNvr()
    for (const o of [{ maxBytes: 0 }, { maxBytes: -1 }, { maxMs: 0 }, { maxMs: Number.NaN }, { maxBytes: Infinity }]) {
      expect(((await rejection(client(nvr.port).postStream(PATH, BODY, o))) as Error).message).toBe('Invalid NVR download limits.')
    }
  })

  describe('errors before the first byte are typed errors of the call', () => {
    it('wrong password: auth; user not allowed: forbidden; nothing listening: unreachable; no answer: timeout', async () => {
      nvr = await startFakeNvr()
      expect(await rejection(client(nvr.port, 'wrong').postStream(PATH, BODY))).toMatchObject({ kind: 'auth' })
      await nvr.close()
      nvr = await startFakeNvr({ mode: 'forbidden' })
      expect(await rejection(client(nvr.port).postStream(PATH, BODY))).toMatchObject({ kind: 'forbidden' })
      expect(await rejection(client(await closedPort()).postStream(PATH, BODY))).toMatchObject({ kind: 'unreachable' })
      await nvr.close()
      nvr = await startFakeNvr({ mode: 'slow' })
      expect(await rejection(client(nvr.port, 'secret-pass', 250).postStream(PATH, BODY))).toMatchObject({ kind: 'timeout' })
    })

    it('an answer that is a document (an XML status) instead of a recording is a bad response', async () => {
      nvr = await startFakeNvr({ download: 'xml' })
      expect(await rejection(client(nvr.port).postStream(PATH, BODY))).toMatchObject({ kind: 'bad_response' })
    })

    it('a Content-Length above the limit is a bad response, and nothing is read', async () => {
      nvr = await startFakeNvr({ downloadBytes: Buffer.alloc(10_000, 3) })
      expect(await rejection(client(nvr.port).postStream(PATH, BODY, { maxBytes: 9_999 }))).toMatchObject({ kind: 'bad_response' })
      expect(await readAll(await client(nvr.port).postStream(PATH, BODY, { maxBytes: 10_000 }))).toHaveLength(10_000)
    })

    it('a redirect is not followed', async () => {
      const seen: RequestInit[] = []
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        seen.push(init)
        return new Response(null, { status: 302, headers: { Location: 'http://evil.example/x' } })
      }) as unknown as typeof fetch
      const c = new NvrClient({ host: '127.0.0.1', port: 1, username: 'viewer', password: 'secret-pass' }, { fetchImpl })
      expect(await rejection(c.postStream(PATH, BODY))).toMatchObject({ kind: 'bad_response' })
      expect(seen).toHaveLength(1)
      expect(seen[0].redirect).toBe('manual')
    })

    it('no error carries the password, the user name, the address or the path', async () => {
      nvr = await startFakeNvr({ download: 'xml' })
      const errors: unknown[] = []
      errors.push(await rejection(client(nvr.port, 'hunter2-password').postStream(PATH, BODY)))
      await nvr.close()
      nvr = await startFakeNvr()
      errors.push(await rejection(client(nvr.port, 'hunter2-password').postStream(PATH, BODY)))
      errors.push(await rejection(client(await closedPort(), 'hunter2-password').postStream(PATH, BODY)))
      for (const e of errors) {
        const text = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`
        expect(text).not.toMatch(/hunter2|viewer|127\.0\.0\.1|ContentMgmt|rtsp:/)
      }
    })
  })

  describe('once the stream has started', () => {
    it('stops at the byte limit with an error and lets go of the NVR', async () => {
      nvr = await startFakeNvr({ download: 'endless' })
      const stream = await client(nvr.port).postStream(PATH, BODY, { maxBytes: 5_000 })
      await expect(readAll(stream)).rejects.toMatchObject({ name: 'NvrError', kind: 'bad_response' })
      await waitFor(() => nvr!.downloadsEnded.count === 1)
    })

    it('stops when the whole-transfer time has passed, although the connection and login were quick', async () => {
      nvr = await startFakeNvr({ download: 'endless' })
      const t0 = Date.now()
      const stream = await client(nvr.port, 'secret-pass', 5000).postStream(PATH, BODY, { maxMs: 400 })
      await expect(readAll(stream)).rejects.toMatchObject({ name: 'NvrError', kind: 'timeout' })
      expect(Date.now() - t0).toBeLessThan(3000)
      await waitFor(() => nvr!.downloadsEnded.count === 1)
    })

    it('the short connection deadline does not cut a transfer that is going well', async () => {
      nvr = await startFakeNvr({ download: 'endless' })
      const stream = await client(nvr.port, 'secret-pass', 150).postStream(PATH, BODY, { maxBytes: 20_000 })
      const reader = stream.getReader()
      let got = 0
      const t0 = Date.now()
      while (Date.now() - t0 < 500) got += (await reader.read()).value?.byteLength ?? 0 // well past the 150 ms deadline
      expect(got).toBeGreaterThan(FAKE_DOWNLOAD_BYTES.length)
      await reader.cancel()
    })

    it('a stalled transfer ends at the whole-transfer time', async () => {
      nvr = await startFakeNvr({ download: 'stall' })
      const stream = await client(nvr.port).postStream(PATH, BODY, { maxMs: 300 })
      await expect(readAll(stream)).rejects.toMatchObject({ kind: 'timeout' })
    })

    it('stops at once when the caller cancels, and the NVR sees the connection end', async () => {
      nvr = await startFakeNvr({ download: 'endless' })
      const gone = new AbortController()
      const stream = await client(nvr.port).postStream(PATH, BODY, { signal: gone.signal })
      const reader = stream.getReader()
      await reader.read()
      gone.abort()
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return
        })(),
      ).rejects.toBeInstanceOf(NvrError)
      await waitFor(() => nvr!.downloadsEnded.count === 1)
    })

    it('stops when the reader cancels the stream, and the NVR sees the connection end', async () => {
      nvr = await startFakeNvr({ download: 'endless' })
      const stream = await client(nvr.port).postStream(PATH, BODY)
      const reader = stream.getReader()
      await reader.read()
      await reader.cancel()
      await waitFor(() => nvr!.downloadsEnded.count === 1)
    })

    it('a caller that is already gone asks the NVR for nothing', async () => {
      nvr = await startFakeNvr()
      const gone = new AbortController()
      gone.abort()
      expect(await rejection(client(nvr.port).postStream(PATH, BODY, { signal: gone.signal }))).toMatchObject({ kind: 'unreachable' })
      expect(nvr.requests).toEqual([])
    })

    it('reads nothing from the NVR until the reader asks (pull by pull)', async () => {
      let reads = 0
      const chunks = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]
      const body = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            reads++
            const next = chunks.shift()
            if (next) c.enqueue(next)
            else c.close()
          },
        },
        { highWaterMark: 0 },
      )
      const fetchImpl = (async () => new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4' } })) as unknown as typeof fetch
      const stream = await new NvrClient({ host: '127.0.0.1', port: 1, username: 'viewer', password: 'p' }, { fetchImpl }).postStream(PATH, BODY)
      await new Promise((r) => setTimeout(r, 50))
      expect(reads).toBe(0)
      const reader = stream.getReader()
      await reader.read()
      await new Promise((r) => setTimeout(r, 50))
      expect(reads).toBeLessThanOrEqual(2)
      await reader.cancel()
    })
  })
})
