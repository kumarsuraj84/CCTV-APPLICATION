import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/actions/admin/users', () => ({ createUserAction: vi.fn(), setActiveAction: vi.fn(), setRoleAction: vi.fn(), reactivationReviewAction: vi.fn(), resetPasswordAction: vi.fn() }))

import { ReactivationPanel, RoleChangePanel } from '@/components/admin/UserRow'
import { previewToken } from '@/lib/admin/access'
import { displayReason } from '@/components/admin/access-labels'
import { ROLE_CHANGE_EFFECT } from '@/lib/admin/roles'
import { auditSecrets, getSecret } from '@/lib/secrets'

// P2-3 review fix round 1 (unit part): HMAC preview token (M-5), super administrator reactivation text (M-6), role-change wording and
// the "Review remaining access" prompt (I-2), legacy reason display (M-8), the new secret purpose.

afterEach(() => {
  delete process.env.ACCESS_PREVIEW_SECRET
})

describe('M-5: the preview token is an HMAC with a server secret', () => {
  const changes = [{ op: 'grant' as const, capability: 'cctv.live', scope_kind: 'location' as const, scope_id: 'l1', valid_until: null, reason: '' }]
  it('depends on the secret, the person, the version and the changes', () => {
    process.env.ACCESS_PREVIEW_SECRET = 'a'.repeat(32)
    const t = previewToken('u1', 3, changes)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(previewToken('u1', 3, changes)).toBe(t)
    expect(previewToken('u2', 3, changes)).not.toBe(t)
    expect(previewToken('u1', 4, changes)).not.toBe(t)
    process.env.ACCESS_PREVIEW_SECRET = 'b'.repeat(32)
    expect(previewToken('u1', 3, changes)).not.toBe(t)
  })
  it('without a configured secret, a random key of this server process is used (tokens do not survive a restart)', () => {
    expect(getSecret('access_preview')).toBeNull()
    const t = previewToken('u1', 3, changes)
    expect(previewToken('u1', 3, changes)).toBe(t)
    process.env.ACCESS_PREVIEW_SECRET = 'c'.repeat(32)
    expect(previewToken('u1', 3, changes)).not.toBe(t)
  })
  it('is a purpose of its own with the minimum length rule', () => {
    process.env.ACCESS_PREVIEW_SECRET = 'short'
    expect(getSecret('access_preview')).toBeNull()
    expect(auditSecrets({}).some((i) => i.env === 'ACCESS_PREVIEW_SECRET' && i.problem === 'not set')).toBe(true)
  })
})

describe('screens', () => {
  it('M-6: reactivating a super administrator says the full set returns by itself, and offers no "remove all"', () => {
    const html = renderToStaticMarkup(
      <ReactivationPanel name="Sam" targetRole="platform_owner" review={{ ok: true, version: 1, canRevoke: true, grants: [{ id: 'g', capabilityLabel: 'Watch live video', scopeLabel: 'Whole organisation', lastDay: null, state: 'active', source: 'manual' }] }}
        reason="" onReason={() => {}} onKeep={() => {}} onRevokeAll={() => {}} onCancel={() => {}} pending={false} userId="u" />,
    )
    expect(html).toContain('A super administrator gets every right back automatically when reactivated.')
    expect(html).not.toContain('Remove all of it and reactivate')
  })

  it('I-2: the role change explains what is removed, and afterwards asks to review the remaining access', () => {
    expect(ROLE_CHANGE_EFFECT('admin', 'manager')).toBe('Their administration rights (admin.*) and download rights (export) are removed. Their other access stays: review it next.')
    expect(ROLE_CHANGE_EFFECT('platform_owner', 'admin')).toBe('The rights only a super administrator may hold are removed (remote control, scripts, software, configuration, patching, credentials, operating-system deployment). Their other access stays: review it next.')
    expect(ROLE_CHANGE_EFFECT('user', 'operator')).toBe('Their access stays as it is.')
    expect(ROLE_CHANGE_EFFECT('admin', 'platform_owner')).toBe('They get every right for the whole organisation.')
    const html = renderToStaticMarkup(
      <RoleChangePanel name="Asha" userId="u1" currentRole="admin" allowedRoles={['user', 'operator', 'manager', 'admin']} pending={false} onChange={() => {}} onCancel={() => {}}
        result={{ revoked: 5, remaining: [{ id: 'g', capabilityLabel: 'Watch live video', scopeLabel: 'L1 · Location one', lastDay: null, state: 'active', source: 'manual' }] }} />,
    )
    expect(html).toContain('Review remaining access')
    expect(html).toContain('5 rights were removed')
    expect(html).toContain('href="/admin/users/u1/access"')
    expect(html).not.toContain('keeps the person’s access')
  })

  it('M-8: the old automatic reason is shown with the new words', () => {
    expect(displayReason('Platform owner: all capabilities')).toBe('Super administrator: all capabilities')
    expect(displayReason('Incident 7')).toBe('Incident 7')
    expect(displayReason(null)).toBeNull()
  })
})
