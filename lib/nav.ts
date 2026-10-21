import { isAdminRole, ROLES, type Role } from '@/lib/admin/roles'

export type { Role }

export type NavItem = {
  href: string
  label: string
  icon: 'home' | 'store' | 'server' | 'users' | 'upload' | 'building'
  group: 'Monitoring' | 'Admin'
  roles?: Role[]
  mobile?: true
}

const ADMIN: Role[] = ROLES.filter(isAdminRole)

// One list for the sidebar and the mobile bar. Hiding a link is not a security control: every page and action checks the role again.
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home', group: 'Monitoring', mobile: true },
  { href: '/stores', label: 'Stores', icon: 'store', group: 'Monitoring', mobile: true },
  { href: '/devices', label: 'Devices', icon: 'server', group: 'Monitoring', mobile: true },
  { href: '/admin/users', label: 'Users', icon: 'users', group: 'Admin', roles: ADMIN },
  { href: '/admin/stores', label: 'Manage stores', icon: 'building', group: 'Admin', roles: ADMIN },
  { href: '/admin/devices', label: 'Manage devices', icon: 'server', group: 'Admin', roles: ADMIN },
  { href: '/admin/import', label: 'Import', icon: 'upload', group: 'Admin', roles: ADMIN },
]

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => !item.roles || item.roles.includes(role))
}

export function mobileNavFor(role: Role): NavItem[] {
  return navFor(role).filter((i) => i.mobile)
}
