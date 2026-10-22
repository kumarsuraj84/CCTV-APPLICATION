import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { logger } from '@/lib/observability/logger'

// The caller's own session as the database reads it from the verified token (my_session_status, migration 20261021000034): the
// multi-factor switch of their organisation, whether they are "privileged" (administrative role or a capability that requires MFA),
// the session's level, whether they have an authenticator app, and the sign-in / last-authentication times (seconds).

export type SessionStatus = {
  mfaEnforced: boolean
  privileged: boolean
  aal2: boolean
  hasFactor: boolean
  sessionId: string | null
  signedInAt: number | null
  lastAuthAt: number | null
}

type Row = { mfa_enforced: boolean; privileged: boolean; aal2: boolean; has_factor: boolean; session_id: string | null; signed_in_at: string | null; last_auth_at: string | null }
const sec = (t: string | null) => (t ? Math.floor(Date.parse(t) / 1000) : null)

/** Null when it cannot be read (the gate then relies on the database alone, and every sensitive action is refused). */
export async function readSessionStatus(client: SupabaseClient<Database>): Promise<SessionStatus | null> {
  const { data, error } = await client.rpc('my_session_status')
  const r = (Array.isArray(data) ? data[0] : data) as Row | undefined
  if (error || !r) {
    if (error) logger.warn({ event: 'session_status_unreadable', code: error.code })
    return null
  }
  return {
    mfaEnforced: r.mfa_enforced === true,
    privileged: r.privileged === true,
    aal2: r.aal2 === true,
    hasFactor: r.has_factor === true,
    sessionId: r.session_id,
    signedInAt: sec(r.signed_in_at),
    lastAuthAt: sec(r.last_auth_at),
  }
}
