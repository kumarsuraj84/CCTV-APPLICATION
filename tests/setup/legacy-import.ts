import { z } from 'zod'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import type { RowError } from '@/lib/import/csv'
import { parseCsv } from '@/lib/import/csv'
import { normalizeZone } from '@/lib/import/regions'
import { isValidIp, parsePort } from '@/lib/import/validators'
import { ensurePlaceholderCameras } from '@/lib/inventory/cameras'
import { addressChanged, MSG_PASSWORD_AGAIN } from '@/lib/inventory/recorder-admin'
import { sanitizeError } from '@/lib/observability/sanitize-error'

// Release 1 clean-ups (T-1 review L2): the LEGACY location paths, moved out of lib/ into the tests. Nothing in the application reaches
// them any more (T-1 retired the old "Manage stores" page and its CSV import; locations are made by the validated import and the
// Locations and NVRs screens). They stay here, unchanged in behaviour, because the owner's real estate was made by the legacy import
// (one "primary" NVR per location, display name = code) and the integration tests still build that shape and drive the database's
// recorder_save / credential / placeholder rules through them. They were:
//   lib/import/stores-csv.ts   parseStoresCsv, StoreRow, RecorderFields
//   lib/import/apply.ts        importStores (audit action import_stores)
//   lib/inventory/stores.ts    createStore, updateStore, deleteStore, savePrimaryRecorder, primaryRecorderOf (store_created / _updated / _deleted)
//   lib/inventory/schemas.ts   storeSchema
// tests/unit/legacy-store-code.test.ts proves that nothing in app/, components/, lib/ or services/ imports this file.

// ── the legacy CSV (was lib/import/stores-csv.ts) ────────────────────────────
/** The NVR part of a row: the location's primary recorder (P2-5b). The password is never kept anywhere but the vault. */
export type RecorderFields = { host: string; rtsp_port: number; http_port: number; username: string; password: string; channels: number }
export type StoreRow = {
  line: number
  code: string
  name: string
  city: string | null
  zone: string | null
  state: string | null
  address: string | null
  recorder: RecorderFields
}

const orNull = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)

// Columns follow the legacy stores file: name, city, zone, ip, port, http_port, user, password, channels; plus optional code, state, address.
// P2-5b: one row is a location plus its primary recorder (the NVR at ip/port/http_port with that login) and its number of channels.
export function parseStoresCsv(text: string): { rows: StoreRow[]; errors: RowError[] } {
  const raw = parseCsv(text)
  if (raw.length === 0) return { rows: [], errors: [{ line: 1, message: 'The file is empty.' }] }
  const headers = raw[0].cells.map((h) => h.trim().toLowerCase())
  if (!['name', 'ip', 'user'].every((h) => headers.includes(h))) {
    return { rows: [], errors: [{ line: 1, message: 'The first line must have the columns name, ip and user (see the sample file).' }] }
  }
  const rows: StoreRow[] = []
  const errors: RowError[] = []
  const seen = new Set<string>()
  for (const { line, cells } of raw.slice(1)) {
    const v: Record<string, string> = {}
    headers.forEach((h, i) => (v[h] = cells[i] ?? ''))
    const fail = (message: string) => errors.push({ line, message })
    const name = v.name.trim()
    if (!name) { fail('The location name is empty.'); continue }
    if (!isValidIp(v.ip)) { fail(`“${v.ip.trim()}” is not a valid IP address.`); continue }
    const rtsp = parsePort(v.port ?? '', 554)
    const http = parsePort(v.http_port ?? '', 80)
    if (rtsp === null || http === null) { fail('A port must be a number from 1 to 65535.'); continue }
    if (!v.user.trim()) { fail('The NVR user name is empty.'); continue }
    const channelsText = (v.channels ?? '').trim()
    if (channelsText !== '' && !/^\d{1,3}$/.test(channelsText)) { fail('The number of channels must be a whole number up to 999.'); continue }
    const code = (v.code?.trim() || name).toUpperCase().slice(0, 50)
    if (seen.has(code)) { fail(`The location code ${code} appears more than once in this file.`); continue }
    seen.add(code)
    rows.push({
      line, code, name,
      city: orNull(v.city), zone: normalizeZone(v.zone), state: normalizeZone(v.state), address: orNull(v.address),
      recorder: {
        host: v.ip.trim(), rtsp_port: rtsp, http_port: http, username: v.user.trim(), password: v.password ?? '',
        channels: channelsText === '' ? 0 : Number(channelsText),
      },
    })
  }
  return { rows, errors }
}

// ── the legacy form's schema (was lib/inventory/schemas.ts storeSchema) ──────
const port = z.number().int().min(1, 'A port must be from 1 to 65535.').max(65535, 'A port must be from 1 to 65535.')
const ip = z.string().trim().refine(isValidIp, 'Enter a valid IP address.')
const optionalText = z.string().trim().max(200).nullish().transform((v) => (v ? v : null))
export const storeSchema = z.object({
  code: z.string().trim().max(50).nullish(),
  name: z.string().trim().min(1, 'Enter the location name.').max(200),
  city: optionalText,
  zone: optionalText,
  state: optionalText,
  address: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
  // P2-5b: the NVR fields describe the location's primary recorder (its own row; the location has no NVR columns any more).
  ip,
  rtsp_port: port.default(554),
  http_port: port.default(80),
  nvr_user: z.string().trim().min(1, 'Enter the NVR user name.').max(100),
  nvr_password: z.string().max(200).nullish(),
  channels: z.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
})
export type StoreInput = z.input<typeof storeSchema>

// ── the legacy form's service (was lib/inventory/stores.ts) ──────────────────
// A location plus its PRIMARY recorder (NVR) and that recorder's cameras. The location row holds no NVR data; the NVR is a recorder of
// its own (address, ports, login name, expected cameras; the password only in the vault). A location's further NVRs are never touched.

const DENIED = 'Only administrators can change locations.'

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

export const MSG_ADDRESS_SHARED = 'This NVR address is also used by the NVR of another location. Check that it is right.'
/** The plain answer to the database's DR010 (another NVR of the same location already has this address and port). */
export const MSG_ADDRESS_TAKEN_HERE = 'Another NVR of this location already has this address.'

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

export const CAMERAS_FAILED = 'The location was saved, but its cameras could not be created. Open the location and save it again.'

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
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createStore', fallback: 'Could not save the location.' }) }
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
  if (!existing) return { ok: false, error: 'Location not found.' }
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
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateStore', fallback: 'Could not save the location.' }) }
  const camerasOk = await tryPlaceholderCameras(admin, actor.orgId, storeId, recorderId, v.channels, 'updateStore.cameras')
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_updated', entityType: 'location', entityId: storeId, detail: { recorder_id: recorderId } })
  if (!camerasOk) return { ok: false, error: CAMERAS_FAILED }
  return { ok: true, ...(warning ? { warning } : {}) }
}

export async function deleteStore(admin: AdminClient, actor: Actor, storeId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data: existing } = await admin.from('locations').select('id, code').eq('id', storeId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!existing) return { ok: false, error: 'Location not found.' }
  // P2-5a (brief item 2): deleting is archiving. The location, its cameras, recorders and devices are switched off and archived;
  // their monitoring history, grants, groups and the recorders' vault logins are kept (restore brings them back).
  const { error } = await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: storeId, p_actor: actor.id })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteStore', fallback: 'Could not delete the location.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_deleted', entityType: 'location', entityId: storeId, detail: { code: existing.code, archived: true } })
  return { ok: true }
}

// ── the legacy import (was lib/import/apply.ts importStores) ─────────────────
/** `warnings`: rows that were saved but need a look (for example an NVR address another location's NVR also has, review M-2). */
export type LegacyImportResult = { created: number; updated: number; errors: RowError[]; warnings?: RowError[] }

/**
 * Saves parsed legacy rows one by one: a bad row is reported with its line number and never stops the others. P2-5b: the legacy columns
 * keep working as "location + primary recorder + channels": the location (by code), its primary recorder (ip, port, http_port, user;
 * the password into the vault) and cameras on channels 1..channels of that recorder. A location's other NVRs are never touched.
 * Review M-6: a row is saved NVR first: when its NVR cannot be saved, a new location is archived again and an existing one keeps its
 * fields; a failed look-up is an error (never "a new location"); cameras that could not be made are reported as exactly that.
 */
export async function importStores(admin: AdminClient, actor: Actor, rows: StoreRow[]): Promise<LegacyImportResult> {
  const result: LegacyImportResult = { created: 0, updated: 0, errors: [] }
  const warnings: RowError[] = []
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  for (const r of rows) {
    try {
      const { data: existing, error: lookupError } = await admin.from('locations').select('id').eq('org_id', actor.orgId).eq('code', r.code).is('archived_at', null).maybeSingle()
      if (lookupError) throw lookupError
      const fields = { name: r.name, city: r.city, zone: r.zone, state: r.state, address: r.address }
      let storeId: string
      let current: string | null = null
      if (existing) {
        storeId = existing.id
        current = await primaryRecorderOf(admin, storeId)
        // Review M-7: an existing location that has no NVR yet gets one only with its password.
        if (!current && !r.recorder.password) {
          result.errors.push({ line: r.line, message: 'This location has no NVR yet: give the password of its NVR.' })
          continue
        }
        // P2-5c-1 review I-4 (the NVR page's rule and words): the saved password belongs to the address and web port it was saved for;
        // a row that changes them without a password is refused before anything changes.
        if (current && !r.recorder.password) {
          const { data: saved, error: savedError } = await admin.from('recorders').select('http_port, assets!recorders_asset_fk!inner(ip)').eq('id', current).eq('org_id', actor.orgId).maybeSingle()
          if (savedError) throw savedError
          const s = saved as unknown as { http_port: number; assets: { ip: string | null } } | null
          if (!s || addressChanged(s.assets.ip, s.http_port, r.recorder.host, r.recorder.http_port)) {
            result.errors.push({ line: r.line, message: MSG_PASSWORD_AGAIN })
            continue
          }
        }
      } else {
        if (!r.recorder.password) {
          result.errors.push({ line: r.line, message: 'A new location needs a password for its NVR.' })
          continue
        }
        const { data, error } = await admin.from('locations').insert({ ...fields, org_id: actor.orgId, code: r.code }).select('id').single()
        if (error || !data) throw error
        storeId = data.id
      }
      // P2-5a: never deleted, archived (the archived location frees its code for the next attempt). A new NVR of an existing location
      // that got no password is archived too.
      const undo = async (newRecorder?: string) => {
        if (!existing) await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: storeId, p_actor: actor.id })
        else if (newRecorder) await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'recorder', p_id: newRecorder, p_actor: actor.id })
      }
      let saved: Awaited<ReturnType<typeof savePrimaryRecorder>>
      try {
        saved = await savePrimaryRecorder(admin, actor, storeId, r.recorder, current)
      } catch (e) {
        await undo()
        result.errors.push({ line: r.line, message: recorderSaveError(e, 'importStores', 'This row could not be saved.') })
        continue
      }
      if (r.recorder.password) {
        const { error } = await admin.rpc('recorder_store_credential', { p_recorder: saved.recorderId, p_secret: r.recorder.password })
        if (error) {
          await undo(saved.created ? saved.recorderId : undefined)
          throw error
        }
      }
      if (existing) {
        const { error } = await admin.from('locations').update(fields).eq('id', existing.id).eq('org_id', actor.orgId)
        if (error) throw error
      }
      if (existing) result.updated++
      else result.created++
      if (saved.warning) warnings.push({ line: r.line, message: saved.warning })
      try {
        await ensurePlaceholderCameras(admin, actor.orgId, storeId, saved.recorderId, r.recorder.channels)
      } catch (e) {
        sanitizeError(e, { route: 'importStores.cameras' }) // logged; the row says what happened
        result.errors.push({ line: r.line, message: CAMERAS_FAILED })
      }
    } catch (err) {
      result.errors.push({ line: r.line, message: sanitizeError(err, { route: 'importStores', fallback: 'This row could not be saved.' }) })
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'import_stores', detail: { created: result.created, updated: result.updated, errors: result.errors.length } })
  // A bulk import changes the inventory faster than autovacuum re-analyses it: fresh planner statistics keep the pages fast at once.
  if (result.created + result.updated >= 20) {
    const { error } = await admin.rpc('inventory_refresh_statistics')
    if (error) sanitizeError(error, { route: 'importStores.statistics' }) // logged; the import itself is done
  }
  if (warnings.length > 0) result.warnings = warnings
  return result
}
