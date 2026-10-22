import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FAST_TOKEN_LIFETIME_SEC, fastStreamName, MAX_FAST_SEC, signFastToken, verifyFastToken, type FastClaims } from '@/lib/streams/fast-token'
import { signStreamToken, verifyStreamToken } from '@/lib/streams/token'

// P4-L2 (decision D-L1): fast playback is opened with a short-lived token signed by the server, bound to ONE person, ONE camera, ONE media
// session of kind playback and one span of recording. It is a different kind of token from the gateway's stream token (its own purpose in
// the signature), so neither can be used in place of the other.

const SECRET = 'stream-secret-value-0123456789'
const OTHER = 'another-secret-value-9876543210'
const USER = '3f2b8c1e-5a47-4d0e-9b61-0c7d2e8a1f10'
const CAM = '9a1d4e7c-2b36-4f58-8e0a-6c5d3b2a1f09'
const SID = '5e0c1d2b-7a3f-4b9e-8c6d-1f2e3a4b5c6d'
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0)
const nowSec = Math.floor(NOW / 1000)
const S = Math.floor(Date.UTC(2026, 9, 22, 14, 30, 0) / 1000)
const claims = (over: Partial<FastClaims> = {}): FastClaims => ({ sid: SID, u: USER, c: CAM, s: S, e: S + 600, exp: nowSec + FAST_TOKEN_LIFETIME_SEC, ...over })
const forge = (payload: unknown, purpose = 'fastpb.v1.', secret = SECRET) => {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${p}.${createHmac('sha256', secret).update(purpose + p).digest('base64url')}`
}

describe('fast playback tokens', () => {
  it('open within 90 seconds, like the gateway tokens (P2-4)', () => expect(FAST_TOKEN_LIFETIME_SEC).toBe(90))

  it('round-trip: person, camera, session and span', () => {
    const t = signFastToken(claims(), SECRET)
    expect(verifyFastToken(t, NOW, SECRET)).toEqual(claims())
  })

  it('a wrong secret, a changed payload, an expired token or one from too far ahead is refused', () => {
    const t = signFastToken(claims(), SECRET)
    expect(verifyFastToken(t, NOW, OTHER)).toBeNull()
    const [p, sig] = t.split('.')
    const changed = Buffer.from(JSON.stringify({ ...claims(), c: '11111111-2222-4333-8444-555555555555' })).toString('base64url')
    expect(verifyFastToken(`${changed}.${sig}`, NOW, SECRET)).toBeNull()
    expect(verifyFastToken(`${p}.${sig}x`, NOW, SECRET)).toBeNull()
    expect(verifyFastToken(signFastToken(claims({ exp: nowSec }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(signFastToken(claims({ exp: nowSec + 3600 }), SECRET), NOW, SECRET)).toBeNull()
  })

  it('a gateway stream token is never a fast token, and a fast token never opens a gateway socket', () => {
    const gw = signStreamToken({ sid: SID, u: USER, c: CAM, k: 'pb', exp: nowSec + 90, s: S, e: S + 600 }, SECRET)
    expect(verifyFastToken(gw, NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signFastToken(claims(), SECRET), NOW, SECRET)).toBeNull()
    // the same payload signed for the stream purpose is still not a fast token
    expect(verifyFastToken(forge(claims(), 'stream.v1.'), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge(claims()), NOW, SECRET)).toEqual(claims())
  })

  it('every field must be there and well formed; nothing else may be', () => {
    const base = claims() as Record<string, unknown>
    for (const k of Object.keys(base)) {
      const less = { ...base }
      delete less[k]
      expect(verifyFastToken(forge(less), NOW, SECRET), `without ${k}`).toBeNull()
    }
    expect(verifyFastToken(forge({ ...base, k: 'pb' }), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge({ ...base, u: USER.toUpperCase() }), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge({ ...base, c: 'camera-1' }), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge({ ...base, sid: 'x' }), NOW, SECRET)).toBeNull()
  })

  it('the span is a positive length of at most 30 minutes', () => {
    expect(MAX_FAST_SEC).toBe(1800)
    expect(verifyFastToken(forge(claims({ e: S })), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge(claims({ e: S - 1 })), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge(claims({ e: S + 1801 })), NOW, SECRET)).toBeNull()
    expect(verifyFastToken(forge(claims({ e: S + 1800 })), NOW, SECRET)).not.toBeNull()
    expect(verifyFastToken(forge(claims({ s: 1.5 })), NOW, SECRET)).toBeNull()
  })

  it('never throws on rubbish, and refuses an over-long token', () => {
    for (const bad of ['', 'a', 'a.b.c', '.', 'x'.repeat(2000), '%%%.%%%']) expect(verifyFastToken(bad, NOW, SECRET)).toBeNull()
    expect(verifyFastToken(signFastToken(claims(), SECRET), Number.NaN, SECRET)).toBeNull()
  })

  it('signing without a usable secret fails loudly (never a fallback key)', () => {
    expect(() => signFastToken(claims(), 'short')).toThrow()
    expect(() => signFastToken(claims(), null)).toThrow()
  })

  it('names its media session stream from the signed claims only: fpb_<camera>_<start>_<end>', () => {
    expect(fastStreamName(claims())).toBe(`fpb_${CAM}_${S}_${S + 600}`)
    expect(() => fastStreamName({ c: 'x', s: S, e: S + 1 })).toThrow()
  })
})
