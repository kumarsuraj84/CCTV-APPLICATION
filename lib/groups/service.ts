import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { addAudit } from '@/lib/admin/audit'
import { canManageGroups, isAdminRole } from '@/lib/admin/roles'
import { sanitizeError } from '@/lib/observability/sanitize-error'

// `rls` is the person's own signed-in client: whatever it can read is what that person may see.
// `admin` does the writes (the tables cannot be written through the data API).
export type GroupDeps = { admin: AdminClient; rls: AdminClient }

const DENIED = 'Only operators and administrators can change camera groups.'
const NOT_FOUND = 'Group not found.'
const NOT_AVAILABLE = 'Some of those cameras are not available to you.'
const MAX_PER_REQUEST = 500 // at most this many cameras are added in one go
const CHUNK = 100 // ids per lookup, so the request address stays short

function cleanName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length < 1) return { ok: false, error: 'Enter a name for the group.' }
  if (trimmed.length > 100) return { ok: false, error: 'The group name can be at most 100 characters.' }
  return { ok: true, name: trimmed }
}

/** Finds a group in the person's own organisation that they are allowed to see; anything else looks like "not found". */
async function findGroup(deps: GroupDeps, actor: Actor, groupId: string): Promise<{ id: string; name: string; created_by: string | null } | null> {
  const { data } = await deps.admin.from('camera_groups').select('id, name, created_by').eq('id', groupId).eq('org_id', actor.orgId).maybeSingle()
  if (!data) return null
  const seen = await deps.rls.from('camera_groups').select('id').eq('id', groupId).maybeSingle()
  return seen.data ? data : null
}

export async function createGroup(deps: GroupDeps, actor: Actor, name: string): Promise<Result<{ groupId: string }>> {
  if (!canManageGroups(actor.role)) return { ok: false, error: DENIED }
  const n = cleanName(name)
  if (!n.ok) return n
  const { data, error } = await deps.admin.from('camera_groups').insert({ org_id: actor.orgId, name: n.name, created_by: actor.id }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createGroup', fallback: 'Could not create the group.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_created', entityType: 'camera_group', entityId: data.id, detail: { name: n.name } })
  return { ok: true, groupId: data.id }
}

export async function renameGroup(deps: GroupDeps, actor: Actor, groupId: string, name: string): Promise<Result<object>> {
  if (!canManageGroups(actor.role)) return { ok: false, error: DENIED }
  const n = cleanName(name)
  if (!n.ok) return n
  const group = await findGroup(deps, actor, groupId)
  if (!group) return { ok: false, error: NOT_FOUND }
  const { error } = await deps.admin.from('camera_groups').update({ name: n.name }).eq('id', groupId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'renameGroup', fallback: 'Could not rename the group.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_renamed', entityType: 'camera_group', entityId: groupId, detail: { from: group.name, to: n.name } })
  return { ok: true }
}

// Only the person who made a group, or an administrator, may delete it.
export async function deleteGroup(deps: GroupDeps, actor: Actor, groupId: string): Promise<Result<object>> {
  if (!canManageGroups(actor.role)) return { ok: false, error: DENIED }
  const group = await findGroup(deps, actor, groupId)
  if (!group) return { ok: false, error: NOT_FOUND }
  if (!isAdminRole(actor.role) && group.created_by !== actor.id) return { ok: false, error: 'Only the person who made a group, or an administrator, can delete it.' }
  const { error } = await deps.admin.from('camera_groups').delete().eq('id', groupId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteGroup', fallback: 'Could not delete the group.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_deleted', entityType: 'camera_group', entityId: groupId, detail: { name: group.name } })
  return { ok: true }
}

/** Puts cameras into a group. Cameras already there are ignored; `added` counts only the new ones. */
async function insertItems(deps: GroupDeps, actor: Actor, groupId: string, cameraIds: string[], detail: Record<string, string | number>): Promise<Result<{ added: number }>> {
  if (cameraIds.length === 0) return { ok: true, added: 0 }
  const rows = cameraIds.map((camera_id) => ({ org_id: actor.orgId, group_id: groupId, camera_id }))
  const { data, error } = await deps.admin.from('camera_group_items').upsert(rows, { onConflict: 'group_id,camera_id', ignoreDuplicates: true }).select('camera_id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'addCameras', fallback: 'Could not add the cameras.' }) }
  const added = data?.length ?? 0
  if (added > 0) {
    await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_cameras_added', entityType: 'camera_group', entityId: groupId, detail: { ...detail, added } })
  }
  return { ok: true, added }
}

/** All-or-nothing: if any id is a camera the person may not see (or does not exist), nothing is added and the answer is the same either way. */
export async function addCameras(deps: GroupDeps, actor: Actor, groupId: string, cameraIds: string[]): Promise<Result<{ added: number }>> {
  if (!canManageGroups(actor.role)) return { ok: false, error: DENIED }
  const ids = [...new Set(cameraIds)]
  if (ids.length === 0) return { ok: false, error: 'Choose at least one camera.' }
  if (ids.length > MAX_PER_REQUEST) return { ok: false, error: `Add at most ${MAX_PER_REQUEST} cameras at a time.` }
  const group = await findGroup(deps, actor, groupId)
  if (!group) return { ok: false, error: NOT_FOUND }
  let visible = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await deps.rls.from('cameras').select('id').in('id', chunk)
    if (error) {
      // A malformed id is the caller's mistake, shown as the same plain refusal; anything else is a real failure.
      if (error.code === '22P02') return { ok: false, error: NOT_AVAILABLE }
      return { ok: false, error: sanitizeError(error, { route: 'addCameras.check', fallback: 'Could not check the cameras.' }) }
    }
    visible += data?.length ?? 0
  }
  if (visible !== ids.length) return { ok: false, error: NOT_AVAILABLE }
  return insertItems(deps, actor, groupId, ids, { count: ids.length })
}

// "%" and "_" are wildcards in a name search; a person typing them means the characters themselves.
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Adds the cameras the person can see whose name contains the keyword (any capitals), at most 500. */
export async function addCamerasByKeyword(deps: GroupDeps, actor: Actor, groupId: string, keyword: string): Promise<Result<{ added: number }>> {
  if (!canManageGroups(actor.role)) return { ok: false, error: DENIED }
  const word = typeof keyword === 'string' ? keyword.trim() : ''
  if (!word) return { ok: false, error: 'Enter a word to look for in the camera names.' }
  if (word.length > 100) return { ok: false, error: 'The word can be at most 100 characters.' }
  const group = await findGroup(deps, actor, groupId)
  if (!group) return { ok: false, error: NOT_FOUND }
  const { data, error } = await deps.rls
    .from('cameras')
    .select('id')
    .ilike('name', `%${escapeLike(word)}%`)
    .order('name')
    .order('id')
    .limit(MAX_PER_REQUEST)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'addCamerasByKeyword', fallback: 'Could not look up the cameras.' }) }
  return insertItems(deps, actor, groupId, (data ?? []).map((c) => c.id), { keyword: word })
}

export async function removeCamera(deps: GroupDeps, actor: Actor, groupId: string, cameraId: string): Promise<Result<object>> {
  if (!canManageGroups(actor.role)) return { ok: false, error: DENIED }
  const group = await findGroup(deps, actor, groupId)
  if (!group) return { ok: false, error: NOT_FOUND }
  // The person's own view of the items only contains cameras they may see, so a hidden camera cannot be removed (or detected).
  const seen = await deps.rls.from('camera_group_items').select('camera_id').eq('group_id', groupId).eq('camera_id', cameraId).maybeSingle()
  if (!seen.data) return { ok: false, error: 'That camera is not in this group.' }
  const { error } = await deps.admin.from('camera_group_items').delete().eq('group_id', groupId).eq('camera_id', cameraId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'removeCamera', fallback: 'Could not remove the camera.' }) }
  await addAudit(deps.admin, { orgId: actor.orgId, actorId: actor.id, action: 'group_camera_removed', entityType: 'camera_group', entityId: groupId, detail: { cameraId } })
  return { ok: true }
}
