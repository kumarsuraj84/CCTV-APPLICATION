import { describe, expect, it } from 'vitest'
import { monthAllowed, nvrMonthsFor, shownRecordedDays } from '@/lib/streams/calendar'

// P4-L2 brief item 2: the recorder's own clock offset is applied to the CALENDAR too (before P4-L2 it showed the NVR's own days, which
// differ from the shown days near midnight). Shown time = NVR time + offset; an NVR day d covers the shown span
// [d 00:00 + offset, d+1 00:00 + offset), so it marks every shown day that span touches. The marks stay a hint: any day can be opened.

const H = 3_600_000

describe('nvrMonthsFor: the NVR months whose days can fall into a shown month', () => {
  it('no offset: the month itself', () => {
    expect(nvrMonthsFor(2026, 10, 0)).toEqual([{ year: 2026, month: 10 }])
  })
  it('a positive offset (NVR behind the shown clock) also needs the month before (its last day reaches into the 1st)', () => {
    expect(nvrMonthsFor(2026, 10, 5.5 * H)).toEqual([{ year: 2026, month: 9 }, { year: 2026, month: 10 }])
    expect(nvrMonthsFor(2026, 1, 97_000)).toEqual([{ year: 2025, month: 12 }, { year: 2026, month: 1 }])
  })
  it('a negative offset (NVR ahead) also needs the month after', () => {
    expect(nvrMonthsFor(2026, 12, -H)).toEqual([{ year: 2026, month: 12 }, { year: 2027, month: 1 }])
  })
})

describe('shownRecordedDays', () => {
  const oct = (days: number[]) => ({ year: 2026, month: 10, days })
  const sep = (days: number[]) => ({ year: 2026, month: 9, days })
  const nov = (days: number[]) => ({ year: 2026, month: 11, days })

  it('no offset: exactly the NVR days', () => {
    expect(shownRecordedDays([oct([3, 20, 31])], 0, 2026, 10)).toEqual([3, 20, 31])
  })
  it('+5:30 (NVR on UTC, shown India time): an NVR day reaches into the next shown day', () => {
    expect(shownRecordedDays([oct([3, 20])], 5.5 * H, 2026, 10)).toEqual([3, 4, 20, 21])
  })
  it('-1 h (NVR an hour ahead): an NVR day reaches back into the shown day before', () => {
    expect(shownRecordedDays([oct([3, 20])], -H, 2026, 10)).toEqual([2, 3, 19, 20])
  })
  it('a few seconds of skew are still honest: the next day may hold the last seconds of the NVR day', () => {
    expect(shownRecordedDays([oct([10])], 97_000, 2026, 10)).toEqual([10, 11])
  })
  it('the last NVR day of the month before reaches the 1st; the 31st reaches the 1st of the next month, which is not this month', () => {
    expect(shownRecordedDays([sep([30]), oct([31])], 5.5 * H, 2026, 10)).toEqual([1, 31])
    expect(shownRecordedDays([oct([1]), nov([1])], -H, 2026, 10)).toEqual([1, 31])
  })
  it('29 February in a leap year; days that do not exist in the month are ignored', () => {
    expect(shownRecordedDays([{ year: 2028, month: 2, days: [29] }], 0, 2028, 2)).toEqual([29])
    expect(shownRecordedDays([{ year: 2026, month: 2, days: [29, 30] }], 0, 2026, 2)).toEqual([])
  })
  it('an offset of more than a day either way, or not a number, marks nothing (it is refused upstream)', () => {
    expect(shownRecordedDays([oct([3])], 25 * H, 2026, 10)).toEqual([])
    expect(shownRecordedDays([oct([3])], Number.NaN, 2026, 10)).toEqual([])
  })
})

describe('monthAllowed: the calendar goes back 12 months and never before the oldest recording', () => {
  it('without an oldest recording: 12 months back to this month', () => {
    expect(monthAllowed(2025, 10, '2026-10-22', null)).toBe(true)
    expect(monthAllowed(2025, 9, '2026-10-22', null)).toBe(false)
    expect(monthAllowed(2026, 11, '2026-10-22', null)).toBe(false)
  })
  it('with one: not before its month', () => {
    expect(monthAllowed(2026, 8, '2026-10-22', '2026-09-03')).toBe(false)
    expect(monthAllowed(2026, 9, '2026-10-22', '2026-09-03')).toBe(true)
  })
})
