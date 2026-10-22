import { headers } from 'next/headers'
import { processSingleton } from '@/lib/process-singleton'

type Entry = { count: number; resetAt: number }
// One table for the whole process (P2-2 fix M-8): actions, route handlers and reloaded modules all count in the same place.
const store = processSingleton('app.rateLimitStore', () => new Map<string, Entry>())

const MAX_KEYS = 50_000
let lastCleanup = 0
function cleanup() {
  const now = Date.now()
  // At most once a second, and the table can never grow without limit.
  if (now - lastCleanup < 1000 && store.size <= MAX_KEYS) return
  lastCleanup = now
  for (const [k, v] of store) if (v.resetAt < now) store.delete(k)
  for (const k of store.keys()) {
    if (store.size <= MAX_KEYS) break
    store.delete(k)
  }
}

const clip = (key: string) => (key.length > 200 ? key.slice(0, 200) : key)

/** Simple in-process rate limiter (one counter per key and window). Use a shared store if the app ever runs as several copies. */
export async function rateLimit(key: string, limit = 5, windowMs = 60_000): Promise<{ limited: boolean; remaining: number }> {
  cleanup()
  key = clip(key)
  const now = Date.now()
  const entry = store.get(key)
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { limited: false, remaining: limit - 1 }
  }
  entry.count++
  if (entry.count > limit) return { limited: true, remaining: 0 }
  return { limited: false, remaining: limit - entry.count }
}

/** Is this key already over its limit? Does not count the call (used before a sign-in attempt; only failed attempts are counted). */
export function isOverLimit(key: string, limit: number): boolean {
  const entry = store.get(clip(key))
  return !!entry && entry.resetAt >= Date.now() && entry.count >= limit
}

/** Count one event on a key (a failed sign-in) and return how many there have been in the window. */
export function recordEvent(key: string, windowMs: number): number {
  cleanup()
  key = clip(key)
  const now = Date.now()
  const entry = store.get(key)
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return 1
  }
  entry.count++
  return entry.count
}

/**
 * The caller's address, or null when it cannot be known reliably. A client can send any X-Forwarded-For it likes, so it is only
 * believed when the number of reverse proxies in front of the app is configured (TRUSTED_PROXY_HOPS=1 for one proxy).
 */
export async function getClientIp(): Promise<string | null> {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0)
  if (!Number.isInteger(hops) || hops < 1) return null
  const parts = ((await headers()).get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length >= hops ? parts[parts.length - hops] : null
}
