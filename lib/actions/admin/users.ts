'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { liveGrantsOf, MSG_CONFLICT, revokeAll } from '@/lib/admin/access'
import { createUser, resetUserPassword, updateUser } from '@/lib/admin/users'
import type { AdminCapability } from '@/lib/auth/capabilities'
import { mayAdminister, requireAdministration } from '@/lib/auth/profile'
import { submittedValues } from '@/lib/forms/submitted-values'
import { rateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

export type CreateUserState = { error?: string; values?: Record<string, string>; created?: { userId: string; email: string; oneTimePassword: string; warning?: string } }
export type PasswordState = { error?: string; oneTimePassword?: string }
export type SimpleState = { error?: string; ok?: boolean; conflict?: boolean }
export type ReactivationState =
  | { ok: true; version: number; canRevoke: boolean; grants: { id: string; capabilityLabel: string; scopeLabel: string; lastDay: string | null; state: string; source: string }[] }
  | { ok: false; error: string }

const MSG_SLOW_DOWN = 'Too many requests in a short time. Wait a minute and try again.'

// P2-2: people are managed with an administrative role AND admin.users; access with admin.access. canManageRole (in the service)
// still decides which roles an actor may manage (only a super administrator manages super administrators, ruling P-1).
async function ctx(cap: AdminCapability = 'admin.users') {
  const p = await requireAdministration(cap)
  return { profile: p, admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}
const limited = async (actorId: string) => (await rateLimit(`users:${actorId}`, 30, 60_000)).limited

export async function createUserAction(_prev: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const { admin, actor } = await ctx()
  const values = submittedValues(formData, ['full_name', 'email', 'role', 'store_id'])
  if (await limited(actor.id)) return { error: MSG_SLOW_DOWN, values }
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
  const { profile, admin, actor } = await ctx()
  if (await limited(actor.id)) return { error: MSG_SLOW_DOWN }
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

/** Before reactivating: the person's live grants, which apply again as soon as they are active (P2-3 brief, review item 7). */
export async function reactivationReviewAction(userId: string): Promise<ReactivationState> {
  const { profile, admin, actor } = await ctx()
  if (!z.uuid().safeParse(userId).success) return { ok: false, error: 'User not found.' }
  if (await limited(actor.id)) return { ok: false, error: MSG_SLOW_DOWN }
  const live = await liveGrantsOf(admin, actor.orgId, userId)
  if (!live) return { ok: false, error: 'User not found.' }
  return {
    ok: true, version: live.version, canRevoke: mayAdminister(profile, 'admin.access'),
    grants: live.grants.map((g) => ({ id: g.id, capabilityLabel: g.capabilityLabel, scopeLabel: g.scopeLabel, lastDay: g.lastDay, state: g.state, source: g.source })),
  }
}

export async function setRoleAction(userId: string, role: string): Promise<SimpleState> {
  const { admin, actor } = await ctx()
  if (await limited(actor.id)) return { error: MSG_SLOW_DOWN }
  const res = await updateUser(admin, actor, userId, { role })
  revalidatePath('/admin/users')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function resetPasswordAction(userId: string): Promise<PasswordState> {
  const { admin, actor } = await ctx()
  if (await limited(actor.id)) return { error: MSG_SLOW_DOWN }
  const res = await resetUserPassword(admin, actor, userId)
  revalidatePath('/admin/users')
  return res.ok ? { oneTimePassword: res.oneTimePassword } : { error: res.error }
}
