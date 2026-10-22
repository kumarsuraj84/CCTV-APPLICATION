// Pure helpers for the playback screen (no browser, no server): the day's recordings as blocks on a 24 hour bar, clock text and the
// time picked on the bar. They are used by the screen and by the server, so they can be tested alone.
//
// "Shown time" (ruling R13): every time on this screen is a plain instant whose UTC clock fields are the wall clock that people see
// (India time). It is NVR time + PLAYBACK_OFFSET_MIN, so it is NOT the real UTC instant. The clock fields are read as written, with no
// time zone conversion anywhere, which keeps the screen the same whatever the time zone of the browser or the server is.

/**
 * The clock people see is India time: the shown clock is the real clock + 330 minutes. Used for "today" and for "not in the future".
 * This is the offset of DISPLAY_TIME_ZONE in lib/time.ts (India has no daylight saving time, so it is a constant); a unit test fails if that
 * zone changes, so the two cannot drift apart.
 */
export const SHOWN_CLOCK_OFFSET_MIN = 330
export const MINUTES_PER_DAY = 1440
/** Lengths offered on the screen, in minutes. */
export const LENGTH_CHOICES = [5, 10, 30, 60] as const
export const DEFAULT_LENGTH = 10
const MAX_LISTED = 20

const two = (n: number) => String(n).padStart(2, '0')

/** A block of the bar: minutes since midnight of the shown day (0 to 1440) and the same as percentages of the bar's width. */
export type Block = { startMin: number; endMin: number; left: number; width: number }

/** A real calendar day written `yyyy-mm-dd` between 2000 and 2100, else null. */
export function parseDay(day: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d ? { y, m, d } : null
}

/** The shown clock for a real moment (milliseconds since 1970): its UTC fields are the clock people see. */
export const shownNowMs = (nowMs: number): number => nowMs + SHOWN_CLOCK_OFFSET_MIN * 60_000

/** Today's day on the shown clock, `yyyy-mm-dd`. */
export function shownToday(nowMs: number): string {
  const t = new Date(shownNowMs(nowMs))
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`
}

/**
 * The day's recordings as blocks of the 24 hour bar. `segments` are ISO strings of shown time (as the server sends them). Parts outside
 * the day are cut off, the start is rounded down and the end up to the minute (so even a very short recording shows), and recordings that
 * overlap or touch are joined. Anything that does not parse, is empty or lies on another day is left out.
 */
export function dayBlocks(day: string, segments: readonly { start: string; end: string }[]): Block[] {
  const p = parseDay(day)
  if (!p) return []
  const dayStart = Date.UTC(p.y, p.m - 1, p.d)
  const spans: { startMin: number; endMin: number }[] = []
  for (const s of segments) {
    const from = Math.max(Date.parse(s.start), dayStart)
    const to = Math.min(Date.parse(s.end), dayStart + MINUTES_PER_DAY * 60_000)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    spans.push({ startMin: Math.floor((from - dayStart) / 60_000), endMin: Math.ceil((to - dayStart) / 60_000) })
  }
  spans.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const joined: { startMin: number; endMin: number }[] = []
  for (const s of spans) {
    const last = joined.at(-1)
    if (last && s.startMin <= last.endMin) last.endMin = Math.max(last.endMin, s.endMin)
    else joined.push({ ...s })
  }
  return joined.map((b) => ({ ...b, left: (b.startMin * 100) / MINUTES_PER_DAY, width: ((b.endMin - b.startMin) * 100) / MINUTES_PER_DAY }))
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A shown-time instant (ISO string) as "22 Oct, 14:35" (its clock fields, 24 hour), or an empty string when it does not parse. */
export function formatShortDateTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}

/** Minutes since midnight as 24 hour `HH:MM` (1440 is `24:00`, the end of the day). */
export function formatClock(minutes: number): string {
  return `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`
}

/** Minutes since midnight for `HH:MM` or `H:MM` (00:00 to 23:59), else null. */
export function parseClock(text: string): number | null {
  const m = typeof text === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(text.trim()) : null
  if (!m) return null
  const [h, mi] = [Number(m[1]), Number(m[2])]
  return h <= 23 && mi <= 59 ? h * 60 + mi : null
}

/** The minute (0 to 1439) for a position on the bar, as a part of its width (0 to 1), rounded to `step` minutes and kept inside the day. */
export function minuteAt(fraction: number, step = 1): number {
  const s = Number.isInteger(step) && step >= 1 ? step : 1
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const last = Math.floor((MINUTES_PER_DAY - 1) / s) * s
  return Math.min(last, Math.round((f * MINUTES_PER_DAY) / s) * s)
}

/** The start time to ask for: the day and minute as one shown-time instant (clock fields written in UTC form). Throws for anything invalid. */
export function startIso(day: string, minute: number): string {
  if (!parseDay(day) || !Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) throw new Error('Invalid start time.')
  return `${day}T${formatClock(minute)}:00Z`
}

/** The instant for `yyyy-mm-ddThh:mm[:ss[.fff]]Z`, strictly (a real time, with the Z), else null. */
export function parseStartIso(text: string): Date | null {
  const m = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z$/.exec(text) : null
  if (!m || !parseDay(`${m[1]}-${m[2]}-${m[3]}`)) return null
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (h > 23 || mi > 59 || s > 59) return null
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, s, ms))
}

/** The block that holds a minute (its end minute is not part of it), or null. */
export const blockAt = (blocks: readonly Block[], minute: number): Block | null => blocks.find((b) => b.startMin <= minute && minute < b.endMin) ?? null

/** The start minute of the first recording that begins after `minute`, or null. */
export const nextBlockStart = (blocks: readonly Block[], minute: number): number | null => blocks.find((b) => b.startMin > minute)?.startMin ?? null

/** The recordings in words, for a screen reader. Long lists are cut after 20. */
export function describeBlocks(blocks: readonly Block[]): string {
  if (blocks.length === 0) return 'No recordings.'
  const listed = blocks.slice(0, MAX_LISTED).map((b) => `${formatClock(b.startMin)} to ${formatClock(b.endMin)}`)
  const more = blocks.length - listed.length
  return `${blocks.length} ${blocks.length === 1 ? 'recording' : 'recordings'}: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`
}

// ── P4-L2: the timeline in seconds (LG-10 snap, LG-11 zoom, LG-12 edge, LG-13 jumps) ─────────────────────────────────────────────────
// India has no daylight saving time, so every shown day has exactly 86 400 seconds and "midnight" is always 00:00:00 of the next date.

export const DAY_SECONDS = 86_400
/** The narrowest window the bar zooms in to: 10 minutes. */
export const MIN_VIEW_SECONDS = 600
/** The window of the day that the bar shows, in seconds of the shown day (start < end, inside 0..86400). */
export type View = { start: number; end: number }
export const FULL_DAY: View = Object.freeze({ start: 0, end: DAY_SECONDS }) as View
/** A recording as seconds of the shown day, end exclusive. */
export type Span = { startSec: number; endSec: number }
/** How far a start may be ahead of the shown clock (NVR clocks run fast) and how far back it may be. */
export const PLAYABLE_FUTURE_SLACK_MS = 15 * 60_000
export const PLAYABLE_MAX_AGE_MS = 365 * 86_400_000
/** The outer part of the bar, on either side, that counts as its edge (LG-12). */
export const EDGE_FRACTION = 0.04
/** How long the pointer must stay at the edge before the bar pans or changes the day, and how often it repeats a pan. */
export const EDGE_DWELL_MS = 700
export const EDGE_REPEAT_MS = 500
/** One pan step at the edge: a quarter of the window. */
export const EDGE_PAN_FRACTION = 0.25
/** The jump buttons (LG-13), in seconds. */
export const JUMPS = [-600, -300, -60, 60, 300, 600] as const

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const clampNum = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export const isFullDay = (v: View): boolean => v.start <= 0 && v.end >= DAY_SECONDS

/** A view kept valid: inside the day, at least MIN_VIEW_SECONDS wide, the whole day at most. */
function normalView(start: number, span: number): View {
  const width = Math.round(clampNum(span, MIN_VIEW_SECONDS, DAY_SECONDS))
  const from = Math.round(clampNum(start, 0, DAY_SECONDS - width))
  return { start: from, end: from + width }
}

/** Zoom by `factor` (below 1 zooms in) around `focusSec`, which stays at the same place on the bar. Anything that is not a number changes nothing. */
export function zoomView(view: View, focusSec: number, factor: number): View {
  if (!finite(focusSec) || !finite(factor) || factor <= 0) return view
  const span = view.end - view.start
  const focus = clampNum(focusSec, view.start, view.end)
  const at = span > 0 ? (focus - view.start) / span : 0
  const next = clampNum(span * factor, MIN_VIEW_SECONDS, DAY_SECONDS)
  return normalView(focus - at * next, next)
}

/** Move the window by `deltaSec`, stopping at the ends of the day. */
export function panView(view: View, deltaSec: number): View {
  if (!finite(deltaSec)) return view
  return normalView(view.start + deltaSec, view.end - view.start)
}

/** The whole second (0 to 86 399) at a position on the bar (0 = left edge, 1 = right edge) of this window. */
export function secondAt(view: View, fraction: number): number {
  const f = finite(fraction) ? clampNum(fraction, 0, 1) : 0
  return Math.min(DAY_SECONDS - 1, view.end - 1, Math.floor(view.start + f * (view.end - view.start)))
}

/** Where a second is on the bar of this window (0 to 1 inside it; outside the window it is below 0 or above 1). */
export const fractionOf = (view: View, sec: number): number => (sec - view.start) / (view.end - view.start)

/**
 * The day's recordings as seconds of the shown day: cut at 00:00 on both sides (a recording across midnight shows on both days), start
 * rounded down and end up to the second, overlapping or touching ones joined, earliest first.
 */
export function daySpans(day: string, segments: readonly { start: string; end: string }[]): Span[] {
  const p = parseDay(day)
  if (!p) return []
  const dayStart = Date.UTC(p.y, p.m - 1, p.d)
  const spans: Span[] = []
  for (const s of segments) {
    const from = Math.max(Date.parse(s.start), dayStart)
    const to = Math.min(Date.parse(s.end), dayStart + DAY_SECONDS * 1000)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    spans.push({ startSec: Math.floor((from - dayStart) / 1000), endSec: Math.ceil((to - dayStart) / 1000) })
  }
  spans.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  const joined: Span[] = []
  for (const s of spans) {
    const last = joined.at(-1)
    if (last && s.startSec <= last.endSec) last.endSec = Math.max(last.endSec, s.endSec)
    else joined.push({ ...s })
  }
  return joined
}

/** The parts of the recordings inside the window, with their place on the bar as percentages of the window. */
export function spansInView(spans: readonly Span[], view: View): (Span & { left: number; width: number })[] {
  const width = view.end - view.start
  const out: (Span & { left: number; width: number })[] = []
  for (const s of spans) {
    const from = Math.max(s.startSec, view.start)
    const to = Math.min(s.endSec, view.end)
    if (to <= from) continue
    out.push({ startSec: from, endSec: to, left: ((from - view.start) * 100) / width, width: ((to - from) * 100) / width })
  }
  return out
}

/** The recording that holds a second (its end second is not part of it), or null. */
export const spanAt = (spans: readonly Span[], sec: number): Span | null => spans.find((s) => s.startSec <= sec && sec < s.endSec) ?? null

/**
 * LG-10: a click is moved to the nearest recording. Inside one it stays. In a gap it goes to whichever is nearer: the START of the next
 * recording, or the last minute of the previous one (so that something is left to play; a previous recording shorter than a minute is
 * played from its start). Null when there are no recordings.
 */
export function snapToRecording(spans: readonly Span[], sec: number): number | null {
  if (spans.length === 0 || !finite(sec)) return null
  if (spanAt(spans, sec)) return sec
  const next = spans.find((s) => s.startSec > sec)
  const prev = [...spans].reverse().find((s) => s.endSec <= sec)
  const toNext = next ? next.startSec - sec : Number.POSITIVE_INFINITY
  const toPrev = prev ? sec - prev.endSec : Number.POSITIVE_INFINITY
  if (next && toNext <= toPrev) return next.startSec
  if (prev) return Math.max(prev.startSec, prev.endSec - 60)
  return null
}

const dayOf = (ms: number) => {
  const t = new Date(ms)
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`
}

/** A shown day and second moved by `deltaSec`, across midnight (and months and years) as needed. */
export function shiftTime(day: string, sec: number, deltaSec: number): { day: string; sec: number } {
  const p = parseDay(day)
  if (!p || !finite(sec) || !finite(deltaSec)) return { day, sec }
  const ms = Date.UTC(p.y, p.m - 1, p.d) + Math.round(sec + deltaSec) * 1000
  const next = dayOf(ms)
  const q = parseDay(next)!
  return { day: next, sec: Math.round((ms - Date.UTC(q.y, q.m - 1, q.d)) / 1000) }
}

/** The plain name of a jump button. */
export function jumpLabel(deltaSec: number): string {
  const min = Math.abs(Math.round(deltaSec / 60))
  return `${deltaSec < 0 ? 'Back' : 'Forward'} ${min} ${min === 1 ? 'minute' : 'minutes'}`
}

/** LG-13 keyboard: left / right 30 seconds (with Shift 5 minutes), Page Up / Page Down an hour; null for any other key. */
export function keyMove(key: string, shift: boolean): number | null {
  if (key === 'ArrowLeft') return shift ? -300 : -30
  if (key === 'ArrowRight') return shift ? 300 : 30
  if (key === 'PageUp') return 3600
  if (key === 'PageDown') return -3600
  return null
}

/** True when a start (a shown-time instant) is not more than 15 minutes ahead of the shown clock and not older than a year. `nowMs` is the real clock. */
export function isPlayableStart(startMs: number, nowMs: number): boolean {
  const shownNow = shownNowMs(nowMs)
  return finite(startMs) && startMs <= shownNow + PLAYABLE_FUTURE_SLACK_MS && startMs >= shownNow - PLAYABLE_MAX_AGE_MS
}

/** Which edge of the bar a position is at (the outer 4 % on either side), or null. */
export function edgeSide(fraction: number): 'left' | 'right' | null {
  if (!finite(fraction)) return null
  if (fraction <= EDGE_FRACTION) return 'left'
  if (fraction >= 1 - EDGE_FRACTION) return 'right'
  return null
}

export type EdgeAction = 'pan-left' | 'pan-right' | 'previous-day' | 'next-day' | null

/**
 * LG-12, guarded: dwelling at an edge pans a zoomed-in window; when there is nothing left to pan to (or the whole day is shown) it changes
 * to the previous or next day, but only when that is allowed (never beyond today, never before the oldest recording or the year back).
 */
export function edgeAction(view: View, side: 'left' | 'right', o: { canPreviousDay: boolean; canNextDay: boolean }): EdgeAction {
  if (side === 'left') return view.start > 0 ? 'pan-left' : o.canPreviousDay ? 'previous-day' : null
  return view.end < DAY_SECONDS ? 'pan-right' : o.canNextDay ? 'next-day' : null
}

const TICK_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600]

/** Marks for the window: about 4 to 12 of them, on round clock times, labelled HH:MM; the larger steps are `major`. */
export function viewTicks(view: View): { sec: number; label: string; major: boolean }[] {
  const span = view.end - view.start
  const step = TICK_STEPS.find((s) => span / s <= 12) ?? 21_600
  const major = isFullDay(view) ? 21_600 : step
  const out: { sec: number; label: string; major: boolean }[] = []
  for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) out.push({ sec: t, label: formatClock(Math.round(t / 60)), major: t % major === 0 })
  return out
}

/** Seconds of the day as 24 hour `HH:MM:SS`. */
export function formatClockSeconds(sec: number): string {
  const s = Math.max(0, Math.min(DAY_SECONDS, Math.floor(sec)))
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`
}

/** Seconds of the day for `HH:MM` or `HH:MM:SS` (24 hour, 00:00:00 to 23:59:59), else null. */
export function parseClockSeconds(text: string): number | null {
  const m = typeof text === 'string' ? /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim()) : null
  if (!m) return null
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  return h <= 23 && mi <= 59 && s <= 59 ? h * 3600 + mi * 60 + s : null
}

/** The start to ask for, with its second: `yyyy-mm-ddTHH:MM:SSZ` (a shown time). Throws for anything invalid. */
export function startIsoAt(day: string, sec: number): string {
  if (!parseDay(day) || !Number.isInteger(sec) || sec < 0 || sec >= DAY_SECONDS) throw new Error('Invalid start time.')
  return `${day}T${formatClockSeconds(sec)}Z`
}
