import { redirect } from 'next/navigation'
import type { AdminCapability } from '@/lib/auth/capabilities'
import { getCurrentProfile, requireAdministration, type CurrentProfile } from '@/lib/auth/profile'
import { freshAuthRefusal } from '@/lib/auth/session-policy'

// P3-1 review I-3: the ONE fresh-sign-in mechanism. Every Server Action and route handler either goes through one of these guards or is
// on the explicit, reasoned allow-list of tests/unit/fresh-auth-guard.test.ts, which fails for any new, unclassified one. The guard
// first checks the caller as before (redirects for a signed-out person, the code step, a missing administrative right), then the
// fresh sign-in (a sign-in or code within FRESH_AUTH_MINUTES, from the verified token; lib/auth/session-policy.ts) and gives back the
// plain words to show when it is too old. Callers return `{ ok: false, error }` / `{ error }` in their own result shape.

export type Fresh<P> = { ok: true; profile: P } | { ok: false; error: string }

/** Administrative role AND the admin capability for the whole organisation (requireAdministration), then a fresh sign-in. */
export async function requireFreshAdministration(cap: AdminCapability): Promise<Fresh<CurrentProfile>> {
  const profile = await requireAdministration(cap)
  const stale = freshAuthRefusal(profile)
  return stale ? { ok: false, error: stale } : { ok: true, profile }
}

/**
 * A signed-in, active person (not the full page gate: two-step set-up and the password change are themselves steps of signing in),
 * then a fresh sign-in. `unless`: no fresh sign-in is asked when it holds (the forced first password change right after signing in).
 */
export async function requireFreshProfile(o: { unless?: (p: CurrentProfile) => boolean } = {}): Promise<Fresh<CurrentProfile>> {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  if (o.unless?.(profile)) return { ok: true, profile }
  const stale = freshAuthRefusal(profile)
  return stale ? { ok: false, error: stale } : { ok: true, profile }
}

/** For a route handler that already holds the profile: null when fresh, else the words to show. */
export const requireFreshFor = (profile: Pick<CurrentProfile, 'session'>): string | null => freshAuthRefusal(profile)
