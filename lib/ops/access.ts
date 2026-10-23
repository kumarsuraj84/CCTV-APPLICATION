import { mfaGateOf, type CurrentProfile } from '@/lib/auth/profile'

// P5.4: the detailed health (the Health page, /api/health/detail) is for super administrators (role platform_owner, shown as "Super
// administrator"; ruling P-1) who have finished signing in: their two-step code where they have an app or one is required, and a
// password of their own. Everybody else is treated as if the address did not exist.

export const isSuperAdministrator = (p: Pick<CurrentProfile, 'role'>): boolean => p.role === 'platform_owner'

export function mayReadDetailedHealth(p: CurrentProfile | null): boolean {
  if (!p || !p.is_active || p.must_reset_password || !isSuperAdministrator(p)) return false
  return mfaGateOf(p) === 'ok'
}
