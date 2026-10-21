import { describe, expect, it } from 'vitest'
import { redact } from '@/lib/observability/logger'

describe('redact', () => {
  it('hides secret-looking keys at any depth', () => {
    const out = redact({ user: 'a', password: 'p', nested: { apiKey: 'k', token: 't', ok: 1 }, list: [{ authorization: 'x' }] })
    expect(out).toEqual({ user: 'a', password: '[redacted]', nested: { apiKey: '[redacted]', token: '[redacted]', ok: 1 }, list: [{ authorization: '[redacted]' }] })
  })
  it('keeps only name and message of an Error', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>
    expect(out).toEqual({ name: 'Error', message: 'boom' })
  })
})
