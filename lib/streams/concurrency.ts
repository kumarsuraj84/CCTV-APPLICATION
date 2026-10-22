// P4-L1 brief item 2: bounded live concurrency. Pure helpers (no browser, no server code) so the rules can be tested alone.
//
// Two places use them:
//   - the server (openStreams): a new opening may bring the person's DIFFERENT open live streams up to LIVE_MAX_STREAMS_PER_USER;
//     what is open is counted by the session registry (media_sessions_live_open: sockets the gateway opened and still checks);
//   - the wall (LiveWall): at most that many pictures play at once; the tiles on screen come first, the rest say "Paused to save
//     bandwidth" (a still is not available yet: thumbnails are not built), and tiles scrolled out of view or in a hidden tab play nothing.

/** Simultaneous live streams per person when LIVE_MAX_STREAMS_PER_USER is not set (or not a whole number from 1 to 100). */
export const DEFAULT_MAX_STREAMS_PER_USER = 25
/** The highest value the setting may take (four 5×5 walls). */
export const MAX_STREAMS_PER_USER_CEILING = 100

export const MSG_PAUSED_FOR_BANDWIDTH = 'Paused to save bandwidth'

/** The per-person limit from the environment: a whole number 1..100, anything else the default (never unbounded, never zero). */
export function maxStreamsPerUser(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.LIVE_MAX_STREAMS_PER_USER ?? '').trim()
  if (!/^\d{1,3}$/.test(raw)) return DEFAULT_MAX_STREAMS_PER_USER
  const n = Number(raw)
  if (n < 1) return DEFAULT_MAX_STREAMS_PER_USER
  return Math.min(n, MAX_STREAMS_PER_USER_CEILING)
}

/**
 * Which of the requested streams (stream names, in the wall's order) may be opened, given the person's open live streams. Streams the
 * person already has open are renewals: they are kept first and never counted twice. The others fill what is left of `max` in order;
 * the rest are `paused`. Repeats in `requested` count once.
 */
export function capStreams(requested: readonly string[], openNow: ReadonlySet<string>, max: number): { allowed: Set<string>; paused: string[] } {
  const wanted = [...new Set(requested)]
  const others = [...openNow].filter((s) => !wanted.includes(s)).length
  let room = Math.max(0, max - others)
  const allowed = new Set<string>()
  for (const s of wanted) {
    if (openNow.has(s) && room > 0) {
      allowed.add(s)
      room--
    }
  }
  const paused: string[] = []
  for (const s of wanted) {
    if (allowed.has(s)) continue
    if (room > 0) {
      allowed.add(s)
      room--
    } else paused.push(s)
  }
  return { allowed, paused }
}

/** `idle`: not on screen, or behind the large picture: no socket, no word needed (the tile is out of sight). */
export type TileAllocation = { play: string[]; bandwidth: string[]; idle: string[] }

/**
 * The wall's own rule for its page of tiles: tiles on screen play, in page order, up to `max` (the rest are paused for bandwidth);
 * tiles not on screen do not play. While the large picture is open the grid behind it plays nothing (the large picture is its own).
 */
export function allocateTiles(page: readonly string[], onScreen: ReadonlySet<string>, max: number, largeOpen = false): TileAllocation {
  if (largeOpen) return { play: [], bandwidth: [], idle: [...page] }
  const play: string[] = []
  const bandwidth: string[] = []
  const idle: string[] = []
  for (const id of page) {
    if (!onScreen.has(id)) idle.push(id)
    else if (play.length < max) play.push(id)
    else bandwidth.push(id)
  }
  return { play, bandwidth, idle }
}
