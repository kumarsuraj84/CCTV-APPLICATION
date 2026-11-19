import { afterEach, describe, expect, it } from 'vitest'
import { NvrClient, NvrError } from '@/lib/nvr/client'
import { guardNvrClient, LoginTicket, outcomeOfNvrError } from '@/lib/nvr/login-guard'
import type { LoginGate } from '@/lib/nvr/login-policy'
import { rtspDescribe } from '@/lib/rtsp/describe'
import { registerEndpoints } from '@/lib/security/targets'
import { startFakeRtsp, type FakeRtsp } from '../helpers/fake-servers'

// Final fix X round 2 (review I-2, M-4; ruling NB-8): an NVR answer proves or refuses the saved login only when it came after the
// password was actually sent. A 403 or 200 to the first, unauthenticated request (an IP filter, a lock page, another device at that
// address) and a 401 never answered (Basic only, a password a Digest header cannot carry) are "unknown", on the web paths as in the worker.

const challenge = { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", qop="auth", nonce="n1"' } }
/** A fetch that answers each request in turn; `sent` records whether each carried an Authorization header. */
function fakeFetch(answers: { status: number; headers?: Record<string, string>; body?: string }[]) {
  const sent: boolean[] = []
  let i = 0
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(!!(init?.headers as Record<string, string> | undefined)?.Authorization)
    const a = answers[Math.min(i++, answers.length - 1)]
    return new Response(a.body ?? '<x/>', { status: a.status, headers: a.headers })
  }) as typeof fetch
  return { impl, sent }
}
const STATUS = '<InputProxyChannelStatusList><InputProxyChannelStatus><id>1</id><online>true</online></InputProxyChannelStatus></InputProxyChannelStatusList>'
const client = (answers: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(answers)
  return { c: new NvrClient({ host: '127.0.0.1', port: 80, username: 'viewer', password: 'pw' }, { fetchImpl: f.impl }), sent: f.sent }
}

/** A ticket whose reports are recorded instead of sent. */
function ticket() {
  const reports: string[] = []
  const gate: LoginGate = { decision: 'probe', version: 'v', until: null, baselined: false, level: 0, claimed: true }
  const t = new LoginTicket({ rpc: async (_n: string, a: { p_outcome: string }) => { reports.push(a.p_outcome); return { data: [{ applied: true }], error: null } } } as never, 'r1', gate, 'discovery')
  return { t, reports }
}

describe('the NVR client says whether the password was sent', () => {
  it('a real Digest login that works: proven, reported ok', async () => {
    const { c, sent } = client([challenge, { status: 200, body: STATUS }])
    const { t, reports } = ticket()
    await guardNvrClient(c, t).channelStatus()
    expect(sent).toEqual([false, true])
    expect(c.loginProven()).toBe(true)
    expect(reports).toEqual(['ok'])
  })

  it('a 403 to the first request, before any login: not proven, reported unknown (the attempt is given back)', async () => {
    const { c, sent } = client([{ status: 403 }])
    const { t, reports } = ticket()
    const e = await guardNvrClient(c, t).channelStatus().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(NvrError)
    expect((e as NvrError).kind).toBe('forbidden')
    expect((e as NvrError).credentialsSent).toBe(false)
    expect(sent).toEqual([false])
    expect(outcomeOfNvrError(e)).toBe('unknown')
    expect(reports).toEqual(['unknown'])
  })

  it('a 403 after the Digest login: the password was accepted, reported ok', async () => {
    const { c } = client([challenge, { status: 403 }])
    const { t, reports } = ticket()
    const e = await guardNvrClient(c, t).channelStatus().catch((x: unknown) => x)
    expect((e as NvrError).credentialsSent).toBe(true)
    expect(reports).toEqual(['ok'])
  })

  it('a 200 to the first request without any login: the answer is used, but nothing is proven (unknown)', async () => {
    const { c } = client([{ status: 200, body: STATUS }])
    const { t, reports } = ticket()
    expect((await guardNvrClient(c, t).channelStatus()).get(1)).toBe(true)
    expect(c.loginProven()).toBe(false)
    expect(reports).toEqual(['unknown'])
  })

  it('a 401 after the Digest login: refused', async () => {
    const { c } = client([challenge, challenge])
    const { t, reports } = ticket()
    await guardNvrClient(c, t).channelStatus().catch(() => {})
    expect(reports).toEqual(['refused'])
  })
})

describe('the RTSP check says whether the password was sent (review M-4)', () => {
  let rtsp: FakeRtsp | undefined
  afterEach(async () => {
    await rtsp?.close()
    rtsp = undefined
  })

  it('open camera: 200 without any login (authSent false); Digest: authSent true', async () => {
    rtsp = await startFakeRtsp('open')
    registerEndpoints([{ host: '127.0.0.1', port: rtsp.port }])
    expect(await rtspDescribe({ host: '127.0.0.1', port: rtsp.port, username: 'viewer', password: 'pw', channel: 1 })).toMatchObject({ code: 200, authSent: false })
    await rtsp.close()
    rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: 'pw' })
    expect(await rtspDescribe({ host: '127.0.0.1', port: rtsp.port, username: 'viewer', password: 'pw', channel: 1 })).toMatchObject({ code: 200, authSent: true })
    expect(await rtspDescribe({ host: '127.0.0.1', port: rtsp.port, username: 'viewer', password: 'wrong', channel: 1 })).toMatchObject({ code: 401, authSent: true })
  })

  it('a 401 never answered (no Digest offered, or a user name a header cannot carry): authSent false', async () => {
    rtsp = await startFakeRtsp('needs-auth-basic-only' as never)
    expect(await rtspDescribe({ host: '127.0.0.1', port: rtsp.port, username: 'viewer', password: 'pw', channel: 1 })).toMatchObject({ code: 401, authSent: false })
    await rtsp.close()
    rtsp = await startFakeRtsp('needs-auth')
    expect(await rtspDescribe({ host: '127.0.0.1', port: rtsp.port, username: 'vie"wer', password: 'pw', channel: 1 })).toMatchObject({ code: 401, authSent: false })
  })
})
