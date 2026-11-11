import type { Actor, AdminClient } from '@/lib/admin/types'
import { isAdminRole } from '@/lib/admin/roles'
import type { DeviceIssue, DeviceRow } from '@/lib/import/devices-csv'
import { logger } from '@/lib/observability/logger'
import type { Json } from '@/types/database'

// Release 1 clean-ups (T-1 review L2): the legacy location import (importStores, with its arbitrary "primary NVR" pick) left lib/; it
// lives on only as a test fixture (tests/setup/legacy-import.ts). Locations are imported by lib/import/locations-import.ts.
//
// Final fix Y (final review C I-8): the device import is applied by the database in ONE transaction (inventory_devices_import, migration
// 20261021000049): a check (apply = false) tries everything and keeps nothing; an import keeps everything or, with any row problem,
// nothing. A device is matched by address and port among the organisation's devices (the five device types); an access point, switch,
// router or other kind of equipment at that address, or an NVR, is never changed. Empty cells keep what is saved. The database checks
// the actor's admin.inventory again and writes the audit row (import_devices). Messages name the column, never a cell value.

export type DeviceImportOutcome = { created: number; updated: number; errors: DeviceIssue[]; applied: boolean }
export type ImportResult = DeviceImportOutcome

export const MSG_IMPORT_FAILED = 'The file could not be imported. Nothing was saved. Please try again.'

export async function importDevices(admin: AdminClient, actor: Actor, rows: DeviceRow[], apply: boolean): Promise<DeviceImportOutcome | { error: string }> {
  if (!isAdminRole(actor.role)) return { error: 'Only administrators can import.' }
  if (rows.length === 0) return { created: 0, updated: 0, errors: [], applied: false }
  const { data, error } = await admin.rpc('inventory_devices_import', { p_org: actor.orgId, p_actor: actor.id, p_rows: rows as unknown as Json, p_apply: apply })
  if (error || !data || typeof data !== 'object') {
    logger.warn({ event: 'device_import_failed', code: error?.code ?? 'no_answer' })
    return { error: error?.code === '42501' ? 'Only an administrator with the inventory right can import devices.' : MSG_IMPORT_FAILED }
  }
  return data as unknown as DeviceImportOutcome
}
