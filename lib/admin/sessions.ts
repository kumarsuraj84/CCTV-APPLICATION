import { addAudit } from '@/lib/admin/audit'
import { canManageRole, type Role } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { recordAuthEvent } from '@/lib/auth/auth-events'
import { logger } from '@/lib/observability/logger'
import { revokeMediaSessions } from '@/lib/streams/registry'

// P3-1 brief items 1 and 7: an administrator signs a person out everywhere; a super administrator resets a person's authenticator app
// (the recovery path for a lost phone). Both end every sign-in of the person and their open video, and both are audited
// (admin_audit_log and auth_events). The caller (the Server Action) has already checked requireAdministration('admin.users') and the
// fresh sign-in. `admin`: the web app's database role, with GoTrue's admin API through the service key (createUserAdminClient).

export const MSG_NOT_FOUND = 'User not found.'
export const MSG_OWNER_ONLY = 'Only a super administrator can reset someone’s two-step sign-in.'
export const MSG_NOT_SELF = 'Use the Security page to change your own sign-in.'
export const MSG_REASON = 'Give a reason of at least 3 characters.'

async function loadTarget(admin: AdminClient, actor: Actor, userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null
  const { data } = await admin.from('profiles').select('id, role').eq('id', userId).eq('org_id', actor.orgId).maybeSingle()
  return data as { id: string; role: Role } | null
}

async function endEverything(admin: AdminClient, actor: Actor, userId: string, reason: string): Promise<boolean> {
  // Final fix Y (review A M-6): the web app's form names the organisation; the database refuses a person of another one.
  const ended = await admin.rpc('revoke_user_sessions', { p_org: actor.orgId, p_user: userId })
  if (ended.error) {
    logger.error({ event: 'revoke_sessions_failed', userId, code: ended.error.code })
    return false
  }
  await revokeMediaSessions(admin, actor.orgId, userId, reason)
  return true
}

/** Ends every sign-in of a person (and their open video): a lost or shared computer, a person leaving a shift. */
export async function signOutEverywhere(admin: AdminClient, actor: Actor, userId: string): Promise<Result<object>> {
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: MSG_NOT_FOUND }
  if (target.id === actor.id) return { ok: false, error: MSG_NOT_SELF }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  if (!(await endEverything(admin, actor, userId, 'signed_out_everywhere'))) return { ok: false, error: 'The sign-ins could not be ended. Please try again.' }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_signed_out_everywhere', entityType: 'profile', entityId: userId })
  await recordAuthEvent({ event: 'sign_out_everywhere', userId, actorId: actor.id })
  return { ok: true }
}

/**
 * Removes a person's authenticator apps (they lost their phone): super administrators only, never their own, with a reason. The audit
 * row is written FIRST and the reset is refused when it cannot be written; then every factor is deleted and every sign-in ended, so the
 * person signs in again and, where it is required, must set up a new app before anything else.
 */
export async function resetFactors(admin: AdminClient, actor: Actor, userId: string, reason: unknown): Promise<Result<{ removed: number }>> {
  if (actor.role !== 'platform_owner') return { ok: false, error: MSG_OWNER_ONLY }
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (why.length < 3 || why.length > 500) return { ok: false, error: MSG_REASON }
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: MSG_NOT_FOUND }
  if (target.id === actor.id) return { ok: false, error: MSG_NOT_SELF }
  const listed = await admin.auth.admin.mfa.listFactors({ userId })
  if (listed.error) return { ok: false, error: 'The sign-in settings of this person could not be read. Please try again.' }
  const factors = listed.data?.factors ?? []
  const { error: auditError } = await admin.from('admin_audit_log').insert({
    org_id: actor.orgId, actor_id: actor.id, action: 'mfa_factor_reset', entity_type: 'profile', entity_id: userId,
    detail: { reason: why, factors: factors.length, verified: factors.filter((f) => f.status === 'verified').length },
  })
  if (auditError) {
    logger.error({ event: 'audit_write_failed', action: 'mfa_factor_reset', code: auditError.code })
    return { ok: false, error: 'The reset could not be recorded, so nothing was changed. Please try again.' }
  }
  let removed = 0
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id })
    if (error) {
      logger.error({ event: 'mfa_factor_delete_failed', userId })
      await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'mfa_factor_reset_incomplete', entityType: 'profile', entityId: userId, detail: { removed } })
      return { ok: false, error: 'Not every authenticator app could be removed. Please try again.' }
    }
    removed++
  }
  // Review M-3: an existing (perhaps an attacker's) aal2 session must not survive the reset unnoticed.
  if (!(await endEverything(admin, actor, userId, 'mfa_reset'))) {
    await recordAuthEvent({ event: 'mfa_factor_reset', userId, actorId: actor.id, detail: { removed, sessions_ended: false } })
    return { ok: false, error: 'The authenticator apps were removed, but the current sign-ins could not be ended. Use "Sign out everywhere…" now.' }
  }
  await recordAuthEvent({ event: 'mfa_factor_reset', userId, actorId: actor.id, detail: { removed } })
  // Final fix Y (review B I-2): a new app starts with a clean count of wrong codes (a locked code step is cleared, audited).
  const cleared = await admin.rpc('mfa_code_lock_clear', { p_org: actor.orgId, p_actor: actor.id, p_user: userId, p_reason: `Two-step sign-in reset: ${why}`.slice(0, 500) })
  if (cleared.error) logger.warn({ event: 'mfa_code_lock_clear_failed', code: cleared.error.code })
  return { ok: true, removed }
}

export const MSG_LOCK_OWNER_ONLY = 'Only a super administrator can unlock someone’s code step.'

/**
 * Final fix Y (review B I-2): a super administrator unlocks a person's code step (after 10 wrong codes in a row it locks for a while,
 * after 100 until this). Never their own; with a reason; the database checks it again and audits it (auth_events, admin_audit_log).
 */
export async function clearCodeLock(admin: AdminClient, actor: Actor, userId: string, reason: unknown): Promise<Result<object>> {
  if (actor.role !== 'platform_owner') return { ok: false, error: MSG_LOCK_OWNER_ONLY }
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (why.length < 3 || why.length > 500) return { ok: false, error: MSG_REASON }
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: MSG_NOT_FOUND }
  if (target.id === actor.id) return { ok: false, error: MSG_NOT_SELF }
  const { error } = await admin.rpc('mfa_code_lock_clear', { p_org: actor.orgId, p_actor: actor.id, p_user: userId, p_reason: why })
  if (error) return { ok: false, error: error.code === '42501' ? MSG_LOCK_OWNER_ONLY : 'The code step could not be unlocked. Please try again.' }
  return { ok: true }
}

export type CodeLock = { failures: number; lockedUntil: string | null; forGood: boolean }

/** Final fix Y (review B I-2): people of the organisation with wrong codes in a row or a locked code step (the people screen). */
export async function codeLocks(admin: AdminClient, orgId: string): Promise<Map<string, CodeLock> | null> {
  const { data, error } = await admin.rpc('mfa_code_locks', { p_org: orgId })
  if (error) return null
  return new Map(((data ?? []) as { user_id: string; failures: number; locked_until: string | null; for_good: boolean }[]).map((r) => [
    r.user_id, { failures: r.failures, lockedUntil: r.locked_until, forGood: r.for_good },
  ]))
}

export type TwoStep = { factors: number; enrolledAt: string | null; enrolledIp: string | null }

/**
 * Who in the organisation has an authenticator app, and (review I-4) when and from which address it was set up (the latest
 * mfa_enrolled sign-in event), for the people screen: user id → summary. Nothing about the app itself.
 */
export async function twoStepSummary(admin: AdminClient, orgId: string): Promise<Map<string, TwoStep> | null> {
  const [factors, events] = await Promise.all([admin.rpc('mfa_factor_people', { p_org: orgId }), admin.rpc('mfa_enrolment_events', { p_org: orgId })])
  if (factors.error) return null
  const when = new Map(((events.data ?? []) as { user_id: string; enrolled_at: string; enrolled_ip: string | null }[]).map((r) => [r.user_id, r]))
  return new Map(((factors.data ?? []) as { user_id: string; factors: number }[]).map((r) => [
    r.user_id, { factors: r.factors, enrolledAt: when.get(r.user_id)?.enrolled_at ?? null, enrolledIp: when.get(r.user_id)?.enrolled_ip ?? null },
  ]))
}
