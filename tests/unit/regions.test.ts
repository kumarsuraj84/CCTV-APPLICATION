import { describe, expect, it } from 'vitest'
import { normalizeRegion } from '@/lib/import/regions'

describe('normalizeRegion', () => {
  it('makes the same place always look the same', () => {
    expect(normalizeRegion('JH')).toBe('Jharkhand')
    expect(normalizeRegion('Jharkhand')).toBe('Jharkhand')
    expect(normalizeRegion('ASSAM')).toBe('Assam')
    expect(normalizeRegion(' assam ')).toBe('Assam')
  })
  it('keeps short zone codes in capitals', () => {
    expect(normalizeRegion('br')).toBe('BR')
    expect(normalizeRegion('UP')).toBe('UP')
    expect(normalizeRegion('Mp')).toBe('MP')
  })
  it('title-cases longer names', () => {
    expect(normalizeRegion('uttar  pradesh')).toBe('Uttar Pradesh')
  })
  it('returns null for empty values', () => {
    expect(normalizeRegion('')).toBeNull()
    expect(normalizeRegion(undefined)).toBeNull()
  })
})
