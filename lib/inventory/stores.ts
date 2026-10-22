import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import { normalizeZone } from '@/lib/import/regions'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { storeSchema } from '@/lib/inventory/schemas'

const DENIED = 'Only administrators can change stores.'

/** Adds "Camera 1…N" for channels that do not exist yet. Real names come from discovery later; existing cameras are never touched. */
// P2-5a: a camera's identity no longer depends on its channel (the (location, channel) key is gone; mappings to recorders hold the
// channel). Until P2-5b makes this per recorder, missing channels are looked up at the location and only those are added; each new
// camera is mapped to the location's primary recorder by the database (transitional seam, decision D5-7).
export async function ensurePlaceholderCameras(admin: AdminClient, orgId: string, storeId: string, count: number): Promise<void> {
  if (count <= 0) return
  const { data: existing, error: readError } = await admin.from('cameras').select('channel').eq('org_id', orgId).eq('location_id', storeId).is('archived_at', null)
  if (readError) throw readError
  const taken = new Set((existing ?? []).map((c) => c.channel))
  const rows = Array.from({ length: Math.min(count, 999) }, (_, i) => i + 1)
    .filter((ch) => !taken.has(ch))
    .map((ch) => ({ org_id: orgId, location_id: storeId, channel: ch, name: `Camera ${ch}` }))
  if (rows.length === 0) return
  const { error } = await admin.from('cameras').insert(rows)
  if (error) throw error
}

const CAMERAS_FAILED = 'The store was saved, but its cameras could not be created. Open the store and save it again.'

/** The store is already saved when this runs, so a failure is reported without undoing anything (the audit row is still written by the caller). */
async function tryPlaceholderCameras(admin: AdminClient, orgId: string, storeId: string, count: number, route: string): Promise<boolean> {
  try {
    await ensurePlaceholderCameras(admin, orgId, storeId, count)
    return true
  } catch (e) {
    sanitizeError(e, { route }) // logs the real error; the person sees only the plain message above
    return false
  }
}

export async function createStore(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ storeId: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  if (!v.nvr_password) return { ok: false, error: 'Enter the NVR password.' }
  const code = (v.code?.trim() || v.name).toUpperCase().slice(0, 50)
  const { data, error } = await admin.from('locations').insert({
    org_id: actor.orgId, code, name: v.name, city: v.city, zone: normalizeZone(v.zone), state: normalizeZone(v.state), address: v.address,
    nvr_ip: v.ip, rtsp_port: v.rtsp_port, http_port: v.http_port, nvr_username: v.nvr_username, expected_channels: v.channels, is_active: v.is_active,
  }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createStore', fallback: 'Could not save the store.' }) }
  const cred = await admin.rpc('nvr_store_credential', { p_store: data.id, p_secret: v.nvr_password })
  if (cred.error) {
    // P2-5a: rows are archived, never deleted (history is kept); an archived location frees its code for a new attempt.
    await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: data.id, p_actor: actor.id })
    return { ok: false, error: sanitizeError(cred.error, { route: 'createStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  const camerasOk = await tryPlaceholderCameras(admin, actor.orgId, data.id, v.channels, 'createStore.cameras')
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_created', entityType: 'store', entityId: data.id, detail: { code } })
  if (!camerasOk) return { ok: false, error: CAMERAS_FAILED }
  return { ok: true, storeId: data.id }
}

export async function updateStore(admin: AdminClient, actor: Actor, storeId: string, input: unknown): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  const { data: existing } = await admin.from('locations').select('id').eq('id', storeId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  const { error } = await admin.from('locations').update({
    name: v.name, city: v.city, zone: normalizeZone(v.zone), state: normalizeZone(v.state), address: v.address,
    nvr_ip: v.ip, rtsp_port: v.rtsp_port, http_port: v.http_port, nvr_username: v.nvr_username, expected_channels: v.channels, is_active: v.is_active,
  }).eq('id', storeId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateStore', fallback: 'Could not save the store.' }) }
  if (v.nvr_password) {
    const cred = await admin.rpc('nvr_store_credential', { p_store: storeId, p_secret: v.nvr_password })
    if (cred.error) return { ok: false, error: sanitizeError(cred.error, { route: 'updateStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  const camerasOk = await tryPlaceholderCameras(admin, actor.orgId, storeId, v.channels, 'updateStore.cameras')
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_updated', entityType: 'store', entityId: storeId })
  if (!camerasOk) return { ok: false, error: CAMERAS_FAILED }
  return { ok: true }
}

export async function deleteStore(admin: AdminClient, actor: Actor, storeId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data: existing } = await admin.from('locations').select('id, code').eq('id', storeId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  // P2-5a (brief item 2): deleting is archiving. The location, its cameras, recorders and devices are switched off and archived;
  // their monitoring history, grants, groups and the recorder's vault login are kept (restore brings them back).
  const { error } = await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: storeId, p_actor: actor.id })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteStore', fallback: 'Could not delete the store.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_deleted', entityType: 'location', entityId: storeId, detail: { code: existing.code, archived: true } })
  return { ok: true }
}
