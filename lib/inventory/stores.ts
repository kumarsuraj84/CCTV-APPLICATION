import type { Actor, AdminClient, Result } from '@/lib/admin/users'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/auth/roles'
import { normalizeRegion } from '@/lib/import/regions'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { storeSchema } from '@/lib/inventory/schemas'

const DENIED = 'Only administrators can change stores.'

/** Adds "Camera 1…N" for channels that do not exist yet. Real names come from discovery later; existing cameras are never touched. */
export async function ensurePlaceholderCameras(admin: AdminClient, orgId: string, storeId: string, count: number): Promise<void> {
  if (count <= 0) return
  const rows = Array.from({ length: Math.min(count, 999) }, (_, i) => ({ org_id: orgId, store_id: storeId, channel: i + 1, name: `Camera ${i + 1}` }))
  const { error } = await admin.from('cameras').upsert(rows, { onConflict: 'store_id,channel', ignoreDuplicates: true })
  if (error) throw error
}

export async function createStore(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ storeId: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  if (!v.nvr_password) return { ok: false, error: 'Enter the NVR password.' }
  const code = (v.code?.trim() || v.name).toUpperCase().slice(0, 50)
  const { data, error } = await admin.from('stores').insert({
    org_id: actor.orgId, code, name: v.name, city: v.city, zone: normalizeRegion(v.zone), state: normalizeRegion(v.state), address: v.address,
    nvr_ip: v.ip, rtsp_port: v.rtsp_port, http_port: v.http_port, nvr_username: v.nvr_username, expected_channels: v.channels, is_active: v.is_active,
  }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createStore', fallback: 'Could not save the store.' }) }
  const cred = await admin.rpc('nvr_store_credential', { p_store: data.id, p_secret: v.nvr_password })
  if (cred.error) {
    await admin.from('stores').delete().eq('id', data.id)
    return { ok: false, error: sanitizeError(cred.error, { route: 'createStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  await ensurePlaceholderCameras(admin, actor.orgId, data.id, v.channels)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_created', entityType: 'store', entityId: data.id, detail: { code } })
  return { ok: true, storeId: data.id }
}

export async function updateStore(admin: AdminClient, actor: Actor, storeId: string, input: unknown): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  const { data: existing } = await admin.from('stores').select('id').eq('id', storeId).eq('org_id', actor.orgId).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  const { error } = await admin.from('stores').update({
    name: v.name, city: v.city, zone: normalizeRegion(v.zone), state: normalizeRegion(v.state), address: v.address,
    nvr_ip: v.ip, rtsp_port: v.rtsp_port, http_port: v.http_port, nvr_username: v.nvr_username, expected_channels: v.channels, is_active: v.is_active,
  }).eq('id', storeId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateStore', fallback: 'Could not save the store.' }) }
  if (v.nvr_password) {
    const cred = await admin.rpc('nvr_store_credential', { p_store: storeId, p_secret: v.nvr_password })
    if (cred.error) return { ok: false, error: sanitizeError(cred.error, { route: 'updateStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  await ensurePlaceholderCameras(admin, actor.orgId, storeId, v.channels)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_updated', entityType: 'store', entityId: storeId })
  return { ok: true }
}

export async function deleteStore(admin: AdminClient, actor: Actor, storeId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data: existing } = await admin.from('stores').select('id, code').eq('id', storeId).eq('org_id', actor.orgId).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  await admin.rpc('nvr_delete_credential', { p_store: storeId })
  const { error } = await admin.from('stores').delete().eq('id', storeId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteStore', fallback: 'Could not delete the store.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_deleted', entityType: 'store', entityId: storeId, detail: { code: existing.code } })
  return { ok: true }
}
