import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signStreamToken, streamName, TOKEN_LIFETIME_SEC, verifyStreamToken, type StreamClaims } from '@/lib/streams/token'

const SECRET = 'stream-secret-value-0123456789'
const OTHER = 'another-secret-value-9876543210'
const USER = '3f2b8c1e-5a47-4d0e-9b61-0c7d2e8a1f10'
const CAM = '9a1d4e7c-2b36-4f58-8e0a-6c5d3b2a1f09'
const NOW = Date.UTC(2026, 2, 10, 10, 0, 0)
const nowSec = Math.floor(NOW / 1000)

// P2-4 (D-3, AC-14): every token names its media session (sid); the gateway opens exactly that session in the registry.
const SID = '5e0c1d2b-7a3f-4b9e-8c6d-1f2e3a4b5c6d'
const live = (over: Partial<StreamClaims> = {}): StreamClaims => ({ sid: SID, u: USER, c: CAM, k: 'sub', exp: nowSec + TOKEN_LIFETIME_SEC, ...over })
const b64 = (s: string) => Buffer.from(s).toString('base64url')
/** Builds a correctly signed token around any payload text, so tests can reach the shape checks. */
const forge = (payload: unknown, secret = SECRET) => {
  const p = b64(typeof payload === 'string' ? payload : JSON.stringify(payload))
  return `${p}.${createHmac('sha256', secret).update(`stream.v1.${p}`).digest('base64url')}`
}
/** A token made the plain way (no purpose prefix), as another feature using the same secret would make it. */
const rawForge = (payload: unknown, secret = SECRET) => {
  const p = b64(JSON.stringify(payload))
  return `${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`
}

const KEYS = ['STREAM_TOKEN_SECRET']
// Review round 1 (minor): whatever the environment held before this file is put back afterwards (not just deleted).
const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
beforeEach(() => KEYS.forEach((k) => delete process.env[k]))
afterEach(() => KEYS.forEach((k) => (ORIGINAL[k] === undefined ? delete process.env[k] : (process.env[k] = ORIGINAL[k]))))

describe('stream tokens', () => {
  // P2-4 (D-3, AC-14): the connect window drops from 10 minutes to 90 seconds. A token only opens a socket; it is not needed afterwards.
  it('has a 90 second connect window', () => expect(TOKEN_LIFETIME_SEC).toBe(90))

  it('rejects a token without a session id (the old shape), and a malformed one', () => {
    const old: Record<string, unknown> = { ...live() }
    delete old.sid
    expect(verifyStreamToken(forge(old), NOW, SECRET)).toBeNull()
    for (const sid of ['', 'x', SID.toUpperCase(), `${SID}x`, 5, null, [SID]]) {
      expect(verifyStreamToken(forge({ ...live(), sid }), NOW, SECRET), String(sid)).toBeNull()
    }
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb', s: nowSec - 60, e: nowSec }), SECRET), NOW, SECRET)?.sid).toBe(SID)
  })

  it('round-trips the claims', () => {
    const claims = live()
    expect(verifyStreamToken(signStreamToken(claims, SECRET), NOW, SECRET)).toEqual(claims)
  })

  it('round-trips a playback token with its range', () => {
    const claims = live({ k: 'pb', s: nowSec - 3600, e: nowSec })
    expect(verifyStreamToken(signStreamToken(claims, SECRET), NOW, SECRET)).toEqual(claims)
  })

  it('uses the stream_token secret from the environment when none is passed', () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    const t = signStreamToken(live())
    expect(verifyStreamToken(t, NOW)).toEqual(live())
    expect(verifyStreamToken(t, NOW, SECRET)).toEqual(live())
  })

  it('refuses to sign without a secret, and verifies to null without one', () => {
    expect(() => signStreamToken(live())).toThrow('stream_token secret is not set')
    expect(() => signStreamToken(live(), null)).toThrow('stream_token secret is not set')
    expect(() => signStreamToken(live(), '')).toThrow('stream_token secret is not set')
    const t = signStreamToken(live(), SECRET)
    expect(verifyStreamToken(t, NOW)).toBeNull()
    expect(verifyStreamToken(t, NOW, null)).toBeNull()
    expect(verifyStreamToken(t, NOW, '')).toBeNull()
  })

  it('rejects a wrong secret', () => {
    expect(verifyStreamToken(signStreamToken(live(), SECRET), NOW, OTHER)).toBeNull()
  })

  // P2-6 brief item 7 (docs/drishti/runbooks/secret-rotation.md): rotating STREAM_TOKEN_SECRET (web app and gateway together) makes every
  // token signed before it worthless at once, while tokens signed after it work; viewers simply get new tokens on their next renewal.
  it('rotating the stream_token secret invalidates every older token at once', () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    const before = signStreamToken(live())
    expect(verifyStreamToken(before, NOW)).toEqual(live())
    process.env.STREAM_TOKEN_SECRET = OTHER // the rotation
    expect(verifyStreamToken(before, NOW)).toBeNull()
    const after = signStreamToken(live())
    expect(verifyStreamToken(after, NOW)).toEqual(live())
    expect(verifyStreamToken(after, NOW, SECRET)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const [, sig] = signStreamToken(live(), SECRET).split('.')
    const evil = b64(JSON.stringify(live({ c: '11111111-1111-4111-8111-111111111111' })))
    expect(verifyStreamToken(`${evil}.${sig}`, NOW, SECRET)).toBeNull()
  })

  it('rejects a tampered, truncated, padded or empty signature', () => {
    const [p, sig] = signStreamToken(live(), SECRET).split('.')
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    expect(verifyStreamToken(`${p}.${flipped}`, NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(`${p}.${sig.slice(0, -2)}`, NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(`${p}.${sig}AA`, NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(`${p}.`, NOW, SECRET)).toBeNull()
  })

  it('rejects an expired token, including one that expires this very second', () => {
    expect(verifyStreamToken(signStreamToken(live({ exp: nowSec - 1 }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ exp: nowSec }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ exp: nowSec + 1 }), SECRET), NOW, SECRET)).not.toBeNull()
  })

  it('checks expiry against the time given, so a token ages out', () => {
    const t = signStreamToken(live(), SECRET)
    expect(verifyStreamToken(t, NOW + (TOKEN_LIFETIME_SEC - 1) * 1000, SECRET)).not.toBeNull()
    expect(verifyStreamToken(t, NOW + (TOKEN_LIFETIME_SEC + 1) * 1000, SECRET)).toBeNull()
  })

  it('returns null, never throws, for malformed strings', () => {
    const good = signStreamToken(live(), SECRET)
    const [p, sig] = good.split('.')
    const bad: unknown[] = [
      '', '.', '..', 'abc', 'a.b.c', `${good}.x`, `${p}`, `.${sig}`, `${p}.${sig}.`, ' ' + good, good + '\n', `${p}+.${sig}`, `${p}/.${sig}`,
      `${p}=.${sig}`, `${p}.${sig}=`, `${p}.${sig}!`, 'é.é', '\u0000.\u0000', 'x'.repeat(100_000), null, undefined, 42, {}, [], true,
    ]
    for (const t of bad) expect(verifyStreamToken(t as string, NOW, SECRET), String(t).slice(0, 20)).toBeNull()
  })

  it('rejects a signed payload that is not a JSON object', () => {
    for (const payload of ['not json', 'null', '42', '"text"', 'true', '[]', JSON.stringify([live()]), '{', '']) {
      expect(verifyStreamToken(forge(payload), NOW, SECRET), payload).toBeNull()
    }
  })

  it('rejects a signed payload with extra, missing or wrongly typed fields', () => {
    const base = live()
    const cases: Record<string, unknown> = {
      extra: { ...base, admin: true },
      proto: JSON.parse(`{"sid":"${SID}","u":"${USER}","c":"${CAM}","k":"sub","exp":${base.exp},"__proto__":{"x":1}}`),
      noU: { sid: SID, c: CAM, k: 'sub', exp: base.exp },
      noC: { sid: SID, u: USER, k: 'sub', exp: base.exp },
      noK: { sid: SID, u: USER, c: CAM, exp: base.exp },
      noExp: { sid: SID, u: USER, c: CAM, k: 'sub' },
      noSid: { u: USER, c: CAM, k: 'sub', exp: base.exp },
      uNumber: { ...base, u: 5 },
      cNull: { ...base, c: null },
      kNumber: { ...base, k: 1 },
      expString: { ...base, exp: String(base.exp) },
      expNull: { ...base, exp: null },
      expBool: { ...base, exp: true },
      expArray: { ...base, exp: [base.exp] },
    }
    for (const [name, payload] of Object.entries(cases)) expect(verifyStreamToken(forge(payload), NOW, SECRET), name).toBeNull()
  })

  it('rejects non-UUID person or camera ids', () => {
    for (const bad of ['', 'not-a-uuid', '1', CAM.toUpperCase(), CAM.toUpperCase().replace(/-/g, ''), `${CAM.slice(0, 8).toUpperCase()}${CAM.slice(8)}`, `${CAM}x`, `${CAM}\n`, '../../etc/passwd', `${CAM}_sub`]) {
      expect(verifyStreamToken(signStreamToken(live({ c: bad }), SECRET), NOW, SECRET), `c=${bad}`).toBeNull()
      expect(verifyStreamToken(signStreamToken(live({ u: bad }), SECRET), NOW, SECRET), `u=${bad}`).toBeNull()
    }
  })

  it('rejects an unknown kind', () => {
    for (const k of ['admin', '', 'SUB', 'sub ', 'pb2']) {
      expect(verifyStreamToken(forge({ ...live(), k }), NOW, SECRET), k).toBeNull()
    }
  })

  it('rejects non-finite or negative exp', () => {
    // JSON cannot carry NaN or Infinity, so these arrive as null or as an out-of-range literal that parses to Infinity.
    expect(verifyStreamToken(forge(`{"sid":"${SID}","u":"${USER}","c":"${CAM}","k":"sub","exp":1e999}`), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(forge(`{"sid":"${SID}","u":"${USER}","c":"${CAM}","k":"sub","exp":-1e999}`), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ exp: Number.NaN }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ exp: Infinity }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ exp: -5 }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ exp: -5 }), SECRET), -10_000_000, SECRET)).toBeNull()
  })

  it('rejects a non-finite verification time', () => {
    const t = signStreamToken(live(), SECRET)
    expect(verifyStreamToken(t, Number.NaN, SECRET)).toBeNull()
    expect(verifyStreamToken(t, Infinity, SECRET)).toBeNull()
  })

  it('rejects s and e on non-playback kinds', () => {
    for (const k of ['sub', 'main'] as const) {
      expect(verifyStreamToken(signStreamToken(live({ k, s: nowSec - 60, e: nowSec }), SECRET), NOW, SECRET), k).toBeNull()
      expect(verifyStreamToken(signStreamToken(live({ k, s: nowSec - 60 }), SECRET), NOW, SECRET), k).toBeNull()
      expect(verifyStreamToken(signStreamToken(live({ k, e: nowSec }), SECRET), NOW, SECRET), k).toBeNull()
    }
  })

  it('rejects a playback token without s and e', () => {
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb' }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb', s: nowSec - 60 }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb', e: nowSec }), SECRET), NOW, SECRET)).toBeNull()
  })

  it('rejects a playback token with wrongly typed, non-finite or inverted s and e', () => {
    const pb = { ...live({ k: 'pb' }) }
    const cases: Record<string, unknown> = {
      sString: { ...pb, s: '1', e: nowSec },
      eString: { ...pb, s: nowSec - 60, e: String(nowSec) },
      sNull: { ...pb, s: null, e: nowSec },
      eNull: { ...pb, s: nowSec - 60, e: null },
      sInfinity: JSON.parse(`{"sid":"${SID}","u":"${USER}","c":"${CAM}","k":"pb","exp":${pb.exp},"s":-1e999,"e":${nowSec}}`),
      eInfinity: JSON.parse(`{"sid":"${SID}","u":"${USER}","c":"${CAM}","k":"pb","exp":${pb.exp},"s":${nowSec - 60},"e":1e999}`),
      sNegative: { ...pb, s: -10, e: 50 },
      equal: { ...pb, s: nowSec, e: nowSec },
      inverted: { ...pb, s: nowSec, e: nowSec - 60 },
      fractional: { ...pb, s: nowSec - 60.5, e: nowSec },
    }
    for (const [name, payload] of Object.entries(cases)) expect(verifyStreamToken(forge(payload), NOW, SECRET), name).toBeNull()
  })

  it('allows a playback range of exactly 24 hours and rejects anything longer', () => {
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb', s: nowSec - 86400, e: nowSec }), SECRET), NOW, SECRET)).not.toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb', s: nowSec - 86401, e: nowSec }), SECRET), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live({ k: 'pb', s: 0, e: nowSec }), SECRET), NOW, SECRET)).toBeNull()
  })

  it('does not accept a token signed with a different secret even with a valid-looking signature of the same length', () => {
    const t = forge(live(), OTHER)
    expect(t.split('.')[1]).toHaveLength(signStreamToken(live(), SECRET).split('.')[1].length)
    expect(verifyStreamToken(t, NOW, SECRET)).toBeNull()
  })

  it('does not leak the secret or the claims in a thrown error', () => {
    const weak = 'short-secret-15' // 15 characters
    expect(() => signStreamToken(live(), weak)).toThrow('stream_token secret is not set')
    let message = ''
    try {
      signStreamToken(live(), weak)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toContain(weak)
    expect(message).not.toContain(USER)
    expect(message).not.toContain(CAM)
  })

  it('treats a secret shorter than 16 characters as not set, on sign and on verify', () => {
    const fifteen = 'a'.repeat(15)
    const sixteen = 'a'.repeat(16)
    expect(() => signStreamToken(live(), fifteen)).toThrow('stream_token secret is not set')
    expect(verifyStreamToken(signStreamToken(live(), sixteen), NOW, fifteen)).toBeNull()
    expect(verifyStreamToken(signStreamToken(live(), sixteen), NOW, sixteen)).toEqual(live())
    // A token somebody signed with a weak secret is not accepted either.
    expect(verifyStreamToken(forge(live(), fifteen), NOW, fifteen)).toBeNull()
  })

  it('treats a short secret from the environment as not set', () => {
    process.env.STREAM_TOKEN_SECRET = 'a'.repeat(15)
    expect(() => signStreamToken(live())).toThrow('stream_token secret is not set')
    expect(verifyStreamToken(forge(live(), 'a'.repeat(15)), NOW)).toBeNull()
  })

  // P2-4 (AC-14): was 10 minutes + 1; now the 90 second connect window + a minute of clock difference.
  it('enforces the token lifetime: a token valid for longer than 90 seconds (plus a minute of clock difference) is rejected', () => {
    const at = (exp: number) => verifyStreamToken(signStreamToken(live({ exp }), SECRET), NOW, SECRET)
    expect(at(nowSec + 90)).not.toBeNull()
    expect(at(nowSec + 150)).not.toBeNull()
    expect(at(nowSec + 151)).toBeNull()
    expect(at(nowSec + 600)).toBeNull()
    expect(at(nowSec + 86_400)).toBeNull()
    expect(at(nowSec * 1000)).toBeNull() // milliseconds by mistake
  })

  it('does not accept a token signed the plain way (domain separation), even with the right secret', () => {
    expect(verifyStreamToken(rawForge(live()), NOW, SECRET)).toBeNull()
    expect(verifyStreamToken(forge(live()), NOW, SECRET)).toEqual(live())
  })

  it('rejects an over-long token before doing any work', () => {
    const t = signStreamToken(live(), SECRET)
    expect(t.length).toBeLessThanOrEqual(1024)
    expect(verifyStreamToken(t, NOW, SECRET)).not.toBeNull()
    expect(verifyStreamToken(t + 'A'.repeat(1024), NOW, SECRET)).toBeNull()
    const long = forge({ ...live(), pad: 'x'.repeat(1100) })
    expect(long.length).toBeGreaterThan(1024)
    expect(verifyStreamToken(long, NOW, SECRET)).toBeNull()
  })
})

describe('streamName', () => {
  it('names live streams after the camera and the kind', () => {
    expect(streamName({ c: CAM, k: 'sub' })).toBe(`cam_${CAM}_sub`)
    expect(streamName({ c: CAM, k: 'main' })).toBe(`cam_${CAM}_main`)
  })
  it('names playback streams after the camera and the start', () => {
    expect(streamName({ c: CAM, k: 'pb', s: 1773136800 })).toBe(`pb_${CAM}_1773136800`)
  })
  it('refuses an upper-case camera id', () => {
    expect(() => streamName({ c: CAM.toUpperCase(), k: 'sub' })).toThrow()
  })
  it('ignores s for live kinds', () => {
    expect(streamName({ c: CAM, k: 'sub', s: 5 })).toBe(`cam_${CAM}_sub`)
  })
  it('refuses to build a name from anything but a UUID camera, or a playback without a whole-number start', () => {
    expect(() => streamName({ c: 'x&src=rtsp://evil', k: 'sub' })).toThrow()
    expect(() => streamName({ c: CAM, k: 'pb' })).toThrow()
    expect(() => streamName({ c: CAM, k: 'pb', s: 1.5 })).toThrow()
    expect(() => streamName({ c: CAM, k: 'pb', s: -1 })).toThrow()
    expect(() => streamName({ c: CAM, k: 'other' as 'sub' })).toThrow()
  })
})
