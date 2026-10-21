import { describe, expect, it } from 'vitest'
import { formatDateTime } from '@/lib/time'

describe('formatDateTime', () => {
  it('shows IST on a 24-hour clock', () => {
    expect(formatDateTime('2026-10-21T05:50:00Z')).toBe('21 Oct 2026, 11:20')
  })
  it('shows midnight as 00 and rolls the date', () => {
    expect(formatDateTime('2026-10-21T18:35:00Z')).toBe('22 Oct 2026, 00:05')
  })
  it('shows a dash for empty or invalid values', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('not a date')).toBe('—')
  })
})
