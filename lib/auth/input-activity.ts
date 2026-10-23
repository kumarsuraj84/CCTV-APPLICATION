// P4-L1 review round 1, I-2 (P3-1 review M-6): only real input keeps a sign-in alive. Pure, no browser or crypto code, so both the
// browser (components/layout/InputReporter.tsx) and the proxy can use it, and it can be tested alone.
//
// The browser writes the time of the person's last real input — a key, a pointer press or move, a touch, a wheel — into the cookie
// `drishti-input` (whole seconds, in the server's clock: fix round 2, N-2, see inputCookieValue). The proxy dates the session's activity from it: a background request (the wall's token renewal, the
// 60 s refresh) carries the old input time and never moves the activity forward. The cookie can only make a session END sooner: it is
// never trusted beyond the request's own time, and a session's recorded activity never moves backwards because of it.

export const INPUT_COOKIE = 'drishti-input'
/** The events that count as somebody being there. A tab coming back into view (visibilitychange) is not one. */
export const PRESENCE_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'] as const

/**
 * P4-L1 fix round 2 (re-review N-2): the difference between the server's clock and the browser's (ms), from the server's time the page
 * was rendered with and the browser's time when it starts. 0 when the server's time is missing (a page from before this change).
 */
export function clockOffset(serverNowMs: number | undefined | null, browserNowMs: number): number {
  return typeof serverNowMs === 'number' && Number.isFinite(serverNowMs) && Number.isFinite(browserNowMs) ? Math.round(serverNowMs - browserNowMs) : 0
}

/**
 * The input cookie's value: the browser's time moved by that difference, so the cookie is in the SERVER's clock — a browser clock that
 * is hours wrong neither signs a working person out nor keeps an unattended sign-in alive (whole seconds).
 */
export function inputCookieValue(browserNowMs: number, offsetMs: number): string {
  return String(Math.floor((browserNowMs + offsetMs) / 1000))
}

/** The browser's last-input time in whole seconds, never later than `now`; null when missing or not a plausible time. */
export function readInputAt(value: string | undefined, now: number): number | null {
  const s = (value ?? '').trim()
  if (!/^\d{9,11}$/.test(s)) return null
  return Math.min(Number(s), now)
}

/**
 * When the session was last active (seconds): a new sign-in (no record yet) is active now; without any input report the request itself
 * counts (the rule before P4-L1, for a page that has not reported yet); otherwise the later of the recorded activity and the last input.
 */
export function activitySeen(o: { now: number; inputAt: number | null; known: { seen: number } | null }): number {
  if (!o.known) return o.now
  if (o.inputAt === null) return o.now
  return Math.max(o.known.seen, Math.min(o.inputAt, o.now))
}
