import { describe, expect, it } from 'vitest'
import {
  bufferTargetSec,
  clipEnd,
  createStallWatch,
  fastBudget,
  MSG_RECORDING_PART_ENDED,
  secondsToPlay,
  downshift,
  EXPORT_CAPABILITY,
  FAST_PLAYBACK_CAPABILITY,
  FAST_SPEEDS,
  FAST_STREAM_PATH,
  FAST_TOKEN_HEADER,
  fastMinutes,
  isSpeed,
  MAX_FAST_MINUTES,
  MSG_DOWNSHIFTED,
  MSG_H265,
  readyToStart,
  SPEEDS,
  speedLabel,
} from '@/lib/streams/speed'

// Decision D-L1 (owner, 2026-10-22) supersedes D-6a and P2-2 fix M-3 for fast playback: 2x-16x is a cctv.playback right, delivered only as
// a browser stream; cctv.export is for saveable files (/api/vod) only. The tests that asserted "fast playback needs cctv.export" and the
// 1/2/4/8 list encoded the pre-D-L1 rule and are replaced here (LG-14: 16x added).

describe('speeds (LG-14)', () => {
  it('are 1x, 2x, 4x, 8x and 16x; the fast ones are 2x to 16x', () => {
    expect([...SPEEDS]).toEqual([1, 2, 4, 8, 16])
    expect([...FAST_SPEEDS]).toEqual([2, 4, 8, 16])
    expect(SPEEDS.map(speedLabel)).toEqual(['1x', '2x', '4x', '8x', '16x'])
    expect([1, 2, 4, 8, 16].every(isSpeed)).toBe(true)
    expect([0, 3, 32, '2', null, undefined, Number.NaN].some(isSpeed)).toBe(false)
  })
  it('a fast clip is at most 30 minutes and at least 1', () => {
    expect(MAX_FAST_MINUTES).toBe(30)
    expect([5, 10, 30, 60, 0, -4, 1.4, Number.NaN].map(fastMinutes)).toEqual([5, 10, 30, 30, 1, 1, 1, 1])
  })
})

describe('who may use which (D-L1, E-1)', () => {
  it('fast playback needs cctv.playback; only saveable files (export) need cctv.export', () => {
    expect(FAST_PLAYBACK_CAPABILITY).toBe('cctv.playback')
    expect(EXPORT_CAPABILITY).toBe('cctv.export')
  })
  it('the stream path is not the old savable address, and the token travels in a header, never in the address', () => {
    expect(FAST_STREAM_PATH).toBe('/api/playback/stream')
    expect(FAST_STREAM_PATH).not.toContain('vod')
    expect(FAST_TOKEN_HEADER).toBe('x-playback-token')
  })
  it('the old helpers that built /api/vod addresses for a plain <video> are gone', async () => {
    const speed = await import('@/lib/streams/speed')
    expect('vodUrl' in speed).toBe(false)
    expect('probeVod' in speed).toBe(false)
  })
})

describe('stall auto-downshift (LG-15: 3 stalls in 40 seconds)', () => {
  it('steps down one speed at a time and never below 1x', () => {
    expect([16, 8, 4, 2, 1].map((s) => downshift(s as never))).toEqual([8, 4, 2, 1, 1])
  })
  it('the third stall within 40 s says "slow down", then the count starts again', () => {
    const w = createStallWatch()
    expect(w.stall(0)).toBe(false)
    expect(w.stall(10_000)).toBe(false)
    expect(w.stall(39_000)).toBe(true)
    expect(w.stall(40_000)).toBe(false)
  })
  it('stalls further apart than 40 s never add up', () => {
    const w = createStallWatch()
    expect([0, 30_000, 61_000, 90_000, 121_000].map((t) => w.stall(t))).toEqual([false, false, false, false, false])
  })
  it('the words for a downshift and for H.265 are plain and name a later release for the conversion', () => {
    expect(MSG_DOWNSHIFTED(8, 4)).toBe('The recording is arriving too slowly for 8x, so it now plays at 4x.')
    expect(MSG_H265).toMatch(/H\.265/)
    expect(MSG_H265).toMatch(/later release/)
  })
})

describe('the end of a fast clip (review m-3)', () => {
  it('the end of the chosen time is just that; an earlier end says so and offers to carry on from there', () => {
    expect(clipEnd(600, 10)).toEqual({ message: 'End of the chosen time.', canContinue: false })
    expect(clipEnd(596, 10)).toEqual({ message: 'End of the chosen time.', canContinue: false })
    expect(clipEnd(240, 10)).toEqual({ message: MSG_RECORDING_PART_ENDED, canContinue: true })
    expect(MSG_RECORDING_PART_ENDED).toMatch(/Continue from here/)
  })
})

describe('review I-1 (owner ruling): what fast playback may cost a person', () => {
  it('the budget defaults to 120 minutes of recording per hour and 8 hours per day, settable, never below 1 or above a day', () => {
    expect(fastBudget({})).toEqual({ perHourMin: 120, perDayMin: 480 })
    expect(fastBudget({ FAST_PLAYBACK_MINUTES_PER_HOUR: '30', FAST_PLAYBACK_MINUTES_PER_DAY: '60' })).toEqual({ perHourMin: 30, perDayMin: 60 })
    expect(fastBudget({ FAST_PLAYBACK_MINUTES_PER_HOUR: 'lots', FAST_PLAYBACK_MINUTES_PER_DAY: '0' })).toEqual({ perHourMin: 120, perDayMin: 480 })
    expect(fastBudget({ FAST_PLAYBACK_MINUTES_PER_DAY: '99999' })).toEqual({ perHourMin: 120, perDayMin: 1440 })
  })
  it('the pace: 16x is 16 seconds of recording per second, so an hour takes 3.75 minutes', () => {
    expect(secondsToPlay(3600, 16)).toBe(225)
    expect(secondsToPlay(3600, 2)).toBe(1800)
  })
})

describe('buffer gating (LG-15)', () => {
  it('waits for about two seconds of watching at the chosen speed (at least 2 s, at most 30 s of recording)', () => {
    expect(bufferTargetSec(1)).toBe(2)
    expect(bufferTargetSec(2)).toBe(4)
    expect(bufferTargetSec(8)).toBe(16)
    expect(bufferTargetSec(16)).toBe(30)
  })
  it('starts when that much is buffered, or when the whole clip has arrived', () => {
    expect(readyToStart(3.9, 2, false)).toBe(false)
    expect(readyToStart(4, 2, false)).toBe(true)
    expect(readyToStart(1, 16, true)).toBe(true)
  })
})
