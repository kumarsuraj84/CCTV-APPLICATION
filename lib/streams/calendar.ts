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
