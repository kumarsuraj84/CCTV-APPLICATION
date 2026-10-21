import { describe, expect, it } from 'vitest'
import { buildDigestHeader, DigestInputError, DigestUnsupportedError, digestFetch, parseDigestChallenge } from '@/lib/nvr/digest'
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

describe('several challenges in one header', () => {
  const D = 'Digest realm="r", nonce="n1", qop="auth", opaque="o"'
  it('finds the Digest challenge whether Basic comes first or last', () => {
    expect(parseDigestChallenge(`Basic realm="x", ${D}`)).toMatchObject({ realm: 'r', nonce: 'n1', qop: 'auth', opaque: 'o' })
    expect(parseDigestChallenge(`${D}, Basic realm="x"`)).toMatchObject({ realm: 'r', nonce: 'n1', qop: 'auth', opaque: 'o' })
    expect(parseDigestChallenge(`Negotiate, Basic realm="x", ${D}`)).toMatchObject({ realm: 'r', nonce: 'n1' })
  })
  it('skips an unusable Digest challenge for a usable one', () => {
    expect(parseDigestChallenge('Digest realm="a", nonce="s", algorithm=SHA-256, Digest realm="b", nonce="m", algorithm=MD5')).toMatchObject({ realm: 'b', nonce: 'm' })
    expect(parseDigestChallenge('Digest realm="a", nonce="s", qop="auth-int", Digest realm="b", nonce="m", qop="auth"')).toMatchObject({ realm: 'b', nonce: 'm' })
  })
  it('does not split on commas inside quoted values', () => {
    expect(parseDigestChallenge('Digest realm="shop, Basic office", nonce="n"')).toMatchObject({ realm: 'shop, Basic office', nonce: 'n' })
    expect(parseDigestChallenge('Basic realm="a, Digest realm=\\"b\\", nonce=\\"c\\""')).toBeNull()
  })
  it('gives nothing when only unusable methods are offered', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
    expect(parseDigestChallenge('Basic realm="x", Bearer realm="y"')).toBeNull()
    expect(parseDigestChallenge('Digest realm="x", nonce="n", algorithm=SHA-256')).toBeNull()
    expect(parseDigestChallenge('')).toBeNull()
  })
})

describe('values that cannot go into a header', () => {
  it('rejects quotes, backslashes and control characters in a challenge', () => {
    expect(parseDigestChallenge('Digest realm="a\\"b", nonce="n"')).toBeNull()
    expect(parseDigestChallenge('Digest realm="a", nonce="n\\x"')).toBeNull()
    expect(parseDigestChallenge('Digest realm="a", nonce="n", opaque="o\u0007"')).toBeNull()
  })
  it('refuses to build a header from unsafe values and never echoes them', () => {
    const challenge = { realm: 'r', nonce: 'n', qop: 'auth' as const, opaque: null, algorithm: 'MD5' as const }
    const base = { password: 'p', method: 'GET', uri: '/' }
    for (const username of ['vi"ewer', 'vi\\ewer', 'vi\r\nX-Evil: 1', 'vi\u0000ewer', 'vi\u007fewer']) {
      expect(() => buildDigestHeader(challenge, { ...base, username })).toThrow(DigestInputError)
      try {
        buildDigestHeader(challenge, { ...base, username })
      } catch (e) {
        expect(String(e)).not.toContain('ewer')
      }
    }
    expect(() => buildDigestHeader({ ...challenge, nonce: 'n"x' }, { ...base, username: 'u' })).toThrow(DigestInputError)
    expect(() => buildDigestHeader({ ...challenge, realm: 'r\ny' }, { ...base, username: 'u' })).toThrow(DigestInputError)
    expect(() => buildDigestHeader({ ...challenge, opaque: 'o"' }, { ...base, username: 'u' })).toThrow(DigestInputError)
  })
  it('digestFetch refuses an unsafe user name before sending anything', async () => {
    const nvr = await startFakeNvr()
    await expect(digestFetch(`http://127.0.0.1:${nvr.port}/x`, { username: 'a"b', password: 'p' })).rejects.toBeInstanceOf(DigestInputError)
    expect(nvr.requests).toEqual([])
    await nvr.close()
  })
})

describe('digestFetch never sends the password in clear', () => {
  const url = (port: number) => `http://127.0.0.1:${port}/ISAPI/ContentMgmt/InputProxy/channels/status`
  const creds = { username: 'viewer', password: 'secret-pass' }

  it('sends nothing to a server that offers only Basic', async () => {
    const nvr = await startFakeNvr({ challenge: 'basic-only' })
    await expect(digestFetch(url(nvr.port), creds)).rejects.toBeInstanceOf(DigestUnsupportedError)
    expect(nvr.requests).toHaveLength(1)
    expect(nvr.authorizations).toEqual([])
    await nvr.close()
  })
  it('sends nothing to a server that offers only SHA-256', async () => {
    const nvr = await startFakeNvr({ challenge: 'sha256-only' })
    await expect(digestFetch(url(nvr.port), creds)).rejects.toBeInstanceOf(DigestUnsupportedError)
    expect(nvr.authorizations).toEqual([])
    await nvr.close()
  })
  it.each(['basic-then-digest', 'digest-then-basic'] as const)('answers the Digest challenge when Basic is offered too (%s)', async (challenge) => {
    const nvr = await startFakeNvr({ challenge, statuses: { 1: true } })
    const res = await digestFetch(url(nvr.port), creds)
    expect(res.status).toBe(200)
    expect(nvr.authorizations).toHaveLength(1)
    expect(nvr.authorizations[0]).toMatch(/^Digest /)
    expect(nvr.authorizations.join('\n')).not.toMatch(/Basic/i)
    await nvr.close()
  })
  it('is bounded by a signal passed in', async () => {
    const nvr = await startFakeNvr({ mode: 'slow' })
    await expect(digestFetch(url(nvr.port), { ...creds, signal: AbortSignal.timeout(200) })).rejects.toMatchObject({ name: 'TimeoutError' })
    await nvr.close()
  })
})

describe('the fake NVR checks the uri', () => {
  it('rejects a login that was computed for another uri', async () => {
    const nvr = await startFakeNvr({ statuses: { 1: true } })
    const path = '/ISAPI/ContentMgmt/InputProxy/channels/status'
    const first = await fetch(`http://127.0.0.1:${nvr.port}${path}`)
    const challenge = parseDigestChallenge(first.headers.get('www-authenticate')!)!
    const wrong = buildDigestHeader(challenge, { username: 'viewer', password: 'secret-pass', method: 'GET', uri: '/ISAPI/Other' })
    expect((await fetch(`http://127.0.0.1:${nvr.port}${path}`, { headers: { Authorization: wrong } })).status).toBe(401)
    const right = buildDigestHeader(challenge, { username: 'viewer', password: 'secret-pass', method: 'GET', uri: path })
    expect((await fetch(`http://127.0.0.1:${nvr.port}${path}`, { headers: { Authorization: right } })).status).toBe(200)
    await nvr.close()
  })
})
