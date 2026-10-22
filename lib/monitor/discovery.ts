import { isAdminRole } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { mapLimit } from '@/lib/async/pool'
import { auditAccess } from '@/lib/auth/access-audit'
import { holdsOrgWide, readCapabilities } from '@/lib/auth/capabilities'
import { locationFor, MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { reattachableByChannel } from '@/lib/inventory/cameras'
import { loadRecorders, MSG_MONITORING_OFF, readRecorderPassword, recordersOfLocation, type Recorder } from '@/lib/inventory/recorders'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { describeNvrError } from '@/lib/nvr/client'
import { sanitizeError } from '@/lib/observability/sanitize-error'

// Camera discovery, per recorder (P2-5b). Reads the channel list from ONE NVR and saves names and addresses. Cameras keep their ids:
//   1. a channel already mapped to this NVR is that camera (match by recorder + channel, the ACTIVE mapping);
//   2. else an unmapped camera of the location that was on this NVR's channel before (or any unmapped one when the location has only
//      this NVR) is put back on it;
//   3. else, when another camera of the location looks like the one on this channel (same reported address, or same name) — it may have
//      been moved between NVRs — NOTHING is created: the channel is listed for reconciliation, so a camera never gets a second identity;
//   4. else a new camera is created, mapped to this NVR's channel.
// Nothing is ever deleted or archived: a camera whose channel the NVR no longer lists is reported too. One attempt only: a refused
// login is reported, never retried (a wrong password must not lock the NVR account). A switched-off NVR is never contacted.
//
// Who (P2-2): an administrative role (admin / platform owner) AND admin.inventory covering the location, asked as the person
// (admin.inventory is organisation-wide, so this also proves the location is in the person's organisation). Only then are the NVR
// address and password read with the service role, scoped to the organisation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 200

const DENIED = 'Only administrators can look for cameras.'
export const MSG_NVR_NOT_FOUND = 'NVR not found.'
export const MSG_NO_NVR_PASSWORD = 'This NVR has no password saved. Add it on the Manage stores page first.'
export const MSG_NO_NVR = 'This store has no NVR.'

/** Something an administrator should look at; nothing was changed for it. */
export type Reconciliation =
  /** The NVR lists this channel and no camera is mapped to it, but camera `cameraId` of the location may be the one (moved between NVRs, or unmapped on another channel). Not created. */
  | { kind: 'possible_move'; channel: number; reportedName: string; cameraId: string; cameraName: string; because: 'same_address' | 'same_name' | 'unmapped_same_channel' }
  /** A camera mapped to this NVR whose channel the NVR no longer lists. Kept as it is (never deleted or archived). */
  | { kind: 'missing'; channel: number; cameraId: string; cameraName: string }
  /** The NVR gives a matched camera a different name; the NVR's name was saved. */
  | { kind: 'renamed'; channel: number; cameraId: string; from: string; to: string }

export type RecorderDiscovery = {
  recorderId: string; locationId: string
  /** Channels the NVR listed. */
  cameras: number
  created: number
  /** Cameras already on this NVR whose name or address was refreshed. */
  updated: number
  /** Unmapped cameras put back on this NVR. */
  mapped: number
  reconciliation: Reconciliation[]
}

type Clients = { admin: AdminClient; rls: AdminClient }
type Deps = { nvr: Probes['nvr'] }
const defaults: Deps = { nvr: realProbes.nvr }

const placeholderOf = (channel: number) => `Camera ${channel}`
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Discovery of one recorder after every check has passed (the caller has proven admin.inventory for its location). `rec` was read with
 * the service role. Never throws for NVR trouble: a plain error.
 */
async function discoverOne(clients: Clients, actor: Actor, rec: Recorder, deps: Deps): Promise<Result<RecorderDiscovery>> {
  const admin = clients.admin
  // Owner addition: a switched-off NVR is never contacted (checked before its password is read).
  if (!rec.monitored) return { ok: false, error: MSG_MONITORING_OFF }
  if (!rec.host) return { ok: false, error: 'This NVR has no address saved.' }
  // The password is read here, used for this one call and not kept anywhere.
  const read = await readRecorderPassword(admin, rec.id)
  if (!read.ok) return { ok: false, error: sanitizeError({ code: read.code }, { route: 'discoverRecorderCameras', fallback: 'Could not read the NVR password.' }) }
  if (!read.password) return { ok: false, error: MSG_NO_NVR_PASSWORD }

  let channels
  try {
    channels = await deps.nvr({ host: rec.host, port: rec.http_port, username: rec.username, password: read.password }).channels()
  } catch (e) {
    return { ok: false, error: describeNvrError(e) }
  }
  if (channels.length === 0) return { ok: false, error: 'The NVR did not list any cameras.' }

  const fail = (error: unknown, fallback: string): { ok: false; error: string } => ({ ok: false, error: sanitizeError(error, { route: 'discoverRecorderCameras', fallback }) })
  const [{ data: existing, error: existingError }, { data: active, error: activeError }] = await Promise.all([
    admin.from('cameras').select('id, channel, name, camera_ip, recorder_id').eq('location_id', rec.location_id).eq('org_id', actor.orgId).is('archived_at', null).order('id'),
    admin.from('camera_channel_mappings').select('camera_id, channel').eq('org_id', actor.orgId).eq('recorder_id', rec.id).is('valid_to', null),
  ])
  if (existingError || activeError) return fail(existingError ?? activeError, 'Could not read the cameras.')
  let back: Map<number, string>
  try {
    back = await reattachableByChannel(admin, actor.orgId, rec.location_id, rec.id)
  } catch (e) {
    return fail(e, 'Could not read the cameras.')
  }
  const byId = new Map((existing ?? []).map((c) => [c.id, c]))
  const onThis = new Map((active ?? []).filter((m) => byId.has(m.camera_id)).map((m) => [m.channel, byId.get(m.camera_id)!]))
  const used = new Set<string>([...onThis.values()].map((c) => c.id))
  const reconciliation: Reconciliation[] = []
  const updates: { id: string; fields: { name: string; camera_ip: string | null; recorder_id?: string; channel?: number } }[] = []
  const fresh: { org_id: string; location_id: string; recorder_id: string; channel: number; name: string; camera_ip: string | null }[] = []
  let updated = 0
  let mapped = 0

  const listed = new Set<number>()
  for (const c of channels) {
    listed.add(c.channel)
    const placeholder = placeholderOf(c.channel)
    const reported = (c.name.trim() || placeholder).slice(0, MAX_NAME)
    // A name the NVR only made up (its own placeholder) does not overwrite a name somebody chose.
    const nameFor = (old?: string) => (reported === placeholder && old ? old : reported)
    const mine = onThis.get(c.channel)
    if (mine) {
      const name = nameFor(mine.name)
      if (!sameName(name, mine.name) && mine.name !== placeholder) reconciliation.push({ kind: 'renamed', channel: c.channel, cameraId: mine.id, from: mine.name, to: name })
      // An address the NVR does not report now is not forgotten.
      updates.push({ id: mine.id, fields: { name, camera_ip: c.ip ?? mine.camera_ip ?? null } })
      updated++
      continue
    }
    const loose = back.get(c.channel)
    if (loose && !used.has(loose)) {
      const cam = byId.get(loose)!
      used.add(loose)
      updates.push({ id: loose, fields: { name: nameFor(cam.name), camera_ip: c.ip ?? cam.camera_ip ?? null, recorder_id: rec.id, channel: c.channel } })
      mapped++
      continue
    }
    // Rule 3: never a second identity for a camera that may only have moved. Another NVR's camera, or an unmapped one, that looks like
    // this channel's camera is listed for an administrator to decide (remap it, or leave it), and nothing is created.
    const others = (existing ?? []).filter((x) => !used.has(x.id) && x.recorder_id !== rec.id)
    const sameAddress = c.ip ? others.find((x) => x.camera_ip === c.ip) : undefined
    const sameNamed = reported !== placeholder ? others.find((x) => sameName(x.name, reported)) : undefined
    const unmappedSameChannel = others.find((x) => x.recorder_id === null && x.channel === c.channel)
    const candidate = sameAddress ?? sameNamed ?? unmappedSameChannel
    if (candidate) {
      used.add(candidate.id)
      reconciliation.push({
        kind: 'possible_move', channel: c.channel, reportedName: reported, cameraId: candidate.id, cameraName: candidate.name,
        because: sameAddress ? 'same_address' : sameNamed ? 'same_name' : 'unmapped_same_channel',
      })
      continue
    }
    fresh.push({ org_id: actor.orgId, location_id: rec.location_id, recorder_id: rec.id, channel: c.channel, name: reported, camera_ip: c.ip ?? null })
  }
  for (const [channel, cam] of onThis) if (!listed.has(channel)) reconciliation.push({ kind: 'missing', channel, cameraId: cam.id, cameraName: cam.name })

  if (fresh.length > 0) {
    const { error } = await admin.from('cameras').insert(fresh)
    if (error) return fail(error, 'Could not save the cameras.')
  }
  for (const u of updates) {
    const { error } = await admin.from('cameras').update(u.fields).eq('id', u.id).eq('org_id', actor.orgId)
    if (error) return fail(error, 'Could not save the cameras.')
  }
  const result: RecorderDiscovery = { recorderId: rec.id, locationId: rec.location_id, cameras: channels.length, created: fresh.length, updated, mapped, reconciliation }
  await auditAccess(admin, {
    orgId: actor.orgId, actorId: actor.id, action: 'cameras_discovered', capability: 'admin.inventory', locationIds: [rec.location_id],
    detail: { recorder_id: rec.id, created: result.created, updated, mapped, to_reconcile: reconciliation.length },
  })
  return { ok: true, ...result }
}

/** The caller's checks: an administrative role, then admin.inventory for the location (as the person). Not found and not allowed look alike to outsiders. */
async function mayDiscoverAt(clients: Clients, actor: Actor, locationId: string, notFound: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await locationFor(clients.rls, 'admin.inventory', locationId)
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.allowed) return { ok: true }
  const exists = await clients.admin.from('locations').select('id').eq('id', locationId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  return { ok: false, error: exists.data ? DENIED : notFound }
}

/** Discovery of ONE recorder (NVR). */
export async function discoverRecorderCameras(clients: Clients, actor: Actor, recorderId: string, deps: Deps = defaults): Promise<Result<RecorderDiscovery>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  if (typeof recorderId !== 'string' || !UUID.test(recorderId)) return { ok: false, error: MSG_NVR_NOT_FOUND }
  let rec: Recorder | undefined
  try {
    rec = (await loadRecorders(clients.admin, actor.orgId, [recorderId.toLowerCase()])).get(recorderId.toLowerCase())
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'discoverRecorderCameras', fallback: 'Could not read the NVR.' }) }
  }
  if (!rec) return { ok: false, error: MSG_NVR_NOT_FOUND }
  const may = await mayDiscoverAt(clients, actor, rec.location_id, MSG_NVR_NOT_FOUND)
  if (!may.ok) return may
  return discoverOne(clients, actor, rec, deps)
}

export type LocationDiscovery = {
  cameras: number; created: number; updated: number; mapped: number
  recorders: ({ recorderId: string; name: string } & ({ ok: true; result: RecorderDiscovery } | { ok: false; error: string }))[]
}

/**
 * Discovery of every NVR of one location, one after the other (the "Find cameras" button of the store list). A switched-off NVR is
 * listed with its plain message and never contacted. Succeeds when at least one NVR answered.
 */
export async function discoverStoreCameras(clients: Clients, actor: Actor, storeId: string, deps: Deps = defaults): Promise<Result<LocationDiscovery>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  if (typeof storeId !== 'string' || !UUID.test(storeId)) return { ok: false, error: 'Store not found.' }
  const may = await mayDiscoverAt(clients, actor, storeId, 'Store not found.')
  if (!may.ok) return may
  let recorders: Recorder[]
  try {
    recorders = await recordersOfLocation(clients.admin, actor.orgId, storeId)
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'discoverStoreCameras', fallback: 'Could not read the store.' }) }
  }
  if (recorders.length === 0) return { ok: false, error: MSG_NO_NVR }
  const out: LocationDiscovery = { cameras: 0, created: 0, updated: 0, mapped: 0, recorders: [] }
  for (const rec of recorders) {
    const r = await discoverOne(clients, actor, rec, deps)
    if (r.ok) {
      const { ok: _ok, ...result } = r
      void _ok
      out.recorders.push({ recorderId: rec.id, name: rec.name, ok: true, result })
      out.cameras += result.cameras
      out.created += result.created
      out.updated += result.updated
      out.mapped += result.mapped
    } else out.recorders.push({ recorderId: rec.id, name: rec.name, ok: false, error: r.error })
  }
  if (!out.recorders.some((r) => r.ok)) return { ok: false, error: (out.recorders[0] as { error: string }).error }
  return { ok: true, ...out }
}

export type BulkDiscoveryItem = { recorderId: string; locationId: string; code: string; name: string } & (
  | { ok: true; result: RecorderDiscovery }
  | { ok: false; error: string; skipped?: 'monitoring_off' }
)

/**
 * "Discover all recorders" (for the P2-5c screen): every NVR of the organisation, at most `concurrency` at a time (default 4, at most
 * 8), with progress after each one. Switched-off NVRs are skipped without any contact. Each NVR's result or plain error is listed;
 * one NVR's failure never stops the others. Needs an administrative role and admin.inventory for the organisation.
 */
export async function discoverAllRecorders(
  clients: Clients,
  actor: Actor,
  o: { concurrency?: number; onProgress?: (done: number, total: number) => void; deps?: Deps } = {},
): Promise<Result<{ items: BulkDiscoveryItem[] }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const caps = await readCapabilities(clients.rls)
  if (caps.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  if (!holdsOrgWide(caps, 'admin.inventory')) return { ok: false, error: DENIED }
  const { data, error } = await clients.admin.from('recorders').select('id, assets!recorders_asset_fk!inner(archived_at), locations!recorders_location_fk!inner(archived_at)')
    .eq('org_id', actor.orgId).is('assets.archived_at', null).is('locations.archived_at', null).order('location_id').order('created_at').order('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'discoverAllRecorders', fallback: 'Could not read the NVRs.' }) }
  let recorders: Map<string, Recorder>
  try {
    recorders = await loadRecorders(clients.admin, actor.orgId, (data ?? []).map((r) => r.id))
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'discoverAllRecorders', fallback: 'Could not read the NVRs.' }) }
  }
  const list = (data ?? []).map((r) => recorders.get(r.id)).filter((r): r is Recorder => r !== undefined)
  const deps = o.deps ?? defaults
  const limit = Math.min(8, Math.max(1, Math.floor(o.concurrency ?? 4)))
  let done = 0
  const items = await mapLimit(list, limit, async (rec): Promise<BulkDiscoveryItem> => {
    const base = { recorderId: rec.id, locationId: rec.location_id, code: rec.code, name: rec.name }
    let item: BulkDiscoveryItem
    if (!rec.monitored) item = { ...base, ok: false, error: MSG_MONITORING_OFF, skipped: 'monitoring_off' }
    else {
      try {
        const r = await discoverOne(clients, actor, rec, deps)
        item = r.ok ? { ...base, ok: true, result: { recorderId: r.recorderId, locationId: r.locationId, cameras: r.cameras, created: r.created, updated: r.updated, mapped: r.mapped, reconciliation: r.reconciliation } } : { ...base, ok: false, error: r.error }
      } catch (e) {
        item = { ...base, ok: false, error: sanitizeError(e, { route: 'discoverAllRecorders', fallback: 'Could not look for cameras on this NVR.' }) }
      }
    }
    try {
      o.onProgress?.(++done, list.length)
    } catch {
      // A broken progress callback never stops the run.
    }
    return item
  })
  // Many new cameras and mappings at once: fresh planner statistics (see inventory_refresh_statistics). A failure is only logged.
  if (items.some((i) => i.ok && i.result.created + i.result.mapped > 0)) {
    const { error: statsError } = await clients.admin.rpc('inventory_refresh_statistics')
    if (statsError) sanitizeError(statsError, { route: 'discoverAllRecorders.statistics' })
  }
  return { ok: true, items }
}
