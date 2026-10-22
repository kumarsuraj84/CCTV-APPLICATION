import { describe, expect, it } from 'vitest'
import { canManageGroups, canManageRole, canRunChecks, isAdminRole } from '@/lib/admin/roles'

describe('canManageRole', () => {
  it('a platform owner may manage every role', () => {
    for (const r of ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const) expect(canManageRole('platform_owner', r)).toBe(true)
  })
  it('an admin may manage viewers, operators and managers only', () => {
    expect(canManageRole('admin', 'user')).toBe(true)
    expect(canManageRole('admin', 'agent')).toBe(true)
    expect(canManageRole('admin', 'manager')).toBe(true)
    expect(canManageRole('admin', 'admin')).toBe(false)
    expect(canManageRole('admin', 'platform_owner')).toBe(false)
  })
  it('nobody else may manage anyone', () => {
    for (const a of ['user', 'agent', 'manager'] as const) expect(canManageRole(a, 'user')).toBe(false)
  })
})

describe('isAdminRole and canRunChecks', () => {
  it('isAdminRole is true only for admin and platform_owner', () => {
    expect(isAdminRole('admin')).toBe(true)
    expect(isAdminRole('platform_owner')).toBe(true)
    for (const r of ['user', 'agent', 'manager'] as const) expect(isAdminRole(r)).toBe(false)
  })
  it('operators, admins and owners may request a check; viewers and managers may not', () => {
    for (const r of ['agent', 'admin', 'platform_owner'] as const) expect(canRunChecks(r)).toBe(true)
    for (const r of ['user', 'manager'] as const) expect(canRunChecks(r)).toBe(false)
  })
})

describe('canManageGroups', () => {
  it('operators, admins and owners may manage camera groups; viewers and managers may not', () => {
    for (const r of ['agent', 'admin', 'platform_owner'] as const) expect(canManageGroups(r)).toBe(true)
    for (const r of ['user', 'manager'] as const) expect(canManageGroups(r)).toBe(false)
  })
})
