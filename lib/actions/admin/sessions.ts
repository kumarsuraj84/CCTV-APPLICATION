'use server'

// P3-1: "Sign out everywhere" for a person and the super administrator's reset of a person's two-step sign-in. The caller first:
// requireAdministration('admin.users') (signed in, active, password chosen, code finished where required, administrative role AND
// admin.users for the organisation), then a fresh sign-in (lib/auth/session-policy.ts freshAuthRefusal), then the shared count.
import { revalidatePath } from 'next/cache'
import { resetFactors, signOutEverywhere } from '@/lib/admin/sessions'
import { requireAdministration } from '@/lib/auth/profile'
import { freshAuthRefusal } from '@/lib/auth/session-policy'
import { adminRefusalFor } from '@/lib/rate-limit-shared'
import { createUserAdminClient } from '@/lib/supabase/admin'

export type SessionActionState = { ok: true; removed?: number } | { ok: false; error: string }

async function ctx() {
  const p = await requireAdministration('admin.users')
  return { profile: p, actor: { id: p.id, orgId: p.org_id, role: p.role } }
}

export async function signOutEverywhereAction(userId: string): Promise<SessionActionState> {
  const { profile, actor } = await ctx()
  const stale = freshAuthRefusal(profile)
  if (stale) return { ok: false, error: stale }
  const slow = await adminRefusalFor('users_change', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await signOutEverywhere(createUserAdminClient(), actor, String(userId))
  revalidatePath('/admin/users')
  return res
}

export async function resetFactorsAction(userId: string, reason: string): Promise<SessionActionState> {
  const { profile, actor } = await ctx()
  const stale = freshAuthRefusal(profile)
  if (stale) return { ok: false, error: stale }
  const slow = await adminRefusalFor('users_change', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await resetFactors(createUserAdminClient(), actor, String(userId), reason)
  revalidatePath('/admin/users')
  return res
}
