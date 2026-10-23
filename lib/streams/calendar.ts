// Pure month helpers for the playback calendar. Months are 1 to 12; weeks start on Monday.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** The month as weeks of seven cells, Monday first; a cell is a day number or null (outside the month). */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7))
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12 + 12) % 12 + 1 }
}

export const dayString = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

export const monthLabel = (year: number, month: number): string => `${MONTHS[month - 1]} ${year}`

export const dayLabel = (year: number, month: number, day: number): string =>
  `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day} ${MONTHS[month - 1]} ${year}`

export const WEEKDAY_NAMES: readonly string[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** How many months back from the current month the calendar goes. */
export const MONTHS_BACK = 12

const monthIndex = (year: number, month: number) => year * 12 + (month - 1)

/** The first and last month that can be shown, for today's day (yyyy-mm-dd): the current month and 12 months before it. */
export function monthBounds(today: string): { min: { year: number; month: number }; max: { year: number; month: number } } {
  const max = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
  return { min: shiftMonth(max.year, max.month, -MONTHS_BACK), max }
}

export function monthInBounds(year: number, month: number, today: string): boolean {
  const { min, max } = monthBounds(today)
  const i = monthIndex(year, month)
  return i >= monthIndex(min.year, min.month) && i <= monthIndex(max.year, max.month)
}

/** The day if its month can be shown, else today. */
export const clampDay = (day: string, today: string): string => (monthInBounds(Number(day.slice(0, 4)), Number(day.slice(5, 7)), today) ? day : today)

/**
 * P4-L2 review I-3: whether the previous and the next day may be opened. The only bounds are the 12 months back and today: the oldest
 * recording is a hint ("Go to it") and NEVER limits navigation (a real NVR's answer may not be the true oldest).
 */
export function dayNavigation(day: string, today: string): { canPreviousDay: boolean; canNextDay: boolean } {
  const t = Date.parse(`${day}T00:00:00Z`)
  const prev = new Date(t - 86_400_000)
  return { canPreviousDay: Number.isFinite(t) && monthInBounds(prev.getUTCFullYear(), prev.getUTCMonth() + 1, today), canNextDay: Number.isFinite(t) && day < today }
}

// ── P4-L2 brief item 2: the recorder's clock offset on the calendar ────────────────────────────────────────────────────────────────────
// The NVR's calendar marks ITS days. Shown time = NVR time + offset, so NVR day d covers the shown span [d 00:00 + offset, d+1 00:00 +
// offset): with an offset it touches two shown days. Every shown day such a span touches is marked: a hint that there may be recordings
// that day. Review m-4: a skew under 10 minutes spills only seconds or minutes into the neighbouring day and is treated as noise (no
// extra day is marked or asked for); the caller leaves out days after today. Any day can still be opened.

const DAY_MS = 86_400_000
const MAX_OFFSET_MS = DAY_MS
/** Review m-4: an offset below this is noise for the calendar. */
export const CALENDAR_NOISE_MS = 10 * 60_000
const effective = (offsetMs: number) => (Math.abs(offsetMs) < CALENDAR_NOISE_MS ? 0 : offsetMs)

/** The NVR months whose days can reach into this shown month: the month itself, plus the month before (offset > 0) or after (offset < 0). */
export function nvrMonthsFor(year: number, month: number, offsetMs: number): { year: number; month: number }[] {
  const self = { year, month }
  if (!Number.isFinite(offsetMs) || effective(offsetMs) === 0) return [self]
  return offsetMs > 0 ? [shiftMonth(year, month, -1), self] : [self, shiftMonth(year, month, 1)]
}

/** The days (1 to 31) of the SHOWN month `year`-`month` that the NVR days of `nvr` reach into, with the recorder's offset in milliseconds. */
export function shownRecordedDays(nvr: readonly { year: number; month: number; days: readonly number[] }[], offsetMs: number, year: number, month: number): number[] {
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > MAX_OFFSET_MS) return []
  const first = Date.UTC(year, month - 1, 1)
  const after = Date.UTC(year, month, 1)
  const out = new Set<number>()
  for (const m of nvr) {
    const length = daysInMonth(m.year, m.month)
    for (const d of m.days) {
      if (!Number.isInteger(d) || d < 1 || d > length) continue
      const from = Date.UTC(m.year, m.month - 1, d) + effective(offsetMs)
      const to = from + DAY_MS // exclusive
      for (let t = Math.floor(from / DAY_MS) * DAY_MS; t < to; t += DAY_MS) {
        if (t >= first && t < after) out.add(new Date(t).getUTCDate())
      }
    }
  }
  return [...out].sort((a, b) => a - b)
}
