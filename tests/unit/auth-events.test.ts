import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emailHash } from '@/lib/auth/auth-events'

// P3-1 review M-4: a typed e-mail address is kept in the sign-in audit only as a KEYED hash (HMAC with a server secret), so a list of
// company addresses cannot be hashed and matched against the table by anyone who reads it.

afterEach(() => vi.unstubAllEnvs())

describe('the e-mail hash of the sign-in audit', () => {
  it('is an HMAC with the server key: stable for one key, different for another, not a plain hash', () => {
    vi.stubEnv('VERIFIED_USER_SECRET', 'k'.repeat(48))
    const a = emailHash('Asha.Rao@CityKart.example')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(emailHash('asha.rao@citykart.example ')).toBe(a)
    expect(a).not.toBe(createHash('sha256').update('asha.rao@citykart.example').digest('hex'))
    expect(a).not.toBe(createHash('sha256').update('drishti-auth-event-v1\u0000asha.rao@citykart.example').digest('hex'))
    vi.stubEnv('VERIFIED_USER_SECRET', 'z'.repeat(48))
    expect(emailHash('asha.rao@citykart.example')).not.toBe(a)
  })
})
