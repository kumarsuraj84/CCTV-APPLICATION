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
// address AND client IP; from the third failure in 15 minutes the next try must wait 5 s, then 10, 20, ... up to 5 minutes, and a
// successful sign-in clears the count. The client IP is known only behind a configured number of trusted reverse proxies
// (TRUSTED_PROXY_HOPS, lib/rate-limit.ts getClientIp); without it every client shares "noip" and the delays then apply per e-mail address.

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

const SIGN_IN_WINDOW_SEC = 900
/** When the database cannot be asked, a sign-in waits this long (fail closed, but never a lockout). */
const SIGN_IN_UNAVAILABLE_WAIT_SEC = 30

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
}
export type HitAnswer = { allowed: true } | { allowed: false; reason: 'limit' | 'unavailable'; retryAfterSec: number }

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

    /** Seconds this e-mail address + IP must still wait before trying to sign in (0 = may try now). */
    async signInWait(subject: string): Promise<number> {
      try {
        const s = await store.state(limitKey('sign_in_failures', subject), SIGN_IN_WINDOW_SEC)
        const delay = signInDelaySec(s.hits)
        if (delay === 0 || s.lastHitAt === null) return 0
        return Math.max(0, Math.ceil((s.lastHitAt + delay * 1000 - now()) / 1000))
      } catch (e) {
        failed('sign_in', e)
        return SIGN_IN_UNAVAILABLE_WAIT_SEC
      }
    },
    /** Notes a failed sign-in of this e-mail address + IP. Never throws. */
    async signInFailed(subject: string): Promise<void> {
      try {
        await store.hit(limitKey('sign_in_failures', subject), 100_000, SIGN_IN_WINDOW_SEC)
      } catch (e) {
        failed('sign_in', e)
      }
    },
    /** A successful sign-in forgets the failures. Never throws. */
    async signInSucceeded(subject: string): Promise<void> {
      try {
        await store.clear(limitKey('sign_in_failures', subject))
      } catch (e) {
        failed('sign_in', e)
      }
    },
  }
}

export type SharedLimiter = ReturnType<typeof createSharedLimiter>

type Row = { allowed: boolean; hits: number; reset_at: string }
type StateRow = { hits: number; last_hit_at: string | null }

/** The database store: rate_limit_hit / rate_limit_state / rate_limit_clear through the web app's own role (app_web). */
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
