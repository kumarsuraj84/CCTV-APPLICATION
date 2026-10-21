import { describe, expect, it } from 'vitest'
import { buildDigestHeader, digestFetch, parseDigestChallenge } from '@/lib/nvr/digest'
import { startFakeNvr } from '../helpers/fake-servers'

describe('digest challenge', () => {
  it('reads realm, nonce, qop and opaque', () => {
    const c = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')
    expect(c).toEqual({ realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', opaque: '5ccc069c403ebaf9f0171e9517f40e41', algorithm: 'MD5' })
  })
  it('refuses anything that is not Digest with MD5', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
    expect(parseDigestChallenge('Digest realm="x", nonce="n", algorithm=SHA-256')).toBeNull()
    expect(parseDigestChallenge('Digest realm="x", nonce="n", qop="auth-int"')).toBeNull()
    expect(parseDigestChallenge('Digest nonce="n"')).toBeNull()
  })
})

describe('digest header', () => {
  it('matches the worked example of RFC 2617', () => {
    const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!
    const header = buildDigestHeader(challenge, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b' })
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(header).toContain('nc=00000001')
    expect(header).toContain('qop=auth')
  })
})

describe('digestFetch against the fake NVR', () => {
  it('logs in with the right password', async () => {
    const nvr = await startFakeNvr({ statuses: { 1: true } })
    const res = await digestFetch(`http://127.0.0.1:${nvr.port}/ISAPI/ContentMgmt/InputProxy/channels/status`, { username: 'viewer', password: 'secret-pass' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<online>true</online>')
    await nvr.close()
  })
  it('gets 401 with a wrong password', async () => {
    const nvr = await startFakeNvr()
    const res = await digestFetch(`http://127.0.0.1:${nvr.port}/ISAPI/ContentMgmt/InputProxy/channels/status`, { username: 'viewer', password: 'wrong' })
    expect(res.status).toBe(401)
    await nvr.close()
  })
})
