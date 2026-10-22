// Approvals bound to the approval subject (P7-0, review round 1). Pure functions.
// The caller (Server Action) has already checked that the approver holds the approval capability for the
// scope; the engine checks what only it can: the subject of the current revision, distinct approvers, that no
// author of the current version approves (four-eyes), and impact acknowledgement.
import { canonicalize, sha256Hex } from './canonical'
import { fail, ok, type Approval, type ExcludedTarget, type ImpactEstimate, type IncludedTarget, type Outcome, type RiskLevel } from './types'

export type ApprovalRule = 'none' | 'one' | 'two'
export type ApprovalRules = Record<RiskLevel, ApprovalRule>

export const DEFAULT_APPROVAL_RULES: ApprovalRules = { low: 'none', medium: 'one', high: 'two' }

const COUNT: Record<ApprovalRule, number> = { none: 0, one: 1, two: 2 }
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

export function requiredApprovals(risk: RiskLevel, rules: ApprovalRules): number {
  return COUNT[rules[risk]]
}

/** The highest of the given risk levels. */
export function maxRisk(...levels: (RiskLevel | null | undefined)[]): RiskLevel {
  let out: RiskLevel = 'low'
  for (const l of levels) if (l && RISK_RANK[l] > RISK_RANK[out]) out = l
  return out
}

/** Disruption, reconnection or reboot (or an unknown impact) make a change at least medium risk. */
export function impactRisk(impact: ImpactEstimate | null, anyTargetWithoutEstimate: boolean): RiskLevel {
  if (impact === null || anyTargetWithoutEstimate) return 'medium'
  return impact.disruption !== 'none' || impact.reconnect_required || impact.reboot_required ? 'medium' : 'low'
}

export const SUBJECT_DOMAIN = 'drishti.approval-subject.v1'

export interface SubjectParts {
  rollout_id: string
  revision: number
  payload_hash: string
  targets: IncludedTarget[]
  excluded: ExcludedTarget[]
  impact: ImpactEstimate | null
  impact_requires_acknowledgement: boolean
  effective_risk: RiskLevel
}

/** What an approver approves: everything that decides what runs where. */
export function approvalSubject(p: SubjectParts): string {
  const body = {
    rollout_id: p.rollout_id,
    revision: p.revision,
    payload_hash: p.payload_hash,
    targets: p.targets.map((t) => ({ target_id: t.target_id, location_id: t.location_id, order: t.order, phase: t.phase, effective_hash: t.effective_hash })),
    excluded: p.excluded.map((e) => ({ target_id: e.target_id, location_id: e.location_id, reasons: e.reasons })),
    impact: p.impact,
    impact_requires_acknowledgement: p.impact_requires_acknowledgement,
    effective_risk: p.effective_risk,
  }
  return sha256Hex(`${SUBJECT_DOMAIN}\n${canonicalize(body)}`)
}

export interface ApprovalContext {
  subject: string | null
  /** Everyone who authored the current version: none of them may approve it. */
  authors: string[]
  impact_requires_acknowledgement: boolean
  approvals: Approval[]
}

export type IgnoredReason = 'subject_changed' | 'approver_is_author' | 'duplicate_approver' | 'impact_not_acknowledged'

export interface ApprovalEvaluation {
  counted: Approval[]
  ignored: { approval_id: string; reason: IgnoredReason }[]
  rejected: boolean
  required: number
  satisfied: boolean
}

/** Which recorded approvals count for the current subject. A rejection of the current subject wins. */
export function evaluateApprovals(ctx: ApprovalContext & { required: number }): ApprovalEvaluation {
  const counted: Approval[] = []
  const ignored: ApprovalEvaluation['ignored'] = []
  const people = new Set<string>()
  const authors = new Set(ctx.authors)
  let rejected = false
  for (const a of ctx.approvals) {
    if (ctx.subject === null || a.subject !== ctx.subject) { ignored.push({ approval_id: a.id, reason: 'subject_changed' }); continue }
    if (authors.has(a.approver)) { ignored.push({ approval_id: a.id, reason: 'approver_is_author' }); continue }
    if (a.decision === 'reject') { rejected = true; continue }
    if (people.has(a.approver)) { ignored.push({ approval_id: a.id, reason: 'duplicate_approver' }); continue }
    if (ctx.impact_requires_acknowledgement && !a.acknowledged_impact) { ignored.push({ approval_id: a.id, reason: 'impact_not_acknowledged' }); continue }
    people.add(a.approver)
    counted.push(a)
  }
  return { counted, ignored, rejected, required: ctx.required, satisfied: ctx.subject !== null && !rejected && counted.length >= ctx.required }
}

export interface ApprovalRequest {
  approver: string
  subject: string
  acknowledged_impact: boolean
}

/** Whether a new approval (or rejection) may be recorded. */
export function checkNewApproval(ctx: ApprovalContext, req: ApprovalRequest): Outcome<true> {
  if (ctx.subject === null || req.subject !== ctx.subject) {
    return fail('subject_mismatch', 'The change or its targets changed after you opened it. Review the current version before deciding.')
  }
  if (ctx.authors.includes(req.approver)) return fail('approver_is_author', 'Somebody who wrote, changed or submitted this version cannot approve it.')
  if (ctx.approvals.some((a) => a.approver === req.approver && a.subject === ctx.subject)) {
    return fail('duplicate_approver', 'You have already decided on this version.')
  }
  if (ctx.impact_requires_acknowledgement && !req.acknowledged_impact) {
    return fail('impact_not_acknowledged', 'Confirm that you have read the expected disruption before approving.')
  }
  return ok(true)
}
