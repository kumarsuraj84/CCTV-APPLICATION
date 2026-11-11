import { countsText } from '@/lib/live/rollups'
import type { StoreStatusRow } from '@/lib/queries/status'

// Final fix Y (final review C M-10, M-12): the camera column of the Locations list in the words of every other screen (countsText:
// live, offline, recorder not reachable, not checked, switched off), and the ?state= filter the Home tiles link to.

export type LocationState = 'offline' | 'unreachable' | 'stale' | 'not_checked'
export const LOCATION_STATE_LABELS: Record<LocationState, string> = {
  offline: 'Offline', unreachable: 'Recorder not reachable', stale: 'Not checked lately', not_checked: 'Not checked yet',
}
export const parseLocationState = (v: string | undefined): LocationState | null =>
  v && Object.hasOwn(LOCATION_STATE_LABELS, v) ? (v as LocationState) : null

export function locationCountsText(s: StoreStatusRow | undefined): { text: string; bad: boolean; quiet: boolean } {
  if (!s) return { text: '—', bad: false, quiet: true }
  const unreachable = s.cameras_recorder_unreachable ?? 0
  const off = s.cameras_monitoring_off ?? 0
  const text = countsText({
    total: s.cameras_total, live: s.cameras_live, offline: s.cameras_down, recorderUnreachable: unreachable,
    notChecked: s.cameras_unknown, stale: s.cameras_stale, off,
  })
  return { text, bad: s.cameras_down > 0, quiet: s.cameras_total === 0 || s.cameras_live + s.cameras_down + unreachable === 0 }
}

export function locationListFilter(state: LocationState | null, s: StoreStatusRow | undefined): boolean {
  if (!state) return true
  if (!s) return false
  if (state === 'offline') return s.cameras_down > 0
  if (state === 'unreachable') return (s.cameras_recorder_unreachable ?? 0) > 0
  if (state === 'stale') return s.cameras_stale > 0
  return s.cameras_unknown > 0
}
