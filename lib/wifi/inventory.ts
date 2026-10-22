import type { AdminClient, Result } from '@/lib/admin/types'
import { holds, readCapabilities } from '@/lib/auth/capabilities'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { ASSET_TYPE_LABELS, type AssetType } from '@/lib/inventory/forms'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { isStale } from '@/lib/queries/status'

// The Wi-Fi inventory (P2-5c-2 brief item 4; supplement section A, decisions W-1, W-2, W-5). Access points, routers and switches are
// ordinary assets of the one inventory (no second list); this view shows them to holders of wifi.inventory.view, at the places they
// hold it for, through the person's OWN client: the list from wifi_inventory() (the database applies the grants) and the documented
// capability matrix from device_capabilities (readable by holders of wifi.inventory.view). Nothing here contacts a device. The matrix
// is documentation evidence only: nothing is lab-validated, so the view says plainly "Documented — not tested here", "Not supported"
// or "Unverified" (anything the documentation does not cover is unverified). The Wi-Fi profile an AP should carry is a placeholder
// until the profile module exists (WF-6).

export const MSG_WIFI_DENIED = 'You do not have access to the Wi-Fi inventory. Ask an administrator for “See Wi-Fi access points, routers and switches”.'

/** The operations of the matrix, in the order the screen shows them (docs/drishti/wifi-capability-research.md). */
export const OPERATIONS = [
  ['inventory', 'Inventory (model, serial, firmware)'], ['health_metrics', 'Health and client counts'], ['config_read', 'Read the configuration'],
  ['ssid_security', 'SSID and security settings'], ['mac_acl', 'MAC allow / deny lists'], ['radio', 'Radio settings'], ['backup_restore', 'Backup and restore'],
  ['firmware_upgrade', 'Firmware upgrade'], ['reboot', 'Reboot'], ['snmpv3', 'SNMPv3'], ['snmpv1v2c', 'SNMP v1 / v2c'], ['snmpv2c_compat', 'SNMP v2c compatibility'],
  ['ssh', 'SSH'], ['telnet', 'Telnet'], ['syslog', 'Syslog'], ['ntp', 'NTP'], ['rest_api', 'REST API'],
] as const

export type Support = 'supported' | 'unsupported' | 'unverified'
export const SUPPORT_WORDS: Record<Support, string> = { supported: 'Documented — not tested here', unsupported: 'Not supported', unverified: 'Unverified' }

export type MatrixRow = {
  vendor: string; model: string; firmware_min: string | null; firmware_max: string | null; management_mode: string; operation: string
  support: string; source_ref: string; notes: string | null; adapter_state: string
}
export type CapabilityRow = { operation: string; label: string; support: Support; source: string | null; notes: string | null; labValidated: boolean }

export type WifiItem = {
  id: string; locationId: string | null; locationCode: string | null; locationName: string | null
  /** Plain kind: "Wi-Fi access point", "Router", "Switch". */
  kind: string
  name: string; vendor: string | null; model: string | null; firmware: string | null; serial: string | null; mac: string | null
  managementMode: string | null; managementIp: string | null; lifecycle: string
  reachability: 'Reachable' | 'Not reachable' | 'Not checked lately' | 'Not checked yet' | 'Monitoring off'
  lastChecked: string | null
  profile: string
  capabilities: CapabilityRow[]
  /** One line about the capabilities ("3 documented, 2 not supported, 12 unverified" or why there are none). */
  capabilitySummary: string
}

/** Compares dotted version strings number by number ("10.5.1" > "10.4.12"); non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split(/[.\-_]/)
  const pb = b.trim().split(/[.\-_]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = /^\d+$/.test(x) ? Number(x) : NaN
    const ny = /^\d+$/.test(y) ? Number(y) : NaN
    const c = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny
    if (c !== 0) return c < 0 ? -1 : 1
  }
  return 0
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * The documented capabilities of one device: every operation of the matrix, from the rows for its vendor, model and management mode
 * whose firmware range covers its firmware (a row without a range covers every firmware; the most specific range wins); an operation
 * the documentation does not cover is "unverified". Without vendor, model or management mode nothing can be matched: [].
 */
export function capabilitiesFor(asset: { vendor: string | null; model: string | null; firmware: string | null; managementMode: string | null }, matrix: readonly MatrixRow[]): CapabilityRow[] {
  if (!asset.vendor || !asset.model || !asset.managementMode) return []
  const fits = matrix.filter((r) => same(r.vendor, asset.vendor) && same(r.model, asset.model) && same(r.management_mode, asset.managementMode)).filter((r) => {
    if (r.firmware_min && (!asset.firmware || compareVersions(asset.firmware, r.firmware_min) < 0)) return false
    if (r.firmware_max && (!asset.firmware || compareVersions(asset.firmware, r.firmware_max) > 0)) return false
    return true
  })
  return OPERATIONS.map(([op, label]) => {
    const rows = fits.filter((r) => r.operation === op).sort((a, b) => compareVersions(b.firmware_min ?? '0', a.firmware_min ?? '0'))
    const r = rows[0]
    if (!r) return { operation: op, label, support: 'unverified' as const, source: null, notes: 'No documentation found for this model and mode.', labValidated: false }
    const support: Support = r.support === 'supported' || r.support === 'unsupported' ? r.support : 'unverified'
    return { operation: op, label, support, source: r.source_ref, notes: r.notes, labValidated: r.adapter_state === 'lab_validated' }
  })
}

export function capabilitySummary(asset: { vendor: string | null; model: string | null; managementMode: string | null }, rows: readonly CapabilityRow[]): string {
  if (!asset.vendor || !asset.model) return 'Add the vendor and exact model to see what the documentation says.'
  if (!asset.managementMode) return 'Add the management mode (for example standalone) to see what the documentation says.'
  const lab = rows.filter((r) => r.support === 'supported' && r.labValidated).length
  const n = (s: Support) => rows.filter((r) => r.support === s).length
  // (review note: never "none tested here" when a row is lab-validated)
  return `${lab} tested in the lab, ${n('supported') - lab} documented (not tested here), ${n('unsupported')} not supported, ${n('unverified')} unverified.`
}

export function reachabilityOf(r: { enabled: boolean; status: string | null; last_checked_at: string | null }, now: Date = new Date()): WifiItem['reachability'] {
  if (!r.enabled) return 'Monitoring off'
  if (!r.status || r.status === 'unknown' || !r.last_checked_at) return 'Not checked yet'
  // As statusLabel: a "down" stays down however old the result is; only a live result goes stale.
  if (r.status === 'down') return 'Not reachable'
  return isStale(r.last_checked_at, now) ? 'Not checked lately' : 'Reachable'
}

const KINDS = ['access_point', 'router', 'switch'] as const
function kindOf(type: string, role: string | null): string {
  const t = (KINDS as readonly string[]).includes(type) ? type : (role ?? '').trim().toLowerCase()
  return ASSET_TYPE_LABELS[t as AssetType] ?? 'Network device'
}

type InventoryRow = {
  asset_id: string; location_id: string | null; location_code: string | null; location_name: string | null; asset_type: string; role: string | null; name: string
  vendor: string | null; model: string | null; firmware: string | null; serial: string | null; mac: string | null; management_mode: string | null; management_ip: string | null
  enabled: boolean; lifecycle_state: string; assigned_profile_id: string | null; status: string | null; last_checked_at: string | null
}

/** The Wi-Fi inventory as the person may see it (their own client). Refused without wifi.inventory.view anywhere. */
export async function wifiInventory(rls: AdminClient, now: Date = new Date()): Promise<Result<{ items: WifiItem[] }>> {
  const caps = await readCapabilities(rls)
  if (caps.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  if (!holds(caps, 'wifi.inventory.view')) return { ok: false, error: MSG_WIFI_DENIED }
  const [list, matrix] = await Promise.all([
    rls.rpc('wifi_inventory'),
    rls.from('device_capabilities').select('vendor, model, firmware_min, firmware_max, management_mode, operation, support, source_ref, notes, adapter_state'),
  ])
  if (list.error || matrix.error) return { ok: false, error: sanitizeError(list.error ?? matrix.error, { route: 'wifiInventory', fallback: 'Could not read the Wi-Fi inventory.' }) }
  const rows = (list.data ?? []) as InventoryRow[]
  return {
    ok: true,
    items: rows.map((r) => {
      const asset = { vendor: r.vendor, model: r.model, firmware: r.firmware, managementMode: r.management_mode }
      const capabilities = capabilitiesFor(asset, (matrix.data ?? []) as MatrixRow[])
      return {
        id: r.asset_id, locationId: r.location_id, locationCode: r.location_code, locationName: r.location_name, kind: kindOf(r.asset_type, r.role), name: r.name,
        vendor: r.vendor, model: r.model, firmware: r.firmware, serial: r.serial, mac: r.mac, managementMode: r.management_mode, managementIp: r.management_ip,
        lifecycle: r.lifecycle_state, reachability: reachabilityOf(r, now), lastChecked: r.last_checked_at,
        profile: r.assigned_profile_id ? 'Assigned (profiles arrive with the Wi-Fi profile module)' : 'Not assigned',
        capabilities, capabilitySummary: capabilitySummary(asset, capabilities),
      }
    }),
  }
}
