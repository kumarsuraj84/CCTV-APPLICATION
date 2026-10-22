import { logger } from '@/lib/observability/logger'
import { databaseStore, limitKey, MSG_LIMITER_UNAVAILABLE, type LimiterStore } from '@/lib/rate-limit-shared'
import { createWindowLimiter } from '@/lib/streams/limiter'
import { processSingleton } from '@/lib/process-singleton'

// P3-1 brief item 5: the multi-factor and "Confirm it's you" steps use the shared database-backed limiter of P2-6 (its store
// rate_limit_hit and its hashed keys, lib/rate-limit-shared.ts) with an in-process first filter, counted per person. Kept in this file
// so the shared limiter's own list stays untouched. All fail closed: when the count cannot be read the step is refused.
//   mfa_verify  6 codes per person in 5 minutes (a 6-digit code: 6 tries in 5 minutes make guessing hopeless)
//   mfa_enrol   10 new authenticator set-ups per person an hour
//   reauth      6 password confirmations per person in 15 minutes

export type AuthLimitName = 'mfa_verify' | 'mfa_enrol' | 'reauth'
export const AUTH_LIMITS: Record<AuthLimitName, { limit: number; windowSec: number }> = {
  mfa_verify: { limit: 6, windowSec: 300 },
  mfa_enrol: { limit: 10, windowSec: 3600 },
  reauth: { limit: 6, windowSec: 900 },
}
export const MSG_TOO_MANY_CODES = 'Too many tries. Wait a few minutes and try again.'

const holder = processSingleton('auth.limits', () => ({
  store: null as LimiterStore | null,
  local: new Map<AuthLimitName, ReturnType<typeof createWindowLimiter>>(),
}))

/** Tests only: another store (null = the database). */
export function useAuthLimitStoreForTest(store: LimiterStore | null): void {
  holder.store = store
  holder.local.clear()
}

/** Null when `subject` may go ahead with `name` (and counts it), else the plain words to show. Never throws. */
export async function authRefusal(name: AuthLimitName, subject: string): Promise<string | null> {
  const spec = AUTH_LIMITS[name]
  let local = holder.local.get(name)
  if (!local) holder.local.set(name, (local = createWindowLimiter(spec.limit, spec.windowSec * 1000)))
  if (!local.allow(subject)) return MSG_TOO_MANY_CODES
  try {
    const r = await (holder.store ?? databaseStore()).hit(limitKey(name, subject), spec.limit, spec.windowSec)
    return r.allowed ? null : MSG_TOO_MANY_CODES
  } catch (e) {
    logger.warn({ event: 'rate_limit_store_failed', what: name, errorName: e instanceof Error ? e.name : 'error' })
    return MSG_LIMITER_UNAVAILABLE
  }
}
