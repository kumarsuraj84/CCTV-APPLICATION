import { afterEach, describe, expect, it } from 'vitest'
import { closedPort, startFakeNvr, startFakeRtsp, startFakeTcp, type Running } from '../helpers/fake-servers'
import net from 'node:net'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

describe('fake servers', () => {
  it('the fake NVR asks for a digest login first', async () => {
    const nvr = await startFakeNvr()
    running.push(nvr)
    const res = await fetch(`http://127.0.0.1:${nvr.port}/ISAPI/ContentMgmt/InputProxy/channels/status`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Digest realm="fake-nvr", qop="auth", nonce="[0-9a-f]+"/)
  })

  it('a closed port refuses connections and an open one accepts them', async () => {
    const open = await startFakeTcp()
    running.push(open)
    const gone = await closedPort()
    const connect = (port: number) =>
      new Promise<string>((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port })
        s.once('connect', () => { s.destroy(); resolve('open') })
        s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
      })
    expect(await connect(open.port)).toBe('open')
    expect(await connect(gone)).toBe('ECONNREFUSED')
  })

  it('the fake RTSP server answers DESCRIBE according to its mode', async () => {
    const rtsp = await startFakeRtsp('refuse')
    running.push(rtsp)
    const answer = await new Promise<string>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: rtsp.port }, () => s.write('DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n'))
      s.once('data', (d) => { s.destroy(); resolve(d.toString().split('\r\n')[0]) })
    })
    expect(answer).toBe('RTSP/1.0 404 Not Found')
    expect(rtsp.requests[0]).toContain('DESCRIBE')
  })
})
