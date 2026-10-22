import { describe, expect, it } from 'vitest'
import { allocateTiles, capStreams, DEFAULT_MAX_STREAMS_PER_USER, MAX_STREAMS_PER_USER_CEILING, maxStreamsPerUser, MSG_PAUSED_FOR_BANDWIDTH } from '@/lib/streams/concurrency'
import { MAX_STREAMS_PER_REQUEST } from '@/lib/streams/open'
import { LAYOUTS, perPage } from '@/lib/streams/wall'

// P4-L1 brief item 2: max simultaneous streams per user from the environment (default 25); excess tiles are paused to save bandwidth.

describe('the per-person limit (LIVE_MAX_STREAMS_PER_USER)', () => {
  it('is 25 by default and for anything that is not a whole number from 1 to 100', () => {
    expect(DEFAULT_MAX_STREAMS_PER_USER).toBe(25)
    for (const v of [undefined, '', ' ', 'lots', '0', '-3', '2.5', '1e2', '0x10', '25 cameras']) expect(maxStreamsPerUser({ LIVE_MAX_STREAMS_PER_USER: v }), String(v)).toBe(25)
    expect(maxStreamsPerUser({ LIVE_MAX_STREAMS_PER_USER: '9' })).toBe(9)
    expect(maxStreamsPerUser({ LIVE_MAX_STREAMS_PER_USER: ' 16 ' })).toBe(16)
    expect(maxStreamsPerUser({ LIVE_MAX_STREAMS_PER_USER: '500' })).toBe(MAX_STREAMS_PER_USER_CEILING)
  })

  it('the biggest wall (5×5) fits the default limit and one request', () => {
    expect(Math.max(...LAYOUTS.map(perPage))).toBe(25)
    expect(Math.max(...LAYOUTS.map(perPage))).toBeLessThanOrEqual(DEFAULT_MAX_STREAMS_PER_USER)
    expect(Math.max(...LAYOUTS.map(perPage))).toBeLessThanOrEqual(MAX_STREAMS_PER_REQUEST)
  })
})

describe('capStreams (the server: what a new opening may add)', () => {
  it('fills what is left of the limit in order and pauses the rest', () => {
    const r = capStreams(['a', 'b', 'c', 'd'], new Set(['x', 'y']), 4)
    expect([...r.allowed]).toEqual(['a', 'b'])
    expect(r.paused).toEqual(['c', 'd'])
  })

  it('streams already open are renewals: kept first and never counted twice', () => {
    const r = capStreams(['a', 'b', 'x'], new Set(['x', 'y', 'z']), 4)
    expect(r.allowed.has('x')).toBe(true)
    expect([...r.allowed].sort()).toEqual(['a', 'x'])
    expect(r.paused).toEqual(['b'])
    // A whole wall asked for again while every stream of it is open: nothing is paused.
    const wall = Array.from({ length: 25 }, (_, i) => `s${i}`)
    expect(capStreams(wall, new Set(wall), 25).paused).toEqual([])
  })

  it('repeats count once; nothing open means everything up to the limit', () => {
    expect([...capStreams(['a', 'a', 'b'], new Set(), 25).allowed]).toEqual(['a', 'b'])
    expect(capStreams(['a', 'b'], new Set(['p', 'q', 'r']), 2).paused).toEqual(['a', 'b'])
  })
})

describe('allocateTiles (the wall: which tiles play)', () => {
  const page = ['t1', 't2', 't3', 't4']
  it('tiles on screen play in page order up to the limit; the rest are paused for bandwidth', () => {
    expect(allocateTiles(page, new Set(page), 2)).toEqual({ play: ['t1', 't2'], bandwidth: ['t3', 't4'], idle: [] })
    expect(allocateTiles(page, new Set(page), 25)).toEqual({ play: page, bandwidth: [], idle: [] })
  })

  it('tiles scrolled out of view do not play and do not use the limit', () => {
    expect(allocateTiles(page, new Set(['t3', 't4']), 2)).toEqual({ play: ['t3', 't4'], bandwidth: [], idle: ['t1', 't2'] })
  })

  it('while the large picture is open, the grid behind it plays nothing', () => {
    expect(allocateTiles(page, new Set(page), 25, true)).toEqual({ play: [], bandwidth: [], idle: page })
  })

  it('says so in plain words', () => {
    expect(MSG_PAUSED_FOR_BANDWIDTH).toBe('Paused to save bandwidth')
  })
})
