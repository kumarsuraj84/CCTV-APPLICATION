import { QUICK_RETRY_MS, RETRY_EVERY_MS } from '@/lib/streams/wall'

// P4-L1 brief item 2: one wall picture's connection, without React or the browser (the player is a `connect` function), so the
// cleanup can be tested. A picture connects while it has a token and is not paused; pausing (hidden tab, scrolled away, behind the large
// picture, over the bandwidth limit) closes its socket at once; `dispose` (the tile is removed: another page, another wall, leaving the
// page) closes everything and leaves no timer behind. A picture that cannot play reconnects after 2, 4, 8, 16, then every 30 seconds; one
// that played for a while and then ended (the gateway ends sessions after 30 minutes) comes back after 2. A new token does not
// reconnect a running picture: the token is only used to connect.

/** Give up on a connection that has shown no picture after this long, and try again later. */
export const CONNECT_TIMEOUT_MS = 25_000
/** A picture that played at least this long and then ended is a normal end of its session, not a failure. */
export const NORMAL_RUN_MS = 5_000
export const BACKOFF_FIRST_MS = 2_000
export const BACKOFF_MAX_MS = RETRY_EVERY_MS

/** The wait before attempt `failures + 1`: 2 s doubling up to 30 s; after a normal run it is the quick retry. */
export function reconnectDelayMs(failures: number, afterNormalRun: boolean): number {
  if (afterNormalRun) return QUICK_RETRY_MS
  const k = Math.max(1, Math.floor(failures))
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (k - 1))
}

export type TileView = 'connecting' | 'playing' | 'reconnecting' | 'unavailable' | 'paused'
export type Connector = (url: string, events: { onPlaying: () => void; onEnded: () => void }) => () => void

type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }

export type TileConnection = {
  /** The newest socket address (null: no token yet) and whether the picture is paused. */
  update(next: { url: string | null; paused: boolean }): void
  dispose(): void
}

export function createTileConnection(o: { connect: Connector; onView: (v: TileView) => void; now?: () => number; timers?: Timers }): TileConnection {
  const now = o.now ?? Date.now
  const timers: Timers = o.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }
  let url: string | null = null
  let paused = true
  let disposed = false
  let stop: (() => void) | null = null
  let generation = 0
  let watchdog: unknown = null
  let retry: unknown = null
  let playedAt = 0
  let failures = 0
  let view: TileView | null = null

  const show = (v: TileView) => {
    if (v === view || disposed) return
    view = v
    o.onView(v)
  }
  const clearWatchdog = () => {
    if (watchdog !== null) timers.clearTimeout(watchdog)
    watchdog = null
  }
  const clearRetry = () => {
    if (retry !== null) timers.clearTimeout(retry)
    retry = null
  }
  const close = () => {
    generation++ // events of the socket being closed are ignored from now on
    clearWatchdog()
    stop?.()
    stop = null
    playedAt = 0
  }
  const ended = (gen: number) => {
    if (gen !== generation || disposed) return
    const normal = playedAt > 0 && now() - playedAt >= NORMAL_RUN_MS
    close()
    failures = normal ? 0 : failures + 1
    show(normal ? 'reconnecting' : 'unavailable')
    clearRetry()
    retry = timers.setTimeout(() => {
      retry = null
      connectNow()
    }, reconnectDelayMs(failures, normal))
  }
  const connectNow = () => {
    if (disposed || paused || url === null || stop) return
    const gen = ++generation
    if (view !== 'reconnecting' && view !== 'unavailable') show('connecting')
    stop = o.connect(url, {
      onPlaying: () => {
        if (gen !== generation || disposed) return
        clearWatchdog()
        if (playedAt === 0) playedAt = now()
        show('playing')
      },
      onEnded: () => ended(gen),
    })
    watchdog = timers.setTimeout(() => {
      watchdog = null
      ended(gen)
    }, CONNECT_TIMEOUT_MS)
  }

  return {
    update(next) {
      if (disposed) return
      url = next.url
      paused = next.paused
      if (paused || url === null) {
        clearRetry()
        close()
        failures = 0
        show(paused ? 'paused' : 'connecting')
        return
      }
      if (!stop && retry === null) connectNow()
    },
    dispose() {
      if (disposed) return
      clearRetry()
      close()
      disposed = true
    },
  }
}
