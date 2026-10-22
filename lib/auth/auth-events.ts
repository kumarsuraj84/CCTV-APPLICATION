import { createHash } from 'node:crypto'
import type { Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'
import { createAdminClient } from '@/lib/supabase/admin'

// Durable audit of sign-ins (P3-1 brief item 7): sign-ins, sign-outs, failed sign-ins, expired sessions, multi-factor enrolment,
// codes, resets and confirmations go to public.auth_events (append-only; migration 20261021000034) through auth_event_record, the
// web app's own role (app_web). Never a password, code, secret or token. A failed sign-in for an address that has no account is kept
// with a hash of the address only (so repeated guessing is visible without storing what was typed).

export type AuthEventKind =
  | 'sign_in' | 'sign_in_failed' | 'sign_out' | 'sign_out_everywhere'
  | 'session_expired_idle' | 'session_expired_absolute'
  | 'mfa_enrolled' | 'mfa_verified' | 'mfa_failed' | 'mfa_removed' | 'mfa_factor_reset'
  | 'reauth' | 'reauth_failed'

export type AuthEvent = {
  event: AuthEventKind
  /** The person, when known. */
  userId?: string | null
  /** The e-mail address typed (failed sign-ins): only its hash is stored, and the person is looked up by it. */
  email?: string | null
  /** Who did it, when it is somebody else (an administrator signing a person out everywhere or resetting their factor). */
  actorId?: string | null
  ip?: string | null
  userAgent?: string | null
  detail?: Json
}

/** sha256 of the lower-cased address with a fixed label (the same address always gives the same value). */
export const emailHash = (email: string) => createHash('sha256').update(`drishti-auth-event-v1\u0000${email.trim().toLowerCase()}`).digest('hex')

/** Writes one event. Returns false (and logs, without values) when it could not be written; never throws. */
export async function recordAuthEvent(e: AuthEvent, client: () => ReturnType<typeof createAdminClient> = createAdminClient): Promise<boolean> {
  try {
    // The generated types do not know that the SQL function takes NULL for the optional parts.
    const { error } = await client().rpc('auth_event_record', {
      p_event: e.event,
      p_user: e.userId ?? null,
      p_email: e.email ? e.email.trim().toLowerCase() : null,
      p_email_hash: e.email ? emailHash(e.email) : null,
      p_actor: e.actorId ?? null,
      p_ip: e.ip ? e.ip.slice(0, 64) : null,
      p_user_agent: e.userAgent ? e.userAgent.slice(0, 200) : null,
      p_detail: e.detail ?? {},
    } as never)
    if (error) {
      logger.error({ event: 'auth_event_write_failed', kind: e.event, code: error.code })
      return false
    }
    return true
  } catch (err) {
    logger.error({ event: 'auth_event_write_failed', kind: e.event, errorName: err instanceof Error ? err.name : 'error' })
    return false
  }
}
