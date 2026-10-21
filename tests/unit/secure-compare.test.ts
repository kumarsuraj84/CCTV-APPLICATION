import { describe, expect, it } from 'vitest'
import { secureCompare } from '@/lib/secure-compare'

describe('secureCompare', () => {
  it('is true only for identical strings', () => {
    expect(secureCompare('abc', 'abc')).toBe(true)
    expect(secureCompare('abc', 'abd')).toBe(false)
  })
  it('does not throw on different lengths', () => {
    expect(secureCompare('abc', 'abcd')).toBe(false)
    expect(secureCompare('', 'x')).toBe(false)
  })
})
