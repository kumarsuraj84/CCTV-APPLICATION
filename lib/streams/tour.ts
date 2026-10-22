// P4-L1 brief item 2 (LG-3): tour mode. Pure helpers (no browser code) so the schedule can be tested alone.
//
// A tour shows one "stop" after another every 5–60 seconds. On a wall of one location, one NVR, one group or one camera the stops are
// its pages; on a wall of several locations (a region or cluster) they go location by location, each location's own pages, so a page
// never mixes two locations. A location whose recorder is not reachable — every camera of it is "Recorder not reachable" — is skipped,
// like any page on which nothing could be seen. It pauses while the pointer is on the wall and while the tab is hidden, and stops on a key.

export const TOUR_SECONDS = [5, 10, 15, 30, 60] as const
export const TOUR_DEFAULT_SECONDS = 15
export const TOUR_MIN_SECONDS = 5
export const TOUR_MAX_SECONDS = 60

export function clampTourSeconds(s: number): number {
  if (!Number.isFinite(s)) return TOUR_DEFAULT_SECONDS
  return Math.min(TOUR_MAX_SECONDS, Math.max(TOUR_MIN_SECONDS, Math.round(s)))
}

export type TourCamera = { id: string; locationId: string; unreachable: boolean }
export type TourStop = { section: string; ids: string[] }

export function tourStops(cameras: readonly TourCamera[], perPage: number, byLocation: boolean): TourStop[] {
  const size = Math.max(1, Math.floor(perPage))
  const sections = new Map<string, TourCamera[]>()
  for (const c of cameras) {
    const key = byLocation ? c.locationId : 'all'
    sections.set(key, [...(sections.get(key) ?? []), c])
  }
  const stops: TourStop[] = []
  for (const [section, list] of sections) {
    if (list.every((c) => c.unreachable)) continue // the location's recorder is down: nothing to see there
    for (let i = 0; i < list.length; i += size) {
      const page = list.slice(i, i + size)
      if (page.every((c) => c.unreachable)) continue
      stops.push({ section, ids: page.map((c) => c.id) })
    }
  }
  return stops
}

export type TourState = { running: boolean; hovering: boolean; index: number; seconds: number }
export type TourEvent =
  | { type: 'start'; stops: number }
  | { type: 'stop' }
  | { type: 'key' }
  | { type: 'tick'; stops: number }
  | { type: 'hover'; on: boolean }
  | { type: 'interval'; seconds: number }

export const INITIAL_TOUR: TourState = Object.freeze({ running: false, hovering: false, index: 0, seconds: TOUR_DEFAULT_SECONDS })

export function tourReducer(s: TourState, e: TourEvent): TourState {
  switch (e.type) {
    case 'start':
      return e.stops > 0 ? { ...s, running: true, index: 0 } : { ...s, running: false }
    case 'stop':
    case 'key':
      return { ...s, running: false }
    case 'tick':
      if (!s.running || s.hovering || e.stops <= 0) return s
      return { ...s, index: (s.index + 1) % e.stops }
    case 'hover':
      return { ...s, hovering: e.on }
    case 'interval':
      return { ...s, seconds: clampTourSeconds(e.seconds) }
  }
}

/**
 * Review M-9: whether a key press stops the tour — any key, except a modifier key alone and keys typed into a form control (for example
 * the arrow keys that change the tour interval in its own select).
 */
export function keyStopsTour(e: { key: string; target: { tagName?: string } | null }): boolean {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return false
  const tag = (e.target?.tagName ?? '').toUpperCase()
  return !(tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA')
}

/** Review M-9: what the polite live region says — only when the tour starts or stops, never at every stop. */
export function tourAnnouncement(before: TourState, after: TourState): string | null {
  if (!before.running && after.running) return 'Tour started. Press any key to stop.'
  if (before.running && !after.running) return 'Tour stopped.'
  return null
}

/** The tour moves on only while it runs, the pointer is not on the wall and the tab is visible. */
export const tourRunning = (s: TourState, visible: boolean): boolean => s.running && !s.hovering && visible
