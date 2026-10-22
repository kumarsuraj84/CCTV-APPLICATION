import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_RULES, checkNewApproval, evaluateApprovals, requiredApprovals } from '@/lib/jobs/approvals'
import type { Approval } from '@/lib/jobs/types'

const H = 'h'.repeat(64)
const H2 = 'g'.repeat(64)
let n = 0
function appr(approver: string, extra: Partial<Approval> = {}): Approval {
  n += 1
  return { id: `a-${n}`, approver, decision: 'approve', payload_hash: H, acknowledged_impact: true, at: n, note: null, ...extra }
}
const base = { payload_hash: H, requested_by: 'req', impact_requires_acknowledgement: false }

describe('approval rules', () => {
  it('default: low none, medium one, high two', () => {
    expect(requiredApprovals('low', DEFAULT_APPROVAL_RULES)).toBe(0)
    expect(requiredApprovals('medium', DEFAULT_APPROVAL_RULES)).toBe(1)
    expect(requiredApprovals('high', DEFAULT_APPROVAL_RULES)).toBe(2)
  })

  it('is configurable per risk level', () => {
    expect(requiredApprovals('low', { low: 'one', medium: 'two', high: 'two' })).toBe(1)
    expect(requiredApprovals('medium', { low: 'none', medium: 'none', high: 'two' })).toBe(0)
  })
})

describe('evaluateApprovals', () => {
  it('counts distinct approvers bound to the current hash', () => {
    const r = evaluateApprovals({ ...base, approvals: [appr('a'), appr('b')], required: 2 })
    expect(r.satisfied).toBe(true)
    expect(r.counted.map((a) => a.approver)).toEqual(['a', 'b'])
  })

  it('an approval of an older payload hash does not count after the payload changed', () => {
    const r = evaluateApprovals({ ...base, payload_hash: H2, approvals: [appr('a'), appr('b')], required: 1 })
    expect(r.satisfied).toBe(false)
    expect(r.ignored.map((i) => i.reason)).toEqual(['payload_changed', 'payload_changed'])
  })

  it('the requester never counts as an approver', () => {
    const r = evaluateApprovals({ ...base, approvals: [appr('req')], required: 1 })
    expect(r.satisfied).toBe(false)
    expect(r.ignored[0].reason).toBe('approver_is_requester')
  })

  it('the same person counts once', () => {
    const r = evaluateApprovals({ ...base, approvals: [appr('a'), appr('a')], required: 2 })
    expect(r.satisfied).toBe(false)
    expect(r.counted).toHaveLength(1)
    expect(r.ignored[0].reason).toBe('duplicate_approver')
  })

  it('needs every counted approver to acknowledge the impact when the impact requires it', () => {
    const r = evaluateApprovals({ ...base, impact_requires_acknowledgement: true, approvals: [appr('a', { acknowledged_impact: false })], required: 1 })
    expect(r.satisfied).toBe(false)
    expect(r.ignored[0].reason).toBe('impact_not_acknowledged')
  })

  it('a rejection for the current hash marks the rollout rejected', () => {
    const r = evaluateApprovals({ ...base, approvals: [appr('a'), appr('b', { decision: 'reject' })], required: 1 })
    expect(r.rejected).toBe(true)
    expect(r.satisfied).toBe(false)
  })

  it('none required is satisfied with no approvals', () => {
    expect(evaluateApprovals({ ...base, approvals: [], required: 0 }).satisfied).toBe(true)
  })
})

describe('checkNewApproval', () => {
  it('refuses a hash other than the current one', () => {
    const r = checkNewApproval({ ...base, approvals: [] }, { approver: 'a', payload_hash: H2, acknowledged_impact: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('payload_hash_mismatch')
  })

  it('refuses the requester and a second approval by the same person', () => {
    const self = checkNewApproval({ ...base, approvals: [] }, { approver: 'req', payload_hash: H, acknowledged_impact: true })
    expect(!self.ok && self.error.code).toBe('approver_is_requester')
    const again = checkNewApproval({ ...base, approvals: [appr('a')] }, { approver: 'a', payload_hash: H, acknowledged_impact: true })
    expect(!again.ok && again.error.code).toBe('duplicate_approver')
  })

  it('allows the same person again once their earlier approval was for an older hash', () => {
    const r = checkNewApproval({ ...base, approvals: [appr('a', { payload_hash: H2 })] }, { approver: 'a', payload_hash: H, acknowledged_impact: true })
    expect(r.ok).toBe(true)
  })

  it('refuses an approval without impact acknowledgement when needed', () => {
    const r = checkNewApproval({ ...base, impact_requires_acknowledgement: true, approvals: [] }, { approver: 'a', payload_hash: H, acknowledged_impact: false })
    expect(!r.ok && r.error.code).toBe('impact_not_acknowledged')
  })
})
