import { SIGN_IN_WINDOW_SEC, signInDelaySec, useLimiterStoreForTest, type LimiterStore } from '@/lib/rate-limit-shared'

// P2-6 (D-11): the shared rate limiter keeps its counts in the database. Unit tests give it this in-memory store with the database's
// semantics, so they never reach the database:
//   rate_limit_hit: fixed windows per key, every hit counted;
//   sign_in_gate (review round 1, I-3): ONE atomic step per attempt — the e-mail address + IP row is read, refused while the rising delay
//     of its failures since the last attempt has not passed, otherwise the attempt is counted as a failure and stamped (a success clears
//     it, a "busy" answer of the sign-in service gives it back); a known client IP has its own ceiling of attempts per window.
// The methods do all their work before their first await, which in JavaScript makes each of them atomic like the database function.

export function memoryLimiterStore(now: () => number = Date.now): LimiterStore {
  const rows = new Map<string, { hits: number; last: number }>()
  const attempts = new Map<string, { failures: number; windowStart: number; last: number | null }>()
  const windowMs = SIGN_IN_WINDOW_SEC * 1000
  const k = (key: string, w: number) => `${key}|${w}|${Math.floor(now() / 1000 / w)}`
  return {
    async hit(key, limit, windowSec) {
      const r = rows.get(k(key, windowSec)) ?? { hits: 0, last: 0 }
      r.hits++
      r.last = now()
      rows.set(k(key, windowSec), r)
      return { allowed: r.hits <= limit, hits: r.hits, resetAt: (Math.floor(now() / 1000 / windowSec) + 1) * windowSec * 1000 }
    },
    async state(key, windowSec) {
      const r = rows.get(k(key, windowSec))
      return { hits: r?.hits ?? 0, lastHitAt: r ? r.last : null }
    },
    async clear(key) {
      for (const name of [...rows.keys()]) if (name.startsWith(`${key}|`)) rows.delete(name)
    },
    async signInGate(key, ipKey, ipLimit) {
      const t = now()
      let r = attempts.get(key)
      if (!r || (r.last !== null && r.last < t - windowMs)) r = { failures: 0, windowStart: t, last: null }
      attempts.set(key, r)
      const wait = r.last === null ? 0 : Math.max(0, Math.ceil((r.last + signInDelaySec(r.failures) * 1000 - t) / 1000))
      if (wait > 0) return { allowed: false, waitSec: wait, reason: 'wait' }
      if (ipKey) {
        let ip = attempts.get(ipKey)
        if (!ip || ip.windowStart < t - windowMs) ip = { failures: 0, windowStart: t, last: null }
        attempts.set(ipKey, ip)
        if (ip.failures >= ipLimit) return { allowed: false, waitSec: Math.max(1, Math.ceil((ip.windowStart + windowMs - t) / 1000)), reason: 'ip' }
        ip.failures++
        ip.last = t
      }
      r.failures++
      r.last = t
      return { allowed: true, waitSec: 0, reason: null }
    },
    async signInFinish(key, ipKey, outcome) {
      if (outcome === 'succeeded') {
        attempts.delete(key)
        return
      }
      for (const name of [key, ipKey]) {
        const r = name ? attempts.get(name) : undefined
        if (r) r.failures = Math.max(0, r.failures - 1)
      }
    },
  }
}

/** This process's shared limiter on a fresh in-memory store (call in beforeEach). */
export function useMemoryLimiter(now: () => number = Date.now): void {
  useLimiterStoreForTest(memoryLimiterStore(now), now)
}
