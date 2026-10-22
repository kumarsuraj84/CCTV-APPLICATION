// Pure helpers for the playback screen (no browser, no server): the day's recordings as blocks on a 24 hour bar, clock text and the
// time picked on the bar. They are used by the screen and by the server, so they can be tested alone.
//
// "Shown time" (ruling R13): every time on this screen is a plain instant whose UTC clock fields are the wall clock that people see
// (India time). It is NVR time + PLAYBACK_OFFSET_MIN, so it is NOT the real UTC instant. The clock fields are read as written, with no
// time zone conversion anywhere, which keeps the screen the same whatever the time zone of the browser or the server is.

/** The clock people see is India time: the shown clock is the real clock + 330 minutes. Used for "today" and for "not in the future". */
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
