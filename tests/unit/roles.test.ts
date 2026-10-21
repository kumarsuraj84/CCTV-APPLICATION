import { describe, expect, it } from 'vitest'
import { canManageRole } from '@/lib/admin/roles'

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
