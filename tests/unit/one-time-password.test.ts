import { describe, expect, it } from 'vitest'
import { generateOneTimePassword } from '@/lib/admin/users'
import { passwordSchema } from '@/lib/validation/password'

describe('generateOneTimePassword', () => {
  it('has the requested length and mixes letters and digits', () => {
    const p = generateOneTimePassword()
    expect(p).toHaveLength(14)
    expect(p).toMatch(/[A-Z]/)
    expect(p).toMatch(/[a-z]/)
    expect(p).toMatch(/[0-9]/)
  })
  it('never uses look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(generateOneTimePassword()).not.toMatch(/[0O1lI]/)
  })
  it('is different every time and satisfies the password rule', () => {
    const a = generateOneTimePassword()
    const b = generateOneTimePassword()
    expect(a).not.toBe(b)
    expect(passwordSchema.safeParse(a).success).toBe(true)
  })
})
