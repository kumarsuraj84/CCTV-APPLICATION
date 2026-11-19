// The shared NVR login back-off (final fix X, release 1 review C I-1/I-2/I-3; ruling NB-1 in docs/drishti/DECISIONS.md). Pure rules
// with no database or network: the database implements exactly these in nvr_login_gate / nvr_login_report (migration
// 20261021000048) and tests/integration/nvr-login-state-db.test.ts runs the same scenarios against both. The in-memory fake data layer
// of the worker's unit tests (tests/helpers/memory-db.ts) uses this module, so the worker is tested against the same rules.
//
// One state per recorder (NVR), for the CURRENT saved login (its "version": address, ports, user name and the stored password; the
// database derives it, nobody ever sees the password in it):
//   - after a refused login (HTTP 401 on the ISAPI login, RTSP 401 with nothing proving the login works, or go2rtc's "wrong user/pass")
//     every path leaves the NVR alone for 15 minutes, then 30, 60, 120, 240 and at most 360 (NVR_LOGIN_BACKOFF_SEC doubling up to
//     NVR_LOGIN_BACKOFF_MAX_SEC). The level is reset only by a new saved login (a changed password, user name or address) or by an
//     administrator's "Try again"; a success also clears it.
//   - when a window is over, or the login was never proven, exactly ONE caller may try: it claims the attempt (ATTEMPT_SLOT_SEC) and
//     reports what happened. Everyone else waits for that answer. So there is at most one failed login per window across the worker,
//     discovery, the connection test, live video, playback and the downloads.
//   - three refused logins within 30 minutes, whatever the login (one wrong password saved after another), pause the NVR for every login
//     until the oldest of them is 30 minutes old (Hikvision locks after 5 to 7).
//   - an NVR without a saved password is never contacted.
// "forbidden" (HTTP 403 after the Digest login) is NOT a refused login: the NVR accepted the user name and password and only refuses that
// one request (a viewer account reading the channel status). It proves the login works.

export const ATTEMPT_SLOT_SEC = 60
export const LOGIN_REFUSALS_ALLOWED = 3
export const LOGIN_REFUSAL_WINDOW_SEC = 1800
export const DEFAULT_BACKOFF_SEC = 900
export const DEFAULT_BACKOFF_MAX_SEC = 21_600
/** At most this many refusal times are kept per NVR (only the last 30 minutes matter). */
const KEEP_REFUSALS = 10

/** Every path that logs in to an NVR (kept in the state for the administrators' screen). */
export type LoginPath = 'monitoring' | 'discovery' | 'connection_test' | 'live' | 'playback' | 'vod' | 'export' | 'gateway'
export const LOGIN_PATHS: readonly LoginPath[] = ['monitoring', 'discovery', 'connection_test', 'live', 'playback', 'vod', 'export', 'gateway']

/**
 * go: the login was proven (fresh enough for the caller) — log in. probe: nobody knows whether the login works; when `claimed` this caller
 * is the one allowed attempt and must report its outcome. wait: another caller is trying right now. refused: in a back-off window.
 * paused: too many refused logins lately (any login). no_password: nothing to log in with — never contacted.
 */
export type LoginDecision = 'go' | 'probe' | 'wait' | 'refused' | 'paused' | 'no_password'
export type LoginOutcome = 'ok' | 'refused' | 'unknown'

export type LoginState = {
  version: string
  /** The last known outcome for this version: null = not known (never tried, a new login, or "Try again"). */
  outcome: 'ok' | 'refused' | null
  /** Refusals in a row for this version (the back-off doubles with each). */
  level: number
  refusedUntil: number | null
  lastOkAt: number | null
  /** The first time any login of this NVR worked ("baselined"; the staggered start counts NVRs without one). */
  everOkAt: number | null
  attemptUntil: number | null
  /** Times of refused logins (any version), newest last. */
  refusals: number[]
}

export type LoginGate = {
  decision: LoginDecision
  /** The saved login this answer is about (report with it); null when none is saved. */
  version: string | null
  /** When a refused / paused / wait answer ends (ms since the epoch). */
  until: number | null
  baselined: boolean
  level: number
  /** This caller holds the one attempt (it must report). */
  claimed: boolean
}

export type BackoffConfig = { baseSec: number; maxSec: number }

export const fresh = (version: string): LoginState => ({ version, outcome: null, level: 0, refusedUntil: null, lastOkAt: null, everOkAt: null, attemptUntil: null, refusals: [] })

/**
 * The state for the current version: a new saved login starts from nothing but keeps whether any login ever worked. Round 2 (review
 * M-10; ruling NB-10): the refusal times go too, so a corrected password lifts the 3-in-30-minutes pause and is tried at once; if it is
 * refused as well, the first window (15 minutes) follows.
 */
function current(s: LoginState | undefined, version: string): LoginState {
  if (!s) return fresh(version)
  if (s.version === version) return s
  return { ...fresh(version), everOkAt: s.everOkAt }
}

/**
 * Round 2 (review I-2, M-4; ruling NB-8): the ONE classifier of what an NVR answer says about its saved login, used by the worker and the
 * web paths alike. `credentialsSent`: the answer came after the password was actually sent (a Digest login was answered). Without that,
 * nothing is proven or refused: a 403 or 200 before any login (an IP filter, a lock page, another device at that address) and a 401
 * that was never answered (Basic only, a password a Digest header cannot carry) are "unknown".
 */
export type LoginAnswer = { status: 'success' | 'refused' | 'forbidden' | 'other'; credentialsSent: boolean }
export function classifyLoginAnswer(a: LoginAnswer): LoginOutcome {
  if (!a.credentialsSent) return 'unknown'
  if (a.status === 'refused') return 'refused'
  if (a.status === 'success' || a.status === 'forbidden') return 'ok'
  return 'unknown'
}
/** An RTSP DESCRIBE answer (0 = nothing answered): 401 refused, any other answer success, each only after the password was sent. */
export const classifyRtspCode = (code: number, credentialsSent: boolean): LoginOutcome =>
  classifyLoginAnswer({ status: code === 401 ? 'refused' : code === 0 ? 'other' : 'success', credentialsSent })

/** The length of the window after the `level`-th refusal in a row: base, doubling, at most max. */
export function backoffSeconds(level: number, cfg: BackoffConfig = { baseSec: DEFAULT_BACKOFF_SEC, maxSec: DEFAULT_BACKOFF_MAX_SEC }): number {
  const n = Math.max(1, Math.min(level, 21))
  return Math.min(cfg.maxSec, cfg.baseSec * 2 ** (n - 1))
}

const recent = (refusals: readonly number[], now: number) => refusals.filter((t) => t > now - LOGIN_REFUSAL_WINDOW_SEC * 1000).sort((a, b) => a - b)

/**
 * What a caller may do now. `claim`: take the one attempt when a try is needed. `freshSec`: a proven login older than this needs a new
 * proof first (null: any proven login will do — the paths that send one request at a time). Returns the answer and the new state.
 */
export function decideLogin(
  state: LoginState | undefined, version: string | null, now: number, o: { claim: boolean; freshSec?: number | null },
): { gate: LoginGate; state: LoginState | undefined } {
  if (version === null) return { gate: { decision: 'no_password', version: null, until: null, baselined: state?.everOkAt != null, level: 0, claimed: false }, state }
  const s = current(state, version)
  const base = { version, baselined: s.everOkAt !== null, level: s.level }
  const r = recent(s.refusals, now)
  if (r.length >= LOGIN_REFUSALS_ALLOWED) {
    return { gate: { ...base, decision: 'paused', until: r[r.length - LOGIN_REFUSALS_ALLOWED] + LOGIN_REFUSAL_WINDOW_SEC * 1000, claimed: false }, state: s }
  }
  if (s.outcome === 'refused' && s.refusedUntil !== null && s.refusedUntil > now) {
    return { gate: { ...base, decision: 'refused', until: s.refusedUntil, claimed: false }, state: s }
  }
  const freshSec = o.freshSec ?? null
  if (s.outcome === 'ok' && (freshSec === null || (s.lastOkAt !== null && s.lastOkAt > now - freshSec * 1000))) {
    return { gate: { ...base, decision: 'go', until: null, claimed: false }, state: s }
  }
  if (s.attemptUntil !== null && s.attemptUntil > now) return { gate: { ...base, decision: 'wait', until: s.attemptUntil, claimed: false }, state: s }
  if (!o.claim) return { gate: { ...base, decision: 'probe', until: null, claimed: false }, state: s }
  return { gate: { ...base, decision: 'probe', until: null, claimed: true }, state: { ...s, attemptUntil: now + ATTEMPT_SLOT_SEC * 1000 } }
}

/** Records what a login did. A report for another version than the current one is ignored (`applied` false). */
export function reportLogin(
  state: LoginState | undefined, currentVersion: string | null, reportedVersion: string, outcome: LoginOutcome, now: number, cfg?: BackoffConfig,
): { applied: boolean; state: LoginState | undefined } {
  if (currentVersion === null || currentVersion !== reportedVersion) return { applied: false, state }
  const s = current(state, currentVersion)
  if (outcome === 'ok') return { applied: true, state: { ...s, outcome: 'ok', level: 0, refusedUntil: null, lastOkAt: now, everOkAt: s.everOkAt ?? now, attemptUntil: null } }
  if (outcome === 'unknown') return { applied: true, state: { ...s, attemptUntil: null } }
  const refusals = [...recent(s.refusals, now), now].slice(-KEEP_REFUSALS)
  // A second answer from an attempt that was already on its way when the first refusal came does not double the window again.
  if (s.outcome === 'refused' && s.refusedUntil !== null && s.refusedUntil > now) return { applied: true, state: { ...s, refusals, attemptUntil: null } }
  const level = (s.outcome === 'refused' ? s.level : 0) + 1
  return { applied: true, state: { ...s, outcome: 'refused', level, refusedUntil: now + backoffSeconds(level, cfg) * 1000, attemptUntil: null, refusals } }
}

/** An administrator's "Try again": the back-off and its level are cleared; the refusal times stay (the 3-in-30-minutes pause still holds). */
export function tryAgain(state: LoginState | undefined): LoginState | undefined {
  return state ? { ...state, outcome: null, level: 0, refusedUntil: null, attemptUntil: null } : state
}
