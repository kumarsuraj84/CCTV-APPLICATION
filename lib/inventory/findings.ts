import { addAudit } from '@/lib/admin/audit'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { recorderNames, remapCamera } from '@/lib/inventory/mapping'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { fetchAll } from '@/lib/supabase/fetch-all'

// The reconciliation list (P2-5c-1 brief item 3): what camera discovery of an NVR could not place, kept until a person settles it —
// links a possible move (the existing camera takes the listed channel), merges a duplicate (lib/inventory/mapping.ts), archives a
// camera that is really gone, or dismisses the item with a note — or until the next discovery of that NVR replaces it.

export type FindingKind = 'possible_move' | 'missing' | 'channel_taken' | 'unplaced'
export type Finding = {
  id: string; kind: FindingKind; recorderId: string; recorderName: string; locationId: string; locationCode: string; channel: number | null
  cameraId: string; cameraName: string; otherCameraId: string | null; reportedName: string | null; because: string | null; foundAt: string
}

const MSG_NOT_FOUND = 'This item is no longer on the list. Reload the page.'

/** The open findings of the organisation (or of one NVR), newest first. Service role; the caller has checked the administrator. */
export async function listFindings(admin: AdminClient, orgId: string, o: { recorderId?: string; locationId?: string } = {}): Promise<Finding[]> {
  const rows = await fetchAll((from, to) => {
    let q = admin.from('discovery_findings').select('id, kind, recorder_id, location_id, channel, camera_id, other_camera_id, reported_name, because, found_at')
      .eq('org_id', orgId).is('resolved_at', null)
    if (o.recorderId) q = q.eq('recorder_id', o.recorderId)
    if (o.locationId) q = q.eq('location_id', o.locationId)
    return q.order('found_at', { ascending: false }).order('id').range(from, to)
  })
  if (rows.length === 0) return []
  const cameraIds = [...new Set(rows.flatMap((r) => [r.camera_id, r.other_camera_id].filter((x): x is string => !!x)))]
  const [names, cams, locs] = await Promise.all([
    recorderNames(admin, orgId, rows.map((r) => r.recorder_id)),
    inPieces(cameraIds, (part) => admin.from('cameras').select('id, name').eq('org_id', orgId).in('id', part)),
    inPieces([...new Set(rows.map((r) => r.location_id))], (part) => admin.from('locations').select('id, code').eq('org_id', orgId).in('id', part)),
  ])
  const camName = new Map(cams.map((c) => [c.id, c.name]))
  const locCode = new Map(locs.map((l) => [l.id, l.code]))
  return rows.map((r) => ({
    id: r.id, kind: r.kind as FindingKind, recorderId: r.recorder_id, recorderName: names.get(r.recorder_id) ?? 'NVR', locationId: r.location_id,
    locationCode: locCode.get(r.location_id) ?? '', channel: r.channel, cameraId: r.camera_id, cameraName: camName.get(r.camera_id) ?? 'Camera',
    otherCameraId: r.other_camera_id, reportedName: r.reported_name, because: r.because, foundAt: r.found_at,
  }))
}

async function inPieces<T>(ids: string[], read: (part: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await read(ids.slice(i, i + 200))
    if (error) throw new Error('Could not read the list.')
    out.push(...(data ?? []))
  }
  return out
}

async function openFinding(admin: AdminClient, orgId: string, id: string) {
  const { data, error } = await admin.from('discovery_findings').select('id, kind, recorder_id, channel, camera_id').eq('id', id).eq('org_id', orgId).is('resolved_at', null).maybeSingle()
  if (error) throw error
  return data
}

async function settle(admin: AdminClient, actor: Actor, id: string, resolution: 'linked' | 'dismissed', note: string | null): Promise<Result<object>> {
  const { data, error } = await admin.from('discovery_findings').update({ resolved_at: new Date().toISOString(), resolved_by: actor.id, resolution, note })
    .eq('id', id).eq('org_id', actor.orgId).is('resolved_at', null).select('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'findings.settle', fallback: 'Could not update the list.' }) }
  if (!data?.length) return { ok: false, error: MSG_NOT_FOUND }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'discovery_finding_settled', entityType: 'discovery_finding', entityId: id, detail: { resolution, note } })
  return { ok: true }
}

/** Takes an item off the list with a short note (kept as history). */
export async function dismissFinding(clients: InventoryClients, actor: Actor, findingId: string, note: string): Promise<Result<object>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const text = typeof note === 'string' ? note.trim() : ''
  if (text.length < 3 || text.length > 500) return { ok: false, error: 'Give a short note (at least three characters).' }
  const id = cleanId(findingId)
  if (!id) return { ok: false, error: MSG_NOT_FOUND }
  return settle(clients.admin, actor, id, 'dismissed', text)
}

/**
 * Settles a "possible move" or an "unplaced" camera the way the list suggests: the existing camera is put on the channel the NVR lists
 * (possible move: that channel; unplaced: its last channel). Its id, grants, groups and history stay.
 */
export async function linkFinding(clients: InventoryClients, actor: Actor, findingId: string): Promise<Result<object>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(findingId)
  if (!id) return { ok: false, error: MSG_NOT_FOUND }
  let f
  try {
    f = await openFinding(clients.admin, actor.orgId, id)
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'findings.link', fallback: 'Could not read the list.' }) }
  }
  if (!f) return { ok: false, error: MSG_NOT_FOUND }
  if ((f.kind !== 'possible_move' && f.kind !== 'unplaced') || f.channel === null) return { ok: false, error: 'This item cannot be linked; merge or dismiss it instead.' }
  const moved = await remapCamera(clients, actor, { cameraId: f.camera_id, recorderId: f.recorder_id, channel: f.channel })
  if (!moved.ok) return moved
  return settle(clients.admin, actor, id, 'linked', null)
}
