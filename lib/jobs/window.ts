// Maintenance windows and zone-explicit instants (P7-0). Pure: time is always passed in.
import type { EpochMs, MaintenanceWindow } from './types'

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Epoch ms of an ISO-8601 instant that names its zone (Z or ±HH:MM); null for anything else or an impossible date. */
export function parseZonedInstant(text: string): EpochMs | null {
  const m = INSTANT.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const s = m[6] ? Number(m[6]) : 0
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  const check = new Date(utc)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null
  let offsetMin = 0
  if (m[8] !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1
    const oh = Number(m[8].slice(1, 3))
    const om = Number(m[8].slice(4, 6))
    if (oh > 14 || om > 59) return null
    offsetMin = sign * (oh * 60 + om)
  }
  return utc - offsetMin * 60_000
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' })
    formatters.set(timeZone, f)
    return f
  } catch {
    return null
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function localParts(timeZone: string, at: EpochMs): { dow: number; minutes: number } | null {
  const f = formatterFor(timeZone)
  if (!f) return null
  const parts = Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]))
  return { dow: WEEKDAYS[parts.weekday] ?? 0, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

function hhmm(text: string): number | null {
  const m = HHMM.exec(text)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Problems with a window, in plain words; empty when it is valid. */
export function validateWindow(w: MaintenanceWindow): string[] {
  const issues: string[] = []
  if (w.kind === 'absolute') {
    const s = parseZonedInstant(w.start)
    const e = parseZonedInstant(w.end)
    if (s === null) issues.push('start must be an ISO-8601 time with Z or an offset')
    if (e === null) issues.push('end must be an ISO-8601 time with Z or an offset')
    if (s !== null && e !== null && e <= s) issues.push('end must be after start')
    return issues
  }
  if (w.kind !== 'daily') return ['unknown window kind']
  if (!formatterFor(w.time_zone)) issues.push(`unknown time zone "${w.time_zone}"`)
  const s = hhmm(w.start)
  const e = hhmm(w.end)
  if (s === null) issues.push('start must be HH:MM (24-hour)')
  if (e === null) issues.push('end must be HH:MM (24-hour)')
  if (s !== null && e !== null && s === e) issues.push('start and end must differ')
  if (w.days !== undefined) {
    if (w.days.length === 0) issues.push('days must not be empty (leave it out for every day)')
    if (w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) issues.push('days are 0 (Sunday) to 6 (Saturday)')
  }
  return issues
}

/** Whether new jobs may be offered at `at`. No window means always open; an invalid window is closed. */
export function isWindowOpen(w: MaintenanceWindow | null, at: EpochMs): boolean {
  if (w === null) return true
  if (validateWindow(w).length > 0) return false
  if (w.kind === 'absolute') {
    return at >= (parseZonedInstant(w.start) as number) && at < (parseZonedInstant(w.end) as number)
  }
  const local = localParts(w.time_zone, at)
  if (!local) return false
  const s = hhmm(w.start) as number
  const e = hhmm(w.end) as number
  const dayOk = (dow: number) => w.days === undefined || w.days.includes(dow)
  if (s < e) return local.minutes >= s && local.minutes < e && dayOk(local.dow)
  if (local.minutes >= s) return dayOk(local.dow)
  if (local.minutes < e) return dayOk((local.dow + 6) % 7)
  return false
}
