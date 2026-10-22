// Approvals bound to the payload hash (P7-0). Pure functions.
// The caller (Server Action) has already checked that the approver holds the approval capability for the
// scope; the engine checks what only it can: the hash, distinct approvers, requester exclusion, impact acknowledgement.
import { fail, ok, type Approval, type Outcome, type RiskLevel } from './types'

export type ApprovalRule = 'none' | 'one' | 'two'
export type ApprovalRules = Record<RiskLevel, ApprovalRule>

export const DEFAULT_APPROVAL_RULES: ApprovalRules = { low: 'none', medium: 'one', high: 'two' }

const COUNT: Record<ApprovalRule, number> = { none: 0, one: 1, two: 2 }

export function requiredApprovals(risk: RiskLevel, rules: ApprovalRules): number {
  return COUNT[rules[risk]]
}

export interface ApprovalContext {
  payload_hash: string
  requested_by: string
  impact_requires_acknowledgement: boolean
  approvals: Approval[]
}

export type IgnoredReason = 'payload_changed' | 'approver_is_requester' | 'duplicate_approver' | 'impact_not_acknowledged'

export interface ApprovalEvaluation {
  counted: Approval[]
  ignored: { approval_id: string; reason: IgnoredReason }[]
  rejected: boolean
  required: number
  satisfied: boolean
}

/** Which recorded approvals count for the current payload. Only approvals of the current hash count; a rejection of the current hash wins. */
export function evaluateApprovals(ctx: ApprovalContext & { required: number }): ApprovalEvaluation {
  const counted: Approval[] = []
  const ignored: ApprovalEvaluation['ignored'] = []
  const people = new Set<string>()
  let rejected = false
  for (const a of ctx.approvals) {
    if (a.payload_hash !== ctx.payload_hash) { ignored.push({ approval_id: a.id, reason: 'payload_changed' }); continue }
    if (a.approver === ctx.requested_by) { ignored.push({ approval_id: a.id, reason: 'approver_is_requester' }); continue }
    if (a.decision === 'reject') { rejected = true; continue }
    if (people.has(a.approver)) { ignored.push({ approval_id: a.id, reason: 'duplicate_approver' }); continue }
    if (ctx.impact_requires_acknowledgement && !a.acknowledged_impact) { ignored.push({ approval_id: a.id, reason: 'impact_not_acknowledged' }); continue }
    people.add(a.approver)
    counted.push(a)
  }
  return { counted, ignored, rejected, required: ctx.required, satisfied: !rejected && counted.length >= ctx.required }
}

export interface ApprovalRequest {
  approver: string
  payload_hash: string
  acknowledged_impact: boolean
}

/** Whether a new approval (or rejection) may be recorded. */
export function checkNewApproval(ctx: ApprovalContext, req: ApprovalRequest): Outcome<true> {
  if (req.payload_hash !== ctx.payload_hash) {
    return fail('payload_hash_mismatch', 'The plan changed after you opened it. Review the current version before approving.')
  }
  if (req.approver === ctx.requested_by) return fail('approver_is_requester', 'The person who requested a change cannot approve it.')
  if (ctx.approvals.some((a) => a.approver === req.approver && a.payload_hash === ctx.payload_hash)) {
    return fail('duplicate_approver', 'You have already decided on this version.')
  }
  if (ctx.impact_requires_acknowledgement && !req.acknowledged_impact) {
    return fail('impact_not_acknowledged', 'Confirm that you have read the expected disruption before approving.')
  }
  return ok(true)
}
