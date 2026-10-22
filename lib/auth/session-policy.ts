// Session rules of P3-1 (brief items 1 and 7; decision D-10, ruling D-10a), as pure functions so the truth tables are tested alone
// (tests/unit/session-policy.test.ts). Used by proxy.ts (idle timeout and absolute lifetime), the profile gate (multi-factor) and every
// sensitive Server Action (fresh sign-in).

type Env = Record<string, string | undefined>

export type SessionPolicy = {
  /** Absolute lifetime of a sign-in, in hours (SESSION_MAX_HOURS, default 12). */
  maxHours: number
  /** Idle limit for administrators and super administrators, in minutes (SESSION_IDLE_MINUTES_ADMIN, default 60). */
  idleMinutesAdmin: number
  /** Idle limit for everybody else, in minutes (SESSION_IDLE_MINUTES, default 480). */
  idleMinutes: number
  /** A sensitive action needs a sign-in or code within this many minutes (FRESH_AUTH_MINUTES, default 10). */
  freshMinutes: number
}

const whole = (v: string | undefined, fallback: number, max: number): number => {
  const s = (v ?? '').trim()
  if (!/^\d+$/.test(s)) return fallback
  const n = Number(s)
  return n >= 1 && n <= max ? n : fallback
}

export function sessionPolicy(env: Env = process.env): SessionPolicy {
  return {
    maxHours: whole(env.SESSION_MAX_HOURS, 12, 24 * 30),
    idleMinutesAdmin: whole(env.SESSION_IDLE_MINUTES_ADMIN, 60, 24 * 60),
    idleMinutes: whole(env.SESSION_IDLE_MINUTES, 480, 24 * 60),
    freshMinutes: whole(env.FRESH_AUTH_MINUTES, 10, 24 * 60),
  }
}

/** The idle limit for a role (administrators get the shorter one; an unknown role gets it too). */
export const idleMinutesFor = (role: string | null | undefined, p: SessionPolicy): number =>
  role === 'user' || role === 'operator' || role === 'manager' ? p.idleMinutes : p.idleMinutesAdmin

/**
 * Whether a sign-in must end now. Times in seconds since the epoch. `lastSeen` null = no record of activity for this session: a
 * session already older than the idle limit then counts as idle (so removing the record never extends a session).
 */
export function sessionExpiry(o: { now: number; signedInAt: number | null; lastSeen: number | null; idleMinutes: number; maxHours: number }): 'idle' | 'absolute' | null {
  if (o.signedInAt !== null && o.now - o.signedInAt > o.maxHours * 3600) return 'absolute'
  const since = o.lastSeen ?? o.signedInAt
  if (since !== null && o.now - since > o.idleMinutes * 60) return 'idle'
  return null
}

export type SessionClaims = { sessionId: string | null; aal2: boolean; signedInAt: number | null; lastAuthAt: number | null }

/**
 * The parts of an access token the session rules need. Only for a token that was just verified (proxy.ts calls getUser() first, which
 * asks the auth server); the database reads the same claims itself (my_session_status) for every decision about access.
 */
export function claimsOf(accessToken: string | null | undefined): SessionClaims {
  const none: SessionClaims = { sessionId: null, aal2: false, signedInAt: null, lastAuthAt: null }
  const part = (accessToken ?? '').split('.')[1]
  if (!part) return none
  let c: { session_id?: unknown; aal?: unknown; amr?: unknown }
  try {
    c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return none
  }
  if (typeof c !== 'object' || c === null) return none
  const times = Array.isArray(c.amr)
    ? c.amr.map((a) => (typeof a === 'object' && a !== null ? (a as { timestamp?: unknown }).timestamp : null)).filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
    : []
  return {
    sessionId: typeof c.session_id === 'string' && c.session_id !== '' ? c.session_id : null,
    aal2: c.aal === 'aal2',
    signedInAt: times.length ? Math.min(...times) : null,
    lastAuthAt: times.length ? Math.max(...times) : null,
  }
}

export type MfaFacts = {
  /** mfa_enforced() for the person's organisation (security_settings.mfa_enforced). */
  enforced: boolean
  /** An administrator / super administrator, or a holder of any capability that requires MFA (admin.*, cctv.export, high-risk IT/Wi-Fi). */
  privileged: boolean
  /** This session finished a second factor. */
  aal2: boolean
  /** The person has a verified authenticator app. */
  hasFactor: boolean
}

/**
 * Where a signed-in person must go before anything else: `challenge` (enter the code of their authenticator app), `enrol` (set one up:
 * required for them and switched on) or `ok`. A person who set up a factor always finishes it, required or not (otherwise the factor
 * would protect nothing); viewers may set one up but are never made to (ruling D-10a).
 */
export function mfaGate(f: MfaFacts): 'ok' | 'challenge' | 'enrol' {
  if (f.aal2) return 'ok'
  if (f.hasFactor) return 'challenge'
  if (f.enforced && f.privileged) return 'enrol'
  return 'ok'
}

export const MSG_CONFIRM_FIRST =
  'For your safety, confirm it is you first: use “Confirm it’s you” at the top of this page (it opens in a new tab, so nothing here is lost), then try again.'

/**
 * Fresh sign-in (D-10): null when the person signed in or entered a code within the last N minutes, else the words to show. The time is
 * the latest authentication of the session as the database read it from the verified token (my_session_status).
 */
export function freshAuthRefusal(
  profile: { session?: { lastAuthAt: number | null } | null },
  o: { now?: number; freshMinutes?: number } = {},
): string | null {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const minutes = o.freshMinutes ?? sessionPolicy().freshMinutes
  const at = profile.session?.lastAuthAt ?? null
  if (at === null || at > now + 60 || now - at > minutes * 60) return MSG_CONFIRM_FIRST
  return null
}
