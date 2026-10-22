import { describe, expect, it } from 'vitest'
import { ROLES, type Role } from '@/lib/admin/roles'
import { ICONS } from '@/components/layout/icons'
import { type Capabilities, type Capability, type ScopeSummary } from '@/lib/auth/capabilities'
import { homeSections, mobileNavFor, NAV, navFor } from '@/lib/nav'

// P2-2 (directive AC-1/AC-8, brief item 6): navigation follows capabilities, not roles. Roles only add the administrative authority that
// the admin pages need on top of their admin.* capability. Hiding a link is not a security control: every page and action checks again.

const ORG: ScopeSummary = { organization: true, locations: [], cameras: [], assets: [] }
const AT_ONE: ScopeSummary = { organization: false, locations: ['00000000-0000-4000-8000-000000000001'], cameras: [], assets: [] }
const caps = (list: Capability[], scope: ScopeSummary = AT_ONE): Capabilities => ({ failed: false, grants: Object.fromEntries(list.map((c) => [c, scope])) })
const NONE = caps([])
const hrefs = (role: Role, c: Capabilities) => navFor({ role, capabilities: c }).map((i) => i.href)

describe('navigation by capability', () => {
  it('a person with nothing assigned sees only Home, whatever their role', () => {
    for (const role of ROLES) expect(hrefs(role, NONE), role).toEqual(['/home'])
  })

  it('cctv.live shows Live, Stores and Groups; not Playback or Devices', () => {
    expect(hrefs('user', caps(['cctv.live']))).toEqual(['/home', '/stores', '/live', '/groups'])
  })

  it('cctv.playback shows Playback, Stores and Groups; not Live', () => {
    expect(hrefs('user', caps(['cctv.playback']))).toEqual(['/home', '/stores', '/playback', '/groups'])
  })

  it('cctv.export alone shows Stores and Groups (it is a CCTV capability) but neither Live nor Playback', () => {
    expect(hrefs('user', caps(['cctv.export']))).toEqual(['/home', '/stores', '/groups'])
  })

  it('the IT view shows Devices and Stores, never the CCTV pages', () => {
    expect(hrefs('user', caps(['it.inventory.view']))).toEqual(['/home', '/stores', '/devices'])
    expect(hrefs('user', caps(['it.monitoring.view']))).toEqual(['/home', '/stores', '/devices'])
    expect(hrefs('operator', caps(['it.monitoring.operate']))).toEqual(['/home', '/stores'])
  })

  // P2-5c-2 brief item 4 replaces "a Wi-Fi grant shows Stores only": wifi.inventory.view now has its screen, the Wi-Fi inventory.
  it('a Wi-Fi grant shows Stores and the Wi-Fi inventory; no other capability shows the Wi-Fi inventory', () => {
    expect(hrefs('user', caps(['wifi.inventory.view']))).toEqual(['/home', '/stores', '/locations/wifi'])
    expect(NAV.find((i) => i.href === '/locations/wifi')?.label).toBe('Wi-Fi inventory')
    expect(hrefs('user', caps(['wifi.config.view_redacted']))).toEqual(['/home', '/stores'])
    expect(hrefs('admin', caps(['it.inventory.view', 'admin.inventory'], ORG))).not.toContain('/locations/wifi')
  })

  it('administrative capabilities show admin pages only together with an administrative role, and never data pages', () => {
    const adminSet = caps(['admin.users', 'admin.access', 'admin.inventory'], ORG)
    expect(hrefs('admin', adminSet)).toEqual(['/home', '/admin/users', '/admin/access-review', '/admin/monitoring', '/admin/locations', '/admin/regions', '/admin/assets', '/admin/stores', '/admin/devices', '/admin/import'])
    expect(hrefs('platform_owner', adminSet)).toEqual(hrefs('admin', adminSet))
    for (const role of ['user', 'operator', 'manager'] as const) expect(hrefs(role, adminSet), role).toEqual(['/home'])
  })

  it('each admin page needs its own capability, organisation-wide', () => {
    expect(hrefs('admin', caps(['admin.users'], ORG))).toEqual(['/home', '/admin/users'])
    expect(hrefs('admin', caps(['admin.inventory'], ORG))).toEqual(['/home', '/admin/monitoring', '/admin/locations', '/admin/regions', '/admin/assets', '/admin/stores', '/admin/devices', '/admin/import'])
    // P2-3 review: "Access review" for admin.access (the editor itself is reached from Users).
    expect(hrefs('admin', caps(['admin.access'], ORG))).toEqual(['/home', '/admin/access-review'])
    expect(NAV.find((i) => i.href === '/admin/access-review')?.label).toBe('Access review')
    // P2-5c-1: the administration screens for the hierarchy, NVRs and assets (ruling T-1: "Location", never "Store", in new screens).
    expect(['/admin/locations', '/admin/regions', '/admin/assets'].map((h) => NAV.find((i) => i.href === h)?.label)).toEqual(['Locations and NVRs', 'Regions and clusters', 'Assets'])
    // An administrator role with no admin.* capability sees no admin page (P2-2 rule: role AND capability).
    expect(hrefs('admin', caps(['cctv.live'], ORG))).toEqual(['/home', '/stores', '/live', '/groups'])
  })

  it('the old role rules are gone: a manager or admin role alone opens nothing', () => {
    expect(hrefs('manager', NONE)).toEqual(['/home'])
    expect(hrefs('admin', NONE)).toEqual(['/home'])
  })

  it('a summary that could not be read shows Home only', () => {
    expect(hrefs('admin', { failed: true, grants: {} })).toEqual(['/home'])
  })

  it('every item has an icon that exists, and items carry only data (they go to a client component)', () => {
    for (const item of NAV) {
      expect(ICONS[item.icon]).toBeDefined()
      expect(JSON.parse(JSON.stringify(item))).toEqual(item)
    }
  })

  it('Live and Playback keep their own icons; Playback is not on the small mobile bar', () => {
    expect(NAV.find((i) => i.href === '/live')?.icon).toBe('video')
    expect(NAV.find((i) => i.href === '/playback')?.icon).toBe('history')
    expect(NAV.find((i) => i.href === '/playback')?.mobile).toBeUndefined()
  })
})

// P2-2 brief items 4 and 6: the home page has a CCTV section and an IT section, each only with its capability, and a clear state
// when nothing is assigned.
describe('home sections', () => {
  it('nothing assigned (any role): the "Nothing is assigned" state, no sections, no Check now', () => {
    for (const role of ROLES) {
      expect(homeSections({ role, capabilities: NONE }), role).toEqual({ state: 'nothing', cctv: false, it: false, checkNow: false, adminPages: false })
    }
  })
  it('an unreadable summary says so, instead of "nothing assigned"', () => {
    expect(homeSections({ role: 'admin', capabilities: { failed: true, grants: {} } }).state).toBe('unreadable')
  })
  it('CCTV only: the camera section, never the IT one', () => {
    for (const cap of ['cctv.live', 'cctv.playback', 'cctv.export'] as const) {
      expect(homeSections({ role: 'user', capabilities: caps([cap]) })).toEqual({ state: 'ok', cctv: true, it: false, checkNow: false, adminPages: false })
    }
  })
  it('IT view only: the IT section; it.monitoring.operate adds Check now', () => {
    expect(homeSections({ role: 'user', capabilities: caps(['it.inventory.view']) })).toEqual({ state: 'ok', cctv: false, it: true, checkNow: false, adminPages: false })
    expect(homeSections({ role: 'user', capabilities: caps(['it.monitoring.view', 'it.monitoring.operate']) })).toMatchObject({ it: true, checkNow: true })
    // Operate without a view: the button, and the state says nothing to show beyond it.
    expect(homeSections({ role: 'operator', capabilities: caps(['it.monitoring.operate']) })).toEqual({ state: 'nothing', cctv: false, it: false, checkNow: true, adminPages: false })
  })
  // P2-2 fix M-5: the button follows the service rule (organisation or a whole location), so an asset-only grant shows no dead button.
  it('Check now is not offered for an asset-only it.monitoring.operate grant', () => {
    const assetOnly: Capabilities = { failed: false, grants: { 'it.monitoring.operate': { organization: false, locations: [], cameras: [], assets: ['a1'] }, 'it.monitoring.view': AT_ONE } }
    expect(homeSections({ role: 'operator', capabilities: assetOnly }).checkNow).toBe(false)
    expect(homeSections({ role: 'operator', capabilities: caps(['it.monitoring.operate'], ORG) }).checkNow).toBe(true)
  })

  it('administrative capabilities alone: nothing to monitor, but the admin pages are pointed to', () => {
    expect(homeSections({ role: 'admin', capabilities: caps(['admin.users'], ORG) })).toEqual({ state: 'nothing', cctv: false, it: false, checkNow: false, adminPages: true })
  })
})

describe('mobile navigation', () => {
  it('shows the small-bar pages the person may use, from the same list as the sidebar', () => {
    const everything = caps(['cctv.live', 'cctv.playback', 'it.inventory.view'], ORG)
    expect(mobileNavFor({ role: 'user', capabilities: everything }).map((i) => i.href)).toEqual(['/home', '/stores', '/devices', '/live'])
    expect(mobileNavFor({ role: 'user', capabilities: caps(['cctv.playback']) }).map((i) => i.href)).toEqual(['/home', '/stores'])
    expect(mobileNavFor({ role: 'admin', capabilities: NONE }).map((i) => i.href)).toEqual(['/home'])
  })
})
