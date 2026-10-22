import { describe, expect, it } from 'vitest'
import { allocateTiles, DEFAULT_MAX_STREAMS_PER_USER, MAX_STREAMS_PER_USER_CEILING, maxStreamsPerUser, MSG_PAUSED_FOR_BANDWIDTH, releaseFor } from '@/lib/streams/concurrency'
import { MAX_STREAMS_PER_REQUEST } from '@/lib/streams/open'
import { LAYOUTS, perPage } from '@/lib/streams/wall'

// P4-L1 brief item 2: max simultaneous streams per user from the environment (default 25); excess tiles are paused to save bandwidth.
// Review round 1 (I-1): the count itself is the database's (media_session_create_live, media_session_open; tests/integration/
// live-concurrency.test.ts); what stays here is the setting, the wall's own choice of tiles and what the wall lets go of.

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

describe('allocateTiles (the wall: which tiles play)', () => {
  const page = ['t1', 't2', 't3', 't4']
  it('tiles on screen play in page order up to the limit; the rest are paused for bandwidth', () => {
    expect(allocateTiles(page, new Set(page), 2)).toEqual({ play: ['t1', 't2'], bandwidth: ['t3', 't4'], idle: [] })
    expect(allocateTiles(page, new Set(page), 25)).toEqual({ play: page, bandwidth: [], idle: [] })
  })

  it('review M-7: cameras whose recorder cannot be reached take a place only after the others', () => {
    expect(allocateTiles(page, new Set(page), 2, false, new Set(['t1', 't2']))).toEqual({ play: ['t3', 't4'], bandwidth: ['t1', 't2'], idle: [] })
    expect(allocateTiles(page, new Set(page), 3, false, new Set(['t1']))).toEqual({ play: ['t2', 't3', 't4'], bandwidth: ['t1'], idle: [] })
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

describe('releaseFor (what the wall lets go of, so its unused tokens stop counting)', () => {
  it('the cameras of the old list that are not on the new one', () => {
    expect(releaseFor(['a', 'b', 'c'], ['b', 'd'])).toEqual(['a', 'c'])
    expect(releaseFor([], ['a'])).toEqual([])
    expect(releaseFor(['a'], ['a'])).toEqual([])
  })
})
