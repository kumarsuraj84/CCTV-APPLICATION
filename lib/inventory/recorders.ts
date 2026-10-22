import type { AdminClient } from '@/lib/admin/types'

// Recorders (NVRs) as explicit records (P2-5a, decision D-4). Owner addition 2026-10-22: monitoring can be switched off per NVR (the
// real estate is imported into the local database, and a switched-off NVR must never be contacted). Then nothing — the worker's
// checks, camera discovery, live video, playback or fast playback — opens a connection to it or to its cameras, and its cameras show
// "Switched off" instead of offline. Switching it is done by recorder_set_monitoring (super administrators or admin.inventory, with a
// reason, audited); the screens come with P2-5c.

export const MSG_MONITORING_OFF = 'Monitoring is switched off for this NVR.'

export type CameraRoute = { id: string; location_id: string; recorder_id: string | null }

type RecorderRow = { id: string; location_id: string; migrated_from_location_id?: string | null }

/**
 * Each location's primary recorder from rows ordered by (created_at, id): the recorder that carries the location's legacy NVR columns
 * (seam, `migrated_from_location_id` = the location; review M3) when there is one, else the first one made. The same rule as the
 * database's `recorder_primary_of`.
 */
export function pickPrimaries<T extends RecorderRow>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  const isSeam = (r: T) => r.migrated_from_location_id === r.location_id
  for (const r of rows) {
    const current = out.get(r.location_id)
    if (!current || (isSeam(r) && !isSeam(current))) out.set(r.location_id, r)
  }
  return out
}

/** Monitoring counts only when it is switched on AND the recorder's asset is enabled (review M4). */
export function isMonitored(r: { monitoring_enabled: boolean; assets?: unknown }): boolean {
  const asset = (Array.isArray(r.assets) ? r.assets[0] : r.assets) as { enabled?: boolean } | null | undefined
  return r.monitoring_enabled && asset?.enabled !== false
}

/**
 * The primary recorder of each location (see pickPrimaries) — the NVR the legacy location columns describe during the P2-5a seam
 * (decision D5-7) — and whether it is monitored.
 */
export async function primaryRecorders(admin: AdminClient, orgId: string, locationIds: readonly string[]): Promise<Map<string, { id: string; monitoring: boolean }>> {
  const out = new Map<string, { id: string; monitoring: boolean }>()
  const ids = [...new Set(locationIds)]
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('recorders').select('id, location_id, created_at, migrated_from_location_id, monitoring_enabled, assets!recorders_asset_fk!inner(archived_at, enabled)')
      .eq('org_id', orgId).in('location_id', ids.slice(i, i + 200)).is('assets.archived_at', null).order('created_at').order('id')
    if (error) throw new Error('Could not read the recorders.')
    for (const [loc, r] of pickPrimaries(data ?? [])) out.set(loc, { id: r.id, monitoring: isMonitored(r) })
  }
  return out
}

/**
 * Until P2-5b resolves every camera through its own recorder, live video and playback reach a camera through its location's primary
 * NVR (the legacy columns). So a camera is reachable only when it is mapped to that primary recorder and the recorder's monitoring is
 * switched on; `off` lists the cameras whose own recorder is switched off (they get the plain "switched off" message). A camera on
 * another NVR of its location is never opened through the wrong box.
 */
export async function legacyReachable(admin: AdminClient, orgId: string, cameras: readonly CameraRoute[]): Promise<{ usable: Set<string>; off: Set<string> }> {
  const primary = await primaryRecorders(admin, orgId, cameras.map((c) => c.location_id))
  const off = await camerasWithMonitoringOff(admin, orgId, cameras.map((c) => c.id))
  const usable = new Set<string>()
  for (const c of cameras) {
    const p = primary.get(c.location_id)
    if (p && p.monitoring && c.recorder_id === p.id && !off.has(c.id)) usable.add(c.id)
  }
  return { usable, off }
}

/**
 * Of these cameras, the ones whose recorder (the active mapping) has monitoring switched off. Service role, after the person's own
 * access check, scoped to the organisation. A camera without a recorder is not "switched off" (it is simply not mapped).
 */
export async function camerasWithMonitoringOff(admin: AdminClient, orgId: string, cameraIds: readonly string[]): Promise<Set<string>> {
  const off = new Set<string>()
  const ids = [...new Set(cameraIds)]
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('cameras').select('id, recorder_id').eq('org_id', orgId).in('id', ids.slice(i, i + 200)).not('recorder_id', 'is', null)
    if (error) throw new Error('Could not read the cameras.')
    const recorders = [...new Set((data ?? []).map((c) => c.recorder_id as string))]
    if (recorders.length === 0) continue
    const { data: recs, error: rErr } = await admin.from('recorders').select('id, monitoring_enabled, assets!recorders_asset_fk!inner(enabled)').eq('org_id', orgId).in('id', recorders)
    if (rErr) throw new Error('Could not read the recorders.')
    const offRec = new Set((recs ?? []).filter((r) => !isMonitored(r)).map((r) => r.id))
    for (const c of data ?? []) if (offRec.has(c.recorder_id as string)) off.add(c.id)
  }
  return off
}
