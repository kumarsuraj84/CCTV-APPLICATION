import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { hasGroupEditingAuthority, isAdminRole, MSG_GROUPS_DENIED } from '@/lib/admin/roles'
import { holds, readCapabilities } from '@/lib/auth/capabilities'
import { camerasFor } from '@/lib/auth/resource'
import { sanitizeError } from '@/lib/observability/sanitize-error'

// Who may change camera groups (P2-2, brief item 2): the operator, admin or platform-owner role (administrative authority) AND cctv.live
// somewhere; every camera added needs cctv.live for that camera (cameras_with_capability, asked as the person). Reading a group is row
// security (cctv_visible_group_ids: a group shows only cameras the reader may see; its name is hidden when no member is visible).

// Audit actions written here (entity_type 'camera_group', entity_id = the group), named group_<what>_<done>:
//   group_created              detail { name }
//   group_renamed              detail { from, to }
//   group_deleted              detail { name }
//   group_cameras_added        cameras chosen one by one; detail { count, added }
//   group_cameras_added_by_keyword  cameras found by a word in their name; detail { keyword, added }
//   group_camera_removed       detail { cameraId }
// Adding that changes nothing (every camera already in the group) records nothing.

// `rls` is the person's own signed-in client: whatever it can read is what that person may see.
// `admin` does the writes (the tables cannot be written through the data API).
export type GroupDeps = { admin: AdminClient; rls: AdminClient }

const DENIED = MSG_GROUPS_DENIED

/** The role, then cctv.live somewhere (read through the person's own client, evaluated by the database). */
async function mayEdit(deps: GroupDeps, actor: Actor): Promise<Result<object>> {
  if (!hasGroupEditingAuthority(actor.role)) return { ok: false, error: DENIED }
  const caps = await readCapabilities(deps.rls)
  if (caps.failed) return { ok: false, error: 'Could not check your access. Please try again.' }
  return holds(caps, 'cctv.live') ? { ok: true } : { ok: false, error: DENIED }
}
const NOT_FOUND = 'Group not found.'
const NOT_AVAILABLE = 'Some of those cameras are not available to you.'
const MAX_PER_REQUEST = 500 // at most this many cameras are added in one go
const MALFORMED_ID = '22P02' // Postgres: "invalid input syntax" (for example an id that is not a uuid)
const DUPLICATE = '23505'
/**
 * The answer when a group name is taken (P2-1, directive AC-11). Names are unique in the organisation, and the group holding the name may
 * be one the person cannot see, so the answer is the same in every case and never says whose group or that it "exists".
 */
export const MSG_NAME_TAKEN = 'That name cannot be used. Choose a different name.'

function cleanName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length < 1) return { ok: false, error: 'Enter a name for the group.' }
  if (trimmed.length > 100) return { ok: false, error: 'The group name can be at most 100 characters.' }
  return { ok: true, name: trimmed }
}

type GroupRow = { id: string; name: string; created_by: string | null }

/**
 * Finds a group in the person's own organisation that they are allowed to see; anything else (another organisation, a hidden group,
 * an id that is not an id) looks like "not found". A database failure is a plain failure and is not mistaken for "not found".
 */
async function findGroup(deps: GroupDeps, actor: Actor, groupId: string): Promise<Result<{ group: GroupRow }>> {
  const lookupFailed = (error: unknown) => ({ ok: false as const, error: sanitizeError(error, { route: 'findGroup', fallback: 'Could not look up the group.' }) })
  const { data, error } = await deps.admin.from('camera_groups').select('id, name, created_by').eq('id', groupId).eq('org_id', actor.orgId).maybeSingle()
  if (error) return error.code === MALFORMED_ID ? { ok: false, error: NOT_FOUND } : lookupFailed(error)
  if (!data) return { ok: false, error: NOT_FOUND }
  const seen = await deps.rls.from('camera_groups').select('id').eq('id', groupId).maybeSingle()
  if (seen.error) return seen.error.code === MALFORMED_ID ? { ok: false, error: NOT_FOUND } : lookupFailed(seen.error)
  return seen.data ? { ok: true, group: data } : { ok: false, error: NOT_FOUND }
}

export async function createGroup(deps: GroupDeps, actor: Actor, name: string): Promise<Result<{ groupId: string }>> {
  const may = await mayEdit(deps, actor)
  if (!may.ok) return may
  const n = cleanName(name)
  if (!n.ok) return n
  const { data, error } = await deps.admin.from('camera_groups').insert({ org_id: actor.orgId, name: n.name, created_by: actor.id }).select('id').single()
  if (error?.code === DUPLICATE) return { ok: false, error: MSG_NAME_TAKEN }
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createGroup', fallback: 'Could not create the group.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_created', entityType: 'camera_group', entityId: data.id, detail: { name: n.name } })
  return { ok: true, groupId: data.id }
}

export async function renameGroup(deps: GroupDeps, actor: Actor, groupId: string, name: string): Promise<Result<object>> {
  const may = await mayEdit(deps, actor)
  if (!may.ok) return may
  const n = cleanName(name)
  if (!n.ok) return n
  const found = await findGroup(deps, actor, groupId)
  if (!found.ok) return found
  const { error } = await deps.admin.from('camera_groups').update({ name: n.name }).eq('id', groupId).eq('org_id', actor.orgId)
  if (error?.code === DUPLICATE) return { ok: false, error: MSG_NAME_TAKEN }
  if (error) return { ok: false, error: sanitizeError(error, { route: 'renameGroup', fallback: 'Could not rename the group.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_renamed', entityType: 'camera_group', entityId: groupId, detail: { from: found.group.name, to: n.name } })
  return { ok: true }
}

// Only the person who made a group, or an administrator, may delete it.
export async function deleteGroup(deps: GroupDeps, actor: Actor, groupId: string): Promise<Result<object>> {
  const may = await mayEdit(deps, actor)
  if (!may.ok) return may
  const found = await findGroup(deps, actor, groupId)
  if (!found.ok) return found
  const { group } = found
  if (!isAdminRole(actor.role) && group.created_by !== actor.id) return { ok: false, error: 'Only the person who made a group, or an administrator, can delete it.' }
  const { error } = await deps.admin.from('camera_groups').delete().eq('id', groupId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteGroup', fallback: 'Could not delete the group.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_deleted', entityType: 'camera_group', entityId: groupId, detail: { name: group.name } })
  return { ok: true }
}

type AddAction = 'group_cameras_added' | 'group_cameras_added_by_keyword'

/** Puts cameras into a group. Cameras already there are ignored; `added` counts only the new ones. */
async function insertItems(deps: GroupDeps, actor: Actor, groupId: string, cameraIds: string[], action: AddAction, detail: Record<string, string | number>): Promise<Result<{ added: number }>> {
  if (cameraIds.length === 0) return { ok: true, added: 0 }
  const rows = cameraIds.map((camera_id) => ({ org_id: actor.orgId, group_id: groupId, camera_id }))
  const { data, error } = await deps.admin.from('camera_group_items').upsert(rows, { onConflict: 'group_id,camera_id', ignoreDuplicates: true }).select('camera_id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'addCameras', fallback: 'Could not add the cameras.' }) }
  const added = data?.length ?? 0
  if (added > 0) {
    await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action, entityType: 'camera_group', entityId: groupId, detail: { ...detail, added } })
  }
  return { ok: true, added }
}

/** All-or-nothing: if any id is a camera the person may not see (or does not exist), nothing is added and the answer is the same either way. */
export async function addCameras(deps: GroupDeps, actor: Actor, groupId: string, cameraIds: string[]): Promise<Result<{ added: number }>> {
  const may = await mayEdit(deps, actor)
  if (!may.ok) return may
  if (!Array.isArray(cameraIds)) return { ok: false, error: 'Choose at least one camera.' }
  // Ids that differ only by capital letters are the same camera, so they are lower-cased before they are counted.
  const ids = [...new Set(cameraIds.map((id) => (typeof id === 'string' ? id.trim().toLowerCase() : '')))]
  if (ids.length === 0) return { ok: false, error: 'Choose at least one camera.' }
  if (ids.length > MAX_PER_REQUEST) return { ok: false, error: `Add at most ${MAX_PER_REQUEST} cameras at a time.` }
  const found = await findGroup(deps, actor, groupId)
  if (!found.ok) return found
  // Every camera must be one the person may watch live (cctv.live, asked as the person). A malformed id, a camera that does not exist and
  // one they may only see or play back all get the same plain refusal.
  const allowed = await camerasFor(deps.rls, 'cctv.live', ids)
  if (!allowed.ok) return { ok: false, error: 'Could not check the cameras.' }
  if (allowed.ids.length !== ids.length) return { ok: false, error: NOT_AVAILABLE }
  return insertItems(deps, actor, groupId, ids, 'group_cameras_added', { count: ids.length })
}

// The keyword is matched as a case-insensitive regular expression, so every character that means something in one is escaped:
// "%", "_" and "*" (which the like-operators would treat as wildcards) then stay plain text.
const escapeRegex = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

/** Adds the cameras the person can see whose name contains the keyword (any capitals), at most 500. `truncated` says more than 500 matched. */
export async function addCamerasByKeyword(deps: GroupDeps, actor: Actor, groupId: string, keyword: string): Promise<Result<{ added: number; truncated: boolean }>> {
  const may = await mayEdit(deps, actor)
  if (!may.ok) return may
  const word = typeof keyword === 'string' ? keyword.trim() : ''
  if (!word) return { ok: false, error: 'Enter a word to look for in the camera names.' }
  if (word.length > 100) return { ok: false, error: 'The word can be at most 100 characters.' }
  const found = await findGroup(deps, actor, groupId)
  if (!found.ok) return found
  // One more than the limit is read, only to know whether the list was cut.
  const { data, error } = await deps.rls
    .from('cameras')
    .select('id')
    .filter('name', 'imatch', escapeRegex(word))
    .order('name')
    .order('id')
    .limit(MAX_PER_REQUEST + 1)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'addCamerasByKeyword', fallback: 'Could not look up the cameras.' }) }
  // Of the matches (cameras the person may see), only those they may watch live are added. The 500 cap is applied to the matches first.
  const matched = (data ?? []).map((c) => c.id)
  const truncated = matched.length > MAX_PER_REQUEST
  const live = await camerasFor(deps.rls, 'cctv.live', matched.slice(0, MAX_PER_REQUEST))
  if (!live.ok) return { ok: false, error: 'Could not check the cameras.' }
  const res = await insertItems(deps, actor, groupId, live.ids, 'group_cameras_added_by_keyword', { keyword: word })
  return res.ok ? { ok: true, added: res.added, truncated } : res
}

export async function removeCamera(deps: GroupDeps, actor: Actor, groupId: string, cameraId: string): Promise<Result<object>> {
  const may = await mayEdit(deps, actor)
  if (!may.ok) return may
  const found = await findGroup(deps, actor, groupId)
  if (!found.ok) return found
  // The person's own view of the items only contains cameras they may see, so a hidden camera cannot be removed (or detected).
  const seen = await deps.rls.from('camera_group_items').select('camera_id').eq('group_id', groupId).eq('camera_id', cameraId).maybeSingle()
  if (!seen.data) return { ok: false, error: 'That camera is not in this group.' }
  const { error } = await deps.admin.from('camera_group_items').delete().eq('group_id', groupId).eq('camera_id', cameraId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'removeCamera', fallback: 'Could not remove the camera.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_camera_removed', entityType: 'camera_group', entityId: groupId, detail: { cameraId } })
  return { ok: true }
}
