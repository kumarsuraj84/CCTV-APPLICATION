import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { parseChannel } from '@/lib/inventory/forms'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { dropLiveStreams } from '@/lib/streams/go2rtc'
import { fetchAll } from '@/lib/supabase/fetch-all'

// The mapping editor (P2-5c-1 brief item 3): which NVR channel shows a camera. A camera's identity never depends on its channel:
// moving it to another NVR or channel of its location keeps its id, grants, group memberships and monitoring history (camera_remap
// closes the active mapping and opens a new one; the history is append-only). Its live streams still point at the old channel and are
// removed from go2rtc (review M-4; the next viewer opens them again). Merge (re-review correction (a)): a camera physically moved to
// another NVR got a second identity there (ruling I-2); the merge keeps the OLD camera and archives the duplicate.

export const MSG_CAMERA_NOT_FOUND = 'Camera not found.'
export const MSG_OTHER_LOCATION_NVR = 'Choose an NVR of the camera’s own location.'
export const MSG_CHANNEL = 'Enter a channel number from 1 to 999.'
export const msgChannelTaken = (ch: number) => `Channel ${ch} of this NVR already has a camera. Move that camera first, or merge the two cameras.`

/** Moves (or links, for an unmapped camera) one camera to an NVR channel of its own location. */
export async function remapCamera(clients: InventoryClients, actor: Actor, input: { cameraId: string; recorderId: string; channel: number | string }): Promise<Result<{ mappingId: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const cameraId = cleanId(input?.cameraId)
  const recorderId = cleanId(input?.recorderId)
  if (!cameraId) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const channel = parseChannel(input?.channel)
  if (channel === null) return { ok: false, error: MSG_CHANNEL }
  if (!recorderId) return { ok: false, error: MSG_OTHER_LOCATION_NVR }
  const { data: cam, error: camErr } = await clients.admin.from('cameras').select('id').eq('id', cameraId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (camErr) return { ok: false, error: sanitizeError(camErr, { route: 'remapCamera', fallback: 'Could not read the camera.' }) }
  if (!cam) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const { data, error } = await clients.admin.rpc('camera_remap', { p_org: actor.orgId, p_camera: cameraId, p_recorder: recorderId, p_channel: channel, p_actor: actor.id })
  if (error) {
    if (error.code === 'DR006') return { ok: false, error: MSG_OTHER_LOCATION_NVR }
    if (error.code === '23505' || error.code === '23P01') return { ok: false, error: msgChannelTaken(channel) }
    if (error.code === 'P0002') return { ok: false, error: MSG_CAMERA_NOT_FOUND }
    return { ok: false, error: sanitizeError(error, { route: 'remapCamera', fallback: 'Could not move the camera.' }) }
  }
  if (clients.go2rtc) await dropLiveStreams(clients.go2rtc, [cameraId])
  return { ok: true, mappingId: data as string }
}

export type MappingRow = { recorderId: string; recorderName: string; channel: number; validFrom: string; validTo: string | null }

/** One camera's mapping history, newest first (service role, after the administrator check; scoped to the organisation). */
export async function mappingHistory(admin: AdminClient, orgId: string, cameraId: string): Promise<MappingRow[]> {
  const id = cleanId(cameraId)
  if (!id) return []
  const rows = await fetchAll((from, to) =>
    admin.from('camera_channel_mappings').select('id, recorder_id, channel, valid_from, valid_to').eq('org_id', orgId).eq('camera_id', id)
      .order('valid_from', { ascending: false }).order('id').range(from, to))
  const names = await recorderNames(admin, orgId, rows.map((r) => r.recorder_id))
  return rows.map((r) => ({ recorderId: r.recorder_id, recorderName: names.get(r.recorder_id) ?? 'NVR', channel: r.channel, validFrom: r.valid_from, validTo: r.valid_to }))
}

/** The names of these recorders (their assets), archived ones included (history names them). */
export async function recorderNames(admin: AdminClient, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  const out = new Map<string, string>()
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await admin.from('assets').select('id, name').eq('org_id', orgId).in('id', unique.slice(i, i + 200))
    if (error) throw new Error('Could not read the NVR names.')
    for (const a of data ?? []) out.set(a.id, a.name)
  }
  return out
}

export type MergeResult = { recorderId: string | null; channel: number | null; groupsCopied: number; duplicateCameraGrants: number }

/**
 * Merges `duplicateId` into `keepId`: the kept camera takes over the duplicate's NVR channel (and location), gains its group
 * memberships and keeps its own id, grants and history; the duplicate is archived. Live streams of both are removed.
 */
export async function mergeCameras(clients: InventoryClients, actor: Actor, input: { keepId: string; duplicateId: string }): Promise<Result<MergeResult>> {
  const keep = cleanId(input?.keepId)
  const dup = cleanId(input?.duplicateId)
  if (keep && dup && keep === dup) return { ok: false, error: 'Choose two different cameras.' }
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (!keep || !dup) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const { data, error } = await clients.admin.rpc('camera_merge', { p_org: actor.orgId, p_keep: keep, p_duplicate: dup, p_actor: actor.id })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: MSG_CAMERA_NOT_FOUND }
    if (error.code === 'DR011') return { ok: false, error: 'Restore the camera to keep first.' }
    if (error.code === '22023') return { ok: false, error: 'Choose two different cameras.' }
    if (error.code === '23505' || error.code === '23P01') return { ok: false, error: 'The NVR channel is in use by another camera. Reload the page and try again.' }
    return { ok: false, error: sanitizeError(error, { route: 'mergeCameras', fallback: 'Could not merge the cameras.' }) }
  }
  const r = data as { recorder_id: string | null; channel: number | null; groups_copied: number; duplicate_camera_grants: number }
  if (clients.go2rtc) await dropLiveStreams(clients.go2rtc, [keep, dup])
  return { ok: true, recorderId: r.recorder_id, channel: r.channel, groupsCopied: Number(r.groups_copied), duplicateCameraGrants: Number(r.duplicate_camera_grants) }
}
