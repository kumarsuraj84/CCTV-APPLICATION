import { describe, expect, it } from 'vitest'
import { navFor, type Role } from '@/lib/nav'

const hrefs = (role: Role) => navFor(role).map((i) => i.href)

describe('navigation per role', () => {
  it('a viewer sees monitoring pages only', () => {
    const h = hrefs('user')
    expect(h).toEqual(['/home', '/stores', '/devices'])
  })

  it('an operator and a manager see the same pages as a viewer in Plan 1', () => {
    expect(hrefs('agent')).toEqual(hrefs('user'))
    expect(hrefs('manager')).toEqual(hrefs('user'))
  })

  it('an admin also sees the admin pages', () => {
    const h = hrefs('admin')
    expect(h).toContain('/admin/users')
    expect(h).toContain('/admin/stores')
    expect(h).toContain('/admin/devices')
    expect(h).toContain('/admin/import')
  })

  it('a platform owner sees what an admin sees', () => {
    expect(hrefs('platform_owner')).toEqual(hrefs('admin'))
  })
})
