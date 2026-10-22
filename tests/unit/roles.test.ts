import { describe, expect, it } from 'vitest'
import * as roles from '@/lib/admin/roles'
import { canManageRole, hasGroupEditingAuthority, isAdminRole, ROLES } from '@/lib/admin/roles'

// AC-15 (D-16): the human role is "operator"; "agent" is kept free for the endpoint agents of a later phase.
describe('roles', () => {
  it('are user, operator, manager, admin and platform_owner, and agent is gone', () => {
    expect(ROLES).toEqual(['user', 'operator', 'manager', 'admin', 'platform_owner'])
    expect((ROLES as readonly string[]).includes('agent')).toBe(false)
  })
  it('no role is marked as seeing everything any more (AC-8: access comes only from grants)', () => {
    expect('SEES_EVERYTHING' in roles).toBe(false)
  })
  it('P2-2: the interim role rules for actions are gone (check-now needs it.monitoring.operate; groups need cctv.live)', () => {
    expect('canRunChecks' in roles).toBe(false)
    expect('canManageGroups' in roles).toBe(false)
  })
})

describe('canManageRole', () => {
  it('a platform owner may manage every role', () => {
    for (const r of ROLES) expect(canManageRole('platform_owner', r)).toBe(true)
  })
  it('an admin may manage viewers, operators and managers only', () => {
    expect(canManageRole('admin', 'user')).toBe(true)
    expect(canManageRole('admin', 'operator')).toBe(true)
    expect(canManageRole('admin', 'manager')).toBe(true)
    expect(canManageRole('admin', 'admin')).toBe(false)
    expect(canManageRole('admin', 'platform_owner')).toBe(false)
  })
  it('nobody else may manage anyone', () => {
    for (const a of ['user', 'operator', 'manager'] as const) expect(canManageRole(a, 'user')).toBe(false)
  })
})

describe('isAdminRole', () => {
  it('is true only for admin and platform_owner', () => {
    expect(isAdminRole('admin')).toBe(true)
    expect(isAdminRole('platform_owner')).toBe(true)
    for (const r of ['user', 'operator', 'manager'] as const) expect(isAdminRole(r)).toBe(false)
  })
})

describe('hasGroupEditingAuthority (administrative authority only; the cameras need cctv.live, checked separately)', () => {
  it('operators, admins and owners have it; viewers and managers do not', () => {
    for (const r of ['operator', 'admin', 'platform_owner'] as const) expect(hasGroupEditingAuthority(r)).toBe(true)
    for (const r of ['user', 'manager'] as const) expect(hasGroupEditingAuthority(r)).toBe(false)
  })
})
