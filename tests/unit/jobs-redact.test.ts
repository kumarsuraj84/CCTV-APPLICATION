import { describe, expect, it } from 'vitest'
import { redactDetails, tokenFingerprint, REDACTED } from '@/lib/jobs/redact'

describe('redactDetails', () => {
  it('replaces secret-looking keys at any depth', () => {
    const out = redactDetails({
      ssid: 'CK-Staff',
      passphrase: 'hunter2',
      nested: { admin_password: 'x', api_key: 'k', token: 't', list: [{ psk: 'p' }, { client_secret: 's' }] },
      credential: { user: 'u' },
      PrivateKey: 'pk',
    })
    expect(out).toEqual({
      ssid: 'CK-Staff',
      passphrase: REDACTED,
      nested: { admin_password: REDACTED, api_key: REDACTED, token: REDACTED, list: [{ psk: REDACTED }, { client_secret: REDACTED }] },
      credential: REDACTED,
      PrivateKey: REDACTED,
    })
  })

  it('keeps references, idempotency keys and supersede keys', () => {
    const v = { passphrase_ref: 'vault:wifi/staff', idempotency_key: 'j:h', supersedes_key: 'wifi:x', lease_fingerprint: 'abcd' }
    expect(redactDetails(v)).toEqual(v)
  })

  it('redacts values that look like bearer tokens or private keys even under harmless keys', () => {
    const out = redactDetails({ note: 'Bearer abc.def.ghi', pem: '-----BEGIN PRIVATE KEY-----\nMII', msg: 'all good' })
    expect(out).toEqual({ note: REDACTED, pem: REDACTED, msg: 'all good' })
  })

  it('never returns the input object (no aliasing)', () => {
    const v = { a: { b: 1 } }
    const out = redactDetails(v)
    expect(out).toEqual(v)
    expect(out).not.toBe(v)
  })
})

describe('tokenFingerprint', () => {
  it('is a short stable hash that does not contain the token', () => {
    const f = tokenFingerprint('lease-secret-123')
    expect(f).toMatch(/^[0-9a-f]{12}$/)
    expect(f).toBe(tokenFingerprint('lease-secret-123'))
    expect(f).not.toBe(tokenFingerprint('lease-secret-124'))
  })
})
