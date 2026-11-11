'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { MSG_CONFLICT, reviewBeforeReactivation, revokeAll, type GrantView } from '@/lib/admin/access'
import { createUser, resetUserPassword, updateUser } from '@/lib/admin/users'
import { requireFreshAdministration } from '@/lib/auth/fresh'
import { mayAdminister, requireAdministration, type CurrentProfile } from '@/lib/auth/profile'
import { submittedValues } from '@/lib/forms/submitted-values'
import { adminRefusalFor } from '@/lib/rate-limit-shared'
import { createUserAdminClient } from '@/lib/supabase/admin'

export type CreateUserState = { error?: string; values?: Record<string, string>; created?: { userId: string; email: string; oneTimePassword: string; warning?: string } }
export type PasswordState = { error?: string; oneTimePassword?: string }
export type SimpleState = { error?: string; ok?: boolean; conflict?: boolean }
export type ReactivationState =
  | { ok: true; version: number; canRevoke: boolean; grants: { id: string; capabilityLabel: string; scopeLabel: string; lastDay: string | null; state: string; source: string }[] }
  | { ok: false; error: string }

// P2-2: people are managed with an administrative role AND admin.users; access with admin.access. canManageRole (in the service)
// still decides which roles an actor may manage (only a super administrator manages super administrators, ruling P-1).
// P2-6: the web app's own role for the database; GoTrue's admin API (auth.admin) only through the service key (ADR, risk 1).
const ctxOf = (p: CurrentProfile) => ({ profile: p, admin: createUserAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } })
// P2-6 (D-11): 30 changes a minute per administrator, shared by every app instance, on top of the overall administration count;
// refused when the count cannot be read. Null when the action may go ahead, else the words to show.
// P3-1 (D-10, review I-3): every change of people goes through the one fresh-sign-in guard (requireFreshAdministration).
const limited = (actorId: string) => adminRefusalFor('users_change', actorId)

export async function createUserAction(_prev: CreateUserState, formData: FormData): Promise<CreateUserState> {
  // Final fix Y (review B minor 1): the guard is the first call of every action (the scanner refuses any call before it).
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { error: g.error, values: submittedValues(formData, ['full_name', 'email', 'role', 'store_id']) }
  const values = submittedValues(formData, ['full_name', 'email', 'role', 'store_id'])
  const { admin, actor } = ctxOf(g.profile)
  const slow = await limited(actor.id)
  if (slow) return { error: slow, values }
  const email = String(formData.get('email') ?? '')
  const res = await createUser(admin, actor, {
    email,
    full_name: String(formData.get('full_name') ?? ''),
    role: String(formData.get('role') ?? 'user'),
    store_id: String(formData.get('store_id') ?? '') || null,
  })
  revalidatePath('/admin/users')
  return res.ok ? { created: { userId: res.userId, email, oneTimePassword: res.oneTimePassword, warning: res.warning } } : { error: res.error, values }
}

/**
 * Activates or deactivates a person. Reactivating can first revoke the person's old grants (the list the administrator was shown by
 * reactivationReviewAction, at that access version); that needs admin.access too.
 */
export async function setActiveAction(userId: string, isActive: boolean, opts?: { revokeAll?: { grantIds: string[]; reason: string; expectedVersion: number } }): Promise<SimpleState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { error: g.error }
  const { profile, admin, actor } = ctxOf(g.profile)
  const slow = await limited(actor.id)
  if (slow) return { error: slow }
  if (opts?.revokeAll) {
    if (!isActive) return { error: 'Removing access is offered only when reactivating.' }
    if (!mayAdminister(profile, 'admin.access')) return { error: 'Removing access needs the right to change access (admin.access).' }
    const r = await revokeAll(admin, actor, userId, opts.revokeAll)
    if (!r.ok) return { error: r.error, conflict: r.error === MSG_CONFLICT || undefined }
  }
  const res = await updateUser(admin, actor, userId, { is_active: isActive })
  revalidatePath('/admin/users')
  return res.ok ? { ok: true } : { error: res.error }
}

type ListedGrant = { id: string; capabilityLabel: string; scopeLabel: string; lastDay: string | null; state: string; source: string }
const listed = (grants: GrantView[]): ListedGrant[] => grants.map((g) => ({ id: g.id, capabilityLabel: g.capabilityLabel, scopeLabel: g.scopeLabel, lastDay: g.lastDay, state: g.state, source: g.source }))

/**
 * Before reactivating: the person's live grants, which apply again as soon as they are active (P2-3 brief; review M-1: only for an
 * administrator who may manage the person, and — without admin.access — only while the person is deactivated).
 */
export async function reactivationReviewAction(userId: string): Promise<ReactivationState> {
  const { profile, admin, actor } = ctxOf(await requireAdministration('admin.users'))
  if (!z.uuid().safeParse(userId).success) return { ok: false, error: 'User not found.' }
  // Reading the list changes nothing: the shared count only, no fresh sign-in.
  const slow = await adminRefusalFor('users_change', actor.id)
  if (slow) return { ok: false, error: slow }
  const mayReadAccess = mayAdminister(profile, 'admin.access')
  const r = await reviewBeforeReactivation(admin, actor, userId, { mayReadAccess })
  if (!r.ok) return r
  return { ok: true, version: r.version, canRevoke: mayReadAccess, grants: listed(r.grants) }
}

export type RoleState = { error?: string; ok?: boolean; revoked?: number; remaining?: ListedGrant[] | null }

/**
 * Changes a role (review I-2): the rights the new role may not keep are revoked in the same transaction; afterwards the remaining
 * access is returned for review when the administrator may read access (admin.access).
 */
export async function setRoleAction(userId: string, role: string, expectedVersion?: number | null): Promise<RoleState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { error: g.error }
  const { profile, admin, actor } = ctxOf(g.profile)
  const slow = await limited(actor.id)
  if (slow) return { error: slow }
  const version = typeof expectedVersion === 'number' && Number.isInteger(expectedVersion) && expectedVersion >= 0 ? expectedVersion : null
  const res = await updateUser(admin, actor, userId, { role }, { expectedVersion: version })
  revalidatePath('/admin/users')
  if (!res.ok) return { error: res.error }
  const after = mayAdminister(profile, 'admin.access') ? await reviewBeforeReactivation(admin, actor, userId, { mayReadAccess: true }) : null
  return { ok: true, revoked: res.revoked ?? 0, remaining: after?.ok ? listed(after.grants) : null }
}

export async function resetPasswordAction(userId: string): Promise<PasswordState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { error: g.error }
  const { admin, actor } = ctxOf(g.profile)
  const slow = await limited(actor.id)
  if (slow) return { error: slow }
  const res = await resetUserPassword(admin, actor, userId)
  revalidatePath('/admin/users')
  return res.ok ? { oneTimePassword: res.oneTimePassword } : { error: res.error }
}
