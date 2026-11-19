import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { rtspDescribe, rtspOk } from '@/lib/rtsp/describe'
import { closedPort, startFakeRtsp, type Running } from '../helpers/fake-servers'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})
const target = (port: number) => ({ host: '127.0.0.1', port, username: 'viewer', password: 'pw', channel: 3, timeoutMs: 1500 })

/** A raw server whose behaviour per connection is given by the test; records what each client sent. */
async function rawServer(onConnection: (s: net.Socket, received: () => string) => void): Promise<Running & { received: string[] }> {
  const sockets = new Set<net.Socket>()
  const received: string[] = []
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString()
      received.push(buf)
    })
    onConnection(s, () => buf)
  })
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  return {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy())
        server.close(() => resolve())
      }),
  }
}

describe('rtsp check', () => {
  it('is ok when the camera answers 200', async () => {
    const s = await startFakeRtsp('open')
    running.push(s)
    expect(await rtspOk(target(s.port))).toBe(true)
    expect(s.requests[0]).toBe('DESCRIBE rtsp://127.0.0.1:' + s.port + '/Streaming/Channels/302 RTSP/1.0')
  })
  it('answers the login challenge with Digest and then succeeds', async () => {
    const s = await startFakeRtsp('needs-auth')
    running.push(s)
    const r = await rtspDescribe(target(s.port))
    expect(r.code).toBe(200)
    expect(r.trace).toHaveLength(2)
    expect(s.requests).toHaveLength(2)
  })
  it('is not ok when the stream is missing or the login is refused', async () => {
    const missing = await startFakeRtsp('refuse')
    const refused = await startFakeRtsp('always-401')
    running.push(missing, refused)
    expect((await rtspDescribe(target(missing.port))).code).toBe(404)
    expect(await rtspOk(target(refused.port))).toBe(false)
  })
  it('gives code 0 when nothing is listening', async () => {
    const r = await rtspDescribe(target(await closedPort()))
    expect(r.code).toBe(0)
    expect(r.trace[0]).toMatch(/refused|failed/i)
  })
})

describe('rtsp check: safety', () => {
  it('never sends the password in clear (no Basic fallback) and keeps it out of the trace', async () => {
    const secret = 'S3cret-Pw!'
    const s = await rawServer((sock, got) => {
      sock.on('data', () => {
        if (!got().includes('\r\n\r\n')) return
        sock.end('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="cam"\r\n\r\n')
      })
    })
    running.push(s)
    const r = await rtspDescribe({ ...target(s.port), password: secret })
    expect(r.code).toBe(401)
    expect(s.received.join('')).not.toMatch(/Authorization/i)
    expect(s.received.join('')).not.toContain(secret)
    expect(s.received.join('')).not.toContain(Buffer.from(`viewer:${secret}`).toString('base64'))
    expect(JSON.stringify(r)).not.toContain(secret)
  })
  it('redacts the password when a camera echoes it back in its status line', async () => {
    const secret = 'S3cret-Pw!'
    const s = await rawServer((sock, got) => {
      sock.on('data', () => {
        if (got().includes('\r\n\r\n')) sock.end(`RTSP/1.0 500 bad ${secret}\r\n\r\n`)
      })
    })
    running.push(s)
    const r = await rtspDescribe({ ...target(s.port), password: secret })
    expect(r.code).toBe(500)
    expect(JSON.stringify(r)).not.toContain(secret)
  })
  it('does not put the credentials in the request line or the URL', async () => {
    const s = await startFakeRtsp('needs-auth')
    running.push(s)
    await rtspDescribe({ ...target(s.port), password: 'zz-secret-zz' })
    expect(s.requests.join('\n')).not.toContain('zz-secret-zz')
    expect(s.requests.join('\n')).not.toContain('@')
  })
  it('refuses an address, port or channel that cannot be right, without connecting', async () => {
    const base = target(1554)
    for (const bad of [
      { host: '2130706433' },
      { host: '0x7f.1' },
      { host: 'user:pw@127.0.0.1' },
      { host: '127.0.0.1/evil' },
      { host: '127.0.0.1\r\nX: y' },
      { host: 'a b' },
      { host: '' },
      { port: 0 },
      { port: 70000 },
      { port: 1.5 },
      { channel: 0 },
      { channel: 4097 },
      { channel: 1.5 },
    ]) {
      const r = await rtspDescribe({ ...base, ...bad })
      expect(r.code).toBe(0)
      expect(r.trace).toEqual(['The camera address is not valid.'])
    }
  })
  it('does not send a user name that could break the header, and says so without echoing it', async () => {
    const s = await startFakeRtsp('needs-auth')
    running.push(s)
    const r = await rtspDescribe({ ...target(s.port), username: 'a"b\r\nX: y' })
    expect(r.code).toBe(401)
    expect(r.trace.join(' ')).not.toContain('X: y')
  })
  it('gives up on an answer that never ends within 64 KB and closes the socket', async () => {
    let closed = false
    const s = await rawServer((sock) => {
      sock.on('close', () => (closed = true))
      sock.on('data', () => sock.write('X'.repeat(100_000))) // no blank line, ever
    })
    running.push(s)
    const r = await rtspDescribe(target(s.port))
    expect(r.code).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(closed).toBe(true)
  })
  it('stops waiting at the deadline for a camera that never answers, and closes the socket', async () => {
    let closed = false
    const s = await rawServer((sock) => sock.on('close', () => (closed = true)))
    running.push(s)
    const started = Date.now()
    const r = await rtspDescribe({ ...target(s.port), timeoutMs: 300 })
    expect(r.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(closed).toBe(true)
  })
  it('keeps the whole check, both requests together, inside one deadline', async () => {
    // The first answer is a Digest challenge; the second request is never answered.
    const s = await rawServer((sock, got) => {
      sock.on('data', () => {
        if (!got().includes('\r\n\r\n')) return
        if (/Authorization:/i.test(got())) return
        sock.write('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="c", nonce="n1"\r\n\r\n')
      })
    })
    running.push(s)
    const started = Date.now()
    const r = await rtspDescribe({ ...target(s.port), timeoutMs: 400 })
    expect(r.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(1500)
  })
  it('never alters the protocol token or the status code when redacting, whatever the password is', async () => {
    const s = await rawServer((sock, got) => {
      sock.on('data', () => {
        if (got().includes('\r\n\r\n')) sock.end('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n')
      })
    })
    running.push(s)
    for (const password of ['200', '1', '0', 'RTSP', 'RTSP/1.0', 'OK', '.']) {
      const r = await rtspDescribe({ ...target(s.port), password })
      // authSent (final fix X round 2, NB-8): a 200 without a challenge was answered before any password was sent.
      expect(r).toEqual({ code: 200, trace: [password === 'OK' ? 'RTSP/1.0 200 ***' : 'RTSP/1.0 200 OK'], authSent: false })
    }
  })
  it('reads a status line that arrives in two pieces', async () => {
    const s = await rawServer((sock, got) => {
      sock.setNoDelay(true)
      sock.on('data', () => {
        if (!got().includes('\r\n\r\n')) return
        sock.write('RTSP/1.0 2')
        setTimeout(() => sock.end('00 OK\r\nCSeq: 1\r\n\r\n'), 40)
      })
    })
    running.push(s)
    expect(await rtspDescribe(target(s.port))).toEqual({ code: 200, trace: ['RTSP/1.0 200 OK'], authSent: false })
  })
  it('uses Digest only, and never Basic, whichever order the camera lists them in', async () => {
    for (const mode of ['needs-auth-basic-first', 'needs-auth-digest-first'] as const) {
      const s = await startFakeRtsp(mode)
      running.push(s)
      const r = await rtspDescribe(target(s.port))
      expect(r.code).toBe(200)
      expect(s.authorizations).toHaveLength(1)
      expect(s.authorizations[0]).toMatch(/^Digest /)
      expect(s.authorizations.join('\n')).not.toMatch(/Basic/i)
      expect(s.authorizations.join('\n')).not.toContain(Buffer.from('viewer:pw').toString('base64'))
    }
  })
  it('is refused when the Digest answer is wrong (the fake checks the answer for real)', async () => {
    const s = await startFakeRtsp('needs-auth')
    running.push(s)
    const r = await rtspDescribe({ ...target(s.port), password: 'not-the-password' })
    expect(r.code).toBe(401)
    expect(s.authorizations).toHaveLength(1)
    expect(JSON.stringify(r)).not.toContain('not-the-password')
  })
  it('keeps the time limit inside 100 ms to 30 s, like the other probes', async () => {
    const s = await rawServer(() => {})
    running.push(s)
    const started = Date.now()
    const r = await rtspDescribe({ ...target(s.port), timeoutMs: 1 })
    const took = Date.now() - started
    expect(r.code).toBe(0)
    expect(took).toBeGreaterThanOrEqual(90) // a 1 ms limit is raised to 100 ms
    expect(took).toBeLessThan(1500)
  })
  it('turns an egress-guard refusal into a plain trace line', async () => {
    const r = await rtspDescribe({ ...target(554), host: '192.0.2.1', timeoutMs: 500 })
    expect(r.code).toBe(0)
    expect(r.trace[0]).toContain('Egress guard')
  })
})
