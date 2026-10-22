import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { isAdminRole } from '@/lib/admin/roles'
import { holdsOrgWide, readCapabilities } from '@/lib/auth/capabilities'
import { MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { sanitizeError } from '@/lib/observability/sanitize-error'

// Archive and restore (P2-5a, decision D5-3; service layer of P2-5b for the P2-5c screens). Nothing in the inventory is ever deleted:
// archiving switches the node off, keeps its history, grants and groups, and raises the access version of exactly the people whose
// access changes (inventory_affected_people → access_bump_versions, the P2-4 revalidation signal); restore brings it back. Both are
// done by the database (inventory_archive / inventory_restore) in one transaction, audited with the acting person.

export type ArchiveKind = 'location' | 'recorder' | 'camera' | 'asset' | 'cluster' | 'region'
const KINDS: readonly ArchiveKind[] = ['location', 'recorder', 'camera', 'asset', 'cluster', 'region']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DENIED = 'Only administrators can archive or restore.'
export const MSG_NOT_FOUND = 'Not found.'
/** The database's refusals, in plain words. */
const REFUSALS: Record<string, string> = {
  DR004: 'Move or archive the cameras of this NVR first.',
  DR007: 'Move or archive what it still contains first.',
  P0002: MSG_NOT_FOUND,
  '42501': DENIED,
}

/**
 * An administrative role AND admin.inventory for the organisation (it has organisation scope only), asked as the person (their own
 * summary: also true in an organisation whose every location is archived, where no location could prove it).
 */
async function allowed(rls: AdminClient, actor: Actor): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const caps = await readCapabilities(rls)
  if (caps.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  return holdsOrgWide(caps, 'admin.inventory') ? { ok: true } : { ok: false, error: DENIED }
}

async function run(fn: 'inventory_archive' | 'inventory_restore', clients: { admin: AdminClient; rls: AdminClient }, actor: Actor, kind: ArchiveKind, id: string): Promise<Result<object>> {
  if (!KINDS.includes(kind)) return { ok: false, error: MSG_NOT_FOUND }
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: MSG_NOT_FOUND }
  const may = await allowed(clients.rls, actor)
  if (!may.ok) return may
  const { error } = await clients.admin.rpc(fn, { p_org: actor.orgId, p_kind: kind, p_id: id.toLowerCase(), p_actor: actor.id })
  if (error) {
    const plain = error.code ? REFUSALS[error.code] : undefined
    if (plain) return { ok: false, error: plain }
    return { ok: false, error: sanitizeError(error, { route: fn, fallback: fn === 'inventory_archive' ? 'Could not archive it.' : 'Could not restore it.' }) }
  }
  return { ok: true }
}

/** Archives one node of the organisation (a recorder with cameras, or a cluster / region with contents, is refused plainly). */
export function archiveInventory(clients: { admin: AdminClient; rls: AdminClient }, actor: Actor, kind: ArchiveKind, id: string): Promise<Result<object>> {
  return run('inventory_archive', clients, actor, kind, id)
}

/**
 * Restores one archived node. Restored cameras come back UNMAPPED (5a ruling): run the NVR's camera discovery (it puts them back on
 * their channel) or map them, and only then are they checked and streamed again.
 */
export function restoreInventory(clients: { admin: AdminClient; rls: AdminClient }, actor: Actor, kind: ArchiveKind, id: string): Promise<Result<object>> {
  return run('inventory_restore', clients, actor, kind, id)
}
