import { describe, expect, it } from 'vitest'
import { safeNext } from '@/lib/auth/safe-next'

describe('safeNext', () => {
  it('keeps a same-site path', () => {
    expect(safeNext('/stores/abc?x=1')).toBe('/stores/abc?x=1')
  })
  it('refuses anything that could leave the site', () => {
    expect(safeNext('https://evil.test')).toBe('/home')
    expect(safeNext('//evil.test')).toBe('/home')
    expect(safeNext('/\\evil.test')).toBe('/home')
    expect(safeNext('javascript:alert(1)')).toBe('/home')
  })
  it('never loops back to the login page', () => {
    expect(safeNext('/login?next=/x')).toBe('/home')
  })
  it('uses the fallback for empty input', () => {
    expect(safeNext(null)).toBe('/home')
    expect(safeNext('', '/stores')).toBe('/stores')
  })
})
