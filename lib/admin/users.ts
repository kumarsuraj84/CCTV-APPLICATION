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

// A person is created with NO grants (AC-8, P2-3): access is given afterwards in the access editor ("Assign access next"). A platform
// owner ("Super administrator") is the exception of owner ruling P-1: they get every capability for the organisation at once.
// A role change keeps the person's grants; a role is administrative authority only (lib/admin/roles.ts).
export const MSG_LAST_SUPER_ADMIN = 'There must always be at least one active super administrator.'

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Check the form and try again.'

async function loadTarget(admin: AdminClient, actor: Actor, userId: string) {
  const { data } = await admin.from('profiles').select('id, role, is_active, org_id').eq('id', userId).eq('org_id', actor.orgId).maybeSingle()
  return data
}

export async function createUser(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ userId: string; oneTimePassword: string; warning?: string }>> {
  const parsed = createUserSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const v = parsed.data
  if (!canManageRole(actor.role, v.role)) return { ok: false, error: 'You are not allowed to create a user with that role.' }
  if (v.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [v.store_id] }])
    } catch {
      return { ok: false, error: 'That location was not found.' }
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
  if (v.role === 'platform_owner') {
    // Ruling P-1: a super administrator holds every capability for the organisation (migration 20261021000016).
    const full = await admin.rpc('grant_platform_owner_all', { p_org: actor.orgId, p_user: userId })
    if (full.error) {
      logger.error({ event: 'platform_owner_grants_failed', userId, errorCode: full.error.code })
      return { ok: true, userId, oneTimePassword, warning: 'The person was added, but their full rights could not be given. Open their access and use “Full rights”.' }
    }
    await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'access_granted', entityType: 'profile', entityId: userId, detail: { preset: 'full-rights', added: Number(full.data ?? 0), reason: 'Platform owner: all capabilities' } })
  }
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
  // Ruling P-1: the organisation always keeps at least one active super administrator (platform_owner).
  const leavesSuper = target.role === 'platform_owner' && target.is_active && (patch.is_active === false || (patch.role !== undefined && patch.role !== 'platform_owner'))
  if (leavesSuper) {
    const { count, error: cErr } = await admin.from('profiles').select('id', { count: 'exact', head: true })
      .eq('org_id', actor.orgId).eq('role', 'platform_owner').eq('is_active', true).neq('id', target.id)
    if (cErr) return { ok: false, error: sanitizeError(cErr, { route: 'updateUser.lastSuper', fallback: 'Could not save the changes.' }) }
    if (!count) return { ok: false, error: MSG_LAST_SUPER_ADMIN }
  }
  if (patch.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [patch.store_id] }])
    } catch {
      return { ok: false, error: 'That location was not found.' }
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

export async function listUsers(admin: AdminClient, orgId: string) {
  return fetchAll((from, to) =>
    admin.from('profiles').select('id, email, full_name, role, is_active, must_reset_password, store_id, created_at').eq('org_id', orgId).order('full_name').order('id').range(from, to),
  )
}

/** Locations for the home-location choice on the create form (information only: it gives no access, AC-7). */
export async function listStoresForAccess(admin: AdminClient, orgId: string) {
  return fetchAll((from, to) => admin.from('stores').select('id, code, name, zone').eq('org_id', orgId).order('code').order('id').range(from, to))
}
