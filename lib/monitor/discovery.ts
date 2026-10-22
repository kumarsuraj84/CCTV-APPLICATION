import { isAdminRole } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { mapLimit } from '@/lib/async/pool'
import { holdsOrgWide, readCapabilities } from '@/lib/auth/capabilities'
import { locationFor, MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'
import { reattachableByChannel } from '@/lib/inventory/cameras'
import { loadRecorders, MSG_MONITORING_OFF, readRecorderPassword, recordersOfLocation, type Recorder } from '@/lib/inventory/recorders'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { describeNvrError } from '@/lib/nvr/client'
import { loginBlock, loginFingerprint, noteLoginResult } from '@/lib/monitor/login-backoff'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { dropLiveStreams, type Go2rtcClient } from '@/lib/streams/go2rtc'
import { fetchAll } from '@/lib/supabase/fetch-all'
import type { Json } from '@/types/database'

// Camera discovery, per recorder (P2-5b; review round 1). Reads the channel list from ONE NVR and saves names and addresses. Cameras keep
// their ids:
//   1. a channel already mapped to this NVR is that camera (match by recorder + channel, the ACTIVE mapping);
//   2. else an unmapped camera of the location that was on this NVR's channel before (or any unmapped one when the location has only
//      this NVR) is put back on it;
//   3. else a camera of THIS NVR whose channel the NVR no longer lists, with the same reported address, moved to this channel (re-patched
//      on the same box): it is moved (camera_remap; id, grants, groups and history kept) — review I-1. A camera that has no active
//      mapping but whose LAST mapping was on this NVR (restored after an archive) counts as a camera of this NVR too (P2-5b re-review
//      N-1): with the same address it is put on the listed channel;
//   4. else, when a camera that could only be this one looks like it — a camera of this NVR (by its active or, when restored, its last
//      mapping) whose channel is gone, with the same chosen name; or a camera of the location that was NEVER mapped, with the same
//      address, chosen name or channel — NOTHING is created: the channel is listed for reconciliation, so a camera never gets a second
//      identity;
//   5. else a new camera is created, mapped to this NVR's channel.
// A restored camera of this NVR that nothing placed is listed as `unplaced` (re-review N-2), never left aside silently. What a
// discovery lists (except renames) is kept in discovery_findings for the reconciliation screen until a person settles it or the next
// discovery of the same NVR replaces it (P2-5c-1).
// A camera mapped to ANOTHER NVR is never taken or matched, whatever its name or address (review I-2: its own NVR lists it). Addresses
// in the ranges PoE NVRs give their cameras (192.168.254.x, 10.1.1.x, 169.254.x.x) repeat on every such NVR and are never used to match;
// names an NVR makes up ("Camera 01", "IPCamera 02", "D3", "Channel 4") are never used to match either.
// Everything one discovery saves goes to the database in ONE transaction with its audit row (discovery_apply; review M-8).
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
/** The location's primary NVR (the one the Manage stores page edits) has no password. */
export const MSG_NO_NVR_PASSWORD = 'This NVR has no password saved. Add it on the Manage stores page first.'
/** Any other NVR of the location (its page arrives with P2-5c): no advice that leads nowhere (review M-8). */
export const MSG_NO_NVR_PASSWORD_OTHER = 'This NVR has no password saved yet.'
export const MSG_NO_NVR = 'This store has no NVR.'
/** P2-5b re-review N-3: an NVR of a switched-off location is never contacted. */
export const MSG_LOCATION_OFF = 'This location is switched off. Switch it on before looking for cameras.'
/** An archived NVR is never contacted (it is not "not found": the administrator can restore it). */
export const MSG_NVR_ARCHIVED = 'This NVR is archived. Restore it before looking for cameras.'

/** Something an administrator should look at; nothing was changed for it. */
export type Reconciliation =
  /** The NVR lists this channel and no camera is mapped to it, but camera `cameraId` may be the one (a camera of this NVR whose channel is gone, or a camera of the location never mapped). Not created. */
  | { kind: 'possible_move'; channel: number; reportedName: string; cameraId: string; cameraName: string; because: 'same_address' | 'same_name' | 'unmapped_same_channel' }
  /** A camera mapped to this NVR whose channel the NVR no longer lists. Kept as it is (never deleted or archived). */
  | { kind: 'missing'; channel: number; cameraId: string; cameraName: string }
  /** The NVR gives a matched camera a different name; the NVR's name was saved. */
  | { kind: 'renamed'; channel: number; cameraId: string; from: string; to: string }
  /** An unmapped (restored) camera that was on this channel: another camera (`takenBy`) is on it now, so it was left unmapped. */
  | { kind: 'channel_taken'; channel: number; cameraId: string; cameraName: string; takenBy: string }
  /** A restored camera last on this NVR (`channel`: its last channel) that nothing the NVR lists could be matched to; left unlinked. */
  | { kind: 'unplaced'; channel: number; cameraId: string; cameraName: string }

export type RecorderDiscovery = {
  recorderId: string; locationId: string
  /** Channels the NVR listed. */
  cameras: number
  created: number
  /** Cameras already on this NVR whose name or address was refreshed. */
  updated: number
  /** Unmapped cameras put back on this NVR. */
  mapped: number
  /** Cameras of this NVR moved to the channel the NVR now lists them on (same address; review I-1). */
  moved: number
  reconciliation: Reconciliation[]
}

type Clients = { admin: AdminClient; rls: AdminClient }
/** `go2rtc`: when given, the live streams of a camera that discovery moved to another channel are removed (review M-4). */
type Deps = { nvr: Probes['nvr']; go2rtc?: Go2rtcClient }
const defaults: Deps = { nvr: realProbes.nvr }

const placeholderOf = (channel: number) => `Camera ${channel}`
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
/** A name an NVR makes up for a channel; never evidence that two cameras are the same (review I-2). */
const DEFAULT_NAME = /^(ip\s*)?cam(era)?\s*0*\d+$|^d\s*0*\d+$|^ch(annel)?\s*0*\d+$/i
export const isDefaultCameraName = (name: string) => DEFAULT_NAME.test(name.trim())
/** Addresses PoE NVRs give the cameras on their own ports: the same on every such NVR, so never evidence of identity (review I-2). */
export function isRepeatingCameraAddress(ip: string): boolean {
  return /^192\.168\.254\.\d{1,3}$/.test(ip) || /^10\.1\.1\.\d{1,3}$/.test(ip) || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)
}
const usableAddress = (ip: string | null | undefined): ip is string => typeof ip === 'string' && ip !== '' && !isRepeatingCameraAddress(ip)

/**
 * Discovery of one recorder after every check has passed (the caller has proven admin.inventory for its location). `rec` was read with
 * the service role. Never throws for NVR trouble: a plain error.
 */
async function discoverOne(clients: Clients, actor: Actor, rec: Recorder, deps: Deps): Promise<Result<RecorderDiscovery>> {
  const admin = clients.admin
  // Owner addition: a switched-off NVR is never contacted (checked before its password is read); nor an NVR of a location that is
  // switched off (re-review N-3: recorder_save switches an NVR's asset on even while its location is off).
  if (!rec.monitored) return { ok: false, error: MSG_MONITORING_OFF }
  if (!rec.location_active) return { ok: false, error: MSG_LOCATION_OFF }
  if (!rec.host) return { ok: false, error: 'This NVR has no address saved.' }
  // The password is read here, used for this one call and not kept anywhere.
  const read = await readRecorderPassword(admin, rec.id)
  if (!read.ok) return { ok: false, error: sanitizeError({ code: read.code }, { route: 'discoverRecorderCameras', fallback: 'Could not read the NVR password.' }) }
  if (!read.password) {
    const { data: primary } = await admin.rpc('recorder_primary_of', { p_location: rec.location_id })
    return { ok: false, error: primary === rec.id ? MSG_NO_NVR_PASSWORD : MSG_NO_NVR_PASSWORD_OTHER }
  }

  // Review I-3 (P2-5c-1): the web server's one login back-off, shared with the connection test and "find cameras for all": after a
  // refused login this NVR is not asked again with the same login until the window is over (R9), and after several refused logins not
  // with any login for a while (fix round 2, A-N3).
  const login = loginFingerprint(rec.host, rec.http_port, rec.username, read.password)
  const blocked = loginBlock(rec.id, login)
  if (blocked) return { ok: false, error: blocked }
  let channels
  try {
    channels = await deps.nvr({ host: rec.host, port: rec.http_port, username: rec.username, password: read.password }).channels()
  } catch (e) {
    noteLoginResult(rec.id, login, e)
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
  let last: Map<string, { recorder_id: string; channel: number }>
  try {
    back = await reattachableByChannel(admin, actor.orgId, rec.location_id, rec.id)
    last = await lastMappings(admin, actor.orgId, (existing ?? []).filter((c) => c.recorder_id === null).map((c) => c.id))
  } catch (e) {
    return fail(e, 'Could not read the cameras.')
  }
  const byId = new Map((existing ?? []).map((c) => [c.id, c]))
  const onThis = new Map((active ?? []).filter((m) => byId.has(m.camera_id)).map((m) => [m.channel, byId.get(m.camera_id)!]))
  const listed = new Set(channels.map((c) => c.channel))
  // Cameras of THIS NVR whose channel the NVR no longer lists: they may have been re-patched to another channel of the same box (I-1).
  const vacated = [...onThis].filter(([ch]) => !listed.has(ch)).map(([, cam]) => cam)
  // N-1: unmapped (restored) cameras whose LAST mapping was on this NVR are this NVR's cameras too; rule 2 puts them back on their old
  // channel when it is listed and free; otherwise they are matched like a vacated camera (rules 3 and 4), never given a second identity.
  const restoredHere = (existing ?? []).filter((c) => c.recorder_id === null && last.get(c.id)?.recorder_id === rec.id)
  const restoredIds = new Set(restoredHere.map((c) => c.id))
  // Cameras of the location that were never mapped to any NVR (made by hand): the only other cameras that may be this channel's.
  // A camera mapped to another NVR, or last mapped to one, belongs to that NVR and is never matched here (review I-2).
  const neverMapped = (existing ?? []).filter((c) => c.recorder_id === null && !last.has(c.id))
  // Taken: the cameras on a channel the NVR still lists (rule 1). The vacated ones are still free to be matched (rules 3 and 4).
  const used = new Set<string>([...onThis].filter(([ch]) => listed.has(ch)).map(([, c]) => c.id))
  const reconciliation: Reconciliation[] = []
  const ops: DiscoveryOp[] = []

  for (const c of channels) {
    const placeholder = placeholderOf(c.channel)
    const reported = (c.name.trim() || placeholder).slice(0, MAX_NAME)
    // A name the NVR only made up does not overwrite a name somebody chose.
    const madeUp = isDefaultCameraName(reported)
    const nameFor = (old?: string) => (madeUp && old ? old : reported)
    const mine = onThis.get(c.channel)
    if (mine) {
      const name = nameFor(mine.name)
      if (!sameName(name, mine.name) && !isDefaultCameraName(mine.name)) reconciliation.push({ kind: 'renamed', channel: c.channel, cameraId: mine.id, from: mine.name, to: name })
      // An address the NVR does not report now is not forgotten.
      ops.push({ op: 'update', id: mine.id, name, ip: c.ip ?? mine.camera_ip ?? null })
      continue
    }
    const loose = back.get(c.channel)
    if (loose && !used.has(loose)) {
      const cam = byId.get(loose)!
      used.add(loose)
      ops.push({ op: 'map', id: loose, channel: c.channel, name: nameFor(cam.name), ip: c.ip ?? cam.camera_ip ?? null })
      continue
    }
    // Rule 3 (I-1, N-1): the same box, the same address, another channel: the camera moved; it keeps its identity. A camera still
    // mapped here is moved (remap); a restored one (unmapped, last on this NVR) is put on the channel (map).
    const free = [...vacated, ...restoredHere].filter((x) => !used.has(x.id))
    const sameBoxAddress = usableAddress(c.ip) ? free.filter((x) => x.camera_ip === c.ip) : []
    if (sameBoxAddress.length === 1) {
      const cam = sameBoxAddress[0]
      used.add(cam.id)
      ops.push({ op: restoredIds.has(cam.id) ? 'map' : 'remap', id: cam.id, channel: c.channel, name: nameFor(cam.name), ip: c.ip ?? cam.camera_ip ?? null })
      continue
    }
    // Rule 4: never a second identity for a camera that may only have moved; listed for an administrator, nothing created.
    const chosen = !madeUp
    const vacatedNamed = chosen ? free.find((x) => sameName(x.name, reported)) : undefined
    const loneOnes = neverMapped.filter((x) => !used.has(x.id))
    const sameAddress = usableAddress(c.ip) ? loneOnes.find((x) => x.camera_ip === c.ip) : undefined
    const sameNamed = chosen ? loneOnes.find((x) => !isDefaultCameraName(x.name) && sameName(x.name, reported)) : undefined
    const sameChannel = loneOnes.find((x) => x.channel === c.channel)
    const candidate = vacatedNamed ?? sameAddress ?? sameNamed ?? sameChannel
    if (candidate) {
      used.add(candidate.id)
      reconciliation.push({
        kind: 'possible_move', channel: c.channel, reportedName: reported, cameraId: candidate.id, cameraName: candidate.name,
        because: candidate === vacatedNamed || candidate === sameNamed ? 'same_name' : candidate === sameAddress ? 'same_address' : 'unmapped_same_channel',
      })
      continue
    }
    ops.push({ op: 'insert', channel: c.channel, name: reported, ip: c.ip ?? null })
  }
  const moved = new Set(ops.filter((o) => o.op === 'remap').map((o) => (o as { id: string }).id))
  for (const [channel, cam] of onThis) if (!listed.has(channel) && !moved.has(cam.id)) reconciliation.push({ kind: 'missing', channel, cameraId: cam.id, cameraName: cam.name })
  // M-8: a restored camera whose channel another camera of this NVR now has is listed (it stays unmapped).
  const reported = new Set<string>()
  for (const [channel, id] of back) {
    const holder = onThis.get(channel)
    if (!used.has(id) && holder && listed.has(channel)) {
      reconciliation.push({ kind: 'channel_taken', channel, cameraId: id, cameraName: byId.get(id)?.name ?? '', takenBy: holder.id })
      reported.add(id)
    }
  }
  // N-2: a restored camera of this NVR that nothing placed is listed too.
  for (const cam of restoredHere) {
    if (!used.has(cam.id) && !reported.has(cam.id)) reconciliation.push({ kind: 'unplaced', channel: last.get(cam.id)!.channel, cameraId: cam.id, cameraName: cam.name })
  }

  // One transaction for every change, the findings for the reconciliation list and the audit row (M-8): all of it or none of it.
  const { data: saved, error: saveError } = await admin.rpc('discovery_apply', {
    p_org: actor.orgId, p_recorder: rec.id, p_ops: ops as unknown as Json, p_to_reconcile: reconciliation.length, p_actor: actor.id,
    p_findings: findingsOf(reconciliation) as unknown as Json,
  })
  if (saveError || !saved) return fail(saveError, 'Could not save the cameras.')
  const counts = saved as { created: number; updated: number; mapped: number; moved: number }
  // M-4: a moved camera's live streams still point at its old channel; they are removed (the next viewer opens them again). Never fatal.
  if (deps.go2rtc && moved.size > 0) await dropLiveStreams(deps.go2rtc, [...moved])
  return {
    ok: true, recorderId: rec.id, locationId: rec.location_id, cameras: channels.length,
    created: counts.created, updated: counts.updated, mapped: counts.mapped, moved: counts.moved, reconciliation,
  }
}

type DiscoveryOp =
  | { op: 'insert'; channel: number; name: string; ip: string | null }
  | { op: 'update'; id: string; name: string; ip: string | null }
  | { op: 'map' | 'remap'; id: string; channel: number; name: string; ip: string | null }

/** For each of these (unmapped) cameras that ever had a channel mapping (to any NVR): its LAST one (the latest end). */
async function lastMappings(admin: AdminClient, orgId: string, ids: string[]): Promise<Map<string, { recorder_id: string; channel: number }>> {
  const out = new Map<string, { recorder_id: string; channel: number; valid_to: string }>()
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    const rows = await fetchAll((from, to) =>
      admin.from('camera_channel_mappings').select('id, camera_id, recorder_id, channel, valid_to').eq('org_id', orgId).in('camera_id', part).order('id').range(from, to))
    for (const m of rows) {
      const seen = out.get(m.camera_id)
      // An active mapping (no end) cannot exist for an unmapped camera; the latest end wins.
      const end = m.valid_to ?? '9999-12-31T00:00:00Z'
      if (!seen || Date.parse(end) > Date.parse(seen.valid_to)) out.set(m.camera_id, { recorder_id: m.recorder_id, channel: m.channel, valid_to: end })
    }
  }
  return new Map([...out].map(([k, v]) => [k, { recorder_id: v.recorder_id, channel: v.channel }]))
}

/** What the reconciliation screen keeps of a discovery: everything but renames (those are done and only reported). */
type FindingRow = { kind: string; channel: number; camera_id: string; other_camera_id?: string; reported_name?: string; because?: string }
function findingsOf(list: Reconciliation[]): FindingRow[] {
  return list.flatMap((r): FindingRow[] => {
    switch (r.kind) {
      case 'possible_move':
        return [{ kind: r.kind, channel: r.channel, camera_id: r.cameraId, reported_name: r.reportedName, because: r.because }]
      case 'missing':
      case 'unplaced':
        return [{ kind: r.kind, channel: r.channel, camera_id: r.cameraId }]
      case 'channel_taken':
        return [{ kind: r.kind, channel: r.channel, camera_id: r.cameraId, other_camera_id: r.takenBy }]
      default:
        return []
    }
  })
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
  if (!rec) {
    // N-3: an archived NVR of the organisation is named as such (after the same checks), never contacted.
    const { data: archived } = await clients.admin.from('recorders').select('id, location_id, assets!recorders_asset_fk!inner(archived_at)')
      .eq('org_id', actor.orgId).eq('id', recorderId.toLowerCase()).not('assets.archived_at', 'is', null).maybeSingle()
    if (!archived) return { ok: false, error: MSG_NVR_NOT_FOUND }
    const mayArchived = await mayDiscoverAt(clients, actor, archived.location_id, MSG_NVR_NOT_FOUND)
    return mayArchived.ok ? { ok: false, error: MSG_NVR_ARCHIVED } : mayArchived
  }
  const may = await mayDiscoverAt(clients, actor, rec.location_id, MSG_NVR_NOT_FOUND)
  if (!may.ok) return may
  return discoverOne(clients, actor, rec, deps)
}

export type LocationDiscovery = {
  cameras: number; created: number; updated: number; mapped: number; moved: number
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
  const out: LocationDiscovery = { cameras: 0, created: 0, updated: 0, mapped: 0, moved: 0, recorders: [] }
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
      out.moved += result.moved
    } else out.recorders.push({ recorderId: rec.id, name: rec.name, ok: false, error: r.error })
  }
  if (!out.recorders.some((r) => r.ok)) return { ok: false, error: (out.recorders[0] as { error: string }).error }
  return { ok: true, ...out }
}

export type BulkDiscoveryItem = { recorderId: string; locationId: string; code: string; name: string } & (
  | { ok: true; result: RecorderDiscovery }
  | { ok: false; error: string; skipped?: 'monitoring_off' | 'location_off' | 'stopped' }
)

/** P2-5c-2 review B-M10: the person stopped the run before this NVR was asked. */
export const MSG_STOPPED = 'Not asked: the search was stopped before this NVR.'

/**
 * "Discover all recorders" (for the P2-5c screen): every NVR of the organisation, at most `concurrency` at a time (default 4, at most
 * 8), with progress after each one. Switched-off NVRs are skipped without any contact. Each NVR's result or plain error is listed;
 * one NVR's failure never stops the others. Needs an administrative role and admin.inventory for the organisation.
 * P2-5c-2 review: `shouldStop` is asked before each NVR (the "Stop" button, B-M10); the NVR list is read page by page (B-M11: more
 * than 1,000 NVRs are never cut off).
 */
export async function discoverAllRecorders(
  clients: Clients,
  actor: Actor,
  o: { concurrency?: number; onProgress?: (done: number, total: number) => void; deps?: Deps; shouldStop?: () => boolean } = {},
): Promise<Result<{ items: BulkDiscoveryItem[] }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const caps = await readCapabilities(clients.rls)
  if (caps.failed) return { ok: false, error: MSG_ACCESS_CHECK_FAILED }
  if (!holdsOrgWide(caps, 'admin.inventory')) return { ok: false, error: DENIED }
  let data: { id: string }[]
  try {
    data = await fetchAll((f, t) => clients.admin.from('recorders').select('id, assets!recorders_asset_fk!inner(archived_at), locations!recorders_location_fk!inner(archived_at)')
      .eq('org_id', actor.orgId).is('assets.archived_at', null).is('locations.archived_at', null).order('location_id').order('created_at').order('id').range(f, t))
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'discoverAllRecorders', fallback: 'Could not read the NVRs.' }) }
  }
  let recorders: Map<string, Recorder>
  try {
    recorders = await loadRecorders(clients.admin, actor.orgId, data.map((r) => r.id))
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'discoverAllRecorders', fallback: 'Could not read the NVRs.' }) }
  }
  const list = data.map((r) => recorders.get(r.id)).filter((r): r is Recorder => r !== undefined)
  const deps = o.deps ?? defaults
  const limit = Math.min(8, Math.max(1, Math.floor(o.concurrency ?? 4)))
  let done = 0
  const items = await mapLimit(list, limit, async (rec): Promise<BulkDiscoveryItem> => {
    const base = { recorderId: rec.id, locationId: rec.location_id, code: rec.code, name: rec.name }
    let item: BulkDiscoveryItem
    let stop = false
    try {
      stop = o.shouldStop?.() === true
    } catch {
      // A broken stop check never stops the run by itself.
    }
    if (stop) item = { ...base, ok: false, error: MSG_STOPPED, skipped: 'stopped' }
    else if (!rec.monitored) item = { ...base, ok: false, error: MSG_MONITORING_OFF, skipped: 'monitoring_off' }
    else if (!rec.location_active) item = { ...base, ok: false, error: MSG_LOCATION_OFF, skipped: 'location_off' }
    else {
      try {
        const r = await discoverOne(clients, actor, rec, deps)
        item = r.ok
          ? { ...base, ok: true, result: { recorderId: r.recorderId, locationId: r.locationId, cameras: r.cameras, created: r.created, updated: r.updated, mapped: r.mapped, moved: r.moved, reconciliation: r.reconciliation } }
          : { ...base, ok: false, error: r.error }
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
  if (items.some((i) => i.ok && i.result.created + i.result.mapped + i.result.moved > 0)) {
    const { error: statsError } = await clients.admin.rpc('inventory_refresh_statistics')
    if (statsError) sanitizeError(statsError, { route: 'discoverAllRecorders.statistics' })
  }
  return { ok: true, items }
}
