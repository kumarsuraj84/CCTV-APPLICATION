import { describe, expect, it } from 'vitest'
import { clampDay, dayLabel, daysInMonth, dayString, monthBounds, monthGrid, monthInBounds, monthLabel, shiftMonth } from '@/lib/streams/calendar'
import { DISPLAY_TIME_ZONE } from '@/lib/time'
import {
  blockAt,
  dayBlocks,
  describeBlocks,
  formatClock,
  formatShortDateTime,
  minuteAt,
  nextBlockStart,
  parseClock,
  parseDay,
  parseStartIso,
  SHOWN_CLOCK_OFFSET_MIN,
  shownToday,
  startIso,
} from '@/lib/streams/timeline'

const seg = (start: string, end: string) => ({ start, end })

describe('parseDay', () => {
  it('accepts real days between 2000 and 2100 only', () => {
    expect(parseDay('2026-10-22')).toEqual({ y: 2026, m: 10, d: 22 })
    expect(parseDay('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 })
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-10-00', '1999-12-31', '2101-01-01', '2026-1-1', '2026-10-22T00:00', ' 2026-10-22', '', 'x', undefined, null]) {
      expect(parseDay(bad as string), String(bad)).toBeNull()
    }
  })
})

describe('shownToday', () => {
  it('is the day on an Indian clock, whatever the machine time zone is', () => {
    expect(shownToday(Date.UTC(2026, 9, 22, 18, 29, 59))).toBe('2026-10-22') // 23:59:59 in India
    expect(shownToday(Date.UTC(2026, 9, 22, 18, 30, 0))).toBe('2026-10-23') // midnight in India
    expect(shownToday(Date.UTC(2026, 11, 31, 20, 0, 0))).toBe('2027-01-01')
  })
})

describe('dayBlocks', () => {
  it('turns segments into percentage blocks of the 24 hour day, snapped to whole minutes', () => {
    const blocks = dayBlocks('2026-10-22', [seg('2026-10-22T06:00:00.000Z', '2026-10-22T12:00:00.000Z')])
    expect(blocks).toEqual([{ startMin: 360, endMin: 720, left: 25, width: 25 }])
  })

  it('rounds the start down and the end up to the minute, so a short recording never vanishes', () => {
    const [b] = dayBlocks('2026-10-22', [seg('2026-10-22T10:00:20.000Z', '2026-10-22T10:00:21.000Z')])
    expect(b.startMin).toBe(600)
    expect(b.endMin).toBe(601)
    expect(b.width).toBeCloseTo(100 / 1440, 6)
    expect(b.left).toBeCloseTo((600 / 1440) * 100, 6)
  })

  it('clips a recording that began the evening before and one that goes on after midnight', () => {
    const blocks = dayBlocks('2026-10-22', [seg('2026-10-21T23:30:00.000Z', '2026-10-22T01:00:00.000Z'), seg('2026-10-22T23:00:00.000Z', '2026-10-23T02:00:00.000Z')])
    expect(blocks.map((b) => [b.startMin, b.endMin])).toEqual([[0, 60], [1380, 1440]])
    expect(blocks[1].left + blocks[1].width).toBeCloseTo(100, 6)
  })

  it('leaves out recordings of other days, empty ones and ones that do not parse', () => {
    const blocks = dayBlocks('2026-10-22', [
      seg('2026-10-21T01:00:00.000Z', '2026-10-21T02:00:00.000Z'),
      seg('2026-10-23T00:00:00.000Z', '2026-10-23T01:00:00.000Z'), // starts exactly when the day ends
      seg('2026-10-21T22:00:00.000Z', '2026-10-22T00:00:00.000Z'), // ends exactly when the day starts
      seg('2026-10-22T05:00:00.000Z', '2026-10-22T05:00:00.000Z'),
      seg('2026-10-22T06:00:00.000Z', '2026-10-22T05:00:00.000Z'),
      seg('nonsense', '2026-10-22T05:00:00.000Z'),
      seg('2026-10-22T07:00:00.000Z', 'nonsense'),
    ])
    expect(blocks).toEqual([])
  })

  it('sorts, and joins recordings that overlap or touch', () => {
    const blocks = dayBlocks('2026-10-22', [
      seg('2026-10-22T09:00:00.000Z', '2026-10-22T10:00:00.000Z'),
      seg('2026-10-22T08:00:00.000Z', '2026-10-22T09:00:00.000Z'),
      seg('2026-10-22T09:30:00.000Z', '2026-10-22T09:45:00.000Z'),
      seg('2026-10-22T11:00:00.000Z', '2026-10-22T11:10:00.000Z'),
    ])
    expect(blocks.map((b) => [b.startMin, b.endMin])).toEqual([[480, 600], [660, 670]])
  })

  it('does not depend on the time zone of the machine: the clock fields of the shown time are used', () => {
    // 23:59 shown is 23:59 on the bar, however the machine is set (the strings are read as written).
    const [b] = dayBlocks('2026-10-22', [seg('2026-10-22T23:59:00.000Z', '2026-10-23T00:30:00.000Z')])
    expect(b).toMatchObject({ startMin: 1439, endMin: 1440 })
  })

  it('returns nothing for a day that is not a day', () => {
    expect(dayBlocks('nope', [seg('2026-10-22T06:00:00.000Z', '2026-10-22T07:00:00.000Z')])).toEqual([])
    expect(dayBlocks('2026-10-22', [])).toEqual([])
  })
})

describe('clock text', () => {
  it('formats minutes of the day as 24 hour HH:MM', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(5)).toBe('00:05')
    expect(formatClock(14 * 60 + 30)).toBe('14:30')
    expect(formatClock(1439)).toBe('23:59')
    expect(formatClock(1440)).toBe('24:00')
  })

  it('reads HH:MM and H:MM, and nothing else', () => {
    expect(parseClock('14:30')).toBe(870)
    expect(parseClock('4:05')).toBe(245)
    expect(parseClock(' 00:00 ')).toBe(0)
    expect(parseClock('23:59')).toBe(1439)
    for (const bad of ['24:00', '12:60', '1230', '12:3', '12:30:00', '-1:30', 'ab:cd', '', '12.30', '1:2:3', '12:30 PM']) expect(parseClock(bad), bad).toBeNull()
  })
})

describe('picking a time on the bar', () => {
  it('turns a position (0 to 1 of the width) into a minute, snapped, and never outside the day', () => {
    expect(minuteAt(0)).toBe(0)
    expect(minuteAt(0.5)).toBe(720)
    expect(minuteAt(0.25)).toBe(360)
    expect(minuteAt(1)).toBe(1439)
    expect(minuteAt(1.5)).toBe(1439)
    expect(minuteAt(-0.2)).toBe(0)
    expect(minuteAt(Number.NaN)).toBe(0)
  })

  it('snaps to the step', () => {
    expect(minuteAt(0.5 + 2 / 1440, 5)).toBe(720)
    expect(minuteAt(0.5 + 3 / 1440, 5)).toBe(725)
    expect(minuteAt(0.9999, 5)).toBe(1435)
  })

  it('makes the start time of a day and a minute, as the clock fields written in UTC form', () => {
    expect(startIso('2026-10-22', 870)).toBe('2026-10-22T14:30:00Z')
    expect(startIso('2026-10-22', 0)).toBe('2026-10-22T00:00:00Z')
    expect(startIso('2026-10-22', 1439)).toBe('2026-10-22T23:59:00Z')
    expect(() => startIso('2026-10-22', 1440)).toThrow()
    expect(() => startIso('2026-10-22', -1)).toThrow()
    expect(() => startIso('2026-02-30', 10)).toThrow()
  })

  it('reads a start time back, strictly', () => {
    expect(parseStartIso('2026-10-22T14:30:00Z')?.toISOString()).toBe('2026-10-22T14:30:00.000Z')
    expect(parseStartIso('2026-10-22T14:30Z')?.toISOString()).toBe('2026-10-22T14:30:00.000Z')
    expect(parseStartIso('2026-10-22T14:30:15.250Z')?.toISOString()).toBe('2026-10-22T14:30:15.250Z')
    for (const bad of ['2026-10-22', '2026-10-22T14:30:00+05:30', '2026-10-22T14:30:00', '2026-02-30T10:00:00Z', '2026-10-22T25:00:00Z', 'now', '', '2026-10-22T14:30:00Zjunk']) {
      expect(parseStartIso(bad), bad).toBeNull()
    }
  })
})

describe('finding recordings near a minute', () => {
  const blocks = dayBlocks('2026-10-22', [seg('2026-10-22T06:00:00.000Z', '2026-10-22T07:00:00.000Z'), seg('2026-10-22T10:00:00.000Z', '2026-10-22T10:30:00.000Z')])
  it('says whether a minute is inside a recording (the end minute is not)', () => {
    expect(blockAt(blocks, 360)).toBe(blocks[0])
    expect(blockAt(blocks, 419)).toBe(blocks[0])
    expect(blockAt(blocks, 420)).toBeNull()
    expect(blockAt(blocks, 359)).toBeNull()
    expect(blockAt(blocks, 610)).toBe(blocks[1])
  })
  it('finds the next recording that starts after a minute', () => {
    expect(nextBlockStart(blocks, 0)).toBe(360)
    expect(nextBlockStart(blocks, 360)).toBe(600)
    expect(nextBlockStart(blocks, 421)).toBe(600)
    expect(nextBlockStart(blocks, 600)).toBeNull()
  })
})

describe('describeBlocks', () => {
  it('lists the recordings in words for a screen reader', () => {
    expect(describeBlocks([])).toBe('No recordings.')
    const blocks = dayBlocks('2026-10-22', [seg('2026-10-22T06:00:00.000Z', '2026-10-22T07:00:00.000Z'), seg('2026-10-22T10:00:00.000Z', '2026-10-23T03:00:00.000Z')])
    expect(describeBlocks(blocks)).toBe('2 recordings: 06:00 to 07:00, 10:00 to 24:00.')
    expect(describeBlocks(blocks.slice(0, 1))).toBe('1 recording: 06:00 to 07:00.')
  })
  it('keeps a very long list short', () => {
    const many = Array.from({ length: 60 }, (_, i) => seg(`2026-10-22T${String(Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 20).padStart(2, '0')}:00.000Z`, `2026-10-22T${String(Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 20 + 10).padStart(2, '0')}:00.000Z`))
    const text = describeBlocks(dayBlocks('2026-10-22', many))
    expect(text.startsWith('60 recordings: 00:00 to 00:10')).toBe(true)
    expect(text).toContain('and 40 more')
  })
})

describe('calendar', () => {
  it('counts the days of a month, leap years included', () => {
    expect(daysInMonth(2026, 10)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
  })

  it('lays a month out in weeks that start on Monday, with blanks around it', () => {
    const grid = monthGrid(2026, 10) // 1 Oct 2026 is a Thursday
    expect(grid[0]).toEqual([null, null, null, 1, 2, 3, 4])
    expect(grid[1]).toEqual([5, 6, 7, 8, 9, 10, 11])
    expect(grid.at(-1)).toEqual([26, 27, 28, 29, 30, 31, null])
    expect(grid.every((w) => w.length === 7)).toBe(true)
    expect(grid.flat().filter((d): d is number => d !== null)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    // A month that starts on a Monday has no blanks at the front; February 2027 also fits exactly in four weeks.
    expect(monthGrid(2026, 6)[0][0]).toBe(1)
    expect(monthGrid(2027, 2)).toHaveLength(4)
    // A month that starts on a Sunday has six blanks at the front.
    expect(monthGrid(2026, 2)[0]).toEqual([null, null, null, null, null, null, 1])
  })

  it('moves between months across years', () => {
    expect(shiftMonth(2026, 10, 1)).toEqual({ year: 2026, month: 11 })
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(shiftMonth(2026, 3, -14)).toEqual({ year: 2025, month: 1 })
  })

  it('writes days and months for people', () => {
    expect(dayString(2026, 3, 7)).toBe('2026-03-07')
    expect(monthLabel(2026, 10)).toBe('October 2026')
    expect(dayLabel(2026, 10, 22)).toBe('Thursday 22 October 2026')
  })
})

describe('the shown clock', () => {
  it('is the offset of the zone every screen shows (a change of zone in lib/time.ts must change SHOWN_CLOCK_OFFSET_MIN too)', () => {
    const offsetMinutes = (zone: string, at: Date) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]))
      return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - at.getTime()) / 60_000
    }
    for (const at of [new Date(Date.UTC(2026, 0, 15)), new Date(Date.UTC(2026, 6, 15)), new Date(Date.UTC(2027, 9, 30))]) expect(offsetMinutes(DISPLAY_TIME_ZONE, at)).toBe(SHOWN_CLOCK_OFFSET_MIN)
  })
})

describe('formatShortDateTime', () => {
  it('writes the day, month and 24 hour clock of a shown time', () => {
    expect(formatShortDateTime('2026-10-22T14:35:00.000Z')).toBe('22 Oct, 14:35')
    expect(formatShortDateTime('2026-01-05T00:05:59Z')).toBe('5 Jan, 00:05')
    expect(formatShortDateTime('nonsense')).toBe('')
  })
})

describe('month bounds', () => {
  it('allows the current month and the 12 months before it', () => {
    expect(monthBounds('2026-10-22')).toEqual({ min: { year: 2025, month: 10 }, max: { year: 2026, month: 10 } })
    expect(monthBounds('2026-03-01')).toEqual({ min: { year: 2025, month: 3 }, max: { year: 2026, month: 3 } })
    expect(monthInBounds(2026, 10, '2026-10-22')).toBe(true)
    expect(monthInBounds(2025, 10, '2026-10-22')).toBe(true)
    expect(monthInBounds(2025, 9, '2026-10-22')).toBe(false)
    expect(monthInBounds(2026, 11, '2026-10-22')).toBe(false)
  })
  it('turns a day outside them into today', () => {
    expect(clampDay('2026-10-01', '2026-10-22')).toBe('2026-10-01')
    expect(clampDay('2025-10-31', '2026-10-22')).toBe('2025-10-31')
    expect(clampDay('2025-09-30', '2026-10-22')).toBe('2026-10-22')
    expect(clampDay('2026-11-02', '2026-10-22')).toBe('2026-10-22')
    expect(clampDay('2030-01-01', '2026-10-22')).toBe('2026-10-22')
  })
})
