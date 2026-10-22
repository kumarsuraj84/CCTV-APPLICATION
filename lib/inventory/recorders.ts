import type { AdminClient } from '@/lib/admin/types'

// Recorders (NVRs) as explicit records (P2-5a, decision D-4). Owner addition 2026-10-22: monitoring can be switched off per NVR (the
// real estate is imported into the local database, and a switched-off NVR must never be contacted). Then nothing — the worker's
// checks, camera discovery, live video, playback or fast playback — opens a connection to it or to its cameras, and its cameras show
// "Switched off" instead of offline. Switching it is done by recorder_set_monitoring (super administrators or admin.inventory, with a
// reason, audited); the screens come with P2-5c.

export const MSG_MONITORING_OFF = 'Monitoring is switched off for this NVR.'

export type CameraRoute = { id: string; location_id: string; recorder_id: string | null }

/**
 * The primary recorder of each location: the first one made that is not archived — the NVR the legacy location columns describe
 * during the P2-5a seam (decision D5-7) — with its monitoring switch.
 */
export async function primaryRecorders(admin: AdminClient, orgId: string, locationIds: readonly string[]): Promise<Map<string, { id: string; monitoring: boolean }>> {
  const out = new Map<string, { id: string; monitoring: boolean }>()
  const ids = [...new Set(locationIds)]
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('recorders').select('id, location_id, created_at, monitoring_enabled, assets!recorders_asset_fk!inner(archived_at)')
      .eq('org_id', orgId).in('location_id', ids.slice(i, i + 200)).is('assets.archived_at', null).order('created_at').order('id')
    if (error) throw new Error('Could not read the recorders.')
    for (const r of data ?? []) if (!out.has(r.location_id)) out.set(r.location_id, { id: r.id, monitoring: r.monitoring_enabled })
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
    const { data: recs, error: rErr } = await admin.from('recorders').select('id').eq('org_id', orgId).in('id', recorders).eq('monitoring_enabled', false)
    if (rErr) throw new Error('Could not read the recorders.')
    const offRec = new Set((recs ?? []).map((r) => r.id))
    for (const c of data ?? []) if (offRec.has(c.recorder_id as string)) off.add(c.id)
  }
  return off
}
