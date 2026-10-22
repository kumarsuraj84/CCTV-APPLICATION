// Roles are ADMINISTRATIVE AUTHORITY only (decision D-1, directive AC-1/AC-8): who may manage people, access and inventory, and who
// may edit camera groups. No role gives access to data by itself, and no role alone allows an operation: what a person may see or do
// with cameras, recordings and IT assets comes only from explicit capability grants (access_grants; docs/drishti/access-model.md).
// The admin pages and actions need an administrative role AND their admin.* capability (lib/auth/profile.ts requireAdministration).
// "operator" was called "agent" before P2-1 (AC-15).
export const ROLES = ['user', 'operator', 'manager', 'admin', 'platform_owner'] as const
export type Role = (typeof ROLES)[number]

/**
 * What people read for each role (P2-3; owner ruling P-1: platform_owner is shown as "Super administrator", the stored value stays).
 * Roles say what a person may administer, never what they may see.
 */
export const ROLE_LABELS: Record<Role, string> = {
  user: 'Viewer',
  operator: 'Operator',
  manager: 'Manager',
  admin: 'Administrator',
  platform_owner: 'Super administrator',
}
export const ROLE_HELP: Record<Role, string> = {
  user: 'Administers nothing.',
  operator: 'May also edit camera groups (with live view of the cameras).',
  manager: 'Administers nothing; a title for the person’s position.',
  admin: 'May manage viewers, operators and managers and give them rights the administrator holds.',
  platform_owner: 'Holds every right for the whole organisation and manages everyone, other super administrators included.',
}
export const MSG_ROLES_GIVE_NO_ACCESS =
  'A role says what a person may administer. It gives no access to cameras, recordings, IT or Wi-Fi: that comes only from the access you assign (except a super administrator, who holds every right).'

export const isAdminRole =(role: Role): boolean => role === 'admin' || role === 'platform_owner'

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
