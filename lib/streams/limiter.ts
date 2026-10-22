/** Counts requests per key in a sliding window, in this process. Refused requests are not counted, so waiting always frees a slot. */
export function createWindowLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>()
  const MAX_KEYS = 10_000
  return {
    /** True (and counted) when the key is still under its limit. */
    allow(key: string): boolean {
      const t = now()
      if (hits.size > MAX_KEYS) {
        for (const [k, v] of hits) if (!v.some((x) => x > t - windowMs)) hits.delete(k)
        for (const k of hits.keys()) {
          if (hits.size <= MAX_KEYS) break
          hits.delete(k)
        }
      }
      const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs)
      const ok = recent.length < limit
      if (ok) recent.push(t)
      hits.set(key, recent)
      return ok
    },
  }
}
