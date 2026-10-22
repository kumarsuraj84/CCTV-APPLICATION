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

  // P2-6 brief item 7: what a library writes into an error message or a free-text field is masked too (the field name says nothing).
  it('masks NVR sources, Authorization values, JWTs and key fields inside text, error messages included', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYXBwX3dlYiJ9.c2ln'
    const out = JSON.stringify(redact({
      error: new Error('fetch failed for rtsp://admin:Nvr-Pass-9@192.168.20.100:554/Streaming/Channels/101'),
      detail: `Authorization: Basic ZHJpc2h0aTpzZWNyZXQ= and ${jwt}`,
      serviceKey: 'abc', SUPABASE_APP_WEB_KEY: jwt, registryKey: 'k',
    }))
    for (const leak of ['Nvr-Pass-9', 'ZHJpc2h0aTpzZWNyZXQ=', jwt, '"abc"', '"k"']) expect(out).not.toContain(leak)
    expect(out).toContain('192.168.20.100')
  })
})
