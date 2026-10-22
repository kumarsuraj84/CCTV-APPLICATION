import { describe, expect, it } from 'vitest'
import { safeNext } from '@/lib/auth/safe-next'

describe('safeNext', () => {
  it('keeps a same-site path', () => {
    expect(safeNext('/locations/abc?x=1')).toBe('/locations/abc?x=1')
  })
  it('refuses anything that could leave the site', () => {
    expect(safeNext('https://evil.test')).toBe('/home')
    expect(safeNext('//evil.test')).toBe('/home')
    expect(safeNext('/\\evil.test')).toBe('/home')
    expect(safeNext('javascript:alert(1)')).toBe('/home')
  })
  it('refuses control and whitespace characters that the URL parser would strip', () => {
    expect(safeNext('/\t/evil.test')).toBe('/home')
    expect(safeNext('/\n/evil.test')).toBe('/home')
    expect(safeNext('/\r/evil.test')).toBe('/home')
    expect(safeNext('/ /evil.test')).toBe('/home')
    expect(safeNext('/locations\u007f')).toBe('/home')
  })
  it('still allows percent-encoded text', () => {
    expect(safeNext('/locations?q=a%09b')).toBe('/locations?q=a%09b')
  })
  it('never loops back to the login page', () => {
    expect(safeNext('/login?next=/x')).toBe('/home')
  })
  it('uses the fallback for empty input', () => {
    expect(safeNext(null)).toBe('/home')
    expect(safeNext('', '/locations')).toBe('/locations')
  })
})
