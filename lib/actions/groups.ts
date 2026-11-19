'use server'

import { revalidatePath } from 'next/cache'
import { hasGroupEditingAuthority, MSG_GROUPS_DENIED } from '@/lib/admin/roles'
import type { Actor } from '@/lib/admin/types'
import { holds } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import {
  addCameras, addCamerasByKeyword, addGroupRule, createGroup, deleteGroup, previewCamerasByKeyword, removeCamera, removeCameras, removeGroupRule, type GroupDeps,
  type RuleKind,
} from '@/lib/groups/service'
import { logger } from '@/lib/observability/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

/** What every group action answers with. `message` is plain text for a toast; nothing here is ever thrown to the browser. */
export type GroupActionState = {
  ok?: boolean; error?: string; message?: string; groupId?: string; values?: Record<string, string>
  /** Final clean-up (C M-20): the cameras an addition put in the group (for its undo). */
  cameraIds?: string[]
  /** Final clean-up (C M-20): what "Add by name" would add (nothing changed yet). */
  preview?: { cameras: { id: string; name: string }[]; truncated: boolean }
}

const DENIED = MSG_GROUPS_DENIED
const FAILED = 'Something went wrong. Please try again.'

/**
 * Checks the caller first (signed in; the operator, admin or platform-owner role AND cctv.live somewhere, P2-2), then runs the service
 * call, which checks cctv.live again in the database for every camera added. A failure of any kind becomes a plain message.
 */
async function run(route: string, body: (deps: GroupDeps, actor: Actor) => Promise<GroupActionState>): Promise<GroupActionState> {
  const p = await requireProfile() // sends signed-out people to the sign-in page
  if (!hasGroupEditingAuthority(p.role) || !holds(p.capabilities, 'cctv.live')) return { error: DENIED }
  const actor: Actor = { id: p.id, orgId: p.org_id, role: p.role }
  try {
    const state = await body({ admin: createAdminClient(), rls: await createClient() }, actor)
    revalidatePath('/groups')
    revalidatePath('/groups/[id]', 'page')
    return state
  } catch (error) {
    logger.error({ event: 'group_action_failed', route, error })
    return { error: FAILED }
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export async function createGroupAction(_prev: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const name = String(formData.get('name') ?? '')
  return run('createGroupAction', async (deps, actor) => {
    const res = await createGroup(deps, actor, name)
    return res.ok ? { ok: true, groupId: res.groupId, message: 'Group created. Now add some cameras.' } : { error: res.error, values: { name } }
  })
}

export async function deleteGroupAction(groupId: string): Promise<GroupActionState> {
  return run('deleteGroupAction', async (deps, actor) => {
    const res = await deleteGroup(deps, actor, String(groupId))
    return res.ok ? { ok: true, message: 'Group deleted.' } : { error: res.error }
  })
}

export async function addCamerasAction(groupId: string, cameraIds: string[]): Promise<GroupActionState> {
  return run('addCamerasAction', async (deps, actor) => {
    const res = await addCameras(deps, actor, String(groupId), Array.isArray(cameraIds) ? cameraIds : [], { returnIds: true })
    if (!res.ok) return { error: res.error }
    return { ok: true, cameraIds: res.ids ?? [], message: res.added === 0 ? 'Those cameras are already in the group.' : `Added ${plural(res.added, 'camera', 'cameras')} to the group.` }
  })
}

/** Final clean-up (C M-20): what "Add by name" would add; reads only. */
export async function previewByKeywordAction(groupId: string, keyword: string): Promise<GroupActionState> {
  return run('previewByKeywordAction', async (deps, actor) => {
    const res = await previewCamerasByKeyword(deps, actor, String(groupId), String(keyword ?? ''))
    if (!res.ok) return { error: res.error }
    return { ok: true, preview: { cameras: res.cameras, truncated: res.truncated } }
  })
}

/** Final clean-up (C M-20): the undo of an addition (only the cameras it put in the group). */
export async function removeCamerasAction(groupId: string, cameraIds: string[]): Promise<GroupActionState> {
  return run('removeCamerasAction', async (deps, actor) => {
    const res = await removeCameras(deps, actor, String(groupId), Array.isArray(cameraIds) ? cameraIds : [])
    if (!res.ok) return { error: res.error }
    return { ok: true, message: `Took ${plural(res.removed, 'camera', 'cameras')} out of the group again.` }
  })
}

export async function addByKeywordAction(groupId: string, keyword: string): Promise<GroupActionState> {
  return run('addByKeywordAction', async (deps, actor) => {
    const res = await addCamerasByKeyword(deps, actor, String(groupId), String(keyword ?? ''))
    if (!res.ok) return { error: res.error }
    const more = res.truncated ? ' More than 500 cameras matched, so only the first 500 (in name order) were looked at. Use a longer word to narrow it down.' : ''
    if (res.added === 0) return { ok: true, message: `No new cameras found with that word in the name. They may already be in the group, or you may not be able to see them.${more}` }
    return { ok: true, message: `Added ${plural(res.added, 'camera', 'cameras')} to the group.${more}` }
  })
}

/** P2-5c-1: a dynamic rule (region / cluster / location / NVR / name); members are always intersected with what each viewer may see. */
export async function addRuleAction(groupId: string, input: { kind: RuleKind; refId?: string | null; nameContains?: string | null }): Promise<GroupActionState> {
  return run('addRuleAction', async (deps, actor) => {
    const res = await addGroupRule(deps, actor, String(groupId), { kind: input?.kind, refId: input?.refId ?? null, nameContains: input?.nameContains ?? null })
    return res.ok ? { ok: true, message: 'Rule added. Its cameras are in the group now, and cameras added there later will be too.' } : { error: res.error }
  })
}

export async function removeRuleAction(groupId: string, ruleId: string): Promise<GroupActionState> {
  return run('removeRuleAction', async (deps, actor) => {
    const res = await removeGroupRule(deps, actor, String(groupId), String(ruleId))
    return res.ok ? { ok: true, message: 'Rule removed.' } : { error: res.error }
  })
}

export async function removeCameraAction(groupId: string, cameraId: string): Promise<GroupActionState> {
  return run('removeCameraAction', async (deps, actor) => {
    const res = await removeCamera(deps, actor, String(groupId), String(cameraId))
    return res.ok ? { ok: true, message: 'Camera removed from the group.' } : { error: res.error }
  })
}
