import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { recordAuthEvent } from '@/lib/auth/auth-events'
import { authRefusal } from '@/lib/auth/auth-limits'
import type { CurrentProfile } from '@/lib/auth/profile'
import { freshAuthRefusal } from '@/lib/auth/session-policy'
import { logger } from '@/lib/observability/logger'
import { MSG_SIGN_IN_BUSY, sharedLimiter, signInOutcomeOf, signInRefusalMessage, type SignInOutcome } from '@/lib/rate-limit-shared'
import { createAdminClient } from '@/lib/supabase/admin'

// Multi-factor sign-in with an authenticator app (TOTP through the auth server's MFA API; P3-1 brief item 1, decision D-10) and
// "Confirm it's you" (fresh sign-in). Every function acts on the person's OWN session (the cookie client): the auth server checks each
// code itself; the app only decides when to ask. The secret of a new authenticator is returned once, to the person setting it up, and
// is never logged or stored by the app (the auth server keeps it). Codes are counted per person (lib/auth/auth-limits.ts).

type Client = SupabaseClient<Database>
type Me = Pick<CurrentProfile, 'id' | 'email' | 'session'>
export type Done<T = object> = ({ ok: true } & T) | { ok: false; error: string }

export const ISSUER = 'CityKart Drishti'
export const MSG_CODE_USED = 'That code was used already. Wait for the next code in your authenticator app.'
export const MSG_BAD_CODE ='That code is not right. Check that the time on your phone is correct, then enter the newest code.'
export const MSG_CODE_FORMAT = 'Enter the 6-digit code from your authenticator app.'
export const MSG_NOT_ENABLED = 'Two-step sign-in is not switched on for this server yet. Ask an administrator.'
export const MSG_CODE_FIRST = 'Enter the code from your authenticator app first.'
export const MSG_ALREADY = 'You already have an authenticator app. Remove it on the Security page first to set up a new one.'
export const MSG_TRY_AGAIN = 'That did not work. Please try again.'
export const MSG_WRONG_PASSWORD = 'That password is not right.'
export const MSG_REQUIRED = 'Two-step sign-in is required for your account, so it cannot be removed. If you have a new phone, ask a super administrator to reset it.'

const CODE = /^\d{6}$/
const cleanCode = (v: unknown) => String(v ?? '').replace(/[\s-]/g, '')

/** The person's verified authenticator apps (ids only). */
async function verifiedTotp(client: Client): Promise<string[] | null> {
  const { data, error } = await client.auth.mfa.listFactors()
  if (error) return null
  return (data?.totp ?? []).filter((f) => f.status === 'verified').map((f) => f.id)
}

/**
 * Review M-9: each code counts once per person. The auth server (GoTrue 2.197) accepts the same code again within its window — measured:
 * a second session and the first one both accepted a code already used — so the code is claimed in the database (mfa_code_claim: a
 * hash of person and code, kept three minutes) before the auth server is asked. True = first use; false = used already; null = the
 * claim could not be made (refused: fail closed).
 */
async function claimCode(userId: string, code: string, web: () => Client): Promise<boolean | null> {
  const hash = createHash('sha256').update(`drishti-mfa-code-v1\u0000${userId}\u0000${code}`).digest('hex')
  const { data, error } = await web().rpc('mfa_code_claim', { p_user: userId, p_hash: hash })
  if (error) {
    logger.warn({ event: 'mfa_code_claim_failed', code: error.code })
    return null
  }
  return data === true
}

async function check(client: Client, me: Me, factorId: string, code: string, ok: 'mfa_enrolled' | 'mfa_verified' | 'reauth', o: { ip?: string | null; web?: () => Client } = {}): Promise<Done> {
  if (!CODE.test(code)) return { ok: false, error: MSG_CODE_FORMAT }
  const slow = await authRefusal('mfa_verify', me.id)
  if (slow) return { ok: false, error: slow }
  const fresh = await claimCode(me.id, code, o.web ?? createAdminClient)
  if (fresh === null) return { ok: false, error: MSG_TRY_AGAIN }
  if (!fresh) {
    await recordAuthEvent({ event: ok === 'reauth' ? 'reauth_failed' : 'mfa_failed', userId: me.id, ip: o.ip, detail: { step: ok, reason: 'code_reused' } })
    return { ok: false, error: MSG_CODE_USED }
  }
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code })
  if (error) {
    const wrong = (error as { code?: string }).code === 'mfa_verification_failed' || /invalid totp/i.test(error.message)
    await recordAuthEvent({ event: ok === 'reauth' ? 'reauth_failed' : 'mfa_failed', userId: me.id, ip: o.ip, detail: { step: ok } })
    if (!wrong) logger.warn({ event: 'mfa_verify_failed', code: (error as { code?: string }).code ?? 'error' })
    return { ok: false, error: wrong ? MSG_BAD_CODE : MSG_TRY_AGAIN }
  }
  await recordAuthEvent({ event: ok, userId: me.id, ip: o.ip, detail: { method: 'totp' } })
  return { ok: true }
}

/**
 * Step 1 of setting up an authenticator app: a new secret with its QR code. Earlier unfinished set-ups are removed first. Not while a
 * code is still owed for an existing app, and not when one is already set up (one app per person; remove it first).
 */
export async function startEnrolment(client: Client, me: Me): Promise<Done<{ factorId: string; qrCode: string; secret: string }>> {
  if (me.session?.hasFactor) return { ok: false, error: me.session.aal2 ? MSG_ALREADY : MSG_CODE_FIRST }
  const slow = await authRefusal('mfa_enrol', me.id)
  if (slow) return { ok: false, error: slow }
  const list = await client.auth.mfa.listFactors()
  for (const f of list.data?.all ?? []) if (f.factor_type === 'totp' && f.status !== 'verified') await client.auth.mfa.unenroll({ factorId: f.id })
  const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator app', issuer: ISSUER })
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code
    if (code !== 'mfa_totp_enroll_not_enabled') logger.warn({ event: 'mfa_enrol_failed', code: code ?? 'error' })
    return { ok: false, error: code === 'mfa_totp_enroll_not_enabled' ? MSG_NOT_ENABLED : MSG_TRY_AGAIN }
  }
  return { ok: true, factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }
}

/** Step 2: the first code proves the app works; the session becomes aal2. */
/** Review I-4: the set-up is recorded with when and from which address (auth_events mfa_enrolled; shown on the people screen). */
export async function confirmEnrolment(client: Client, me: Me, factorId: unknown, code: unknown, o: { ip?: string | null } = {}): Promise<Done> {
  if (typeof factorId !== 'string' || !/^[0-9a-f-]{36}$/i.test(factorId)) return { ok: false, error: MSG_TRY_AGAIN }
  return check(client, me, factorId, cleanCode(code), 'mfa_enrolled', { ip: o.ip })
}

/** The sign-in step: the code of the person's authenticator app. */
export async function verifySignInCode(client: Client, me: Me, code: unknown, o: { ip?: string | null } = {}): Promise<Done> {
  const factors = await verifiedTotp(client)
  if (!factors) return { ok: false, error: MSG_TRY_AGAIN }
  if (factors.length === 0) return { ok: true } // nothing to finish (reset meanwhile): the gate decides what is next
  return check(client, me, factors[0], cleanCode(code), 'mfa_verified', { ip: o.ip })
}

/**
 * "Confirm it's you" (fresh sign-in, D-10): with an authenticator app, a new code (the session's last authentication moves to now);
 * without one, the password again — a new sign-in replaces this one (the auth server stamps it now) and the old session is ended.
 */
export async function confirmIdentity(
  client: Client, me: Me, input: { code?: unknown; password?: unknown }, web: () => Client = createAdminClient, o: { ip?: string | null } = {},
): Promise<Done> {
  if (me.session?.hasFactor) {
    const factors = await verifiedTotp(client)
    if (!factors?.length) return { ok: false, error: MSG_TRY_AGAIN }
    return check(client, me, factors[0], cleanCode(input.code), 'reauth', { ip: o.ip, web })
  }
  const password = typeof input.password === 'string' ? input.password : ''
  if (!password) return { ok: false, error: 'Enter your password.' }
  const slow = await authRefusal('reauth', me.id)
  if (slow) return { ok: false, error: slow }
  // Review M-10: a password here is a sign-in like any other, so it also goes through P2-6's sign-in gate (rising delay per e-mail
  // address and IP, counted before the password is checked).
  const gate = await sharedLimiter().signInGate(me.email.toLowerCase(), o.ip ?? null)
  if (!gate.allowed) return { ok: false, error: signInRefusalMessage(gate) }
  const before = me.session?.sessionId ?? null
  let outcome: SignInOutcome = 'not_counted'
  let failed = true
  try {
    const { error } = await client.auth.signInWithPassword({ email: me.email, password })
    outcome = signInOutcomeOf(error)
    failed = !!error
  } finally {
    await gate.finish(outcome)
  }
  if (outcome === 'not_counted' && failed) return { ok: false, error: MSG_SIGN_IN_BUSY }
  if (failed) {
    await recordAuthEvent({ event: 'reauth_failed', userId: me.id, ip: o.ip, detail: { method: 'password' } })
    return { ok: false, error: MSG_WRONG_PASSWORD }
  }
  if (before) {
    const ended = await web().rpc('auth_session_end', { p_user: me.id, p_session: before })
    if (ended.error) logger.warn({ event: 'reauth_old_session_not_ended', code: ended.error.code })
  }
  await recordAuthEvent({ event: 'reauth', userId: me.id, ip: o.ip, detail: { method: 'password' } })
  return { ok: true }
}

/** Removing one's own authenticator app: needs this session at aal2 and a fresh sign-in; refused where it is required. */
export async function removeOwnFactor(client: Client, me: Me): Promise<Done> {
  if (!me.session?.hasFactor) return { ok: true }
  if (!me.session.aal2) return { ok: false, error: MSG_CODE_FIRST }
  if (me.session.mfaEnforced && me.session.privileged) return { ok: false, error: MSG_REQUIRED }
  const stale = freshAuthRefusal(me)
  if (stale) return { ok: false, error: stale }
  const factors = await verifiedTotp(client)
  if (!factors) return { ok: false, error: MSG_TRY_AGAIN }
  for (const id of factors) {
    const { error } = await client.auth.mfa.unenroll({ factorId: id })
    if (error) return { ok: false, error: MSG_TRY_AGAIN }
  }
  await recordAuthEvent({ event: 'mfa_removed', userId: me.id, detail: { factors: factors.length } })
  return { ok: true }
}
