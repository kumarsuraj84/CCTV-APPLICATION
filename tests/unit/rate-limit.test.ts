import { describe, expect, it } from 'vitest'
import { isOverLimit, rateLimit, recordEvent } from '@/lib/rate-limit'

describe('rate limit', () => {
  it('allows up to the limit and then blocks', async () => {
    const key = `t1-${Math.random()}`
    for (let i = 0; i < 3; i++) expect((await rateLimit(key, 3, 60_000)).limited).toBe(false)
    expect((await rateLimit(key, 3, 60_000)).limited).toBe(true)
  })

  it('counts only recorded events and can be asked without counting', () => {
    const key = `t2-${Math.random()}`
    expect(isOverLimit(key, 2)).toBe(false)
    expect(recordEvent(key, 60_000)).toBe(1)
    expect(isOverLimit(key, 2)).toBe(false)
    recordEvent(key, 60_000)
    expect(isOverLimit(key, 2)).toBe(true)
  })

  it('treats very long keys safely', async () => {
    const key = 'x'.repeat(500)
    expect((await rateLimit(key, 1, 60_000)).limited).toBe(false)
  })
})
