import { isAdminRole, type Role } from '@/lib/admin/roles'
import {
  CCTV_CAPABILITIES, coversSomeWholeLocation, holdsAny, holdsAnyLocationGrant, holdsOrgWide, IT_VIEW, type AdminCapability, type Capabilities, type Capability,
} from '@/lib/auth/capabilities'

export type { Role }

/**
 * What a link needs (P2-2). Plain data, because the items go to client components:
 *   anyOf: at least one of these capabilities, at any scope
 *   anyLocationGrant: any CCTV, IT or Wi-Fi grant (what shows locations)
 *   admin: an administrative role AND this admin.* capability for the whole organisation
 *   superAdmin: the super administrator role AND some admin.* capability for the whole organisation (P5.4: the Health page)
 */
export type NavNeed = { anyOf?: Capability[]; anyLocationGrant?: true; admin?: AdminCapability; superAdmin?: true }

const ADMIN_CAPABILITIES: AdminCapability[] = ['admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read']

export type NavItem = {
  href: string
  label: string
  icon: 'home' | 'location' | 'server' | 'users' | 'upload' | 'building' | 'activity' | 'grid' | 'video' | 'history' | 'network' | 'boxes'
  group: 'Monitoring' | 'Admin'
  needs?: NavNeed
  mobile?: true
}

export type NavViewer = { role: Role; capabilities: Capabilities }

// One list for the sidebar and the mobile bar. Hiding a link is not a security control: every page and action checks again.
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home', group: 'Monitoring', mobile: true },
  { href: '/locations', label: 'Locations', icon: 'location', group: 'Monitoring', needs: { anyLocationGrant: true }, mobile: true },
  { href: '/devices', label: 'Devices', icon: 'server', group: 'Monitoring', needs: { anyOf: [...IT_VIEW] }, mobile: true },
  { href: '/live', label: 'Live', icon: 'video', group: 'Monitoring', needs: { anyOf: ['cctv.live'] }, mobile: true },
  { href: '/playback', label: 'Playback', icon: 'history', group: 'Monitoring', needs: { anyOf: ['cctv.playback'] } },
  { href: '/groups', label: 'Groups', icon: 'grid', group: 'Monitoring', needs: { anyOf: [...CCTV_CAPABILITIES] } },
  // P2-5c-2: access points, routers and switches with their documented capabilities (wifi.inventory.view, at the places granted).
  { href: '/locations/wifi', label: 'Wi-Fi inventory', icon: 'network', group: 'Monitoring', needs: { anyOf: ['wifi.inventory.view'] } },
  { href: '/admin/users', label: 'Users', icon: 'users', group: 'Admin', needs: { admin: 'admin.users' } },
  // P2-3 review: the review of migrated grants (the editor itself is opened from Users). No count here: the items are static data.
  { href: '/admin/access-review', label: 'Access review', icon: 'users', group: 'Admin', needs: { admin: 'admin.access' } },
  { href: '/admin/monitoring', label: 'Monitoring', icon: 'activity', group: 'Admin', needs: { admin: 'admin.inventory' } },
  // P5.4: the installation's health (database, Vault, gateway, worker, migrations, disk, clean-up) for super administrators.
  { href: '/admin/health', label: 'Health', icon: 'activity', group: 'Admin', needs: { superAdmin: true } },
  // P2-5c-1: the hierarchy, NVRs, mapping editor and reconciliation; the asset inventory. T-1: the old "Manage stores" page is gone;
  // /admin/stores redirects to /admin/locations.
  { href: '/admin/locations', label: 'Locations and NVRs', icon: 'building', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/regions', label: 'Regions and clusters', icon: 'network', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/assets', label: 'Assets', icon: 'boxes', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/devices', label: 'Manage devices', icon: 'server', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/import', label: 'Import', icon: 'upload', group: 'Admin', needs: { admin: 'admin.inventory' } },
  // P5.4 brief item 5: the audit log (admin_audit_log and sign-in events) with filters and search.
  { href: '/admin/audit', label: 'Audit log', icon: 'history', group: 'Admin', needs: { admin: 'admin.audit.read' } },
]

/** Whether a viewer meets a need. Exported for pages that show the same links in their own place. */
export function meets(v: NavViewer, need: NavNeed | undefined): boolean {
  if (!need) return true
  if (need.anyOf && !holdsAny(v.capabilities, need.anyOf)) return false
  if (need.anyLocationGrant && !holdsAnyLocationGrant(v.capabilities)) return false
  if (need.admin && !(isAdminRole(v.role) && holdsOrgWide(v.capabilities, need.admin))) return false
  if (need.superAdmin && !(v.role === 'platform_owner' && ADMIN_CAPABILITIES.some((c) => holdsOrgWide(v.capabilities, c)))) return false
  return true
}

export function navFor(v: NavViewer): NavItem[] {
  return NAV.filter((item) => meets(v, item.needs))
}

export function mobileNavFor(v: NavViewer): NavItem[] {
  return navFor(v).filter((i) => i.mobile)
}

/**
 * What the home page shows (P2-2): a CCTV section (any CCTV capability: camera availability only), an IT section (the IT view:
 * devices, NVRs), "Check now" with it.monitoring.operate, and the "Nothing is assigned" state when there is nothing to monitor.
 * `adminPages`: the person can use at least one admin page (pointed to from the empty state).
 */
export type HomeSections = { state: 'ok' | 'nothing' | 'unreadable'; cctv: boolean; it: boolean; checkNow: boolean; adminPages: boolean }

export function homeSections(v: NavViewer): HomeSections {
  const c = v.capabilities
  const cctv = holdsAny(c, CCTV_CAPABILITIES)
  const it = holdsAny(c, IT_VIEW)
  const adminPages = NAV.some((i) => i.group === 'Admin' && meets(v, i.needs))
  const state = c.failed ? 'unreadable' : cctv || it ? 'ok' : 'nothing'
  return { state, cctv, it, checkNow: coversSomeWholeLocation(c, 'it.monitoring.operate'), adminPages }
}
