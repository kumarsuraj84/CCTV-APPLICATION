'use server'

// P3-1: "Sign out everywhere" for a person and the super administrator's reset of a person's two-step sign-in. The caller first, through
// the one fresh-sign-in guard (review I-3): requireFreshAdministration('admin.users') (signed in, active, password chosen, code
// finished where required, administrative role AND admin.users for the organisation, a sign-in or code within FRESH_AUTH_MINUTES),
// then the shared count.
import { revalidatePath } from 'next/cache'
import { clearCodeLock, resetFactors, signOutEverywhere } from '@/lib/admin/sessions'
import { requireFreshAdministration } from '@/lib/auth/fresh'
import { adminRefusalFor } from '@/lib/rate-limit-shared'
import { createUserAdminClient } from '@/lib/supabase/admin'

export type SessionActionState = { ok: true; removed?: number } | { ok: false; error: string }

export async function signOutEverywhereAction(userId: string): Promise<SessionActionState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { ok: false, error: g.error }
  const actor = { id: g.profile.id, orgId: g.profile.org_id, role: g.profile.role }
  const slow = await adminRefusalFor('users_change', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await signOutEverywhere(createUserAdminClient(), actor, String(userId))
  revalidatePath('/admin/users')
  return res
}

export async function resetFactorsAction(userId: string, reason: string): Promise<SessionActionState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { ok: false, error: g.error }
  const actor = { id: g.profile.id, orgId: g.profile.org_id, role: g.profile.role }
  const slow = await adminRefusalFor('users_change', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await resetFactors(createUserAdminClient(), actor, String(userId), reason)
  revalidatePath('/admin/users')
  return res
}

/** Final fix Y (review B I-2): a super administrator unlocks a person's code step (wrong codes in a row), with a reason. */
export async function clearCodeLockAction(userId: string, reason: string): Promise<SessionActionState> {
  const g = await requireFreshAdministration('admin.users')
  if (!g.ok) return { ok: false, error: g.error }
  const actor = { id: g.profile.id, orgId: g.profile.org_id, role: g.profile.role }
  const slow = await adminRefusalFor('users_change', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await clearCodeLock(createUserAdminClient(), actor, String(userId), reason)
  revalidatePath('/admin/users')
  return res
}
