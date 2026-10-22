import { describe, expect, it } from 'vitest'
import { clampTourSeconds, INITIAL_TOUR, TOUR_DEFAULT_SECONDS, TOUR_SECONDS, tourReducer, tourRunning, tourStops, type TourCamera } from '@/lib/streams/tour'

// P4-L1 brief item 2 (LG-3): tour mode cycles the pages (and, on a wall of several locations, location by location) every 5–60 s,
// skipping locations whose NVR is down, pausing while the pointer is on the wall (and while the tab is hidden), stopping on a key.

const cam = (id: string, locationId: string, unreachable = false): TourCamera => ({ id, locationId, unreachable })

describe('tour stops', () => {
  it('one location or group: its pages in order', () => {
    const cams = ['a', 'b', 'c', 'd', 'e'].map((id) => cam(id, 'L1'))
    expect(tourStops(cams, 2, false).map((s) => s.ids)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('several locations: location by location, each location\'s own pages (a page never mixes two locations)', () => {
    const cams = [cam('a', 'L1'), cam('b', 'L1'), cam('c', 'L1'), cam('d', 'L2'), cam('e', 'L3'), cam('f', 'L3')]
    const stops = tourStops(cams, 2, true)
    expect(stops.map((s) => [s.section, s.ids])).toEqual([['L1', ['a', 'b']], ['L1', ['c']], ['L2', ['d']], ['L3', ['e', 'f']]])
  })

  it('skips a location whose recorder is not reachable (every camera of it), and a page where nothing can be seen', () => {
    const cams = [cam('a', 'L1'), cam('b', 'L2', true), cam('c', 'L2', true), cam('d', 'L3'), cam('e', 'L3', true)]
    expect(tourStops(cams, 4, true).map((s) => s.section)).toEqual(['L1', 'L3'])
    // In one group: a page whose cameras are all behind a down NVR is skipped, the others kept.
    const group = [cam('a', 'L1', true), cam('b', 'L1', true), cam('c', 'L2'), cam('d', 'L2', true)]
    expect(tourStops(group, 2, false).map((s) => s.ids)).toEqual([['c', 'd']])
    expect(tourStops([cam('x', 'L9', true)], 4, true)).toEqual([])
  })
})

describe('tour timing', () => {
  it('runs every 5 to 60 seconds; anything else is brought inside', () => {
    expect([...TOUR_SECONDS]).toEqual([5, 10, 15, 30, 60])
    expect(TOUR_DEFAULT_SECONDS).toBe(15)
    expect([1, 5, 12, 60, 300, NaN].map(clampTourSeconds)).toEqual([5, 5, 12, 60, 60, TOUR_DEFAULT_SECONDS])
  })

  it('advances only while running, not hovered, and visible; wraps round; stops on a key', () => {
    let s = tourReducer(INITIAL_TOUR, { type: 'start', stops: 3 })
    expect(s).toMatchObject({ running: true, index: 0 })
    expect(tourRunning(s, true)).toBe(true)
    s = tourReducer(s, { type: 'tick', stops: 3 })
    s = tourReducer(s, { type: 'tick', stops: 3 })
    expect(s.index).toBe(2)
    s = tourReducer(s, { type: 'tick', stops: 3 })
    expect(s.index).toBe(0)
    s = tourReducer(s, { type: 'hover', on: true })
    expect(tourRunning(s, true)).toBe(false)
    expect(tourReducer(s, { type: 'tick', stops: 3 }).index).toBe(0) // a tick while paused moves nothing
    s = tourReducer(s, { type: 'hover', on: false })
    expect(tourRunning(s, false)).toBe(false) // hidden tab
    expect(tourRunning(s, true)).toBe(true)
    s = tourReducer(s, { type: 'interval', seconds: 90 })
    expect(s.seconds).toBe(60)
    s = tourReducer(s, { type: 'key' })
    expect(s.running).toBe(false)
    expect(tourRunning(s, true)).toBe(false)
  })

  it('a tour with nothing to show does not start; fewer stops later keeps the index inside', () => {
    expect(tourReducer(INITIAL_TOUR, { type: 'start', stops: 0 }).running).toBe(false)
    const s = { ...tourReducer(INITIAL_TOUR, { type: 'start', stops: 5 }), index: 4 }
    expect(tourReducer(s, { type: 'tick', stops: 2 }).index).toBe(1)
  })
})
