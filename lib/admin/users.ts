import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { addAudit } from '@/lib/admin/audit'
import { canManageRole, ROLES } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { logger } from '@/lib/observability/logger'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { assertRefsInOrg } from '@/lib/security/org-scope'
import { fetchAll } from '@/lib/supabase/fetch-all'

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGIT = '23456789'

/** A random one-time password with no look-alike characters. Shown once to the administrator; the person must replace it at first sign-in. */
export function generateOneTimePassword(length = 14): string {
  const pick = (s: string) => s[randomInt(s.length)]
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)]
  const all = UPPER + LOWER + DIGIT
  while (chars.length < length) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid e-mail address.')),
  full_name: z.string().trim().min(1, 'Enter the person’s name.').max(100, 'Use 100 characters or fewer for the name.'),
  role: z.enum(ROLES),
  store_id: z.uuid().nullable().optional(),
})

export const updateUserSchema = z.object({
  full_name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
  is_active: z.boolean().optional(),
  store_id: z.uuid().nullable().optional(),
})

export const accessSchema = z.object({
  storeIds: z.array(z.uuid()).max(2000),
  zones: z.array(z.string().trim().min(1).max(100)).max(200),
  cameraIds: z.array(z.uuid()).max(10000),
})

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Check the form and try again.'

async function loadTarget(admin: AdminClient, actor: Actor, userId: string) {
  const { data } = await admin.from('profiles').select('id, role, is_active, org_id').eq('id', userId).eq('org_id', actor.orgId).maybeSingle()
  return data
}

export async function createUser(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ userId: string; oneTimePassword: string }>> {
  const parsed = createUserSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const v = parsed.data
  if (!canManageRole(actor.role, v.role)) return { ok: false, error: 'You are not allowed to create a user with that role.' }
  if (v.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [v.store_id] }])
    } catch {
      return { ok: false, error: 'That store was not found.' }
    }
  }
  const oneTimePassword = generateOneTimePassword()
  const created = await admin.auth.admin.createUser({ email: v.email, password: oneTimePassword, email_confirm: true })
  if (created.error || !created.data.user) {
    return { ok: false, error: sanitizeError(created.error, { route: 'createUser', fallback: 'Could not create the user. The e-mail may already be in use.' }) }
  }
  const userId = created.data.user.id
  const { error } = await admin.from('profiles').insert({
    id: userId,
    org_id: actor.orgId,
    email: v.email,
    full_name: v.full_name,
    role: v.role,
    must_reset_password: true,
    store_id: v.store_id ?? null,
  })
  if (error) {
    const undone = await admin.auth.admin.deleteUser(userId)
    if (undone.error) logger.error({ event: 'create_user_rollback_failed', userId, error: undone.error })
    return { ok: false, error: sanitizeError(error, { route: 'createUser.profile', fallback: 'Could not create the user.' }) }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_created', entityType: 'profile', entityId: userId, detail: { role: v.role } })
  return { ok: true, userId, oneTimePassword }
}

export async function updateUser(admin: AdminClient, actor: Actor, userId: string, input: unknown): Promise<Result<object>> {
  const parsed = updateUserSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const patch = parsed.data
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  // Nobody changes their own role or status: that also means the last administrator can never lock everyone out.
  if (target.id === actor.id && (patch.role !== undefined || patch.is_active !== undefined)) {
    return { ok: false, error: 'You cannot change your own role or status.' }
  }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  if (patch.role && !canManageRole(actor.role, patch.role)) return { ok: false, error: 'You are not allowed to give that role.' }
  if (patch.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [patch.store_id] }])
    } catch {
      return { ok: false, error: 'That store was not found.' }
    }
  }
  const { error } = await admin.from('profiles').update(patch).eq('id', userId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateUser', fallback: 'Could not save the changes.' }) }
  if (patch.is_active !== undefined) {
    // Deactivating also stops sign-ins; reactivating lifts that.
    const ban = await admin.auth.admin.updateUserById(userId, { ban_duration: patch.is_active ? 'none' : '876000h' })
    if (ban.error) {
      logger.error({ event: 'update_user_ban_failed', userId, error: ban.error })
      await admin.from('profiles').update({ is_active: target.is_active }).eq('id', userId).eq('org_id', actor.orgId)
      return { ok: false, error: 'Could not change the status. Please try again.' }
    }
    if (!patch.is_active) {
      // End the sessions that exist now, so they stay dead even if the person is reactivated later.
      const ended = await admin.rpc('revoke_user_sessions', { p_user: userId })
      if (ended.error) {
        logger.error({ event: 'revoke_sessions_failed', userId, error: ended.error })
        return { ok: false, error: 'The person was deactivated, but their current sign-ins could not be ended. Please try again.' }
      }
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_updated', entityType: 'profile', entityId: userId, detail: patch })
  return { ok: true }
}

export async function resetUserPassword(admin: AdminClient, actor: Actor, userId: string): Promise<Result<{ oneTimePassword: string }>> {
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  if (target.id === actor.id) return { ok: false, error: 'Use “Choose a new password” to change your own password.' }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  const oneTimePassword = generateOneTimePassword()
  const res = await admin.auth.admin.updateUserById(userId, { password: oneTimePassword })
  if (res.error) return { ok: false, error: sanitizeError(res.error, { route: 'resetUserPassword', fallback: 'Could not reset the password.' }) }
  const { error } = await admin.from('profiles').update({ must_reset_password: true }).eq('id', userId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'resetUserPassword.flag', fallback: 'Could not reset the password.' }) }
  // The old password is gone, so end every sign-in made with it.
  const ended = await admin.rpc('revoke_user_sessions', { p_user: userId })
  if (ended.error) {
    logger.error({ event: 'revoke_sessions_failed', userId, error: ended.error })
    return { ok: false, error: 'The password was reset, but the current sign-ins could not be ended. Please try again.' }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_password_reset', entityType: 'profile', entityId: userId })
  return { ok: true, oneTimePassword }
}

// The interim access editor (until P2-3 brings the full one with modes, expiry and preview) edits exactly one thing: a person's live
// video and recordings (cctv.live + cctv.playback) for whole stores and single cameras. It is saved as explicit grants (P2-1, D-1):
// grants only add (a camera never narrows a store, AC-6), a zone is turned into grants for the stores in it now, and every other grant
// of the person (other capabilities, organisation-wide grants) is left as it is. Managers get access lists like everyone else (AC-8).
const EDITOR_CAPABILITIES = ['cctv.live', 'cctv.playback'] as const
const EDITOR_SCOPES = ['location', 'camera'] as const

export async function setUserAccess(admin: AdminClient, actor: Actor, userId: string, input: unknown): Promise<Result<object>> {
  const parsed = accessSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  const a = parsed.data
  let zoneStores: string[] = []
  if (a.zones.length > 0) {
    try {
      zoneStores = (await fetchAll((from, to) => admin.from('stores').select('id').eq('org_id', actor.orgId).in('zone', a.zones).order('id').range(from, to))).map((s) => s.id)
    } catch (e) {
      return { ok: false, error: sanitizeError(e, { route: 'setUserAccess.zones', fallback: 'Could not save the access list.' }) }
    }
  }
  const stores = [...new Set([...a.storeIds, ...zoneStores].map((id) => id.toLowerCase()))]
  const cameras = [...new Set(a.cameraIds.map((id) => id.toLowerCase()))]
  const grants = EDITOR_CAPABILITIES.flatMap((capability) => [
    ...stores.map((id) => ({ capability, scope_kind: 'location', scope_id: id })),
    ...cameras.map((id) => ({ capability, scope_kind: 'camera', scope_id: id })),
  ])
  const { data, error } = await admin.rpc('replace_user_grants', {
    p_org: actor.orgId, p_user: userId, p_capabilities: [...EDITOR_CAPABILITIES], p_scope_kinds: [...EDITOR_SCOPES], p_grants: grants,
    p_actor: actor.id, p_reason: 'Access list saved by an administrator.',
  })
  if (error) {
    const msg = error.message.includes('outside organisation') ? 'One of the stores or cameras was not found.' : sanitizeError(error, { route: 'setUserAccess', fallback: 'Could not save the access list.' })
    return { ok: false, error: msg }
  }
  const result = data as { added?: number; revoked?: number } | null
  await addAudit(admin, {
    orgId: actor.orgId, actorId: actor.id, action: 'user_access_set', entityType: 'profile', entityId: userId,
    detail: { stores: stores.length, zones: a.zones.length, cameras: cameras.length, grants_added: result?.added ?? 0, grants_revoked: result?.revoked ?? 0 },
  })
  return { ok: true }
}

export async function listUsers(admin: AdminClient, orgId: string) {
  return fetchAll((from, to) =>
    admin.from('profiles').select('id, email, full_name, role, is_active, must_reset_password, store_id, created_at').eq('org_id', orgId).order('full_name').order('id').range(from, to),
  )
}

/** What the interim editor shows: the stores and cameras of the person's live (not revoked) live-video and recording grants. Zones are no grants any more. */
export async function getUserAccess(admin: AdminClient, orgId: string, userId: string) {
  const rows = await fetchAll((from, to) =>
    admin
      .from('access_grants')
      .select('id, scope_kind, scope_id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .in('capability', [...EDITOR_CAPABILITIES])
      .in('scope_kind', [...EDITOR_SCOPES])
      .order('id')
      .range(from, to),
  )
  const of = (kind: string) => [...new Set(rows.filter((r) => r.scope_kind === kind && r.scope_id).map((r) => r.scope_id as string))].sort()
  return { storeIds: of('location'), zones: [] as string[], cameraIds: of('camera') }
}

export async function listStoresForAccess(admin: AdminClient, orgId: string) {
  return fetchAll((from, to) => admin.from('stores').select('id, code, name, zone').eq('org_id', orgId).order('code').order('id').range(from, to))
}

export async function listCamerasForAccess(admin: AdminClient, orgId: string) {
  return fetchAll((from, to) => admin.from('cameras').select('id, store_id, channel, name').eq('org_id', orgId).order('channel').order('id').range(from, to))
}
