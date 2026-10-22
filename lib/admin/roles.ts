// Roles are ADMINISTRATIVE AUTHORITY only (decision D-1, directive AC-1/AC-8): who may manage people, access and inventory.
// No role gives access to data by itself. What a person may see or do with cameras, recordings and IT assets comes only from
// explicit capability grants (access_grants; docs/drishti/access-model.md). "operator" was called "agent" before P2-1 (AC-15).
export const ROLES = ['user', 'operator', 'manager', 'admin', 'platform_owner'] as const
export type Role = (typeof ROLES)[number]

export const isAdminRole = (role: Role): boolean => role === 'admin' || role === 'platform_owner'

// A platform owner manages everyone; a plain admin manages viewers, operators and managers; nobody else manages anyone.
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'platform_owner') return true
  if (actorRole === 'admin') return targetRole === 'user' || targetRole === 'operator' || targetRole === 'manager'
  return false
}

// Interim, until P2-2 moves these actions to capabilities (it.monitoring.operate, camera-group management):
// operators and administrators may ask the worker to check everything now. Managers only read.
export const canRunChecks = (role: Role): boolean => role === 'operator' || isAdminRole(role)

// Interim, until P2-2: operators and administrators build camera groups. Which cameras they may put in a group is decided by their
// grants (row security), never by the role.
export const canManageGroups = (role: Role): boolean => role === 'operator' || isAdminRole(role)
