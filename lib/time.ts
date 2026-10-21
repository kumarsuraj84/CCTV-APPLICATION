// 24-hour clock in IST, no AM/PM: the one format used across the app.
const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
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
