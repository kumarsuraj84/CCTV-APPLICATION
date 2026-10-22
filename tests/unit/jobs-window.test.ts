import { describe, expect, it } from 'vitest'
import { isWindowOpen, validateWindow, parseZonedInstant } from '@/lib/jobs/window'

const at = (iso: string) => Date.parse(iso)

describe('parseZonedInstant', () => {
  it('accepts ISO-8601 instants with Z or an offset', () => {
    expect(parseZonedInstant('2026-11-02T04:30:00Z')).toBe(at('2026-11-02T04:30:00Z'))
    expect(parseZonedInstant('2026-11-02T10:00:00+05:30')).toBe(at('2026-11-02T04:30:00Z'))
    expect(parseZonedInstant('2026-11-02T10:00:00.250+05:30')).toBe(at('2026-11-02T04:30:00.250Z'))
  })

  it('refuses times without a zone and impossible dates', () => {
    expect(parseZonedInstant('2026-11-02T04:30:00')).toBeNull()
    expect(parseZonedInstant('2026-11-02')).toBeNull()
    expect(parseZonedInstant('2026-02-30T04:30:00Z')).toBeNull()
    expect(parseZonedInstant('not a date')).toBeNull()
  })
})

describe('absolute windows', () => {
  const w = { kind: 'absolute' as const, start: '2026-11-02T22:00:00+05:30', end: '2026-11-03T06:00:00+05:30' }

  it('is open from start (inclusive) to end (exclusive)', () => {
    expect(isWindowOpen(w, at('2026-11-02T16:29:59Z'))).toBe(false)
    expect(isWindowOpen(w, at('2026-11-02T16:30:00Z'))).toBe(true)
    expect(isWindowOpen(w, at('2026-11-03T00:29:59Z'))).toBe(true)
    expect(isWindowOpen(w, at('2026-11-03T00:30:00Z'))).toBe(false)
  })

  it('validates zones and order', () => {
    expect(validateWindow(w)).toEqual([])
    expect(validateWindow({ ...w, start: '2026-11-02T22:00:00' })).not.toEqual([])
    expect(validateWindow({ ...w, end: w.start })).not.toEqual([])
  })
})

describe('daily windows', () => {
  const night = { kind: 'daily' as const, time_zone: 'Asia/Kolkata', start: '22:00', end: '06:00' }

  it('crosses midnight in the named zone', () => {
    // 22:00 IST = 16:30 UTC
    expect(isWindowOpen(night, at('2026-11-02T16:29:00Z'))).toBe(false)
    expect(isWindowOpen(night, at('2026-11-02T16:30:00Z'))).toBe(true)
    expect(isWindowOpen(night, at('2026-11-02T20:00:00Z'))).toBe(true) // 01:30 IST
    expect(isWindowOpen(night, at('2026-11-03T00:29:00Z'))).toBe(true) // 05:59 IST
    expect(isWindowOpen(night, at('2026-11-03T00:30:00Z'))).toBe(false) // 06:00 IST
    expect(isWindowOpen(night, at('2026-11-03T06:30:00Z'))).toBe(false) // noon IST
  })

  it('a same-day window is open between start and end only', () => {
    const lunch = { kind: 'daily' as const, time_zone: 'UTC', start: '12:00', end: '13:00' }
    expect(isWindowOpen(lunch, at('2026-11-02T11:59:00Z'))).toBe(false)
    expect(isWindowOpen(lunch, at('2026-11-02T12:00:00Z'))).toBe(true)
    expect(isWindowOpen(lunch, at('2026-11-02T13:00:00Z'))).toBe(false)
  })

  it('opens only on the listed days, counting a night window by the day it starts', () => {
    // 2026-11-02 is a Monday. Window opens Monday nights only.
    const monNight = { ...night, days: [1] }
    expect(isWindowOpen(monNight, at('2026-11-02T17:00:00Z'))).toBe(true) // Mon 22:30 IST
    expect(isWindowOpen(monNight, at('2026-11-02T20:00:00Z'))).toBe(true) // Tue 01:30 IST, started Monday
    expect(isWindowOpen(monNight, at('2026-11-03T17:00:00Z'))).toBe(false) // Tue 22:30 IST
    expect(isWindowOpen(monNight, at('2026-11-01T20:00:00Z'))).toBe(false) // Mon 01:30 IST, started Sunday
  })

  it('uses the named zone, not the machine zone', () => {
    const ny = { kind: 'daily' as const, time_zone: 'America/New_York', start: '01:00', end: '02:00' }
    expect(isWindowOpen(ny, at('2026-11-02T06:30:00Z'))).toBe(true) // 01:30 EST (UTC-5 after DST ends 1 Nov)
    expect(isWindowOpen(ny, at('2026-11-02T01:30:00Z'))).toBe(false)
  })

  it('validates zone, times and days', () => {
    expect(validateWindow(night)).toEqual([])
    expect(validateWindow({ ...night, time_zone: 'Nowhere/Land' })).not.toEqual([])
    expect(validateWindow({ ...night, start: '24:00' })).not.toEqual([])
    expect(validateWindow({ ...night, end: '6:00' })).not.toEqual([])
    expect(validateWindow({ ...night, start: '06:00', end: '06:00' })).not.toEqual([])
    expect(validateWindow({ ...night, days: [7] })).not.toEqual([])
    expect(validateWindow({ ...night, days: [] })).not.toEqual([])
  })

  it('treats a missing window as always open', () => {
    expect(isWindowOpen(null, at('2026-11-02T12:00:00Z'))).toBe(true)
  })
})
