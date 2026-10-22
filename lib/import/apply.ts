import type { Actor, AdminClient } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import type { DeviceRow } from '@/lib/import/devices-csv'
import type { RowError, StoreRow } from '@/lib/import/stores-csv'
import { ensurePlaceholderCameras, savePrimaryRecorder } from '@/lib/inventory/stores'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { fetchAll } from '@/lib/supabase/fetch-all'

export type ImportResult = { created: number; updated: number; errors: RowError[] }

/**
 * Saves parsed store rows one by one: a bad row is reported with its line number and never stops the others. P2-5b: the legacy columns
 * keep working as "location + primary recorder + channels": the location (by code), its primary recorder (ip, port, http_port, user;
 * the password into the vault) and cameras on channels 1..channels of that recorder. A location's other NVRs are never touched.
 */
export async function importStores(admin: AdminClient, actor: Actor, rows: StoreRow[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] }
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  for (const r of rows) {
    try {
      const { data: existing } = await admin.from('locations').select('id').eq('org_id', actor.orgId).eq('code', r.code).is('archived_at', null).maybeSingle()
      const fields = { name: r.name, city: r.city, zone: r.zone, state: r.state, address: r.address }
      let storeId: string
      if (existing) {
        const { error } = await admin.from('locations').update(fields).eq('id', existing.id).eq('org_id', actor.orgId)
        if (error) throw error
        storeId = existing.id
      } else {
        if (!r.recorder.password) {
          result.errors.push({ line: r.line, message: 'A new store needs a password for its NVR.' })
          continue
        }
        const { data, error } = await admin.from('locations').insert({ ...fields, org_id: actor.orgId, code: r.code }).select('id').single()
        if (error || !data) throw error
        storeId = data.id
      }
      // P2-5a: never deleted, archived (the archived location frees its code for the next attempt).
      const undo = async () => {
        if (!existing) await admin.rpc('inventory_archive', { p_org: actor.orgId, p_kind: 'location', p_id: storeId, p_actor: actor.id })
      }
      let recorderId: string
      try {
        recorderId = (await savePrimaryRecorder(admin, actor, storeId, r.recorder)).recorderId
      } catch (e) {
        await undo()
        throw e
      }
      if (r.recorder.password) {
        const { error } = await admin.rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: r.recorder.password })
        if (error) {
          await undo()
          throw error
        }
      }
      await ensurePlaceholderCameras(admin, actor.orgId, storeId, recorderId, r.recorder.channels)
      if (existing) result.updated++
      else result.created++
    } catch (err) {
      result.errors.push({ line: r.line, message: sanitizeError(err, { route: 'importStores', fallback: 'This row could not be saved.' }) })
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'import_stores', detail: { created: result.created, updated: result.updated, errors: result.errors.length } })
  // A bulk import changes the inventory faster than autovacuum re-analyses it: fresh planner statistics keep the pages fast at once.
  if (result.created + result.updated >= 20) await refreshStatistics(admin)
  return result
}

async function refreshStatistics(admin: AdminClient): Promise<void> {
  const { error } = await admin.rpc('inventory_refresh_statistics')
  if (error) sanitizeError(error, { route: 'importStores.statistics' }) // logged; the import itself is done
}

/** Devices are matched by IP address and port, so importing the same file again updates instead of duplicating. */
export async function importDevices(admin: AdminClient, actor: Actor, rows: DeviceRow[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] }
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  const stores = await fetchAll((from, to) => admin.from('locations').select('id, code').eq('org_id', actor.orgId).is('archived_at', null).order('id').range(from, to))
  const byCode = new Map(stores.map((s) => [s.code, s.id]))
  for (const r of rows) {
    try {
      let storeId: string | null = null
      if (r.store_code) {
        storeId = byCode.get(r.store_code) ?? null
        if (!storeId) {
          result.errors.push({ line: r.line, message: `There is no store with the code ${r.store_code}.` })
          continue
        }
      }
      const { data: same } = await admin.from('assets').select('id, tcp_port').eq('org_id', actor.orgId).eq('ip', r.ip).is('archived_at', null).eq('is_recorder', false)
      const existing = (same ?? []).find((d) => d.tcp_port === r.tcp_port)
      const fields = { location_id: storeId, type: r.type, name: r.name, ip: r.ip, tcp_port: r.tcp_port, notes: r.notes }
      if (existing) {
        const { error } = await admin.from('assets').update(fields).eq('id', existing.id)
        if (error) throw error
        result.updated++
      } else {
        const { error } = await admin.from('assets').insert({ ...fields, org_id: actor.orgId })
        if (error) throw error
        result.created++
      }
    } catch (err) {
      result.errors.push({ line: r.line, message: sanitizeError(err, { route: 'importDevices', fallback: 'This row could not be saved.' }) })
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'import_devices', detail: { created: result.created, updated: result.updated, errors: result.errors.length } })
  return result
}
