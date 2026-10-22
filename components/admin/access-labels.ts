// Plain-English words for the access screens (P2-3). "Location" is the product word for a store, office, DC or warehouse.
import { formatDateTime } from '@/lib/time'

export const SOURCE_LABELS: Record<string, string> = {
  manual: 'Given by an administrator',
  'migrated:store': 'Moved over from an old location grant',
  'migrated:zone': 'Moved over from an old zone grant',
  'migrated:home': 'Moved over from the old home-location rule',
  'migrated:manager': 'Moved over from the old manager role',
  'migrated:camera': 'Moved over from an old camera grant',
  'migrated:admin': 'Moved over from the administrator role',
}

export const STATE_LABELS: Record<string, string> = { active: 'In effect', future: 'Not started yet', expired: 'Ended', revoked: 'Removed' }

export const AREA_LABELS: Record<string, string> = { cctv: 'CCTV', it: 'IT', wifi: 'Wi-Fi', admin: 'Administration' }
export const AREAS = ['cctv', 'it', 'wifi', 'admin'] as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-10-25" → "25 Oct 2026". */
export function formatDay(day: string | null): string {
  if (!day) return '—'
  const [y, m, d] = day.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`
}

/** When a grant counts, in words (IST, 24-hour). */
export function validityText(g: { state: string; validFrom: string; lastDay: string | null }): string {
  const until = g.lastDay ? `until the end of ${formatDay(g.lastDay)}` : 'no end date'
  if (g.state === 'future') return `Starts ${formatDateTime(g.validFrom)}, ${until}`
  if (g.state === 'expired') return `Ended at the end of ${formatDay(g.lastDay)}`
  return `From ${formatDateTime(g.validFrom)}, ${until}`
}

export const SCOPE_KIND_LABELS: Record<string, string> = {
  organization: 'Whole organisation',
  location: 'All cameras and assets of the location, including ones added later',
  camera: 'This camera only',
  asset: 'This asset only',
}
