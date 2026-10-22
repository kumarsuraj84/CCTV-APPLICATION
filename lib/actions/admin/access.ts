'use server'

// Server Actions of the access editor and the access review (P2-3). Every action: the session, active, password chosen, the
// administrative role AND admin.access for the whole organisation (requireAdministration, sends everybody else home before anything
// else happens), then input validation, a per-administrator rate limit, and the service in lib/admin/access.ts, which checks the
// organisation of every id and the grant rules, and writes audit records. They return plain results and never throw to the client.
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { applyChange, keepReviewed, previewChange, selfConfirmReview, type ChangeLine, type PreviewCapability } from '@/lib/admin/access'
import { requireAdministration } from '@/lib/auth/profile'
import { rateLimit } from '@/lib/rate-limit'
import { createAdminClient } from '@/lib/supabase/admin'

export type PreviewState =
  | { ok: true; version: number; token: string; personActive: boolean; capabilities: PreviewCapability[]; lines: ChangeLine[] }
  | { ok: false; error: string; conflict?: true }
export type ApplyState = { ok: true; version: number; added: number; revoked: number } | { ok: false; error: string; conflict?: true }
export type KeepState = { ok: true; kept: number } | { ok: false; error: string }

const MSG_SLOW_DOWN = 'Too many requests in a short time. Wait a minute and try again.'
const MSG_BAD_REQUEST = 'Check the changes and try again.'
const userIdSchema = z.uuid()
const versionSchema = z.number().int().min(0)

async function ctx() {
  const p = await requireAdministration('admin.access')
  return { admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}
const limited = async (kind: string, actorId: string, perMinute: number) => (await rateLimit(`access:${kind}:${actorId}`, perMinute, 60_000)).limited

export async function previewAccessAction(userId: string, input: { changes: unknown; expectedVersion: number }): Promise<PreviewState> {
  const { admin, actor } = await ctx()
  if (!userIdSchema.safeParse(userId).success || !versionSchema.safeParse(input?.expectedVersion).success) return { ok: false, error: MSG_BAD_REQUEST }
  if (await limited('preview', actor.id, 30)) return { ok: false, error: MSG_SLOW_DOWN }
  return previewChange(admin, actor, userId, { changes: input.changes, expectedVersion: input.expectedVersion })
}

export async function applyAccessAction(userId: string, input: { changes: unknown; expectedVersion: number; token: string }): Promise<ApplyState> {
  const { admin, actor } = await ctx()
  if (!userIdSchema.safeParse(userId).success || !versionSchema.safeParse(input?.expectedVersion).success || typeof input?.token !== 'string') return { ok: false, error: MSG_BAD_REQUEST }
  if (await limited('apply', actor.id, 10)) return { ok: false, error: MSG_SLOW_DOWN }
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
  const { admin, actor } = await ctx()
  if (await limited('keep', actor.id, 30)) return { ok: false, error: MSG_SLOW_DOWN }
  const res = await selfConfirmReview(admin, actor, input)
  if (res.ok) {
    revalidatePath('/admin/access-review')
    revalidatePath('/admin/users')
  }
  return res
}

export async function keepReviewedAction(input: { grantIds: string[]; note?: string | null }): Promise<KeepState> {
  const { admin, actor } = await ctx()
  if (await limited('keep', actor.id, 30)) return { ok: false, error: MSG_SLOW_DOWN }
  const res = await keepReviewed(admin, actor, input)
  if (res.ok) {
    revalidatePath('/admin/access-review')
    revalidatePath('/admin/users')
  }
  return res
}
