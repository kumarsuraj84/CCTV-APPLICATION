'use server'

// Server Actions of the access editor and the access review (P2-3). Every action: the session, active, password chosen, the
// administrative role AND admin.access for the whole organisation (requireAdministration, sends everybody else home before anything
// else happens), then input validation, a per-administrator rate limit, and the service in lib/admin/access.ts, which checks the
// organisation of every id and the grant rules, and writes audit records. They return plain results and never throw to the client.
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { applyChange, keepReviewed, previewChange, selfConfirmReview, type ChangeLine, type PreviewCapability } from '@/lib/admin/access'
import { requireAdministration } from '@/lib/auth/profile'
import { freshAuthRefusal } from '@/lib/auth/session-policy'
import { adminRefusalFor, type LimitName } from '@/lib/rate-limit-shared'
import { createAdminClient } from '@/lib/supabase/admin'

export type PreviewState =
  | { ok: true; version: number; token: string; personActive: boolean; capabilities: PreviewCapability[]; lines: ChangeLine[] }
  | { ok: false; error: string; conflict?: true }
export type ApplyState = { ok: true; version: number; added: number; revoked: number } | { ok: false; error: string; conflict?: true }
export type KeepState = { ok: true; kept: number } | { ok: false; error: string }

const MSG_BAD_REQUEST = 'Check the changes and try again.'
const userIdSchema = z.uuid()
const versionSchema = z.number().int().min(0)

async function ctx() {
  const p = await requireAdministration('admin.access')
  return { profile: p, admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}
// P2-6 (D-11): the per-administrator counts are shared by every app instance (lib/rate-limit-shared.ts), with the overall
// administration count on top; refused when the count cannot be read.
const limited = (name: LimitName, actorId: string) => adminRefusalFor(name, actorId)
// P3-1 (D-10): saving a change of access (and keeping a review item, which is giving it) also needs a fresh sign-in; the preview reads only.
const freshAndLimited = async (profile: Parameters<typeof freshAuthRefusal>[0], name: LimitName, actorId: string) => freshAuthRefusal(profile) ?? limited(name, actorId)

export async function previewAccessAction(userId: string, input: { changes: unknown; expectedVersion: number }): Promise<PreviewState> {
  const { admin, actor } = await ctx()
  if (!userIdSchema.safeParse(userId).success || !versionSchema.safeParse(input?.expectedVersion).success) return { ok: false, error: MSG_BAD_REQUEST }
  const slow = await limited('access_preview', actor.id)
  if (slow) return { ok: false, error: slow }
  return previewChange(admin, actor, userId, { changes: input.changes, expectedVersion: input.expectedVersion })
}

export async function applyAccessAction(userId: string, input: { changes: unknown; expectedVersion: number; token: string }): Promise<ApplyState> {
  const { profile, admin, actor } = await ctx()
  if (!userIdSchema.safeParse(userId).success || !versionSchema.safeParse(input?.expectedVersion).success || typeof input?.token !== 'string') return { ok: false, error: MSG_BAD_REQUEST }
  const slow = await freshAndLimited(profile, 'access_apply', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await applyChange(admin, actor, userId, { changes: input.changes, expectedVersion: input.expectedVersion, token: input.token })
  if (res.ok) {
    revalidatePath(`/admin/users/${userId}/access`)
    revalidatePath('/admin/users')
    revalidatePath('/admin/access-review')
  }
  return res
}

export type SelfConfirmState = { ok: true; confirmed: number } | { ok: false; error: string }

/** Break-glass (review M-11): the only super administrator confirms their own migrated grants with a typed reason. */
export async function selfConfirmReviewAction(input: { grantIds: string[]; reason: string }): Promise<SelfConfirmState> {
  const { profile, admin, actor } = await ctx()
  const slow = await freshAndLimited(profile, 'access_keep', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await selfConfirmReview(admin, actor, input)
  if (res.ok) {
    revalidatePath('/admin/access-review')
    revalidatePath('/admin/users')
  }
  return res
}

export async function keepReviewedAction(input: { grantIds: string[]; note?: string | null }): Promise<KeepState> {
  const { profile, admin, actor } = await ctx()
  const slow = await freshAndLimited(profile, 'access_keep', actor.id)
  if (slow) return { ok: false, error: slow }
  const res = await keepReviewed(admin, actor, input)
  if (res.ok) {
    revalidatePath('/admin/access-review')
    revalidatePath('/admin/users')
  }
  return res
}
