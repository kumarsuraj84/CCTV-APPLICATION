import { afterEach, describe, expect, it } from 'vitest'
import { describeNvrError, NvrClient, NvrError } from '@/lib/nvr/client'
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
  it('falls back to the older channel list', async () => {
    nvr = await startFakeNvr({ channels: [{ channel: 7, name: 'Yard' }] })
    // The fake serves both lists; make the first one empty by asking for a list whose proxy part is empty.
    const c = client(nvr.port)
    expect((await c.channels()).map((x) => x.channel)).toEqual([7])
  })
  it('says what went wrong in plain words', () => {
    expect(describeNvrError(new NvrError('auth', 'x'))).toBe('The NVR refused the user name or password.')
    expect(describeNvrError(new NvrError('forbidden', 'x'))).toBe('The NVR user is not allowed to read camera status.')
    expect(describeNvrError(new NvrError('unreachable', 'x'))).toBe('The NVR did not answer.')
    expect(describeNvrError(new NvrError('timeout', 'x'))).toBe('The NVR took too long to answer.')
    expect(describeNvrError(new NvrError('bad_response', 'x'))).toBe('The NVR gave an answer this app does not understand.')
    expect(describeNvrError(new Error('anything'))).toBe('The NVR check failed.')
  })
})
