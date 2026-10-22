// Roles are ADMINISTRATIVE AUTHORITY only (decision D-1, directive AC-1/AC-8): who may manage people, access and inventory, and who
// may edit camera groups. No role gives access to data by itself, and no role alone allows an operation: what a person may see or do
// with cameras, recordings and IT assets comes only from explicit capability grants (access_grants; docs/drishti/access-model.md).
// The admin pages and actions need an administrative role AND their admin.* capability (lib/auth/profile.ts requireAdministration).
// "operator" was called "agent" before P2-1 (AC-15).
export const ROLES = ['user', 'operator', 'manager', 'admin', 'platform_owner'] as const
export type Role = (typeof ROLES)[number]

export const isAdminRole = (role: Role): boolean => role === 'admin' || role === 'platform_owner'

// A platform owner manages everyone; a plain admin manages viewers, operators and managers; nobody else manages anyone.
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'platform_owner') return true
  if (actorRole === 'admin') return targetRole === 'user' || targetRole === 'operator' || targetRole === 'manager'
  return false
}

// Who may make and change camera groups (P2-2 brief: operator, admin or platform_owner). This is authority only: which cameras go into
// a group needs cctv.live for each camera (checked by the database, lib/groups/service.ts), and reading a group needs a CCTV capability.
export const hasGroupEditingAuthority = (role: Role): boolean => role === 'operator' || isAdminRole(role)
export const MSG_GROUPS_DENIED = 'Changing camera groups needs live view of cameras and the operator or administrator role.'
