import { describe, expect, it } from 'vitest'
import { normalizeZone } from '@/lib/import/regions'

describe('normalizeZone', () => {
  it('makes the same place always look the same', () => {
    expect(normalizeZone('JH')).toBe('Jharkhand')
    expect(normalizeZone('Jharkhand')).toBe('Jharkhand')
    expect(normalizeZone('ASSAM')).toBe('Assam')
    expect(normalizeZone(' assam ')).toBe('Assam')
  })
  it('keeps short zone codes in capitals', () => {
    expect(normalizeZone('br')).toBe('BR')
    expect(normalizeZone('UP')).toBe('UP')
    expect(normalizeZone('Mp')).toBe('MP')
  })
  it('title-cases longer names', () => {
    expect(normalizeZone('uttar  pradesh')).toBe('Uttar Pradesh')
  })
  it('returns null for empty values', () => {
    expect(normalizeZone('')).toBeNull()
    expect(normalizeZone(undefined)).toBeNull()
  })
})
