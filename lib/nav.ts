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
 */
export type NavNeed = { anyOf?: Capability[]; anyLocationGrant?: true; admin?: AdminCapability }

export type NavItem = {
  href: string
  label: string
  icon: 'home' | 'store' | 'server' | 'users' | 'upload' | 'building' | 'activity' | 'grid' | 'video' | 'history'
  group: 'Monitoring' | 'Admin'
  needs?: NavNeed
  mobile?: true
}

export type NavViewer = { role: Role; capabilities: Capabilities }

// One list for the sidebar and the mobile bar. Hiding a link is not a security control: every page and action checks again.
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home', group: 'Monitoring', mobile: true },
  { href: '/stores', label: 'Stores', icon: 'store', group: 'Monitoring', needs: { anyLocationGrant: true }, mobile: true },
  { href: '/devices', label: 'Devices', icon: 'server', group: 'Monitoring', needs: { anyOf: [...IT_VIEW] }, mobile: true },
  { href: '/live', label: 'Live', icon: 'video', group: 'Monitoring', needs: { anyOf: ['cctv.live'] }, mobile: true },
  { href: '/playback', label: 'Playback', icon: 'history', group: 'Monitoring', needs: { anyOf: ['cctv.playback'] } },
  { href: '/groups', label: 'Groups', icon: 'grid', group: 'Monitoring', needs: { anyOf: [...CCTV_CAPABILITIES] } },
  { href: '/admin/users', label: 'Users', icon: 'users', group: 'Admin', needs: { admin: 'admin.users' } },
  // P2-3 review: the review of migrated grants (the editor itself is opened from Users). No count here: the items are static data.
  { href: '/admin/access-review', label: 'Access review', icon: 'users', group: 'Admin', needs: { admin: 'admin.access' } },
  { href: '/admin/monitoring', label: 'Monitoring', icon: 'activity', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/stores', label: 'Manage stores', icon: 'building', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/devices', label: 'Manage devices', icon: 'server', group: 'Admin', needs: { admin: 'admin.inventory' } },
  { href: '/admin/import', label: 'Import', icon: 'upload', group: 'Admin', needs: { admin: 'admin.inventory' } },
]

/** Whether a viewer meets a need. Exported for pages that show the same links in their own place. */
export function meets(v: NavViewer, need: NavNeed | undefined): boolean {
  if (!need) return true
  if (need.anyOf && !holdsAny(v.capabilities, need.anyOf)) return false
  if (need.anyLocationGrant && !holdsAnyLocationGrant(v.capabilities)) return false
  if (need.admin && !(isAdminRole(v.role) && holdsOrgWide(v.capabilities, need.admin))) return false
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
