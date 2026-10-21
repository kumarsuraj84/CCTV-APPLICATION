import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/observability/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, redact: (v: unknown) => v }))

import { sanitizeError } from '@/lib/observability/sanitize-error'

describe('sanitizeError', () => {
  it('maps known database codes to plain messages without echoing driver text', () => {
    const msg = sanitizeError({ code: '23505', message: 'duplicate key value violates unique constraint "stores_org_code_key"' })
    expect(msg).toBe('That already exists. Please check for a duplicate and try again.')
    expect(msg).not.toContain('stores_org_code_key')
  })
  it('maps a permission error', () => {
    expect(sanitizeError({ code: '42501' })).toBe('You do not have permission to perform this action.')
  })
  it('uses the fallback for anything unknown', () => {
    expect(sanitizeError(new Error('secret internals'), { fallback: 'Could not save.' })).toBe('Could not save.')
  })
})
