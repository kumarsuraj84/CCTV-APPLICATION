import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import { normalizeZone } from '@/lib/import/regions'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { ensurePlaceholderCameras } from '@/lib/inventory/cameras'
import { storeSchema } from '@/lib/inventory/schemas'
import { addressChanged, MSG_PASSWORD_AGAIN } from '@/lib/inventory/recorder-admin'

// The "Manage stores" form (P2-5b): a location plus its PRIMARY recorder (NVR) and that recorder's cameras. The location row holds no NVR
// data any more; the NVR is a recorder of its own (address, ports, login name, expected cameras; the password only in the vault). A
// location's further NVRs are managed per recorder (P2-5c screens); this form never touches them.

const DENIED = 'Only administrators can change stores.'

export { ensurePlaceholderCameras }

/** The NVR part of the form or of an imported row. */
export type PrimaryRecorderFields = { host: string; http_port: number; rtsp_port: number; username: string; channels: number }

/** The location's primary recorder (recorder_primary_of), or null when it has none yet. */
export async function primaryRecorderOf(admin: AdminClient, locationId: string): Promise<string | null> {
  const { data, error } = await admin.rpc('recorder_primary_of', { p_location: locationId })
  if (error) throw error
  return (data as string | null) ?? null
}

/**
 * Creates the location's primary recorder, or changes it when it has one (recorder_primary_of). Returns its id. Address conflicts in the
 * company network are handled by the database (the recorder gets its location's own address space, D5-8); a second NVR of the SAME
 * location at the same address is refused (DR010, review M-2). `warning` says when another location's NVR has the same address.
 */
export async function savePrimaryRecorder(admin: AdminClient, actor: Actor, locationId: string, f: PrimaryRecorderFields, current?: string | null): Promise<{ recorderId: string; created: boolean; warning?: string }> {
  const existing = current === undefined ? await primaryRecorderOf(admin, locationId) : current
  const { data, error: saveError } = await admin.rpc('recorder_save', {
    p_org: actor.orgId, p_location: locationId, p_recorder: (existing ?? null) as string, p_host: f.host, p_http_port: f.http_port, p_rtsp_port: f.rtsp_port,
    p_username: f.username, p_expected_channels: f.channels, p_actor: actor.id,
  })
  if (saveError || !data) throw saveError ?? new Error('recorder not saved')
  const recorderId = data as string
  const warning = (await sharesAddressWithAnotherLocation(admin, actor.orgId, locationId, recorderId, f.host, f.http_port)) ? MSG_ADDRESS_SHARED : undefined
  return { recorderId, created: !existing, ...(warning ? { warning } : {}) }
}

export const MSG_ADDRESS_SHARED = 'This NVR address is also used by the NVR of another store. Check that it is right.'
/** The plain answer to the database's DR010 (another NVR of the same location already has this address and port). */
export const MSG_ADDRESS_TAKEN_HERE = 'Another NVR of this store already has this address.'

/**
 * Review M-2: on this all-VPN network the same NVR address at two locations is more likely a typo than an SD-WAN overlap. It is saved
 * (decision D5-8) and the person is told. A failed check is not a reason to fail the save (logged only).
 */
async function sharesAddressWithAnotherLocation(admin: AdminClient, orgId: string, locationId: string, recorderId: string, host: string, port: number): Promise<boolean> {
  const { data, error } = await admin.from('assets').select('id').eq('org_id', orgId).eq('is_recorder', true).is('archived_at', null)
    .eq('ip', host.trim()).eq('tcp_port', port).neq('id', recorderId).neq('location_id', locationId).limit(1)
  if (error) {
    sanitizeError(error, { route: 'savePrimaryRecorder.addressCheck' })
    return false
  }
  return (data ?? []).length > 0
}

/** A plain message for a failed recorder save (DR010 has its own; anything else is sanitised to `fallback`). */
export function recorderSaveError(e: unknown, route: string, fallback: string): string {
  if ((e as { code?: string } | null)?.code === 'DR010') return MSG_ADDRESS_TAKEN_HERE
  return sanitizeError(e, { route, fallback })
}

export const CAMERAS_FAILED = 'The store was saved, but its cameras could not be created. Open the store and save it again.'

/** The store is already saved when this runs, so a failure is reported without undoing anything (the audit row is still written by the caller). */
async function tryPlaceholderCameras(admin: AdminClient, orgId: string, locationId: string, recorderId: string, count: number, route: string): Promise<boolean> {
  try {
    await ensurePlaceholderCameras(admin, orgId, locationId, recorderId, count)
    return true
  } catch (e) {
    sanitizeError(e, { route }) // logs the real error; the person sees only the plain message above
    return false
  }
}

const recorderFields = (v: { ip: string; http_port: number; rtsp_port: number; nvr_user: string; channels: number }): PrimaryRecorderFields => ({
  host: v.ip, http_port: v.http_port, rtsp_port: v.rtsp_port, username: v.nvr_user, channels: v.channels,
})

export async function createStore(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ storeId: string; warning?: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  if (!v.nvr_password) return { ok: false, error: 'Enter the NVR password.' }
  const code = (v.code?.trim() || v.name).toUpperCase().slice(0, 50)
  const { data, error } = await admin.from('locations').insert({
    org_id: actor.orgId, code, name: v.name, city: v.city, zone: normalizeZone(v.zone), state: normalizeZone(v.state), address: v.address, is_active: v.is_active,
  }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createStore', fallback: 'Could not save the store.' }) }
  // Rows are archived, never deleted (history is kept); an archived location frees its code for a new attempt.
  const undo = () => admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: data.id, p_actor: actor.id })
  let recorderId: string
  let warning: string | undefined
  try {
    ;({ recorderId, warning } = await savePrimaryRecorder(admin, actor, data.id, recorderFields(v), null))
  } catch (e) {
    await undo()
    return { ok: false, error: recorderSaveError(e, 'createStore.recorder', 'Could not save the NVR.') }
  }
  const cred = await admin.rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: v.nvr_password })
  if (cred.error) {
    await undo()
    return { ok: false, error: sanitizeError(cred.error, { route: 'createStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  const camerasOk = await tryPlaceholderCameras(admin, actor.orgId, data.id, recorderId, v.channels, 'createStore.cameras')
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_created', entityType: 'location', entityId: data.id, detail: { code, recorder_id: recorderId } })
  if (!camerasOk) return { ok: false, error: CAMERAS_FAILED }
  return { ok: true, storeId: data.id, ...(warning ? { warning } : {}) }
}

export async function updateStore(admin: AdminClient, actor: Actor, storeId: string, input: unknown): Promise<Result<{ warning?: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  const { data: existing } = await admin.from('locations').select('id').eq('id', storeId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  // Review M-7: a store without an NVR (a head office, or every NVR archived) gets one only with its password; checked before anything
  // is changed.
  let current: string | null
  try {
    current = await primaryRecorderOf(admin, storeId)
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'updateStore.recorder', fallback: 'Could not save the NVR.' }) }
  }
  if (!current && !v.nvr_password) return { ok: false, error: 'Enter the NVR password.' }
  // P2-5c-1 review I-4: the saved password is used only for the address and web port it was saved for; a changed address needs it again.
  if (current && !v.nvr_password) {
    const { data: saved } = await admin.from('recorders').select('http_port, assets!recorders_asset_fk!inner(ip)').eq('id', current).eq('org_id', actor.orgId).maybeSingle()
    const s = saved as unknown as { http_port: number; assets: { ip: string | null } } | null
    if (!s || addressChanged(s.assets.ip, s.http_port, v.ip, v.http_port)) return { ok: false, error: MSG_PASSWORD_AGAIN }
  }
  // The NVR first (review M-6): a refused NVR (a duplicate address, DR010) leaves the store's own fields as they were.
  let recorderId: string
  let warning: string | undefined
  let created: boolean
  try {
    ;({ recorderId, warning, created } = await savePrimaryRecorder(admin, actor, storeId, recorderFields(v), current))
  } catch (e) {
    return { ok: false, error: recorderSaveError(e, 'updateStore.recorder', 'Could not save the NVR.') }
  }
  if (v.nvr_password) {
    const cred = await admin.rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: v.nvr_password })
    if (cred.error) {
      // A new NVR without its password is not left behind (M-7); archived, never deleted.
      if (created) await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'recorder', p_id: recorderId, p_actor: actor.id })
      return { ok: false, error: sanitizeError(cred.error, { route: 'updateStore.credential', fallback: 'Could not save the NVR password.' }) }
    }
  }
  const { error } = await admin.from('locations').update({
    name: v.name, city: v.city, zone: normalizeZone(v.zone), state: normalizeZone(v.state), address: v.address, is_active: v.is_active,
  }).eq('id', storeId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateStore', fallback: 'Could not save the store.' }) }
  const camerasOk = await tryPlaceholderCameras(admin, actor.orgId, storeId, recorderId, v.channels, 'updateStore.cameras')
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_updated', entityType: 'location', entityId: storeId, detail: { recorder_id: recorderId } })
  if (!camerasOk) return { ok: false, error: CAMERAS_FAILED }
  return { ok: true, ...(warning ? { warning } : {}) }
}

export async function deleteStore(admin: AdminClient, actor: Actor, storeId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data: existing } = await admin.from('locations').select('id, code').eq('id', storeId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  // P2-5a (brief item 2): deleting is archiving. The location, its cameras, recorders and devices are switched off and archived;
  // their monitoring history, grants, groups and the recorders' vault logins are kept (restore brings them back).
  const { error } = await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: storeId, p_actor: actor.id })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteStore', fallback: 'Could not delete the store.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_deleted', entityType: 'location', entityId: storeId, detail: { code: existing.code, archived: true } })
  return { ok: true }
}
