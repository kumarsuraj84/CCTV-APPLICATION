import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { parseChannel, type MergePreview } from '@/lib/inventory/forms'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { dropLiveStreams } from '@/lib/streams/go2rtc'
import { fetchAll } from '@/lib/supabase/fetch-all'

// The mapping editor (P2-5c-1 brief item 3): which NVR channel shows a camera. A camera's identity never depends on its channel:
// moving it to another NVR or channel of its location keeps its id, grants, group memberships and monitoring history (camera_remap
// closes the active mapping and opens a new one; the history is append-only). Its live streams still point at the old channel and are
// removed from go2rtc (review M-4; the next viewer opens them again). Merge (re-review correction (a)): a camera physically moved to
// another NVR got a second identity there (ruling I-2); the merge keeps the OLD camera and archives the duplicate.

export const MSG_CAMERA_NOT_FOUND = 'Camera not found.'
export const MSG_OTHER_LOCATION_NVR = 'Choose an NVR of the camera’s own location.'
export const MSG_CHANNEL = 'Enter a channel number from 1 to 999.'
export const msgChannelTaken = (ch: number) => `Channel ${ch} of this NVR already has a camera. Move that camera first, or merge the two cameras.`

/** Moves (or links, for an unmapped camera) one camera to an NVR channel of its own location. */
export async function remapCamera(clients: InventoryClients, actor: Actor, input: { cameraId: string; recorderId: string; channel: number | string }): Promise<Result<{ mappingId: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const cameraId = cleanId(input?.cameraId)
  const recorderId = cleanId(input?.recorderId)
  if (!cameraId) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const channel = parseChannel(input?.channel)
  if (channel === null) return { ok: false, error: MSG_CHANNEL }
  if (!recorderId) return { ok: false, error: MSG_OTHER_LOCATION_NVR }
  const { data: cam, error: camErr } = await clients.admin.from('cameras').select('id').eq('id', cameraId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (camErr) return { ok: false, error: sanitizeError(camErr, { route: 'remapCamera', fallback: 'Could not read the camera.' }) }
  if (!cam) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const { data, error } = await clients.admin.rpc('camera_remap', { p_org: actor.orgId, p_camera: cameraId, p_recorder: recorderId, p_channel: channel, p_actor: actor.id })
  if (error) {
    if (error.code === 'DR006') return { ok: false, error: MSG_OTHER_LOCATION_NVR }
    if (error.code === '23505' || error.code === '23P01') return { ok: false, error: msgChannelTaken(channel) }
    if (error.code === 'P0002') return { ok: false, error: MSG_CAMERA_NOT_FOUND }
    return { ok: false, error: sanitizeError(error, { route: 'remapCamera', fallback: 'Could not move the camera.' }) }
  }
  if (clients.go2rtc) await dropLiveStreams(clients.go2rtc, [cameraId])
  return { ok: true, mappingId: data as string }
}

export type MappingRow = { recorderId: string; recorderName: string; channel: number; validFrom: string; validTo: string | null }

/** One camera's mapping history, newest first (service role, after the administrator check; scoped to the organisation). */
export async function mappingHistory(admin: AdminClient, orgId: string, cameraId: string): Promise<MappingRow[]> {
  const id = cleanId(cameraId)
  if (!id) return []
  const rows = await fetchAll((from, to) =>
    admin.from('camera_channel_mappings').select('id, recorder_id, channel, valid_from, valid_to').eq('org_id', orgId).eq('camera_id', id)
      .order('valid_from', { ascending: false }).order('id').range(from, to))
  const names = await recorderNames(admin, orgId, rows.map((r) => r.recorder_id))
  return rows.map((r) => ({ recorderId: r.recorder_id, recorderName: names.get(r.recorder_id) ?? 'NVR', channel: r.channel, validFrom: r.valid_from, validTo: r.valid_to }))
}

/** The names of these recorders (their assets), archived ones included (history names them). */
export async function recorderNames(admin: AdminClient, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  const out = new Map<string, string>()
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await admin.from('assets').select('id, name').eq('org_id', orgId).in('id', unique.slice(i, i + 200))
    if (error) throw new Error('Could not read the NVR names.')
    for (const a of data ?? []) out.set(a.id, a.name)
  }
  return out
}

export type MergeResult = { recorderId: string | null; channel: number | null; groupsCopied: number; duplicateCameraGrants: number }

/**
 * Merges `duplicateId` into `keepId`: the kept camera takes over the duplicate's NVR channel (and location), gains its group
 * memberships and keeps its own id, grants and history; the duplicate is archived. Live streams of both are removed.
 */
export async function mergeCameras(clients: InventoryClients, actor: Actor, input: { keepId: string; duplicateId: string }): Promise<Result<MergeResult>> {
  const keep = cleanId(input?.keepId)
  const dup = cleanId(input?.duplicateId)
  if (keep && dup && keep === dup) return { ok: false, error: 'Choose two different cameras.' }
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (!keep || !dup) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const { data, error } = await clients.admin.rpc('camera_merge', { p_org: actor.orgId, p_keep: keep, p_duplicate: dup, p_actor: actor.id })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: MSG_CAMERA_NOT_FOUND }
    if (error.code === 'DR011') return { ok: false, error: 'Restore the camera to keep first.' }
    if (error.code === 'DR012') return { ok: false, error: 'A camera of another location can only be merged into this one when it shows an NVR channel. Link it to its channel first.' }
    if (error.code === '22023') return { ok: false, error: 'Choose two different cameras.' }
    if (error.code === '23505' || error.code === '23P01') return { ok: false, error: 'The NVR channel is in use by another camera. Reload the page and try again.' }
    return { ok: false, error: sanitizeError(error, { route: 'mergeCameras', fallback: 'Could not merge the cameras.' }) }
  }
  const r = data as { recorder_id: string | null; channel: number | null; groups_copied: number; duplicate_camera_grants: number }
  if (clients.go2rtc) await dropLiveStreams(clients.go2rtc, [keep, dup])
  return { ok: true, recorderId: r.recorder_id, channel: r.channel, groupsCopied: Number(r.groups_copied), duplicateCameraGrants: Number(r.duplicate_camera_grants) }
}
/** The history of several cameras in one read (review M-6), each newest first; the same rows as mappingHistory. */
export async function mappingHistories(admin: AdminClient, orgId: string, cameraIds: string[]): Promise<Map<string, MappingRow[]>> {
  const ids = [...new Set(cameraIds.map((x) => cleanId(x)).filter((x): x is string => !!x))]
  const out = new Map<string, MappingRow[]>(ids.map((id) => [id, []]))
  const rows: { id: string; camera_id: string; recorder_id: string; channel: number; valid_from: string; valid_to: string | null }[] = []
  for (let i = 0; i < ids.length; i += 200) {
    rows.push(...(await fetchAll((from, to) =>
      admin.from('camera_channel_mappings').select('id, camera_id, recorder_id, channel, valid_from, valid_to').eq('org_id', orgId).in('camera_id', ids.slice(i, i + 200))
        .order('valid_from', { ascending: false }).order('id').range(from, to))))
  }
  const names = await recorderNames(admin, orgId, rows.map((r) => r.recorder_id))
  for (const r of rows) out.get(r.camera_id)?.push({ recorderId: r.recorder_id, recorderName: names.get(r.recorder_id) ?? 'NVR', channel: r.channel, validFrom: r.valid_from, validTo: r.valid_to })
  return out
}

/** Where a camera is, in words: "JCL · First floor, channel 2", or "JCL · not linked". */
async function placeOf(admin: AdminClient, orgId: string, cam: { location_id: string; recorder_id: string | null; channel: number }): Promise<string> {
  const { data: loc } = await admin.from('locations').select('code').eq('id', cam.location_id).eq('org_id', orgId).maybeSingle()
  if (!cam.recorder_id) return `${loc?.code ?? ''} · not linked`
  const names = await recorderNames(admin, orgId, [cam.recorder_id])
  return `${loc?.code ?? ''} · ${names.get(cam.recorder_id) ?? 'NVR'}, channel ${cam.channel}`
}

/**
 * What a merge would do, before it is done (review I-5): the exact pair (fix round 2, A-N1), both names, the duplicate's place and
 * whether it shows an NVR channel, and how many people lose this camera's video (A-N2). Writes nothing.
 */
export async function previewMerge(clients: InventoryClients, actor: Actor, input: { keepId: string; duplicateId: string }): Promise<Result<MergePreview>> {
  const keep = cleanId(input?.keepId)
  const dup = cleanId(input?.duplicateId)
  if (keep && dup && keep === dup) return { ok: false, error: 'Choose two different cameras.' }
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (!keep || !dup) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  const { data: cams, error } = await clients.admin.from('cameras').select('id, name, location_id, recorder_id, channel, archived_at').eq('org_id', actor.orgId).in('id', [keep, dup])
  if (error) return { ok: false, error: sanitizeError(error, { route: 'previewMerge', fallback: 'Could not read the cameras.' }) }
  const k = (cams ?? []).find((x) => x.id === keep)
  const d = (cams ?? []).find((x) => x.id === dup)
  if (!k || !d || d.archived_at) return { ok: false, error: MSG_CAMERA_NOT_FOUND }
  if (k.archived_at) return { ok: false, error: 'Restore the camera to keep first.' }
  const losing = await peopleLosingVideo(clients.admin, actor.orgId, k, d)
  if (!losing.ok) return losing
  return {
    ok: true, keepId: keep, duplicateId: dup, keepName: k.name, duplicateName: d.name, duplicatePlace: await placeOf(clients.admin, actor.orgId, d),
    duplicateLinked: !!d.recorder_id, peopleLosing: losing.count,
  }
}

/**
 * Fix round 2 (A-N2): the people who see the duplicate through a grant on it and would NOT see the kept camera after the merge, for at
 * least one CCTV right. After the merge the kept camera is at the duplicate's location, on the duplicate's NVR (or, for an unlinked
 * duplicate at the same location, on its own); a live grant of the same right on the organisation, that location, its cluster or
 * region, that NVR, or the kept camera itself keeps the video. Ended, future and revoked grants count for nothing.
 */
async function peopleLosingVideo(
  admin: AdminClient, orgId: string, k: { id: string; recorder_id: string | null }, d: { id: string; location_id: string; recorder_id: string | null },
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const now = new Date().toISOString()
  const liveNow = `valid_until.is.null,valid_until.gt.${now}`
  const fail = (e: unknown) => ({ ok: false as const, error: sanitizeError(e, { route: 'previewMerge', fallback: 'Could not count the people.' }) })
  const { data: held, error } = await admin.from('access_grants').select('user_id, capability').eq('org_id', orgId).eq('scope_kind', 'camera').eq('scope_id', d.id)
    .is('revoked_at', null).lte('valid_from', now).or(liveNow)
  if (error) return fail(error)
  if (!held?.length) return { ok: true, count: 0 }
  const { data: loc } = await admin.from('locations').select('cluster_id').eq('id', d.location_id).eq('org_id', orgId).maybeSingle()
  const { data: cluster } = loc?.cluster_id
    ? await admin.from('clusters').select('id, region_id').eq('id', loc.cluster_id).eq('org_id', orgId).is('archived_at', null).maybeSingle()
    : { data: null }
  const { data: region } = cluster?.region_id
    ? await admin.from('regions').select('id').eq('id', cluster.region_id).eq('org_id', orgId).is('archived_at', null).maybeSingle()
    : { data: null }
  const clusterId = cluster?.id ?? null
  const regionId = region?.id ?? null
  const recorderAfter = d.recorder_id ?? k.recorder_id
  const users = [...new Set(held.map((g) => g.user_id))]
  const wider: { user_id: string; capability: string; scope_kind: string; scope_id: string | null }[] = []
  for (let i = 0; i < users.length; i += 150) {
    const { data, error: wErr } = await admin.from('access_grants').select('user_id, capability, scope_kind, scope_id').eq('org_id', orgId).in('user_id', users.slice(i, i + 150))
      .in('scope_kind', ['organization', 'region', 'cluster', 'location', 'recorder', 'camera']).is('revoked_at', null).lte('valid_from', now).or(liveNow)
    if (wErr) return fail(wErr)
    wider.push(...(data ?? []))
  }
  const keeps = (g: { scope_kind: string; scope_id: string | null }) =>
    g.scope_kind === 'organization'
    || (g.scope_kind === 'location' && g.scope_id === d.location_id)
    || (g.scope_kind === 'cluster' && !!clusterId && g.scope_id === clusterId)
    || (g.scope_kind === 'region' && !!regionId && g.scope_id === regionId)
    || (g.scope_kind === 'recorder' && !!recorderAfter && g.scope_id === recorderAfter)
    || (g.scope_kind === 'camera' && g.scope_id === k.id)
  const covered = new Set(wider.filter(keeps).map((g) => `${g.user_id}|${g.capability}`))
  return { ok: true, count: new Set(held.filter((g) => !covered.has(`${g.user_id}|${g.capability}`)).map((g) => g.user_id)).size }
}

/** Cameras of the whole organisation whose name contains the words (review M-2: merge across locations). At most 20. */
export async function searchCameras(clients: InventoryClients, actor: Actor, query: string): Promise<Result<{ cameras: { id: string; label: string }[] }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const q = typeof query === 'string' ? query.trim() : ''
  if (q.length < 2) return { ok: false, error: 'Type at least two letters.' }
  if (q.length > 100) return { ok: false, error: 'Use 100 characters or fewer.' }
  // LIKE's own wildcards are escaped. PostgREST also reads "*" as a wildcard and offers no escape for it, so a "*" is sent as "_" (any
  // one character) and the rows are then kept only when the name really contains the words (fix round 2 note).
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_')}%`
  const { data, error } = await clients.admin.from('cameras').select('id, name, channel, recorder_id, location_id, locations!cameras_location_fk!inner(code)')
    .eq('org_id', actor.orgId).is('archived_at', null).ilike('name', pattern).order('name').order('id').limit(q.includes('*') ? 200 : 20)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'searchCameras', fallback: 'Could not look for cameras.' }) }
  const words = q.toLowerCase()
  const rows = ((data ?? []) as unknown as { id: string; name: string; channel: number; recorder_id: string | null; locations: { code: string } }[])
    .filter((r) => !q.includes('*') || r.name.toLowerCase().includes(words)).slice(0, 20)
  const names = await recorderNames(clients.admin, actor.orgId, rows.map((r) => r.recorder_id).filter((x): x is string => !!x))
  return {
    ok: true,
    cameras: rows.map((r) => ({ id: r.id, label: `${r.name} (${r.locations.code} · ${r.recorder_id ? `${names.get(r.recorder_id) ?? 'NVR'}, channel ${r.channel}` : 'not linked'})` })),
  }
}
