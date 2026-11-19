import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { inventoryAdmin, MSG_INVENTORY_DENIED, type InventoryClients } from '@/lib/inventory/admin-gate'
import { pickPrimaries } from '@/lib/inventory/recorders'
import { parseLocationsCsv, type ImportIssue } from '@/lib/import/locations-csv'
import { planImport, type ApplyPlan, type ImportPreview, type ImportSnapshot, type PlanOptions } from '@/lib/import/locations-plan'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { isProductionMode } from '@/lib/runtime-mode'
import { dropLiveStreams } from '@/lib/streams/go2rtc'
import { fetchAll } from '@/lib/supabase/fetch-all'
import type { Json } from '@/types/database'

// The validated location import (P2-5c-2 brief item 1; docs/drishti/admin-guide-import.md): check (validate + preview, writes nothing)
// and apply (the same plan again, bound to the preview by its fingerprint, carried out in ONE database transaction by
// inventory_import_apply). Who: an administrative role AND admin.inventory for the whole organisation, from the person's own summary
// (inventoryAdmin) — asked before anything is read. Everything is then read and written with the service role, scoped to the person's
// organisation. The file's passwords go only into the apply plan (server side) and from there into the vault; the preview, the result,
// the audit and the logs never hold one. Review B-I3: nothing compares a given password with the saved one before the apply (the
// preview is not an oracle); inside the transaction the database writes a given password only when it differs.

export const MAX_FILE_CHARS = 5 * 1024 * 1024
export const MSG_PLAN_CHANGED = 'Something changed since you checked the file (another person, or another import). Check the file again before importing.'
export const MSG_FILE_PROBLEMS = 'The file has problems. Fix them, or choose “Skip the rows with problems”, and check the file again.'
export const MSG_NOTHING = 'There is nothing in this file that can be imported.'
export const MSG_ARCHIVE_NEEDS_CLEAN_FILE = 'Archiving what is not in the file needs a file without problems.'
const MSG_TOO_BIG = 'Choose a CSV file smaller than 5 MB.'

export type ImportOutcome = {
  locationsCreated: number; locationsUpdated: number; recordersCreated: number; recordersUpdated: number
  /** Passwords the file gave (each written only where it differed; how many differed is never told back, review B-I3). */
  passwordsGiven: number
  camerasCreated: number; camerasRelinked: number; regionsCreated: number; clustersCreated: number
  archived: { locations: number; recorders: number; cameras: number }
  warnings: ImportIssue[]
}

/**
 * What the plan needs from the organisation's inventory (service role, after the caller's checks; organisation-scoped). Review B-I3:
 * nothing about saved passwords but whether one is saved.
 */
export async function loadImportSnapshot(admin: AdminClient, orgId: string): Promise<ImportSnapshot> {
  const [allLocations, recorders, active, history, regions, clusters, unmapped] = await Promise.all([
    fetchAll((f, t) => admin.from('locations').select('id, code, name, kind, city, zone, state, address, cluster_id, archived_at').eq('org_id', orgId).order('id').range(f, t)),
    fetchAll((f, t) => admin.from('recorders')
      .select('id, location_id, http_port, rtsp_port, username, expected_channels, monitoring_enabled, secret_id, migrated_from_location_id, created_at, assets!recorders_asset_fk!inner(name, ip, archived_at), locations!recorders_location_fk!inner(archived_at)')
      .eq('org_id', orgId).is('assets.archived_at', null).is('locations.archived_at', null).order('created_at').order('id').range(f, t)),
    fetchAll((f, t) => admin.from('camera_channel_mappings').select('id, camera_id, recorder_id, channel, cameras!inner(name, archived_at)')
      .eq('org_id', orgId).is('valid_to', null).is('cameras.archived_at', null).order('id').range(f, t)),
    fetchAll((f, t) => admin.from('camera_channel_mappings').select('id, recorder_id, channel').eq('org_id', orgId).order('id').range(f, t)),
    fetchAll((f, t) => admin.from('regions').select('id, code').eq('org_id', orgId).is('archived_at', null).order('id').range(f, t)),
    fetchAll((f, t) => admin.from('clusters').select('id, code, region_id').eq('org_id', orgId).is('archived_at', null).order('id').range(f, t)),
    fetchAll((f, t) => admin.from('cameras').select('id, location_id, channel').eq('org_id', orgId).is('archived_at', null).is('recorder_id', null).order('id').range(f, t)),
  ])
  const locations = allLocations.filter((l) => l.archived_at === null)
  const live = new Set(locations.map((l) => l.code.toUpperCase()))
  // The last mapping of each unmapped camera (review B-M12: the database puts such a camera back on its channel).
  const lastOf = new Map<string, { recorder_id: string; channel: number; valid_to: string }>()
  const looseIds = new Set(unmapped.map((c) => c.id))
  if (looseIds.size > 0) {
    const closed = await fetchAll((f, t) => admin.from('camera_channel_mappings').select('id, camera_id, recorder_id, channel, valid_to').eq('org_id', orgId)
      .not('valid_to', 'is', null).order('id').range(f, t))
    for (const m of closed) {
      if (!looseIds.has(m.camera_id) || !m.valid_to) continue
      const seen = lastOf.get(m.camera_id)
      if (!seen || Date.parse(m.valid_to) > Date.parse(seen.valid_to)) lastOf.set(m.camera_id, { recorder_id: m.recorder_id, channel: m.channel, valid_to: m.valid_to })
    }
  }
  type Rec = { id: string; location_id: string; http_port: number; rtsp_port: number; username: string | null; expected_channels: number; monitoring_enabled: boolean; secret_id: string | null; migrated_from_location_id: string | null; assets: { name: string; ip: string | null } }
  const recs = recorders as unknown as Rec[]
  const primaries = new Set([...pickPrimaries(recs).values()].map((r) => r.id))
  const ever: Record<string, number[]> = {}
  for (const m of history) (ever[m.recorder_id] ??= []).push(m.channel)
  return {
    locations: locations.map(({ archived_at: _a, ...l }) => (void _a, { ...l, kind: l.kind as string })),
    archivedCodes: [...new Set(allLocations.filter((l) => l.archived_at !== null && !live.has(l.code.toUpperCase())).map((l) => l.code.toUpperCase()))],
    looseCameras: unmapped.map((c) => ({ id: c.id, location_id: c.location_id, channel: c.channel, last_recorder_id: lastOf.get(c.id)?.recorder_id ?? null, last_channel: lastOf.get(c.id)?.channel ?? null })),
    recorders: recs.map((r) => ({
      id: r.id, location_id: r.location_id, name: r.assets.name, host: r.assets.ip, http_port: r.http_port, rtsp_port: r.rtsp_port, username: r.username,
      expected_channels: r.expected_channels, monitoring_enabled: r.monitoring_enabled, has_password: r.secret_id !== null, primary: primaries.has(r.id),
    })),
    activeCameras: (active as unknown as { camera_id: string; recorder_id: string; channel: number; cameras: { name: string } }[])
      .map((m) => ({ id: m.camera_id, recorder_id: m.recorder_id, channel: m.channel, name: m.cameras.name })),
    channelsEverMapped: ever,
    regions, clusters,
  }
}

/**
 * Parse + snapshot + plan, WITHOUT the caller's checks: only for callers that have checked already (the services below) and for the
 * owner's local command-line tool (scripts/import-estate-local.ts, local stack only), whose writes the database checks again
 * (inventory_import_apply asks for a super administrator or admin.inventory for the organisation).
 */
export async function prepareImport(admin: AdminClient, actor: Actor, text: string, opts: PlanOptions) {
  return prepare(admin, actor, text, opts)
}

/**
 * Final clean-up (review C M-30): the stamp of the inventory the plan is worked out from (inventory_import_stamp, a hash of what the
 * snapshot reads), read BEFORE the snapshot, so a change made in between also makes the apply refuse (DR051) instead of applying a
 * plan made from an older inventory.
 */
async function importStamp(admin: AdminClient, orgId: string): Promise<string> {
  const { data, error } = await admin.rpc('inventory_import_stamp', { p_org: orgId })
  if (error || typeof data !== 'string') throw new Error('The inventory could not be read.')
  return data
}

async function prepare(admin: AdminClient, actor: Actor, text: string, opts: PlanOptions) {
  const stamp = await importStamp(admin, actor.orgId)
  // Final fix X (NB-4): in production a new NVR without a monitoring value in the file starts switched off.
  return { ...planImport(parseLocationsCsv(text), await loadImportSnapshot(admin, actor.orgId), { newRecordersMonitored: !isProductionMode(), ...opts }), stamp }
}

/** Validate + preview: reads the file and the inventory, writes nothing. The preview holds no password and compares none (B-I3). */
export async function checkLocationImport(clients: InventoryClients, actor: Actor, text: string, opts: { skipBadRows: boolean; keepNames?: boolean }): Promise<Result<{ preview: ImportPreview }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FILE_CHARS) return { ok: false, error: MSG_TOO_BIG }
  try {
    const { preview } = await prepare(clients.admin, actor, text, { skipBadRows: opts?.skipBadRows === true, keepNames: opts?.keepNames === true })
    return { ok: true, preview }
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'checkLocationImport', fallback: 'Could not check the file. Try again.' }) }
  }
}

/** Plain words for what the database refused (the line comes from the error's DETAIL). */
function refusal(e: { code?: string; message?: string; details?: string } | null): string {
  const line = /import_line:(\d+)/.exec(e?.details ?? '')?.[1]
  const why = (() => {
    switch (e?.code) {
      case 'DR051': return MSG_PLAN_CHANGED
      case 'DR010': return 'another NVR of this location already has this address and web port.'
      case '23505': return 'a code or an address is already used.'
      case '23514': return 'a value is not allowed there (check the kind and the lengths).'
      case '22023': return 'a value is not valid.'
      case 'P0002': return 'something the file refers to is not there any more. Check the file again.'
      case '42501': return MSG_INVENTORY_DENIED
      default: return sanitizeError(e, { route: 'applyLocationImport', fallback: 'the database refused it.' })
    }
  })()
  return `Nothing was imported. ${line ? `Line ${line}: ` : ''}${why}`
}

/**
 * Apply: the plan is worked out again from the file and the current inventory and must have the fingerprint of the preview the person
 * saw (otherwise nothing is written: MSG_PLAN_CHANGED). All of it is saved in one transaction, or nothing. `archive`: the person
 * confirmed archiving what is not in the file (only for a file without problems).
 */
export async function applyLocationImport(
  clients: InventoryClients, actor: Actor, text: string, opts: { skipBadRows: boolean; keepNames?: boolean; archive: boolean; fingerprint: string },
): Promise<Result<{ result: ImportOutcome; preview: ImportPreview }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FILE_CHARS) return { ok: false, error: MSG_TOO_BIG }
  const skipBadRows = opts?.skipBadRows === true
  const archive = opts?.archive === true
  let planned: Awaited<ReturnType<typeof prepare>>
  try {
    planned = await prepare(clients.admin, actor, text, { skipBadRows, archive, keepNames: opts?.keepNames === true })
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'applyLocationImport', fallback: 'Could not check the file. Try again.' }) }
  }
  const { preview, apply } = planned
  if (typeof opts?.fingerprint !== 'string' || preview.fingerprint !== opts.fingerprint) return { ok: false, error: MSG_PLAN_CHANGED }
  if (preview.errors.length > 0 && !skipBadRows) return { ok: false, error: MSG_FILE_PROBLEMS }
  if (archive && !preview.archiveAllowed) return { ok: false, error: MSG_ARCHIVE_NEEDS_CLEAN_FILE }
  if (!preview.canApply) return { ok: false, error: MSG_NOTHING }
  const done = await runImportPlan(clients, actor, apply, preview.warnings, planned.stamp)
  return done.ok ? { ok: true, preview, result: done.result } : done
}

/**
 * Carries out a plan in one transaction, then the follow-ups. Final clean-up (review C M-30): through inventory_import_run, which
 * checks the acting person, takes the organisation's import lock (one import at a time; a second one waits) and refuses the plan when
 * the inventory is no longer the one stamped when the plan was worked out (DR051: MSG_PLAN_CHANGED).
 */
export async function runImportPlan(
  clients: Pick<InventoryClients, 'admin' | 'go2rtc'>, actor: Actor, apply: ApplyPlan, warnings: ImportIssue[], stamp: string,
): Promise<Result<{ result: ImportOutcome }>> {
  const { data, error } = await clients.admin.rpc('inventory_import_run', { p_org: actor.orgId, p_actor: actor.id, p_plan: apply as unknown as Json, p_stamp: stamp })
  if (error || !data) return { ok: false, error: refusal(error) }
  const r = data as Record<string, number> & { dropped_camera_ids?: string[] }
  // Archived cameras' live streams are removed from go2rtc (review M-4); never fatal.
  if (clients.go2rtc && (r.dropped_camera_ids ?? []).length > 0) await dropLiveStreams(clients.go2rtc, r.dropped_camera_ids!)
  // A bulk change: fresh planner statistics keep the pages fast at once (P2-5b ruling 9). A failure is only logged.
  if (r.locations_created + r.locations_updated + r.recorders_created + r.archived_locations + r.archived_cameras >= 20 || r.cameras_created >= 100) {
    const { error: statsError } = await clients.admin.rpc('inventory_refresh_statistics')
    if (statsError) sanitizeError(statsError, { route: 'applyLocationImport.statistics' })
  }
  return {
    ok: true,
    result: {
      locationsCreated: r.locations_created, locationsUpdated: r.locations_updated, recordersCreated: r.recorders_created, recordersUpdated: r.recorders_updated,
      passwordsGiven: r.passwords_given, camerasCreated: r.cameras_created, camerasRelinked: r.cameras_relinked, regionsCreated: r.regions_created,
      clustersCreated: r.clusters_created, archived: { locations: r.archived_locations, recorders: r.archived_recorders, cameras: r.archived_cameras },
      warnings,
    },
  }
}
