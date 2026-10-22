import { afterEach, describe, expect, it } from 'vitest'
import { closedPort, FAKE_DOWNLOAD_BYTES, startFakeNvr, startFakeRtsp, startFakeTcp, type Running } from '../helpers/fake-servers'
import { createHash } from 'node:crypto'
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

  const digestHeader = (challenge: string, user: string, pass: string, method: string, uri: string) => {
    const nonce = /nonce="([^"]+)"/.exec(challenge)![1]
    const md5 = (s: string) => createHash('md5').update(s).digest('hex')
    const nc = '00000001'
    const cnonce = 'abcdef0123456789'
    const response = md5(`${md5(`${user}:fake-nvr:${pass}`)}:${nonce}:${nc}:${cnonce}:auth:${md5(`${method}:${uri}`)}`)
    return `Digest username="${user}", realm="fake-nvr", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}", opaque="op"`
  }
  const login = async (port: number, uri: string, user: string, pass: string) => {
    const first = await fetch(`http://127.0.0.1:${port}${uri}`)
    return fetch(`http://127.0.0.1:${port}${uri}`, { headers: { Authorization: digestHeader(first.headers.get('www-authenticate')!, user, pass, 'GET', uri) } })
  }
  const statusPath = '/ISAPI/ContentMgmt/InputProxy/channels/status'

  it('the fake NVR returns channel statuses after a correct digest login and follows setStatuses', async () => {
    const nvr = await startFakeNvr({ statuses: { 1: true, 2: false } })
    running.push(nvr)
    const res = await login(nvr.port, statusPath, 'viewer', 'secret-pass')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toMatch(/<id>1<\/id>.*?<online>true<\/online>/)
    expect(xml).toMatch(/<id>2<\/id>.*?<online>false<\/online>/)

    nvr.setStatuses({ 1: false, 2: true, 3: true })
    const again = await (await login(nvr.port, statusPath, 'viewer', 'secret-pass')).text()
    expect(again).toMatch(/<id>1<\/id>.*?<online>false<\/online>/)
    expect(again).toMatch(/<id>2<\/id>.*?<online>true<\/online>/)
    expect(again).toContain('<id>3</id>')
    expect(nvr.requests).toContain(`GET ${statusPath}`)
  })

  it('the fake NVR rejects a wrong password and answers 403 / garbage in those modes', async () => {
    const nvr = await startFakeNvr({ statuses: { 1: true } })
    running.push(nvr)
    expect((await login(nvr.port, statusPath, 'viewer', 'wrong-pass')).status).toBe(401)
    expect((await login(nvr.port, statusPath, 'intruder', 'secret-pass')).status).toBe(401)

    const forbidden = await startFakeNvr({ mode: 'forbidden' })
    running.push(forbidden)
    expect((await login(forbidden.port, statusPath, 'viewer', 'secret-pass')).status).toBe(403)

    const garbage = await startFakeNvr({ mode: 'garbage' })
    running.push(garbage)
    expect(await (await login(garbage.port, statusPath, 'viewer', 'secret-pass')).text()).toBe('this is not xml')
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

  const describeRtsp = (port: number, extraHeader = '') =>
    new Promise<string>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => s.write(`DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n${extraHeader}\r\n`))
      s.once('data', (d) => { s.destroy(); resolve(d.toString().split('\r\n')[0]) })
    })

  it('the fake RTSP server: open answers 200, needs-auth asks first and refuses a wrong Digest answer, always-401 never accepts', async () => {
    const open = await startFakeRtsp('open')
    const needsAuth = await startFakeRtsp('needs-auth')
    const always = await startFakeRtsp('always-401')
    running.push(open, needsAuth, always)
    const auth = 'Authorization: Digest username="u", realm="fake-cam", nonce="n", uri="rtsp://x/y", response="r"\r\n'

    expect(await describeRtsp(open.port)).toBe('RTSP/1.0 200 OK')
    expect(await describeRtsp(needsAuth.port)).toBe('RTSP/1.0 401 Unauthorized')
    expect(await describeRtsp(needsAuth.port, auth)).toBe('RTSP/1.0 401 Unauthorized') // an invented Digest answer is checked and refused
    expect(await describeRtsp(always.port)).toBe('RTSP/1.0 401 Unauthorized')
    expect(await describeRtsp(always.port, auth)).toBe('RTSP/1.0 401 Unauthorized')
    expect(needsAuth.requests).toHaveLength(2)
  })
})

describe('fake NVR recording endpoints', () => {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')
  const header = (challenge: string, user: string, pass: string, method: string, signedUri: string, sentUri = signedUri) => {
    const nonce = /nonce="([^"]+)"/.exec(challenge)![1]
    const nc = '00000001'
    const cnonce = 'abcdef0123456789'
    const response = md5(`${md5(`${user}:fake-nvr:${pass}`)}:${nonce}:${nc}:${cnonce}:auth:${md5(`${method}:${signedUri}`)}`)
    return `Digest username="${user}", realm="fake-nvr", nonce="${nonce}", uri="${sentUri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}", opaque="op"`
  }
  const call = async (port: number, method: string, uri: string, body: string | undefined, opts: { user?: string; pass?: string; signedAs?: string; signedMethod?: string } = {}) => {
    const url = `http://127.0.0.1:${port}${uri}`
    const first = await fetch(url, { method, body })
    const auth = header(first.headers.get('www-authenticate')!, opts.user ?? 'viewer', opts.pass ?? 'secret-pass', opts.signedMethod ?? method, opts.signedAs ?? uri, uri)
    return fetch(url, { method, body, headers: { Authorization: auth, 'Content-Type': 'application/xml' } })
  }
  const DOWNLOAD = '/ISAPI/ContentMgmt/download'

  it('POST download asks for a login, then returns the same fixed bytes every time and records the body', async () => {
    const nvr = await startFakeNvr()
    running.push(nvr)
    const unauth = await fetch(`http://127.0.0.1:${nvr.port}${DOWNLOAD}`, { method: 'POST', body: '<x/>' })
    expect(unauth.status).toBe(401)
    expect(nvr.downloadBodies).toEqual([])
    const a = await call(nvr.port, 'POST', DOWNLOAD, '<downloadRequest><playbackURI>one</playbackURI></downloadRequest>')
    expect(a.status).toBe(200)
    const bytesA = Buffer.from(await a.arrayBuffer())
    const b = await call(nvr.port, 'POST', DOWNLOAD, '<downloadRequest><playbackURI>two</playbackURI></downloadRequest>')
    const bytesB = Buffer.from(await b.arrayBuffer())
    expect(bytesA.length).toBeGreaterThan(0)
    expect(bytesA.equals(bytesB)).toBe(true)
    expect(bytesA.toString('latin1')).toBe(FAKE_DOWNLOAD_BYTES.toString('latin1'))
    expect(nvr.downloadBodies).toEqual(['<downloadRequest><playbackURI>one</playbackURI></downloadRequest>', '<downloadRequest><playbackURI>two</playbackURI></downloadRequest>'])
  })

  it.each([
    ['a wrong password', { pass: 'wrong' }],
    ['a wrong user', { user: 'intruder' }],
    ['a Digest answer signed for another path (the uri must equal the request line)', { signedAs: '/ISAPI/ContentMgmt/other' }],
    ['a Digest answer signed for GET', { signedMethod: 'GET' }],
  ])('POST endpoints refuse %s', async (_name, opts) => {
    const nvr = await startFakeNvr()
    running.push(nvr)
    expect((await call(nvr.port, 'POST', DOWNLOAD, '<a/>', opts)).status).toBe(401)
    expect((await call(nvr.port, 'POST', '/ISAPI/ContentMgmt/search', '<a/>', opts)).status).toBe(401)
    expect((await call(nvr.port, 'POST', '/ISAPI/ContentMgmt/record/tracks/101/dailyDistribution', '<a/>', opts)).status).toBe(401)
    expect(nvr.downloadBodies).toEqual([])
    expect(nvr.posts).toEqual([])
  })

  it('POST endpoints refuse any other method, and the old GET endpoints refuse POST', async () => {
    const nvr = await startFakeNvr({ statuses: { 1: true } })
    running.push(nvr)
    for (const path of [DOWNLOAD, '/ISAPI/ContentMgmt/search', '/ISAPI/ContentMgmt/record/tracks/101/dailyDistribution']) {
      for (const method of ['GET', 'PUT', 'DELETE']) expect((await call(nvr.port, method, path, undefined)).status, `${method} ${path}`).toBe(405)
    }
    expect((await call(nvr.port, 'POST', '/ISAPI/ContentMgmt/InputProxy/channels/status', '<a/>')).status).toBe(405)
    expect(nvr.downloadBodies).toEqual([])
  })

  it('search honours searchResultPostion with a page of two and says MORE until the last page', async () => {
    const recordings = [1, 2, 3, 4, 5].map((h) => ({ start: `2026-10-20T0${h}:00:00`, end: `2026-10-20T0${h}:30:00` }))
    const nvr = await startFakeNvr({ recordings })
    running.push(nvr)
    const body = (pos: number) =>
      `<CMSearchDescription><searchID>a</searchID><trackIDList><trackID>101</trackID></trackIDList><timeSpanList><timeSpan><startTime>2026-10-20T00:00:00Z</startTime><endTime>2026-10-21T00:00:00Z</endTime></timeSpan></timeSpanList><maxResults>200</maxResults><searchResultPostion>${pos}</searchResultPostion></CMSearchDescription>`
    const page = async (pos: number) => {
      const text = await (await call(nvr.port, 'POST', '/ISAPI/ContentMgmt/search', body(pos))).text()
      return { starts: [...text.matchAll(/<startTime>([^<]+)</g)].map((m) => m[1]), more: /<responseStatusStrg>MORE</.test(text) }
    }
    expect(await page(0)).toEqual({ starts: ['2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z'], more: true })
    expect(await page(2)).toEqual({ starts: ['2026-10-20T03:00:00Z', '2026-10-20T04:00:00Z'], more: true })
    expect(await page(4)).toEqual({ starts: ['2026-10-20T05:00:00Z'], more: false })
    expect(await page(6)).toEqual({ starts: [], more: false })
  })
})
