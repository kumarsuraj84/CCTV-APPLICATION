// P4-L1 brief item 2: bounded live concurrency. Pure helpers (no browser, no server code) so the rules can be tested alone.
//
// The count itself belongs to the database (review round 1, I-1; migration 20261021000040): media_session_create_live counts, under
// one lock per person, every live stream the person holds — open sockets and tokens that can still connect — and hands out tokens only
// up to LIVE_MAX_STREAMS_PER_USER; media_session_open refuses a socket above it. Here:
//   - the setting (maxStreamsPerUser), which the server passes to the database;
//   - the wall's own choice (allocateTiles): at most that many pictures play at once; tiles on screen come first, cameras whose recorder
//     cannot be reached last; the rest say "Paused to save bandwidth" (no still yet: thumbnails are not built); tiles out of view play
//     nothing;
//   - what the wall lets go of (releaseFor) when its list changes, so its unused tokens stop counting at once.

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

/** `idle`: not on screen, or behind the large picture: no socket, no word needed (the tile is out of sight). */
export type TileAllocation = { play: string[]; bandwidth: string[]; idle: string[] }

/**
 * The wall's own rule for its page of tiles: tiles on screen play up to `max` — in page order, but cameras whose recorder cannot be
 * reached (`unreachable`) only after the others (review M-7: they would only fail and wait); the rest are paused for bandwidth. Tiles
 * not on screen do not play. While the large picture is open the grid behind it plays nothing (the large picture is its own).
 */
export function allocateTiles(page: readonly string[], onScreen: ReadonlySet<string>, max: number, largeOpen = false, unreachable: ReadonlySet<string> = new Set()): TileAllocation {
  if (largeOpen) return { play: [], bandwidth: [], idle: [...page] }
  const idle = page.filter((id) => !onScreen.has(id))
  const shown = page.filter((id) => onScreen.has(id))
  const order = [...shown.filter((id) => !unreachable.has(id)), ...shown.filter((id) => unreachable.has(id))]
  const chosen = new Set(order.slice(0, Math.max(0, max)))
  return { play: shown.filter((id) => chosen.has(id)), bandwidth: shown.filter((id) => !chosen.has(id)), idle }
}

/** The cameras of the old list that are not on the new one (the wall releases them; review I-1). */
export function releaseFor(previous: readonly string[], next: readonly string[]): string[] {
  const keep = new Set(next)
  return previous.filter((id) => !keep.has(id))
}
