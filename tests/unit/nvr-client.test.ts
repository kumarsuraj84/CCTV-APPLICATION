import { inspect } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { describeNvrError, MAX_RESPONSE_BYTES, NvrClient, NvrError } from '@/lib/nvr/client'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

let nvr: FakeNvr | null = null
afterEach(async () => {
  await nvr?.close()
  nvr = null
})
const client = (port: number, password = 'secret-pass', timeoutMs = 2000) => new NvrClient({ host: '127.0.0.1', port, username: 'viewer', password }, { timeoutMs })

describe('NvrClient', () => {
  it('reads channel status and channels', async () => {
    nvr = await startFakeNvr({ statuses: { 1: true, 2: false }, channels: [{ channel: 1, name: 'Door', ip: '192.0.2.11' }, { channel: 2, name: 'Till' }] })
    const c = client(nvr.port)
    expect([...(await c.channelStatus())]).toEqual([[1, true], [2, false]])
    expect(await c.channels()).toEqual([{ channel: 1, name: 'Door', ip: '192.0.2.11' }, { channel: 2, name: 'Till', ip: null }])
  })
  it('reports a wrong password as an auth problem', async () => {
    nvr = await startFakeNvr()
    await expect(client(nvr.port, 'wrong').channelStatus()).rejects.toMatchObject({ kind: 'auth' })
  })
  it('reports a user who may not read as forbidden', async () => {
    nvr = await startFakeNvr({ mode: 'forbidden' })
    await expect(client(nvr.port).channelStatus()).rejects.toMatchObject({ kind: 'forbidden' })
  })
  it('reports an unreachable NVR and a slow one', async () => {
    await expect(client(await closedPort()).channelStatus()).rejects.toMatchObject({ kind: 'unreachable' })
    nvr = await startFakeNvr({ mode: 'slow' })
    await expect(client(nvr.port, 'secret-pass', 300).channelStatus()).rejects.toMatchObject({ kind: 'timeout' })
  })
  it('reports a page that is not ISAPI XML as a bad response', async () => {
    nvr = await startFakeNvr({ mode: 'garbage' })
    await expect(client(nvr.port).channelStatus()).rejects.toMatchObject({ kind: 'bad_response' })
  })
  it('falls back to the older channel list when the newer one is missing', async () => {
    nvr = await startFakeNvr({ channels: [{ channel: 7, name: 'Yard' }], inputProxy: 'missing' })
    expect(await client(nvr.port).channels()).toEqual([{ channel: 7, name: 'Yard', ip: null }])
    expect(nvr.requests).toContain('GET /ISAPI/ContentMgmt/InputProxy/channels')
    expect(nvr.requests).toContain('GET /ISAPI/System/Video/inputs/channels')
  })
  it('falls back to the older channel list when the newer one is empty', async () => {
    nvr = await startFakeNvr({ channels: [{ channel: 8, name: 'Dock' }], inputProxy: 'empty' })
    expect(await client(nvr.port).channels()).toEqual([{ channel: 8, name: 'Dock', ip: null }])
    expect(nvr.requests).toContain('GET /ISAPI/System/Video/inputs/channels')
  })
  it('does not ask the older list when the newer one answers', async () => {
    nvr = await startFakeNvr({ channels: [{ channel: 1, name: 'Door' }] })
    await client(nvr.port).channels()
    expect(nvr.requests.some((r) => r.includes('/System/Video'))).toBe(false)
  })
  it('does not fall back after a login problem', async () => {
    nvr = await startFakeNvr()
    await expect(client(nvr.port, 'wrong').channels()).rejects.toMatchObject({ kind: 'auth' })
    expect(nvr.requests.some((r) => r.includes('/System/Video'))).toBe(false)
  })
  it('reports two empty channel lists as a bad response', async () => {
    nvr = await startFakeNvr({ channels: [], inputProxy: 'empty', videoInputs: 'empty' })
    await expect(client(nvr.port).channels()).rejects.toMatchObject({ kind: 'bad_response', reason: 'no_channels' })
    expect(nvr.requests).toContain('GET /ISAPI/System/Video/inputs/channels')
  })
  it('reports an empty status list as a bad response', async () => {
    nvr = await startFakeNvr({ statuses: {} })
    await expect(client(nvr.port).channelStatus()).rejects.toMatchObject({ kind: 'bad_response' })
  })
  it('says what went wrong in plain words', () => {
    expect(describeNvrError(new NvrError('auth', 'x'))).toBe('The NVR refused the user name or password.')
    expect(describeNvrError(new NvrError('forbidden', 'x'))).toBe('The NVR user is not allowed to read camera status.')
    expect(describeNvrError(new NvrError('unreachable', 'x'))).toBe('The NVR did not answer.')
    expect(describeNvrError(new NvrError('timeout', 'x'))).toBe('The NVR took too long to answer.')
    expect(describeNvrError(new NvrError('bad_response', 'x'))).toBe('The NVR gave an answer this app does not understand.')
    expect(describeNvrError(new Error('anything'))).toBe('The NVR check failed.')
    expect(describeNvrError(new NvrError('bad_response', 'x', 'unsupported_login'))).toBe('The NVR does not offer a supported login method.')
    expect(describeNvrError(new NvrError('bad_response', 'x', 'no_channels'))).toBe('The NVR did not list any cameras.')
  })
})

describe('NvrClient login methods', () => {
  it.each(['basic-only', 'sha256-only'] as const)('sends no credentials to an NVR that offers only %s', async (challenge) => {
    nvr = await startFakeNvr({ challenge, statuses: { 1: true } })
    const err = await client(nvr.port).channelStatus().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NvrError)
    expect(err).toMatchObject({ kind: 'bad_response' })
    expect(describeNvrError(err)).toBe('The NVR does not offer a supported login method.')
    expect(nvr.authorizations).toEqual([])
    expect(nvr.requests).toHaveLength(1)
  })
  it('does not ask for the older list when no usable login is offered', async () => {
    nvr = await startFakeNvr({ challenge: 'basic-only' })
    await expect(client(nvr.port).channels()).rejects.toMatchObject({ kind: 'bad_response', reason: 'unsupported_login' })
    expect(nvr.requests).toHaveLength(1)
    expect(nvr.authorizations).toEqual([])
  })
  it.each(['basic-then-digest', 'digest-then-basic'] as const)('logs in with Digest when Basic is offered too (%s)', async (challenge) => {
    nvr = await startFakeNvr({ challenge, statuses: { 1: true } })
    expect([...(await client(nvr.port).channelStatus())]).toEqual([[1, true]])
    expect(nvr.authorizations.every((a) => a.startsWith('Digest '))).toBe(true)
  })
  it('refuses a user name that cannot go into a header before sending anything', async () => {
    nvr = await startFakeNvr()
    const c = new NvrClient({ host: '127.0.0.1', port: nvr.port, username: 'vi"ewer\r\nX: y', password: 'secret-pass' }, { timeoutMs: 1000 })
    const err = await c.channelStatus().catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'bad_response' })
    expect(String(err)).not.toContain('ewer')
    expect(nvr.requests).toEqual([])
  })
})

describe('NvrClient answers that go wrong after the headers', () => {
  it('reports a body that stops as a timeout, as an NvrError', async () => {
    nvr = await startFakeNvr({ mode: 'stall-body', statuses: { 1: true } })
    const t = Date.now()
    const err = await client(nvr.port, 'secret-pass', 300).channelStatus().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NvrError)
    expect(err).toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t).toBeLessThan(1500)
  })
  it('reports a connection cut in the middle of the body as unreachable, as an NvrError', async () => {
    nvr = await startFakeNvr({ mode: 'reset-body', statuses: { 1: true } })
    const err = await client(nvr.port).channelStatus().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NvrError)
    expect(err).toMatchObject({ kind: 'unreachable' })
  })
  it('reports an answer over 1 MB as a bad response', async () => {
    nvr = await startFakeNvr({ mode: 'huge' })
    const err = await client(nvr.port).channelStatus().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NvrError)
    expect(err).toMatchObject({ kind: 'bad_response' })
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024)
  })
  it('reads the same failure from the channel list', async () => {
    nvr = await startFakeNvr({ mode: 'huge' })
    await expect(client(nvr.port).channels()).rejects.toMatchObject({ kind: 'bad_response' })
  })
})

describe('NvrClient deadline', () => {
  it('gives one deadline to a whole operation, not one per request', async () => {
    // Each request is answered 200 ms late. The newer list is missing, so channels() makes four requests (about 800 ms
    // in all). It would finish if every request had its own 500 ms; one 500 ms deadline for the operation stops it.
    nvr = await startFakeNvr({ delayMs: 200, inputProxy: 'missing', channels: [{ channel: 1, name: 'Door' }] })
    const t = Date.now()
    await expect(client(nvr.port, 'secret-pass', 500).channels()).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t).toBeLessThan(500 * 1.8)
  })
  it('lets the same operation finish when the one deadline is long enough', async () => {
    nvr = await startFakeNvr({ delayMs: 100, inputProxy: 'missing', channels: [{ channel: 1, name: 'Door' }] })
    expect((await client(nvr.port, 'secret-pass', 3000).channels()).map((c) => c.channel)).toEqual([1])
  })
  it('a stalled NVR is given up on after about one timeout', async () => {
    nvr = await startFakeNvr({ mode: 'slow' })
    const t = Date.now()
    await expect(client(nvr.port, 'secret-pass', 300).channels()).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t).toBeLessThan(300 * 2)
  })
})

describe('NvrClient keeps the password to itself', () => {
  const PASSWORD = 'Sup3r-S3cret-pw-4711'
  it('does not show it when the client is logged, serialised or inspected', () => {
    const c = new NvrClient({ host: '127.0.0.1', port: 80, username: 'viewer', password: PASSWORD })
    expect(JSON.stringify(c)).not.toContain(PASSWORD)
    expect(inspect(c, { showHidden: true, depth: 8 })).not.toContain(PASSWORD)
    expect(String(c)).not.toContain(PASSWORD)
    expect(Object.getOwnPropertyNames(c)).not.toContain('ep')
  })
  it('does not show it in errors from failing calls', async () => {
    nvr = await startFakeNvr({ statuses: { 1: true } })
    const cases: NvrClient[] = [
      client(nvr.port, PASSWORD), // wrong password: auth
      client(await closedPort(), PASSWORD), // unreachable
      new NvrClient({ host: 'bad host', port: nvr.port, username: 'viewer', password: PASSWORD }), // bad address
    ]
    for (const c of cases) {
      const err = (await c.channelStatus().catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(NvrError)
      const everything = [String(err), err.stack ?? '', JSON.stringify(err), inspect(err, { showHidden: true, depth: 8 }), describeNvrError(err)].join('\n')
      expect(everything).not.toContain(PASSWORD)
    }
    expect(nvr.authorizations.join('\n')).not.toContain(PASSWORD)
  })
})

describe('NvrClient address checks', () => {
  const badHosts = ['', 'bad host', 'user@host', 'evil.example/path', 'host:80', 'fe80::1%eth0', '-a.example', 'a..example', 'a.example.', 'x'.repeat(300), '[::1]', 'a\r\nb']
  it.each(badHosts)('reports an unusable host as unreachable without connecting (%j)', async (host) => {
    nvr = await startFakeNvr()
    const err = await new NvrClient({ host, port: nvr.port, username: 'viewer', password: 'secret-pass' }, { timeoutMs: 500 }).channelStatus().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NvrError)
    expect(err).toMatchObject({ kind: 'unreachable' })
    expect(nvr.requests).toEqual([])
  })
  it.each([0, -1, 65536, 1.5, Number.NaN])('reports an unusable port as unreachable (%s)', async (port) => {
    const err = await new NvrClient({ host: '127.0.0.1', port, username: 'viewer', password: 'secret-pass' }).channelStatus().catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'unreachable' })
  })
  it('does not throw from the constructor', () => {
    expect(() => new NvrClient({ host: 'bad host', port: 0, username: '', password: '' })).not.toThrow()
  })
  it('does not reject a valid IPv6 address as a bad address', async () => {
    // Nothing listens there; a refused connection ("request failed") shows the address itself was accepted.
    const err = await new NvrClient({ host: '::1', port: await closedPort(), username: 'viewer', password: 'secret-pass' }, { timeoutMs: 1000 }).channelStatus().catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'unreachable', message: 'request failed' })
  })
})
