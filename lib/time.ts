// 24-hour clock in IST, no AM/PM: the one format used across the app.
/** The time zone every screen shows. The playback screen's shown clock (SHOWN_CLOCK_OFFSET_MIN in lib/streams/timeline.ts) must be this zone's offset; a test checks it. */
export const DISPLAY_TIME_ZONE = 'Asia/Kolkata'
const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`
}
