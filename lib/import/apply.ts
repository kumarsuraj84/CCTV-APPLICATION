import type { Actor, AdminClient } from '@/lib/admin/users'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/auth/roles'
import type { DeviceRow } from '@/lib/import/devices-csv'
import type { RowError, StoreRow } from '@/lib/import/stores-csv'
import { ensurePlaceholderCameras } from '@/lib/inventory/stores'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { fetchAll } from '@/lib/supabase/fetch-all'

export type ImportResult = { created: number; updated: number; errors: RowError[] }

/** Saves parsed store rows one by one: a bad row is reported with its line number and never stops the others. */
export async function importStores(admin: AdminClient, actor: Actor, rows: StoreRow[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] }
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  for (const r of rows) {
    try {
      const { data: existing } = await admin.from('stores').select('id').eq('org_id', actor.orgId).eq('code', r.code).maybeSingle()
      const fields = {
        name: r.name, city: r.city, zone: r.zone, state: r.state, address: r.address, nvr_ip: r.nvr_ip,
        rtsp_port: r.rtsp_port, http_port: r.http_port, nvr_username: r.nvr_username, expected_channels: r.channels,
      }
      let storeId: string
      if (existing) {
        const { error } = await admin.from('stores').update(fields).eq('id', existing.id)
        if (error) throw error
        storeId = existing.id
      } else {
        if (!r.nvr_password) {
          result.errors.push({ line: r.line, message: 'A new store needs a password for its NVR.' })
          continue
        }
        const { data, error } = await admin.from('stores').insert({ ...fields, org_id: actor.orgId, code: r.code }).select('id').single()
        if (error || !data) throw error
        storeId = data.id
      }
      if (r.nvr_password) {
        const { error } = await admin.rpc('nvr_store_credential', { p_store: storeId, p_secret: r.nvr_password })
        if (error) {
          if (!existing) await admin.from('stores').delete().eq('id', storeId)
          throw error
        }
      }
      await ensurePlaceholderCameras(admin, actor.orgId, storeId, r.channels)
      if (existing) result.updated++
      else result.created++
    } catch (err) {
      result.errors.push({ line: r.line, message: sanitizeError(err, { route: 'importStores', fallback: 'This row could not be saved.' }) })
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'import_stores', detail: { created: result.created, updated: result.updated, errors: result.errors.length } })
  return result
}

/** Devices are matched by IP address and port, so importing the same file again updates instead of duplicating. */
export async function importDevices(admin: AdminClient, actor: Actor, rows: DeviceRow[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] }
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  const stores = await fetchAll((from, to) => admin.from('stores').select('id, code').eq('org_id', actor.orgId).range(from, to))
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
      const { data: same } = await admin.from('devices').select('id, tcp_port').eq('org_id', actor.orgId).eq('ip', r.ip)
      const existing = (same ?? []).find((d) => d.tcp_port === r.tcp_port)
      const fields = { store_id: storeId, type: r.type, name: r.name, ip: r.ip, tcp_port: r.tcp_port, notes: r.notes }
      if (existing) {
        const { error } = await admin.from('devices').update(fields).eq('id', existing.id)
        if (error) throw error
        result.updated++
      } else {
        const { error } = await admin.from('devices').insert({ ...fields, org_id: actor.orgId })
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
