import { isAdminRole } from '@/lib/admin/roles'
import type { Actor, AdminClient } from '@/lib/admin/types'
import { holdsOrgWide, readCapabilities } from '@/lib/auth/capabilities'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'

// The one gate of the P2-5c administration services (regions, clusters, locations, NVRs, mapping, merge, reconciliation, assets).
// The Server Action has already checked the session, that the person is active and has chosen their password, the administrative role
// and admin.inventory (requireAdministration). The service asks again, in this order: the administrative role (authority), then
// admin.inventory for the WHOLE organisation from the person's own summary (the database evaluates it: validity, revocation, status,
// MFA once enforced). Only then is anything read or written with the service role — always scoped to the person's organisation, so an
// id of another organisation simply is not found.

export const MSG_INVENTORY_DENIED = 'Only administrators can change locations, NVRs and assets.'

/** Clients of the administration services. `go2rtc`: when given, the live streams of cameras that move or go away are removed (M-4). */
export type InventoryClients = { admin: AdminClient; rls: AdminClient; go2rtc?: Go2rtcClient }

export async function inventoryAdmin(rls: AdminClient, actor: Actor): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isAdminRole(actor.role)) return { ok: false, error: MSG_INVENTORY_DENIED }
  const caps = await readCapabilities(rls)
  if (caps.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  return holdsOrgWide(caps, 'admin.inventory') ? { ok: true } : { ok: false, error: MSG_INVENTORY_DENIED }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A well-formed id, lower case; null otherwise (an id that is not an id is treated like one that does not exist). */
export const cleanId = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null)
