export type Role = 'user' | 'agent' | 'manager' | 'admin' | 'platform_owner'

export type NavItem = {
  href: string
  label: string
  icon: 'home' | 'store' | 'server' | 'users' | 'upload' | 'building'
  group: 'Monitoring' | 'Admin'
  roles?: Role[]
}

const ADMIN: Role[] = ['admin', 'platform_owner']

// One list for the sidebar and the mobile bar. Hiding a link is not a security control: every page and action checks the role again.
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home', group: 'Monitoring' },
  { href: '/stores', label: 'Stores', icon: 'store', group: 'Monitoring' },
  { href: '/devices', label: 'Devices', icon: 'server', group: 'Monitoring' },
  { href: '/admin/users', label: 'Users', icon: 'users', group: 'Admin', roles: ADMIN },
  { href: '/admin/stores', label: 'Manage stores', icon: 'building', group: 'Admin', roles: ADMIN },
  { href: '/admin/devices', label: 'Manage devices', icon: 'server', group: 'Admin', roles: ADMIN },
  { href: '/admin/import', label: 'Import', icon: 'upload', group: 'Admin', roles: ADMIN },
]

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => !item.roles || item.roles.includes(role))
}
