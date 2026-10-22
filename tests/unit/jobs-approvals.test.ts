import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_RULES, approvalSubject, checkNewApproval, evaluateApprovals, impactRisk, maxRisk, requiredApprovals } from '@/lib/jobs/approvals'
import type { Approval } from '@/lib/jobs/types'

const S = 's'.repeat(64)
const S2 = 't'.repeat(64)
let n = 0
function appr(approver: string, extra: Partial<Approval> = {}): Approval {
  n += 1
  return { id: `a-${n}`, approver, decision: 'approve', subject: S, revision: 1, payload_hash: 'h', acknowledged_impact: true, at: n, note: null, ...extra }
}
const base = { subject: S, authors: ['req'], impact_requires_acknowledgement: false }

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

  it('maxRisk and the impact-derived minimum', () => {
    expect(maxRisk('low', undefined, 'high', 'medium')).toBe('high')
    expect(maxRisk()).toBe('low')
    const none = { disruption: 'none' as const, reboot_required: false, reconnect_required: false, estimated_downtime_s: 0, notes: [] }
    expect(impactRisk(none, false)).toBe('low')
    expect(impactRisk({ ...none, reconnect_required: true }, false)).toBe('medium')
    expect(impactRisk({ ...none, reboot_required: true }, false)).toBe('medium')
    expect(impactRisk(none, true)).toBe('medium')
    expect(impactRisk(null, false)).toBe('medium')
  })
})

describe('approvalSubject', () => {
  const parts = {
    rollout_id: 'r1', revision: 1, payload_hash: 'h'.repeat(64), excluded: [], impact: null, impact_requires_acknowledgement: true, effective_risk: 'medium' as const,
    targets: [{ target_id: 'ap1', location_id: 'L', order: 0, phase: 0 as const, warnings: [], effective_hash: 'e'.repeat(64) }],
  }
  it('changes with the revision, targets, effective hashes, exclusions, impact flag and risk', () => {
    const s0 = approvalSubject(parts)
    expect(s0).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalSubject({ ...parts, revision: 2 })).not.toBe(s0)
    expect(approvalSubject({ ...parts, targets: [...parts.targets, { ...parts.targets[0], target_id: 'ap2', order: 1 }] })).not.toBe(s0)
    expect(approvalSubject({ ...parts, targets: [{ ...parts.targets[0], effective_hash: 'f'.repeat(64) }] })).not.toBe(s0)
    expect(approvalSubject({ ...parts, excluded: [{ target_id: 'x', location_id: null, reasons: ['r'] }] })).not.toBe(s0)
    expect(approvalSubject({ ...parts, impact_requires_acknowledgement: false })).not.toBe(s0)
    expect(approvalSubject({ ...parts, effective_risk: 'high' })).not.toBe(s0)
    expect(approvalSubject({ ...parts, rollout_id: 'r2' })).not.toBe(s0)
    expect(approvalSubject(parts)).toBe(s0)
  })
})

describe('evaluateApprovals', () => {
  it('counts distinct approvers bound to the current subject', () => {
    const r = evaluateApprovals({ ...base, approvals: [appr('a'), appr('b')], required: 2 })
    expect(r.satisfied).toBe(true)
    expect(r.counted.map((a) => a.approver)).toEqual(['a', 'b'])
  })

  it('an approval of an older subject does not count', () => {
    const r = evaluateApprovals({ ...base, subject: S2, approvals: [appr('a'), appr('b')], required: 1 })
    expect(r.satisfied).toBe(false)
    expect(r.ignored.map((i) => i.reason)).toEqual(['subject_changed', 'subject_changed'])
  })

  it('no author of the current version counts as an approver', () => {
    const r = evaluateApprovals({ ...base, authors: ['req', 'amender'], approvals: [appr('req'), appr('amender')], required: 1 })
    expect(r.satisfied).toBe(false)
    expect(r.ignored.map((i) => i.reason)).toEqual(['approver_is_author', 'approver_is_author'])
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

  it('a rejection for the current subject marks the rollout rejected', () => {
    const r = evaluateApprovals({ ...base, approvals: [appr('a'), appr('b', { decision: 'reject' })], required: 1 })
    expect(r.rejected).toBe(true)
    expect(r.satisfied).toBe(false)
  })

  it('none required is satisfied with no approvals, but never without a subject', () => {
    expect(evaluateApprovals({ ...base, approvals: [], required: 0 }).satisfied).toBe(true)
    expect(evaluateApprovals({ ...base, subject: null, approvals: [], required: 0 }).satisfied).toBe(false)
  })
})

describe('checkNewApproval', () => {
  it('refuses a subject other than the current one', () => {
    const r = checkNewApproval({ ...base, approvals: [] }, { approver: 'a', subject: S2, acknowledged_impact: true })
    expect(!r.ok && r.error.code).toBe('subject_mismatch')
  })

  it('refuses an author and a second approval by the same person', () => {
    const self = checkNewApproval({ ...base, approvals: [] }, { approver: 'req', subject: S, acknowledged_impact: true })
    expect(!self.ok && self.error.code).toBe('approver_is_author')
    const again = checkNewApproval({ ...base, approvals: [appr('a')] }, { approver: 'a', subject: S, acknowledged_impact: true })
    expect(!again.ok && again.error.code).toBe('duplicate_approver')
  })

  it('allows the same person again once their earlier approval was for an older subject', () => {
    const r = checkNewApproval({ ...base, approvals: [appr('a', { subject: S2 })] }, { approver: 'a', subject: S, acknowledged_impact: true })
    expect(r.ok).toBe(true)
  })

  it('refuses an approval without impact acknowledgement when needed', () => {
    const r = checkNewApproval({ ...base, impact_requires_acknowledgement: true, approvals: [] }, { approver: 'a', subject: S, acknowledged_impact: false })
    expect(!r.ok && r.error.code).toBe('impact_not_acknowledged')
  })
})
