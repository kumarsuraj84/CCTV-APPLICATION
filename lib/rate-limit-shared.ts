import { createHash } from 'node:crypto'
import { logger } from '@/lib/observability/logger'
import { processSingleton } from '@/lib/process-singleton'
import { createWindowLimiter } from '@/lib/streams/limiter'
import { createAdminClient } from '@/lib/supabase/admin'

// Shared rate limiting (P2-6 brief item 6, D-11, SO-7). One count for every app instance, in the database (rate_limit_hit: an atomic
// upsert per key and fixed window, migration 20261021000033), with a cheap in-process first filter in front (an instance that is over
// the limit on its own never asks the database). Keys hold a hash of the subject (person id, e-mail address and IP), never the subject.
//
// When the database cannot be asked: sensitive actions (sign-in, password changes, administration, import, discovery, connection tests,
// merges) are refused ("try again in a moment"); video opening (a read) is allowed within the in-process limit.
//
// Sign-in: no hard lockout any more (the old 15-minute lockout per e-mail let anybody lock anybody out). Failures are counted per e-mail
// address AND client IP; from the third failure the next try must wait 5 s, then 10, 20, ... up to 5 minutes, and a successful sign-in
// clears the count (the count is forgotten after 15 minutes without a try). The client IP is known only behind a configured number of
// trusted reverse proxies (TRUSTED_PROXY_HOPS, lib/rate-limit.ts getClientIp); without it every client shares "noip" and the delays then
// apply per e-mail address.
//
// Review round 1 (I-3, I-4): the check and the count are ONE atomic step in the database (sign_in_gate, migration 20261021000035): every
// try that is let through is counted as a failure BEFORE the password is checked, so simultaneous tries cannot all pass the same check;
// a success clears the count, and a try the sign-in service could not answer (429 "busy", a server error, no answer) is given back —
// only a refusal of the e-mail address and password counts. In front of it, per app instance: one try in flight per e-mail address + IP,
// and a known wait is answered without asking the database. A known client IP also has a ceiling of tries over all addresses
// (SIGN_IN_IP_LIMIT per 15 minutes); "noip" has none, because one ceiling shared by every client would lock everybody out.

export type LimitName =
  | 'forgot_password' | 'change_password' | 'admin_action' | 'users_change' | 'access_preview' | 'access_apply' | 'access_keep'
  | 'hierarchy_preview' | 'camera_search' | 'check_now' | 'import_check' | 'import_apply' | 'discovery' | 'discover_all'
  | 'connection_test' | 'merge_preview' | 'live_open' | 'playback_open' | 'playback_lookup' | 'vod_open' | 'agent_enrol' | 'agent_checkin'

/**
 * Per person (or per e-mail address + IP), per window. `failClosed`: refused when the database cannot be asked (sensitive); otherwise
 * allowed within the in-process limit (video reads). The counts of the in-process limiters they replace are kept where there was one.
 */
export const LIMITS: Record<LimitName, { limit: number; windowSec: number; failClosed: boolean }> = {
  forgot_password: { limit: 3, windowSec: 900, failClosed: true },
  change_password: { limit: 5, windowSec: 900, failClosed: true },
  /** Every administration action together (users, access, inventory, import, discovery), on top of its own count. */
  admin_action: { limit: 120, windowSec: 60, failClosed: true },
  users_change: { limit: 30, windowSec: 60, failClosed: true },
  access_preview: { limit: 30, windowSec: 60, failClosed: true },
  access_apply: { limit: 10, windowSec: 60, failClosed: true },
  access_keep: { limit: 30, windowSec: 60, failClosed: true },
  hierarchy_preview: { limit: 30, windowSec: 60, failClosed: true },
  camera_search: { limit: 60, windowSec: 60, failClosed: true },
  check_now: { limit: 3, windowSec: 60, failClosed: true },
  import_check: { limit: 20, windowSec: 600, failClosed: true },
  import_apply: { limit: 5, windowSec: 600, failClosed: true },
  /** "Find cameras" of one NVR or location (each asks NVRs). */
  discovery: { limit: 6, windowSec: 60, failClosed: true },
  /** "Find cameras for all locations": a few starts per ten minutes. */
  discover_all: { limit: 3, windowSec: 600, failClosed: true },
  connection_test: { limit: 6, windowSec: 60, failClosed: true },
  merge_preview: { limit: 30, windowSec: 60, failClosed: true },
  // Ruling R17: 30 a minute per person for opening live video, refreshing and renewing its tokens. A 36-tile wall renews all its tokens
  // in ONE call a minute and retries missing cameras every 30 s; three such tabs stay far below (tests/unit/rate-limit-shared.test.ts).
  live_open: { limit: 30, windowSec: 60, failClosed: false },
  playback_open: { limit: 30, windowSec: 60, failClosed: false },
  playback_lookup: { limit: 60, windowSec: 60, failClosed: false },
  vod_open: { limit: 30, windowSec: 60, failClosed: false },
  agent_enrol: { limit: 10, windowSec: 3600, failClosed: true },
  agent_checkin: { limit: 120, windowSec: 3600, failClosed: true },
}

export const MSG_SLOW_DOWN = 'Too many requests in a short time. Wait a minute and try again.'
export const MSG_LIMITER_UNAVAILABLE = 'This cannot be done right now. Please try again in a moment.'

export const MSG_SIGN_IN_BUSY = 'Sign-in is busy, please try again in a moment.'

/** A sign-in count is forgotten after this long without a try; a client IP's ceiling counts in windows of this length. */
export const SIGN_IN_WINDOW_SEC = 900
/** Tries from one known client IP over all e-mail addresses per window (an office behind one address stays far below). */
export const SIGN_IN_IP_LIMIT = 100
/** When the database cannot be asked, a sign-in is refused for now (fail closed, but never a lockout). */
const SIGN_IN_UNAVAILABLE_WAIT_SEC = 30
/** A try in flight longer than this (a lost finish) no longer blocks the next one in this instance. */
const SIGN_IN_IN_FLIGHT_MS = 30_000

/** Seconds to wait before the next sign-in after `failures` failures in 15 minutes: 0, 0, 0, 5, 10, 20, ... at most 300. */
export function signInDelaySec(failures: number): number {
  if (!Number.isFinite(failures) || failures < 3) return 0
  return Math.min(300, 5 * 2 ** Math.min(16, failures - 3))
}

/** The key of a subject for one limit: the limit's name and a hash of the subject (never the subject itself). */
export function limitKey(name: string, subject: string): string {
  return `${name}:${createHash('sha256').update(`drishti-rate-limit-v1\u0000${name}\u0000${subject}`).digest('hex').slice(0, 32)}`
}

export type LimiterStore = {
  hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; hits: number; resetAt: number }>
  state(key: string, windowSec: number): Promise<{ hits: number; lastHitAt: number | null }>
  clear(key: string): Promise<void>
  /** One atomic step: refuses while the delay of the key's failures runs (or the IP's ceiling is reached), else counts the try. */
  signInGate(key: string, ipKey: string | null, ipLimit: number): Promise<{ allowed: boolean; waitSec: number; reason: 'wait' | 'ip' | null }>
  /** After the password check: a success clears the key; a try the sign-in service could not answer is given back. */
  signInFinish(key: string, ipKey: string | null, outcome: 'succeeded' | 'not_counted'): Promise<void>
}
export type HitAnswer = { allowed: true } | { allowed: false; reason: 'limit' | 'unavailable'; retryAfterSec: number }

/** What the sign-in service's answer means for the count: only a refusal of the e-mail address and password counts. */
export type SignInOutcome = 'succeeded' | 'refused' | 'not_counted'
export type SignInRefusal = { allowed: false; reason: 'wait' | 'ip' | 'busy' | 'unavailable'; waitSec: number }
export type SignInGate = { allowed: true; finish(outcome: SignInOutcome): Promise<void> } | SignInRefusal

/**
 * Review I-4: the sign-in service's answer. A 429 ("busy"; GoTrue limits per address and sees every sign-in as the web server's), a
 * server error or no answer at all (network, timeout) is NOT a wrong password. Every other refusal (400 invalid_credentials, an
 * unconfirmed or blocked account) counts and gets the same words as a wrong password, so nobody learns which accounts exist.
 */
export function signInOutcomeOf(error: { status?: number; code?: string; name?: string } | null | undefined): SignInOutcome {
  if (!error) return 'succeeded'
  const status = typeof error.status === 'number' ? error.status : 0
  if (status === 429 || error.code === 'over_request_rate_limit') return 'not_counted'
  if (status === 0 || status >= 500) return 'not_counted'
  return 'refused'
}

/** The plain words for a refused sign-in. */
export function signInRefusalMessage(r: SignInRefusal): string {
  if (r.reason === 'busy') return MSG_SIGN_IN_BUSY
  if (r.reason === 'unavailable') return MSG_LIMITER_UNAVAILABLE
  if (r.reason === 'ip') {
    const min = Math.max(1, Math.ceil(r.waitSec / 60))
    return `Too many sign-in attempts from this network. Please wait ${min} ${min === 1 ? 'minute' : 'minutes'} and try again.`
  }
  return `Too many wrong tries. Please wait ${r.waitSec} ${r.waitSec === 1 ? 'second' : 'seconds'} and try again.`
}

export function createSharedLimiter(store: LimiterStore, now: () => number = Date.now) {
  const local = new Map<LimitName, ReturnType<typeof createWindowLimiter>>()
  const localOf = (name: LimitName) => {
    let l = local.get(name)
    if (!l) {
      l = createWindowLimiter(LIMITS[name].limit, LIMITS[name].windowSec * 1000, now)
      local.set(name, l)
    }
    return l
  }
  const failed = (what: string, e: unknown) => logger.warn({ event: 'rate_limit_store_failed', what, errorName: e instanceof Error ? e.name : 'error' })
  /** Sign-in keys with a try in flight in this instance (since when). */
  const inFlight = new Map<string, number>()
  /** Sign-in keys the database said must wait, until when (answered here without asking again). */
  const knownWait = new Map<string, number>()

  return {
    /** Counts one request of `subject` for `name` (in this instance first, then for every instance) and says whether it may go ahead. */
    async hit(name: LimitName, subject: string): Promise<HitAnswer> {
      const spec = LIMITS[name]
      if (!localOf(name).allow(subject)) return { allowed: false, reason: 'limit', retryAfterSec: spec.windowSec }
      try {
        const r = await store.hit(limitKey(name, subject), spec.limit, spec.windowSec)
        return r.allowed ? { allowed: true } : { allowed: false, reason: 'limit', retryAfterSec: Math.max(1, Math.ceil((r.resetAt - now()) / 1000)) }
      } catch (e) {
        failed(name, e)
        return spec.failClosed ? { allowed: false, reason: 'unavailable', retryAfterSec: 30 } : { allowed: true }
      }
    },

    /**
     * Review I-3: may this e-mail address (lower case) from this client IP (null = not known) try a password now? When it may, the try
     * is already counted as a failure; call `finish` with the sign-in service's answer (signInOutcomeOf). Never throws.
     */
    async signInGate(email: string, ip: string | null): Promise<SignInGate> {
      const key = limitKey('sign_in', `${ip ?? 'noip'}|${email}`)
      const ipKey = ip ? limitKey('sign_in_ip', ip) : null
      // The in-process first filter, decided before the first await (so simultaneous calls in this instance see each other).
      const t = now()
      const started = inFlight.get(key)
      if (started !== undefined && started > t - SIGN_IN_IN_FLIGHT_MS) return { allowed: false, reason: 'busy', waitSec: 1 }
      const until = knownWait.get(key)
      if (until !== undefined && until > t) return { allowed: false, reason: 'wait', waitSec: Math.max(1, Math.ceil((until - t) / 1000)) }
      if (knownWait.size > 10_000) knownWait.clear() // bounded: a cleared entry only means one more question to the database
      inFlight.set(key, t)
      let answer: Awaited<ReturnType<LimiterStore['signInGate']>>
      try {
        answer = await store.signInGate(key, ipKey, SIGN_IN_IP_LIMIT)
      } catch (e) {
        inFlight.delete(key)
        failed('sign_in', e)
        return { allowed: false, reason: 'unavailable', waitSec: SIGN_IN_UNAVAILABLE_WAIT_SEC }
      }
      if (!answer.allowed) {
        inFlight.delete(key)
        const waitSec = Math.max(1, answer.waitSec)
        if (answer.reason !== 'ip') knownWait.set(key, now() + waitSec * 1000)
        return { allowed: false, reason: answer.reason === 'ip' ? 'ip' : 'wait', waitSec }
      }
      let finished = false
      return {
        allowed: true,
        finish: async (outcome) => {
          if (finished) return
          finished = true
          inFlight.delete(key)
          if (outcome === 'refused') return // already counted by the gate
          try {
            await store.signInFinish(key, ipKey, outcome)
          } catch (e) {
            failed('sign_in', e)
          }
        },
      }
    },
  }
}

export type SharedLimiter = ReturnType<typeof createSharedLimiter>

type Row = { allowed: boolean; hits: number; reset_at: string }
type StateRow = { hits: number; last_hit_at: string | null }
type GateRow = { allowed: boolean; wait_sec: number; reason: string | null }

/** The database store: rate_limit_hit / _state / _clear and sign_in_gate / _finish through the web app's own role (app_web). */
export const databaseStore = (client: () => ReturnType<typeof createAdminClient> = createAdminClient): LimiterStore => ({
  async hit(key, limit, windowSec) {
    const { data, error } = await client().rpc('rate_limit_hit', { p_key: key, p_limit: limit, p_window_sec: windowSec })
    const r = (Array.isArray(data) ? data[0] : data) as Row | undefined
    if (error || !r) throw new Error(`the shared rate limit could not be read (${error?.code ?? 'no answer'})`)
    return { allowed: r.allowed === true, hits: Number(r.hits), resetAt: Date.parse(r.reset_at) }
  },
  async state(key, windowSec) {
    const { data, error } = await client().rpc('rate_limit_state', { p_key: key, p_window_sec: windowSec })
    const r = (Array.isArray(data) ? data[0] : data) as StateRow | undefined
    if (error || !r) throw new Error(`the shared rate limit could not be read (${error?.code ?? 'no answer'})`)
    return { hits: Number(r.hits), lastHitAt: r.last_hit_at ? Date.parse(r.last_hit_at) : null }
  },
  async clear(key) {
    const { error } = await client().rpc('rate_limit_clear', { p_key: key })
    if (error) throw new Error(`the shared rate limit could not be cleared (${error.code ?? 'error'})`)
  },
  async signInGate(key, ipKey, ipLimit) {
    const { data, error } = await client().rpc('sign_in_gate', { p_key: key, p_ip_key: ipKey ?? undefined, p_ip_limit: ipLimit })
    const r = (Array.isArray(data) ? data[0] : data) as GateRow | undefined
    if (error || !r) throw new Error(`the sign-in count could not be read (${error?.code ?? 'no answer'})`)
    return { allowed: r.allowed === true, waitSec: Number(r.wait_sec) || 0, reason: r.reason === 'ip' ? 'ip' : r.reason === 'wait' ? 'wait' : null }
  },
  async signInFinish(key, ipKey, outcome) {
    const { error } = await client().rpc('sign_in_finish', { p_key: key, p_ip_key: ipKey ?? undefined, p_outcome: outcome })
    if (error) throw new Error(`the sign-in count could not be updated (${error.code ?? 'error'})`)
  },
})

const holder = processSingleton('app.sharedLimiter', () => ({ limiter: null as SharedLimiter | null }))

/** The limiter of this process (one in-process filter for every route, action and reloaded module), on the database store. */
export const sharedLimiter = (): SharedLimiter => (holder.limiter ??= createSharedLimiter(databaseStore()))

/** Tests only: this process's limiter on another store (a fake with the database's semantics), or back to the database (null). */
export function useLimiterStoreForTest(store: LimiterStore | null, now?: () => number): void {
  holder.limiter = store ? createSharedLimiter(store, now) : null
}

/** The plain words for a refusal. */
export const limitMessage = (a: Exclude<HitAnswer, { allowed: true }>): string => (a.reason === 'unavailable' ? MSG_LIMITER_UNAVAILABLE : MSG_SLOW_DOWN)

/** For actions: null when `subject` may go ahead with `name`, else the plain words to show. Never throws. */
export async function refusalFor(name: LimitName, subject: string): Promise<string | null> {
  const a = await sharedLimiter().hit(name, subject)
  return a.allowed ? null : limitMessage(a)
}

/** For actions of administrators: their own count and the overall administration count, both. */
export async function adminRefusalFor(name: LimitName, actorId: string): Promise<string | null> {
  return (await refusalFor('admin_action', actorId)) ?? (await refusalFor(name, actorId))
}
