import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Go2rtcClient } from '@/lib/streams/go2rtc'

let server: http.Server | null = null
afterEach(async () => {
  await new Promise<void>((r) => (server ? (server.closeAllConnections(), server.close(() => r())) : r()))
  server = null
})

async function client(answer: (name: string) => { status?: number; body?: string }): Promise<Go2rtcClient> {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const a = answer(u.searchParams.get('src') ?? '')
    res.statusCode = a.status ?? 200
    res.setHeader('content-type', 'application/json')
    res.end(a.body ?? '{}')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return new Go2rtcClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
}

describe('Go2rtcClient.inspect', () => {
  it('says a stream that go2rtc does not have is not there and not busy', async () => {
    const c = await client(() => ({ status: 404, body: 'not found' }))
    expect(await c.inspect('pb_x')).toEqual({ present: false, busy: false })
  })

  it('an idle stream (a source that is only an address, nobody watching) is present and not busy', async () => {
    for (const consumers of ['null', '[]']) {
      const c = await client(() => ({ body: `{"producers":[{"url":"rtsp://u:p@h/x"}],"consumers":${consumers}}` }))
      expect(await c.inspect('pb_x')).toEqual({ present: true, busy: false })
    }
  })

  it('a stream with a viewer is busy', async () => {
    const c = await client(() => ({ body: '{"producers":[{"url":"rtsp://u:p@h/x"}],"consumers":[{"id":1}]}' }))
    expect(await c.inspect('pb_x')).toEqual({ present: true, busy: true })
  })

  it('a stream whose source is already connected is busy even before a viewer shows up', async () => {
    const c = await client(() => ({ body: '{"producers":[{"id":3,"url":"rtsp://u:p@h/x","medias":["video, recvonly, H264"]}],"consumers":null}' }))
    expect(await c.inspect('pb_x')).toEqual({ present: true, busy: true })
  })

  it('an answer that cannot be read is an error (the caller treats the stream as busy), and never carries the address', async () => {
    for (const a of [{ status: 500, body: 'rtsp://u:planted@h' }, { body: 'not json' }, { body: '[]' }]) {
      const c = await client(() => a)
      const err = await c.inspect('pb_x').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(String((err as Error).message)).not.toMatch(/planted|rtsp|127\.0\.0\.1/)
    }
    const c = await client(() => ({}))
    await expect(c.inspect('bad name&')).rejects.toThrow()
  })

  it('returns no source address', async () => {
    const c = await client(() => ({ body: '{"producers":[{"url":"rtsp://u:planted@h/x"}],"consumers":null}' }))
    expect(JSON.stringify(await c.inspect('pb_x'))).not.toContain('planted')
  })
})
