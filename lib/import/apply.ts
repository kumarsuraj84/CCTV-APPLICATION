import type { Actor, AdminClient } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/admin/roles'
import type { RowError } from '@/lib/import/csv'
import type { DeviceRow } from '@/lib/import/devices-csv'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { fetchAll } from '@/lib/supabase/fetch-all'

// Release 1 clean-ups (T-1 review L2): the legacy location import (importStores, with its arbitrary "primary NVR" pick) left lib/; it
// lives on only as a test fixture (tests/setup/legacy-import.ts). Locations are imported by lib/import/locations-import.ts.

/** `warnings`: rows that were saved but need a look. */
export type ImportResult = { created: number; updated: number; errors: RowError[]; warnings?: RowError[] }

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
          result.errors.push({ line: r.line, message: `There is no location with the code ${r.store_code}.` })
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
