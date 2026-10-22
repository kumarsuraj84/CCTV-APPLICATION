import { describe, expect, it } from 'vitest'
import {
  DAY_SECONDS,
  daySpans,
  edgeAction,
  edgeSide,
  formatClockSeconds,
  fractionOf,
  FULL_DAY,
  isFullDay,
  isPlayableStart,
  JUMPS,
  jumpLabel,
  keyMove,
  MIN_VIEW_SECONDS,
  panView,
  parseClockSeconds,
  secondAt,
  shiftTime,
  shownToday,
  snapToRecording,
  spanAt,
  spansInView,
  startIsoAt,
  viewTicks,
  zoomView,
} from '@/lib/streams/timeline'

// P4-L2 (LG-10..LG-13): the timeline in seconds of the shown day (India time, 24 hour): zoom and pan, the visible window, snapping a
// click to the nearest recording, jumps that cross midnight, the edge of the bar. All pure, so the screen and the tests agree.

const seg = (start: string, end: string) => ({ start, end })
const DAY = '2026-10-22'

describe('daySpans (seconds, not minutes)', () => {
  it('keeps seconds, clips to the day, joins overlapping and touching recordings', () => {
    const spans = daySpans(DAY, [
      seg('2026-10-22T10:00:20.000Z', '2026-10-22T10:00:21.000Z'),
      seg('2026-10-22T06:00:00.000Z', '2026-10-22T07:00:00.000Z'),
      seg('2026-10-22T07:00:00.000Z', '2026-10-22T07:30:00.000Z'),
    ])
    expect(spans).toEqual([
      { startSec: 6 * 3600, endSec: 7.5 * 3600 },
      { startSec: 10 * 3600 + 20, endSec: 10 * 3600 + 21 },
    ])
  })
  it('a recording that spans midnight shows on both days, cut at 00:00', () => {
    const across = [seg('2026-10-21T23:30:00.000Z', '2026-10-22T00:45:00.000Z')]
    expect(daySpans('2026-10-21', across)).toEqual([{ startSec: 23.5 * 3600, endSec: DAY_SECONDS }])
    expect(daySpans(DAY, across)).toEqual([{ startSec: 0, endSec: 45 * 60 }])
  })
  it('leaves out what does not parse, is empty or lies on another day; a bad day gives nothing', () => {
    expect(daySpans(DAY, [seg('x', 'y'), seg('2026-10-22T05:00:00Z', '2026-10-22T05:00:00Z'), seg('2026-10-23T01:00:00Z', '2026-10-23T02:00:00Z')])).toEqual([])
    expect(daySpans('2026-02-30', [seg('2026-10-22T05:00:00Z', '2026-10-22T06:00:00Z')])).toEqual([])
  })
})

describe('the visible window (LG-11 zoom, LG-12 pan)', () => {
  it('starts as the whole day', () => {
    expect(FULL_DAY).toEqual({ start: 0, end: DAY_SECONDS })
    expect(isFullDay(FULL_DAY)).toBe(true)
    expect(isFullDay({ start: 0, end: 3600 })).toBe(false)
  })
  it('zooming in keeps the second under the pointer where it was', () => {
    const v = zoomView(FULL_DAY, 12 * 3600, 0.5)
    expect(v.end - v.start).toBe(DAY_SECONDS / 2)
    expect(fractionOf(v, 12 * 3600)).toBeCloseTo(0.5, 6)
    const w = zoomView(FULL_DAY, 6 * 3600, 0.25) // focus at a quarter of the bar stays at a quarter
    expect(fractionOf(w, 6 * 3600)).toBeCloseTo(0.25, 6)
    expect(w.end - w.start).toBe(DAY_SECONDS / 4)
  })
  it('never zooms in past 10 minutes, never out past the whole day, and stays inside the day', () => {
    let v = FULL_DAY
    for (let i = 0; i < 40; i++) v = zoomView(v, 100, 0.5)
    expect(v.end - v.start).toBe(MIN_VIEW_SECONDS)
    expect(v.start).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < 40; i++) v = zoomView(v, 80_000, 2)
    expect(v).toEqual(FULL_DAY)
    const nearEnd = zoomView(FULL_DAY, DAY_SECONDS - 1, 0.1)
    expect(nearEnd.end).toBeLessThanOrEqual(DAY_SECONDS)
    expect(nearEnd.start).toBeGreaterThanOrEqual(0)
  })
  it('a zoom factor or focus that is not a number changes nothing', () => {
    expect(zoomView(FULL_DAY, Number.NaN, 0.5)).toEqual(FULL_DAY)
    expect(zoomView({ start: 3600, end: 7200 }, 4000, Number.NaN)).toEqual({ start: 3600, end: 7200 })
  })
  it('panning moves the window and stops at the ends of the day', () => {
    const v = { start: 3600, end: 7200 }
    expect(panView(v, 600)).toEqual({ start: 4200, end: 7800 })
    expect(panView(v, -10_000)).toEqual({ start: 0, end: 3600 })
    expect(panView({ start: 80_000, end: 84_000 }, 10_000)).toEqual({ start: DAY_SECONDS - 4000, end: DAY_SECONDS })
    expect(panView(FULL_DAY, 999)).toEqual(FULL_DAY)
  })
  it('a position on the bar is a whole second of the window, inside the day', () => {
    const v = { start: 3600, end: 7200 }
    expect(secondAt(v, 0)).toBe(3600)
    expect(secondAt(v, 0.5)).toBe(5400)
    expect(secondAt(v, 1)).toBe(7199)
    expect(secondAt(v, 7)).toBe(7199)
    expect(secondAt(v, -1)).toBe(3600)
    expect(secondAt(FULL_DAY, 1)).toBe(DAY_SECONDS - 1)
    expect(secondAt(FULL_DAY, Number.NaN)).toBe(0)
  })
  it('only the parts of recordings inside the window are drawn, as percentages of it', () => {
    const spans = [{ startSec: 0, endSec: 3600 }, { startSec: 5000, endSec: 6000 }, { startSec: 7000, endSec: 9000 }]
    const drawn = spansInView(spans, { start: 3600, end: 7200 })
    expect(drawn.map((d) => [d.startSec, d.endSec])).toEqual([[5000, 6000], [7000, 7200]])
    expect(drawn[0].left).toBeCloseTo((1400 / 3600) * 100, 6)
    expect(drawn[0].width).toBeCloseTo((1000 / 3600) * 100, 6)
    expect(drawn[1].left + drawn[1].width).toBeCloseTo(100, 6)
  })
  it('hour marks for the whole day, finer marks as the window narrows, all inside the window and labelled HH:MM', () => {
    const day = viewTicks(FULL_DAY)
    expect(day.filter((t) => t.major).map((t) => t.label)).toEqual(['00:00', '06:00', '12:00', '18:00', '24:00'])
    const hour = viewTicks({ start: 36_000, end: 39_600 }) // 10:00 to 11:00
    expect(hour.length).toBeGreaterThanOrEqual(4)
    expect(hour.every((t) => t.sec >= 36_000 && t.sec <= 39_600)).toBe(true)
    expect(hour.map((t) => t.label)).toContain('10:30')
    const ten = viewTicks({ start: 36_000, end: 36_600 })
    expect(ten.map((t) => t.label)).toContain('10:05')
  })
})

describe('snap to the nearest recording (LG-10)', () => {
  const spans = [{ startSec: 3600, endSec: 7200 }, { startSec: 36_000, endSec: 39_600 }]
  it('a click inside a recording stays where it is', () => {
    expect(snapToRecording(spans, 5000)).toBe(5000)
    expect(spanAt(spans, 5000)).toEqual(spans[0])
    expect(spanAt(spans, 7200)).toBeNull() // the end second is not part of it
  })
  it('a click in a gap goes to the nearer recording: the start of the next, or the last minute of the previous', () => {
    expect(snapToRecording(spans, 30_000)).toBe(36_000) // 6000 s before the next, 22800 s after the previous
    expect(snapToRecording(spans, 8000)).toBe(7200 - 60) // 800 s after the previous: its last minute
    expect(snapToRecording(spans, 0)).toBe(3600)
    expect(snapToRecording(spans, 80_000)).toBe(39_600 - 60)
  })
  it('the previous recording shorter than a minute is played from its start', () => {
    expect(snapToRecording([{ startSec: 100, endSec: 130 }], 140)).toBe(100)
  })
  it('without recordings there is nothing to snap to', () => {
    expect(snapToRecording([], 500)).toBeNull()
  })
})

describe('jumps cross midnight on the shown clock (LG-13, brief item 2)', () => {
  it('the buttons are -10, -5, -1, +1, +5, +10 minutes with plain labels', () => {
    expect(JUMPS).toEqual([-600, -300, -60, 60, 300, 600])
    expect(JUMPS.map(jumpLabel)).toEqual(['Back 10 minutes', 'Back 5 minutes', 'Back 1 minute', 'Forward 1 minute', 'Forward 5 minutes', 'Forward 10 minutes'])
  })
  it('moves inside the day', () => {
    expect(shiftTime(DAY, 3600, 300)).toEqual({ day: DAY, sec: 3900 })
  })
  it('23:58 + 5 minutes is 00:03 of the next day; 00:02 - 5 minutes is 23:57 of the day before', () => {
    expect(shiftTime(DAY, 23 * 3600 + 58 * 60, 300)).toEqual({ day: '2026-10-23', sec: 3 * 60 })
    expect(shiftTime(DAY, 2 * 60, -300)).toEqual({ day: '2026-10-21', sec: 23 * 3600 + 57 * 60 })
  })
  it('across the end of a month, a year and 29 February (no daylight saving time in India: every day has 86400 seconds)', () => {
    expect(shiftTime('2026-10-31', DAY_SECONDS - 30, 60)).toEqual({ day: '2026-11-01', sec: 30 })
    expect(shiftTime('2026-12-31', DAY_SECONDS - 1, 1)).toEqual({ day: '2027-01-01', sec: 0 })
    expect(shiftTime('2028-03-01', 10, -20)).toEqual({ day: '2028-02-29', sec: DAY_SECONDS - 10 })
  })
  it('the keyboard: left/right 30 seconds, with Shift 5 minutes; anything else is not a move', () => {
    expect(keyMove('ArrowLeft', false)).toBe(-30)
    expect(keyMove('ArrowRight', false)).toBe(30)
    expect(keyMove('ArrowLeft', true)).toBe(-300)
    expect(keyMove('ArrowRight', true)).toBe(300)
    expect(keyMove('PageUp', false)).toBe(3600)
    expect(keyMove('PageDown', false)).toBe(-3600)
    expect(keyMove('a', false)).toBeNull()
  })
  it('a start is playable from a year back to 15 minutes ahead of the shown clock (India time), whatever the machine zone', () => {
    const now = Date.UTC(2026, 9, 22, 18, 29, 0) // 23:59 in India
    expect(shownToday(now)).toBe('2026-10-22')
    const shown = (iso: string) => Date.parse(iso)
    expect(isPlayableStart(shown('2026-10-22T23:59:00Z'), now)).toBe(true)
    expect(isPlayableStart(shown('2026-10-23T00:14:00Z'), now)).toBe(true) // just past midnight, inside the 15 minutes
    expect(isPlayableStart(shown('2026-10-23T00:15:01Z'), now)).toBe(false)
    expect(isPlayableStart(shown('2025-10-22T23:58:00Z'), now)).toBe(false)
    expect(isPlayableStart(Number.NaN, now)).toBe(false)
  })
})

describe('the edge of the bar (LG-12, guarded)', () => {
  it('only the outer 4 % on either side is an edge', () => {
    expect(edgeSide(0.01)).toBe('left')
    expect(edgeSide(0.99)).toBe('right')
    expect(edgeSide(0.5)).toBeNull()
    expect(edgeSide(0.1)).toBeNull()
  })
  it('zoomed in: the window pans; at the end of the day it changes the day only when that is allowed', () => {
    const mid = { start: 36_000, end: 39_600 }
    const both = { canPreviousDay: true, canNextDay: true }
    expect(edgeAction(mid, 'left', both)).toBe('pan-left')
    expect(edgeAction(mid, 'right', both)).toBe('pan-right')
    expect(edgeAction({ start: 0, end: 3600 }, 'left', both)).toBe('previous-day')
    expect(edgeAction({ start: 0, end: 3600 }, 'left', { canPreviousDay: false, canNextDay: true })).toBeNull()
    expect(edgeAction({ start: DAY_SECONDS - 3600, end: DAY_SECONDS }, 'right', { canPreviousDay: true, canNextDay: false })).toBeNull()
  })
  it('the whole day: the edge changes the day, never beyond today or before the oldest recording', () => {
    expect(edgeAction(FULL_DAY, 'left', { canPreviousDay: true, canNextDay: false })).toBe('previous-day')
    expect(edgeAction(FULL_DAY, 'right', { canPreviousDay: true, canNextDay: false })).toBeNull()
    expect(edgeAction(FULL_DAY, 'right', { canPreviousDay: false, canNextDay: true })).toBe('next-day')
  })
})

describe('clock text with seconds', () => {
  it('formats and reads HH:MM and HH:MM:SS (24 hour)', () => {
    expect(formatClockSeconds(0)).toBe('00:00:00')
    expect(formatClockSeconds(DAY_SECONDS - 1)).toBe('23:59:59')
    expect(formatClockSeconds(45_296)).toBe('12:34:56')
    expect(parseClockSeconds('12:34')).toBe(45_240)
    expect(parseClockSeconds('9:05:07')).toBe(9 * 3600 + 5 * 60 + 7)
    for (const bad of ['24:00', '12:60', '12:30:60', '1234', '', 'x']) expect(parseClockSeconds(bad), bad).toBeNull()
  })
  it('the start to ask for carries the second', () => {
    expect(startIsoAt(DAY, 45_296)).toBe('2026-10-22T12:34:56Z')
    expect(() => startIsoAt(DAY, DAY_SECONDS)).toThrow()
    expect(() => startIsoAt('2026-02-30', 0)).toThrow()
  })
})
