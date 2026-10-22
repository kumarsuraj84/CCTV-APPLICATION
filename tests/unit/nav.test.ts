import { describe, expect, it } from 'vitest'
import { ROLES } from '@/lib/admin/roles'
import { ICONS } from '@/components/layout/icons'
import { mobileNavFor, NAV, navFor, type Role } from '@/lib/nav'

const hrefs = (role: Role) => navFor(role).map((i) => i.href)

describe('navigation per role', () => {
  it('a viewer sees monitoring pages only', () => {
    const h = hrefs('user')
    expect(h).toEqual(['/home', '/stores', '/devices', '/live', '/groups'])
  })

  it('an operator and a manager see the same pages as a viewer', () => {
    expect(hrefs('agent')).toEqual(hrefs('user'))
    expect(hrefs('manager')).toEqual(hrefs('user'))
  })

  it('every role that can open the app sees Live and Groups, in the Monitoring group', () => {
    for (const role of ROLES) {
      expect(hrefs(role)).toContain('/live')
      expect(hrefs(role)).toContain('/groups')
    }
    for (const [href, label] of [['/live', 'Live'], ['/groups', 'Groups']]) {
      const item = NAV.find((i) => i.href === href)
      expect(item).toMatchObject({ label, group: 'Monitoring' })
      expect(item?.roles).toBeUndefined()
    }
  })

  it('an admin also sees the admin pages', () => {
    const h = hrefs('admin')
    expect(h).toContain('/admin/users')
    expect(h).toContain('/admin/stores')
    expect(h).toContain('/admin/devices')
    expect(h).toContain('/admin/import')
    expect(h).toContain('/admin/monitoring')
  })

  it('nobody below an admin sees the Monitoring page', () => {
    for (const role of ['user', 'agent', 'manager'] as const) expect(hrefs(role)).not.toContain('/admin/monitoring')
  })

  it('a platform owner sees what an admin sees', () => {
    expect(hrefs('platform_owner')).toEqual(hrefs('admin'))
  })

  it('every item has an icon that exists', () => {
    for (const item of NAV) expect(ICONS[item.icon]).toBeDefined()
  })

  it('Live has its own icon', () => {
    expect(NAV.find((i) => i.href === '/live')?.icon).toBe('video')
    expect(ICONS.video).toBeDefined()
  })
})

describe('mobile navigation', () => {
  it('shows only the pages everybody uses, taken from the same list as the sidebar: Live is on the small bar, Groups is not', () => {
    for (const role of ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const) {
      expect(mobileNavFor(role).map((i) => i.href)).toEqual(['/home', '/stores', '/devices', '/live'])
    }
  })
})
