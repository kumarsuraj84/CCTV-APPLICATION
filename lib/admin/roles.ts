export const ROLES = ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const
export type Role = (typeof ROLES)[number]

// A platform owner manages everyone; a plain admin manages viewers, operators and managers; nobody else manages anyone.
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'platform_owner') return true
  if (actorRole === 'admin') return targetRole === 'user' || targetRole === 'agent' || targetRole === 'manager'
  return false
}

// Roles that already see every store, camera and device, so an access list means nothing for them.
export const SEES_EVERYTHING: readonly Role[] = ['manager', 'admin', 'platform_owner']
