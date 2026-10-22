import type { AdminClient } from '@/lib/admin/types'

// Cameras and their channel mappings (P2-5b). A camera's identity never depends on its channel: it is mapped to ONE recorder channel at
// a time (camera_channel_mappings), and moving it keeps its id, grants, groups and history. Nothing here deletes or archives a camera.

/**
 * Unmapped cameras of a location (not archived, no active mapping) that may be put back on THIS recorder by their channel: those whose
 * last mapping was on this recorder; and, when the location has only this NVR, any unmapped camera (there is no other box it could be
 * on). Returns channel → camera id (the lowest id when two share a channel). A camera that could belong to another NVR is never guessed.
 */
export async function reattachableByChannel(admin: AdminClient, orgId: string, locationId: string, recorderId: string): Promise<Map<number, string>> {
  const { data: loose, error } = await admin.from('cameras').select('id, channel').eq('org_id', orgId).eq('location_id', locationId)
    .is('archived_at', null).is('recorder_id', null).order('id')
  if (error) throw error
  const out = new Map<number, string>()
  if (!loose || loose.length === 0) return out
  const { count, error: cErr } = await admin.from('recorders').select('id, assets!recorders_asset_fk!inner(archived_at)', { count: 'exact', head: true })
    .eq('org_id', orgId).eq('location_id', locationId).is('assets.archived_at', null)
  if (cErr) throw cErr
  if (count === 1) {
    for (const c of loose) if (!out.has(c.channel)) out.set(c.channel, c.id)
    return out
  }
  const { data: history, error: hErr } = await admin.from('camera_channel_mappings').select('camera_id, recorder_id, channel, valid_to')
    .eq('org_id', orgId).in('camera_id', loose.map((c) => c.id)).not('valid_to', 'is', null).order('valid_to', { ascending: false })
  if (hErr) throw hErr
  const last = new Map<string, { recorder_id: string; channel: number }>()
  for (const m of history ?? []) if (!last.has(m.camera_id)) last.set(m.camera_id, m)
  for (const c of loose) {
    const m = last.get(c.id)
    if (m && m.recorder_id === recorderId && !out.has(m.channel)) out.set(m.channel, c.id)
  }
  return out
}

/** The channels of this recorder that have an active camera mapping. */
export async function mappedChannels(admin: AdminClient, orgId: string, recorderId: string): Promise<Set<number>> {
  const { data, error } = await admin.from('camera_channel_mappings').select('channel').eq('org_id', orgId).eq('recorder_id', recorderId).is('valid_to', null)
  if (error) throw error
  return new Set((data ?? []).map((m) => m.channel))
}

/**
 * Makes sure channels 1..count of this recorder each have a camera: a channel without one gets a camera of the location that was on it
 * before (see reattachableByChannel), else a new "Camera N" mapped to it. Real names come from discovery later; existing cameras are
 * never renamed, moved off another channel or deleted.
 */
export async function ensurePlaceholderCameras(admin: AdminClient, orgId: string, locationId: string, recorderId: string, count: number): Promise<void> {
  if (count <= 0) return
  const taken = await mappedChannels(admin, orgId, recorderId)
  const missing = Array.from({ length: Math.min(count, 999) }, (_, i) => i + 1).filter((ch) => !taken.has(ch))
  if (missing.length === 0) return
  const back = await reattachableByChannel(admin, orgId, locationId, recorderId)
  for (const ch of missing.filter((c) => back.has(c))) {
    const { error } = await admin.from('cameras').update({ recorder_id: recorderId, channel: ch }).eq('id', back.get(ch)!).eq('org_id', orgId)
    if (error) throw error
  }
  const rows = missing.filter((ch) => !back.has(ch)).map((ch) => ({ org_id: orgId, location_id: locationId, recorder_id: recorderId, channel: ch, name: `Camera ${ch}` }))
  if (rows.length === 0) return
  const { error } = await admin.from('cameras').insert(rows)
  if (error) throw error
}
