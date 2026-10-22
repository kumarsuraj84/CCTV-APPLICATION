/** How often the Monitoring page asks the server for fresh numbers while it is open and visible. */
export const FAST_REFRESH_MS = 8_000
export const SLOW_REFRESH_MS = 30_000
/** A page that was opened this recently keeps the fast pace, because the person is probably waiting for something. */
export const FAST_WINDOW_MS = 2 * 60_000

/** Quickly while a check is waiting or running, or for the first two minutes after the page was opened; otherwise slowly. */
export function refreshDelayMs(o: { busy: boolean; openedForMs: number }): number {
  return o.busy || o.openedForMs < FAST_WINDOW_MS ? FAST_REFRESH_MS : SLOW_REFRESH_MS
}
