import { describe, expect, it } from 'vitest'
import { passwordSchema } from '@/lib/validation/password'

describe('passwordSchema', () => {
  it('accepts a long password with a letter and a number', () => {
    expect(passwordSchema.safeParse('Orange42Tiger').success).toBe(true)
  })
  it('rejects short passwords', () => {
    const r = passwordSchema.safeParse('Ab1')
    expect(r.success).toBe(false)
  })
  it('rejects passwords without a number or without a letter', () => {
    expect(passwordSchema.safeParse('onlyletterslong').success).toBe(false)
    expect(passwordSchema.safeParse('1234567890123').success).toBe(false)
  })
  it('rejects very long passwords', () => {
    expect(passwordSchema.safeParse('a1'.repeat(40)).success).toBe(false)
  })
})
