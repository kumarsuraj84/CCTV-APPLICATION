import { useLimiterStoreForTest, type LimiterStore } from '@/lib/rate-limit-shared'

// P2-6 (D-11): the shared rate limiter keeps its counts in the database. Unit tests give it this in-memory store with the database's
// semantics (rate_limit_hit: fixed windows per key, every hit counted), so they never reach the database.

export function memoryLimiterStore(now: () => number = Date.now): LimiterStore {
  const rows = new Map<string, { hits: number; last: number }>()
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
  }
}

/** This process's shared limiter on a fresh in-memory store (call in beforeEach). */
export function useMemoryLimiter(now: () => number = Date.now): void {
  useLimiterStoreForTest(memoryLimiterStore(now), now)
}
