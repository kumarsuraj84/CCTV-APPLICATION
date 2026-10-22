// The rollout and job orchestration engine (P7-0).
//
// A deterministic state machine over an injected JobStore, clock, id generator and environment. It never
// calls a device: adapters are driven by the runner (lib/jobs/runner.ts) or by the agent API, which report
// what happened through the protocol methods here (ack, start, heartbeat, reportResult, recordVerification,
// beginReconcile/recordReconcile). Every state change is checked against the transition tables, written with
// compare-and-set on the record version, and appended to the event log in the same commit.
import type { AdapterCapabilities } from './adapter'
import { DEFAULT_APPROVAL_RULES, checkNewApproval, evaluateApprovals, requiredApprovals, type ApprovalEvaluation, type ApprovalRules } from './approvals'
import type { JsonObject } from './canonical'
import type { Clock, IdGenerator } from './engine-deps'
import {
  ACTIVE_JOB_STATES,
  FAILURE_JOB_STATES,
  LEASED_JOB_STATES,
  RUNNING_ROLLOUT_STATES,
  SUCCESS_JOB_STATES,
  WAITING_JOB_STATES,
  canTransitionJob,
  canTransitionRollout,
  isTerminalJob,
  isTerminalRollout,
} from './machines'
import { payloadHash, validatePlan } from './plan'
import { assignPhases, finalRolloutState, pathsOverlap, recoveryActionsFor, summarize, thresholdBreach, type RolloutSummary } from './planner'
import { redactDetails, tokenFingerprint } from './redact'
import type { Changeset, JobStore, VersionedWrite } from './store'
import {
  fail,
  ok,
  type ExcludedTarget,
  type ImpactEstimate,
  type IncludedTarget,
  type Job,
  type JobEvent,
  type JobState,
  type NewJobEvent,
  type Outcome,
  type Plan,
  type ReconcileOutcome,
  type ResultOutcome,
  type Rollout,
  type RolloutConflict,
  type RolloutState,
  type TargetCandidate,
  type VerifyOutcome,
} from './types'
import { isWindowOpen, parseZonedInstant } from './window'

/** What the engine needs to know about the world. Supplied by the hub (database, presence, capability matrix) or by tests. */
export interface EngineEnvironment {
  /** The current execution policy version for a plan kind. */
  currentPolicyVersion(kind: string): number
  /** The newest configuration version for a base key (e.g. a Wi-Fi profile id), or null if unknown. */
  currentBaseVersion(key: string): number | null
  /** Whether the target is reachable now (agent checked in recently, AP management path up). */
  isOnline(targetId: string): boolean
  /** Whether the target may still receive this plan (enrolled, not revoked, compatible, in scope). */
  eligibility(targetId: string, plan: Plan): Promise<{ eligible: boolean; reasons: string[] }>
  /** Read-only: whether the desired state is already in place. */
  desiredState(targetId: string, locationId: string, plan: Plan): Promise<'satisfied' | 'not_satisfied' | 'unknown'>
}

export interface EngineOptions {
  store: JobStore
  clock: Clock
  ids: IdGenerator
  env: EngineEnvironment
  adapters: Record<string, AdapterCapabilities>
  approval_rules?: ApprovalRules
  /** How long an offer may wait for its acknowledgement. */
  offer_lease_ms?: number
  /** Lease after acknowledgement, start or heartbeat. */
  run_lease_ms?: number
  /** How long a reconcile request may wait for its answer. */
  reconcile_lease_ms?: number
  /** Inconclusive verifications before a job is "accepted but not verified". */
  max_verify_attempts?: number
  /** Actor recorded for automatic changes. */
  system_actor?: string
}

export interface TickReport {
  offered: Job[]
  /** Records written. */
  changed: number
  /** Compare-and-set conflicts met (another writer was faster; the next tick retries). */
  conflicts: number
}

export type RevalidationDecision =
  | { action: 'offerable' }
  | { action: 'wait'; reason: string }
  | { action: 'expired' | 'superseded' | 'cancelled' | 'already_satisfied'; reason: string }
  | { action: 'blocked'; reason: string }
  | { action: 'not_waiting'; reason: string }

const PRE_START_EXPIRABLE: ReadonlySet<RolloutState> = new Set(['targets_resolved', 'pending_approval', 'approved', 'scheduled'])
const AMENDABLE: ReadonlySet<RolloutState> = new Set(['draft', 'validated', 'targets_resolved', 'pending_approval', 'approved', 'scheduled'])
const STARTED: ReadonlySet<RolloutState> = new Set(['running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold'])
/** States in which a rollout holds its targets for conflict detection. */
const CONFLICT_HOLDING: ReadonlySet<RolloutState> = new Set([
  'targets_resolved', 'pending_approval', 'approved', 'scheduled', 'running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold',
])
/** States in which a newer rollout supersedes older queued jobs with the same key. */
const SUPERSEDING: ReadonlySet<RolloutState> = new Set([
  'approved', 'scheduled', 'running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold', 'completed', 'partially_failed', 'failed',
])
const CANARY_PASS: ReadonlySet<JobState> = new Set(['verified', 'already_satisfied', 'superseded'])
const DISRUPTION_RANK = { none: 0, brief: 1, service_interruption: 2 } as const

export class JobEngine {
  private readonly store: JobStore
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly env: EngineEnvironment
  private readonly adapters: Record<string, AdapterCapabilities>
  private readonly rules: ApprovalRules
  private readonly offerLeaseMs: number
  private readonly runLeaseMs: number
  private readonly reconcileLeaseMs: number
  private readonly maxVerifyAttempts: number
  private readonly system: string

  constructor(o: EngineOptions) {
    this.store = o.store
    this.clock = o.clock
    this.ids = o.ids
    this.env = o.env
    this.adapters = o.adapters
    this.rules = o.approval_rules ?? DEFAULT_APPROVAL_RULES
    this.offerLeaseMs = o.offer_lease_ms ?? 5 * 60_000
    this.runLeaseMs = o.run_lease_ms ?? 15 * 60_000
    this.reconcileLeaseMs = o.reconcile_lease_ms ?? 5 * 60_000
    this.maxVerifyAttempts = o.max_verify_attempts ?? 3
    this.system = o.system_actor ?? 'system:job-engine'
  }

  // -------------------------------------------------------------------------------------------------
  // Reads

  getRollout(id: string): Promise<Rollout | null> {
    return this.store.getRollout(id)
  }

  getJob(id: string): Promise<Job | null> {
    return this.store.getJob(id)
  }

  listJobs(rolloutId: string): Promise<Job[]> {
    return this.store.listJobsByRollout(rolloutId)
  }

  listEvents(filter?: { rollout_id?: string; job_id?: string }): Promise<JobEvent[]> {
    return this.store.listEvents(filter)
  }

  jobsInStates(states: JobState[]): Promise<Job[]> {
    return this.store.listJobsInStates(states)
  }

  /** Rollouts that are not finished, in creation order. */
  async listOpenRollouts(): Promise<Rollout[]> {
    return (await this.store.listRollouts()).filter((r) => !isTerminalRollout(r.state))
  }

  async summary(rolloutId: string): Promise<Outcome<RolloutSummary>> {
    const r = await this.store.getRollout(rolloutId)
    if (!r) return notFound('rollout')
    return ok(summarize(r, await this.store.listJobsByRollout(rolloutId)))
  }

  /** Which approvals count for the rollout's current payload. */
  approvalStatus(r: Rollout): ApprovalEvaluation {
    const ev = evaluateApprovals({
      payload_hash: r.payload_hash,
      requested_by: r.plan.requested_by,
      impact_requires_acknowledgement: r.impact_requires_acknowledgement,
      approvals: r.approvals,
      required: requiredApprovals(r.plan.risk, this.rules),
    })
    // Integrity: the stored hash must still be the hash of the stored plan.
    if (!this.planIntact(r)) return { ...ev, satisfied: false }
    return ev
  }

  /** Unknown jobs whose target is reachable: the runner or agent API should ask the device about them. */
  async reconcileCandidates(): Promise<Job[]> {
    return (await this.store.listJobsInStates(['unknown'])).filter((j) => this.env.isOnline(j.target_id))
  }

  /** Jobs in verification (the runner re-reads their settings). */
  async verificationCandidates(): Promise<Job[]> {
    return (await this.store.listJobsInStates(['verifying'])).filter((j) => this.env.isOnline(j.target_id))
  }

  // -------------------------------------------------------------------------------------------------
  // Rollout lifecycle

  async createRollout(input: { title: string; plan: Plan; actor: string }): Promise<Outcome<Rollout>> {
    let hash: string
    try {
      hash = payloadHash(input.plan)
    } catch (e) {
      return fail('invalid_plan', `The plan is not plain JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    const now = this.clock.now()
    const r: Rollout = {
      id: this.ids.next('rollout'),
      version: 0,
      seq: await this.store.nextRolloutSeq(),
      title: input.title,
      state: 'draft',
      plan: structuredClone(input.plan),
      payload_hash: hash,
      approvals: [],
      targets: [],
      excluded: [],
      impact: null,
      impact_requires_acknowledgement: true,
      conflicts: [],
      current_batch: -1,
      phase_finished_at: null,
      paused_from: null,
      pause_reason: null,
      failures_acknowledged: 0,
      consecutive_failures: 0,
      counted_jobs: [],
      canary_override: false,
      created_by: input.actor,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    }
    const res = await this.store.commit({
      rollouts: [{ record: r, expected_version: null }],
      events: [this.rolloutEvent(r, null, 'draft', input.actor, 'created', { title: r.title })],
    })
    return res.ok ? ok(res.value.rollouts[0]) : res
  }

  /** Replace the plan before execution. Any real change gives a new hash, returns the rollout to draft and voids the approvals. */
  async amendPlan(id: string, plan: Plan, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (STARTED.has(r.state)) return fail('immutable_after_start', 'The plan cannot change once the rollout has started. Cancel it and create a new one.')
    if (!AMENDABLE.has(r.state)) return invalid(`A ${r.state} rollout cannot be changed.`)
    let hash: string
    try {
      hash = payloadHash(plan)
    } catch (e) {
      return fail('invalid_plan', `The plan is not plain JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (hash === r.payload_hash) return ok(r)
    const next: Rollout = {
      ...r,
      plan: structuredClone(plan),
      payload_hash: hash,
      state: 'draft',
      targets: [],
      excluded: [],
      impact: null,
      impact_requires_acknowledgement: true,
      conflicts: [],
      updated_at: this.clock.now(),
    }
    const details = { previous_payload_hash: r.payload_hash, new_payload_hash: hash }
    const event = r.state === 'draft'
      ? this.rolloutEvent(next, 'draft', 'draft', actor, 'plan_amended', details, 'recorded')
      : this.rolloutEvent(next, r.state, 'draft', actor, 'plan_amended', details)
    return this.writeRollout(r, next, [event])
  }

  async validate(id: string, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (!canTransitionRollout(r.state, 'validated')) return invalid(`A ${r.state} rollout cannot be validated.`)
    const now = this.clock.now()
    const issues = validatePlan(r.plan, { now, adapters: this.adapters })
    if (issues.length > 0) {
      return fail('invalid_plan', 'The plan has problems.', { issues: issues.map((i) => ({ field: i.field, message: i.message })) })
    }
    const current = this.env.currentPolicyVersion(r.plan.kind)
    if (current !== r.plan.policy_version) {
      return fail('invalid_plan', `The plan was checked against policy version ${r.plan.policy_version}, but version ${current} is current.`)
    }
    const stale = this.staleBase(r.plan)
    if (stale) return fail('stale_configuration_version', stale)
    const next = { ...r, state: 'validated' as const, updated_at: now }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'validated', actor, 'validated')])
  }

  /** Decide which candidates are included; unsupported or incompatible ones are excluded with reasons, never dropped silently. */
  async resolveTargets(id: string, candidates: TargetCandidate[], actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (!canTransitionRollout(r.state, 'targets_resolved')) return invalid(`Targets can be resolved only for a validated rollout (this one is ${r.state}).`)
    const plan = r.plan
    const sel = plan.target_selector
    const required = this.adapters[plan.adapter]?.kinds[plan.kind]?.required_target_capabilities ?? []
    const excluded: ExcludedTarget[] = []
    const included: (TargetCandidate & { warnings: string[] })[] = []
    const seen = new Set<string>()
    for (const c of candidates) {
      if (seen.has(c.target_id)) {
        const prev = excluded.find((e) => e.target_id === c.target_id)
        if (prev) prev.reasons.push('duplicate candidate (listed more than once)')
        else excluded.push({ target_id: c.target_id, location_id: c.location_id, reasons: ['duplicate candidate (listed more than once); the first entry is used'] })
        continue
      }
      seen.add(c.target_id)
      const reasons: string[] = []
      const selected =
        (sel.organisation_wide === true || (sel.target_ids?.length ?? 0) > 0 || (sel.location_ids?.length ?? 0) > 0) &&
        (!sel.target_ids?.length || sel.target_ids.includes(c.target_id)) &&
        (!sel.location_ids?.length || sel.location_ids.includes(c.location_id)) &&
        (!sel.models?.length || (c.model !== null && sel.models.includes(c.model)))
      if (!selected) reasons.push('not selected by the target selector')
      if (!c.compatible) reasons.push(...(c.incompatibility_reasons.length ? c.incompatibility_reasons : ['incompatible with this change']))
      for (const cap of required) if (!c.capabilities.includes(cap)) reasons.push(`missing capability: ${cap}`)
      for (const issue of c.preflight_issues) if (issue.severity === 'blocking') reasons.push(issue.message)
      if (reasons.length > 0) excluded.push({ target_id: c.target_id, location_id: c.location_id, reasons })
      else included.push({ ...c, warnings: c.preflight_issues.filter((i) => i.severity === 'warning').map((i) => i.message) })
    }
    for (const id2 of sel.target_ids ?? []) {
      if (!seen.has(id2)) excluded.push({ target_id: id2, location_id: null, reasons: ['not found in the inventory'] })
    }
    if (included.length === 0) {
      return fail('no_targets', 'No target is left after exclusions.', { excluded: excluded.map((e) => ({ target_id: e.target_id, reasons: e.reasons })) })
    }
    const phased = assignPhases(included, plan.canary, plan.batch.batch_size)
    if (!phased.ok) return phased
    const warnings = new Map(included.map((c) => [c.target_id, c.warnings]))
    const targets: IncludedTarget[] = phased.value.map((t) => ({ ...t, warnings: warnings.get(t.target_id) ?? [] }))

    const conflicts = await this.findConflicts(r, targets)
    if (conflicts.length > 0 && plan.conflict_policy === 'reject') {
      return fail('conflicting_rollout', 'Another active rollout changes the same setting on some of these targets.', {
        conflicts: conflicts.map((c) => ({ target_id: c.target_id, setting_path: c.setting_path, other_rollout_id: c.other_rollout_id })),
      })
    }
    const impact = aggregateImpact(included.map((c) => c.impact))
    // Unknown impact (no estimate for some target) needs acknowledgement too.
    const requiresAck = impact === null || included.some((c) => c.impact === null) || impact.disruption !== 'none' || impact.reboot_required || impact.reconnect_required
    const now = this.clock.now()
    const next: Rollout = { ...r, state: 'targets_resolved', targets, excluded, conflicts, impact, impact_requires_acknowledgement: requiresAck, updated_at: now }
    return this.writeRollout(r, next, [
      this.rolloutEvent(next, r.state, 'targets_resolved', actor, 'targets_resolved', {
        included: targets.length,
        excluded: excluded.map((e) => ({ target_id: e.target_id, reasons: e.reasons })),
        conflicts: conflicts.length,
      }),
    ])
  }

  /** Ask for approval, or approve at once when the risk level needs none. */
  async submit(id: string, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (r.state !== 'targets_resolved') return invalid(`Only a rollout with resolved targets can be submitted (this one is ${r.state}).`)
    const now = this.clock.now()
    if (requiredApprovals(r.plan.risk, this.rules) === 0) {
      const next = { ...r, state: 'approved' as const, updated_at: now }
      const res = await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'approved', actor, 'no_approval_required', { risk: r.plan.risk })])
      if (res.ok) await this.supersedeOlder(res.value)
      return res
    }
    const next = { ...r, state: 'pending_approval' as const, updated_at: now }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'pending_approval', actor, 'submitted')])
  }

  async approve(id: string, req: { approver: string; payload_hash: string; acknowledged_impact: boolean; note?: string }): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (r.state !== 'pending_approval') return invalid(`Only a rollout waiting for approval can be approved (this one is ${r.state}).`)
    const check = checkNewApproval(
      { payload_hash: r.payload_hash, requested_by: r.plan.requested_by, impact_requires_acknowledgement: r.impact_requires_acknowledgement, approvals: r.approvals },
      req,
    )
    if (!check.ok) return check
    const now = this.clock.now()
    const approval = { id: this.ids.next('approval'), approver: req.approver, decision: 'approve' as const, payload_hash: req.payload_hash, acknowledged_impact: req.acknowledged_impact, at: now, note: req.note ?? null }
    const withApproval: Rollout = { ...r, approvals: [...r.approvals, approval], updated_at: now }
    const status = this.approvalStatus(withApproval)
    const details = { approval_id: approval.id, acknowledged_impact: approval.acknowledged_impact, counted: status.counted.length, required: status.required }
    if (!status.satisfied) {
      return this.writeRollout(r, withApproval, [this.rolloutEvent(withApproval, r.state, r.state, req.approver, 'approval_recorded', details, 'recorded')])
    }
    const next = { ...withApproval, state: 'approved' as const }
    const res = await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'approved', req.approver, 'approved', details)])
    if (res.ok) await this.supersedeOlder(res.value)
    return res
  }

  async reject(id: string, req: { approver: string; payload_hash: string; note: string }): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (r.state !== 'pending_approval') return invalid(`Only a rollout waiting for approval can be rejected (this one is ${r.state}).`)
    const check = checkNewApproval(
      { payload_hash: r.payload_hash, requested_by: r.plan.requested_by, impact_requires_acknowledgement: false, approvals: r.approvals },
      { approver: req.approver, payload_hash: req.payload_hash, acknowledged_impact: true },
    )
    if (!check.ok) return check
    const now = this.clock.now()
    const decision = { id: this.ids.next('approval'), approver: req.approver, decision: 'reject' as const, payload_hash: req.payload_hash, acknowledged_impact: false, at: now, note: req.note }
    const next: Rollout = { ...r, approvals: [...r.approvals, decision], state: 'cancelled', updated_at: now, finished_at: now }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'cancelled', req.approver, 'rejected', { note: req.note })])
  }

  async schedule(id: string, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (!canTransitionRollout(r.state, 'scheduled')) return invalid(`Only an approved rollout can be scheduled (this one is ${r.state}).`)
    if (!this.approvalStatus(r).satisfied) return fail('approvals_missing', 'The approvals do not cover the current plan.')
    const next = { ...r, state: 'scheduled' as const, updated_at: this.clock.now() }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'scheduled', actor, 'scheduled', { not_before: r.plan.schedule.not_before })])
  }

  async pause(id: string, actor: string, reason: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (!RUNNING_ROLLOUT_STATES.has(r.state)) return invalid(`Only a running rollout can be paused (this one is ${r.state}).`)
    const next: Rollout = { ...r, state: 'paused', paused_from: r.state, pause_reason: reason, updated_at: this.clock.now() }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'paused', actor, 'paused', { note: reason })])
  }

  /** Resume after a pause. After a threshold pause this is the required human decision: failures seen so far are acknowledged. */
  async resume(id: string, actor: string, note: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if ((r.state !== 'paused' && r.state !== 'paused_by_threshold') || r.paused_from === null) return invalid(`Only a paused rollout can be resumed (this one is ${r.state}).`)
    const jobs = await this.store.listJobsByRollout(id)
    const failures = jobs.filter((j) => FAILURE_JOB_STATES.has(j.state)).length
    const byThreshold = r.state === 'paused_by_threshold'
    const next: Rollout = {
      ...r,
      state: r.paused_from,
      paused_from: null,
      pause_reason: null,
      failures_acknowledged: byThreshold ? failures : r.failures_acknowledged,
      consecutive_failures: byThreshold ? 0 : r.consecutive_failures,
      canary_override: r.canary_override || (byThreshold && r.paused_from === 'running_canary'),
      updated_at: this.clock.now(),
    }
    return this.writeRollout(r, next, [
      this.rolloutEvent(next, r.state, next.state, actor, byThreshold ? 'resumed_after_threshold' : 'resumed', { note, failures_acknowledged: next.failures_acknowledged }),
    ])
  }

  /** Stop offering; queued jobs are cancelled; jobs in flight are asked to stop when the adapter can, otherwise left to complete (recorded). */
  async cancel(id: string, actor: string, reason: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (isTerminalRollout(r.state)) return invalid(`A ${r.state} rollout cannot be cancelled.`)
    const now = this.clock.now()
    const canStop = this.adapters[r.plan.adapter]?.operations.stop === true
    const jobs = await this.store.listJobsByRollout(id)
    const writes: VersionedWrite<Job>[] = []
    const events: NewJobEvent[] = []
    for (const j of jobs) {
      if (WAITING_JOB_STATES.has(j.state)) {
        const m = this.jobMove(j, 'cancelled', actor, 'rollout_cancelled', { note: reason }, { terminal_reason: 'rollout_cancelled' })
        if (m.ok) { writes.push({ record: m.value.next, expected_version: j.version }); events.push(m.value.event) }
      } else if (LEASED_JOB_STATES.has(j.state) && j.stop === null) {
        const stop = canStop ? 'requested' as const : 'unsupported_left_to_complete' as const
        writes.push({ record: { ...j, stop, updated_at: now }, expected_version: j.version })
        events.push(this.jobEvent(j, 'recorded', j.state, j.state, actor, canStop ? 'stop_requested' : 'left_to_complete', { note: reason }))
      }
    }
    const next: Rollout = { ...r, state: 'cancelled', updated_at: now, finished_at: now, pause_reason: null }
    const res = await this.store.commit({
      rollouts: [{ record: next, expected_version: r.version }],
      jobs: writes,
      events: [this.rolloutEvent(next, r.state, 'cancelled', actor, 'cancelled', { note: reason }), ...events],
    })
    return res.ok ? ok(res.value.rollouts[0]) : res
  }

  // -------------------------------------------------------------------------------------------------
  // Tick: expire leases, start scheduled rollouts, advance phases, offer jobs.

  async tick(): Promise<TickReport> {
    const report: TickReport = { offered: [], changed: 0, conflicts: 0 }
    await this.expireLeases(report)
    for (const r of await this.store.listRollouts()) {
      if (!isTerminalRollout(r.state)) await this.advance(r.id, report)
    }
    return report
  }

  /** A target came back: revalidate its waiting jobs now (expire, supersede, block, already satisfied), then offer what may run. */
  async targetReturned(targetId: string): Promise<{ decisions: { job_id: string; decision: RevalidationDecision }[]; report: TickReport }> {
    const decisions: { job_id: string; decision: RevalidationDecision }[] = []
    for (const j of await this.store.listJobsByTarget(targetId)) {
      if (!WAITING_JOB_STATES.has(j.state)) continue
      const d = await this.revalidate(j.id)
      decisions.push({ job_id: j.id, decision: d.ok ? d.value : { action: 'wait', reason: d.error.code } })
    }
    return { decisions, report: await this.tick() }
  }

  /** Re-check a waiting job against everything that may have changed since it was queued. Applies terminal and blocking outcomes. */
  async revalidate(jobId: string): Promise<Outcome<RevalidationDecision>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    const r = await this.store.getRollout(job.rollout_id)
    if (!r) return notFound('rollout')
    const decision = await this.decide(job, r, await this.store.listRollouts())
    const applied = await this.applyDecision(job, decision)
    return applied.ok ? ok(decision) : applied
  }

  private async decide(job: Job, r: Rollout, rollouts: Rollout[]): Promise<RevalidationDecision> {
    if (!WAITING_JOB_STATES.has(job.state)) return { action: 'not_waiting', reason: job.state }
    const now = this.clock.now()
    if (r.state === 'cancelled') return { action: 'cancelled', reason: 'rollout_cancelled' }
    if (now >= this.expiresAt(r)) return { action: 'expired', reason: 'expired' }
    const newer = this.supersededBy(r, job, rollouts)
    if (newer) return { action: 'superseded', reason: `superseded_by:${newer.id}` }
    if (r.state === 'expired') return { action: 'expired', reason: 'expired' }
    if (!this.planIntact(r) || job.payload_hash !== r.payload_hash) return { action: 'blocked', reason: 'payload_changed' }
    if (!this.approvalStatus(r).satisfied) return { action: 'blocked', reason: 'approval_missing' }
    if (this.env.currentPolicyVersion(r.plan.kind) !== r.plan.policy_version) return { action: 'blocked', reason: 'policy_changed' }
    if (this.staleBase(r.plan)) return { action: 'blocked', reason: 'stale_configuration_version' }
    if (!this.env.isOnline(job.target_id)) return { action: 'wait', reason: 'offline' }
    if (now < this.notBefore(r)) return { action: 'wait', reason: 'not_yet' }
    if (!isWindowOpen(r.plan.schedule.window, now)) return { action: 'wait', reason: 'outside_maintenance_window' }
    const el = await this.env.eligibility(job.target_id, r.plan)
    if (!el.eligible) return { action: 'blocked', reason: `ineligible: ${el.reasons.join('; ') || 'no reason given'}` }
    const desired = await this.env.desiredState(job.target_id, job.location_id, r.plan)
    if (desired === 'satisfied') return { action: 'already_satisfied', reason: 'already_satisfied' }
    return { action: 'offerable' }
  }

  private async applyDecision(job: Job, d: RevalidationDecision): Promise<Outcome<Job | null>> {
    const actor = this.system
    switch (d.action) {
      case 'expired':
      case 'cancelled':
      case 'already_satisfied': {
        const m = this.jobMove(job, d.action, actor, d.reason, {}, { terminal_reason: d.reason, blocked_reason: null })
        return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
      }
      case 'superseded': {
        const by = d.reason.slice('superseded_by:'.length)
        const m = this.jobMove(job, 'superseded', actor, d.reason, { superseded_by: by }, { terminal_reason: 'superseded', superseded_by: by, blocked_reason: null })
        return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
      }
      case 'blocked': {
        if (job.state === 'blocked' && job.blocked_reason === d.reason) return ok(null)
        if (job.state === 'blocked') {
          const next = { ...job, blocked_reason: d.reason, updated_at: this.clock.now() }
          return this.writeJob(job, next, [this.jobEvent(job, 'recorded', 'blocked', 'blocked', actor, d.reason)])
        }
        const m = this.jobMove(job, 'blocked', actor, d.reason, {}, { blocked_reason: d.reason })
        return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
      }
      default:
        return ok(null)
    }
  }

  private async advance(rolloutId: string, report: TickReport): Promise<void> {
    let r = await this.store.getRollout(rolloutId)
    if (!r || isTerminalRollout(r.state)) return
    const now = this.clock.now()
    const step = async (res: Outcome<Rollout>): Promise<boolean> => {
      if (!res.ok) { report.conflicts += 1; return false }
      report.changed += 1
      r = res.value
      return true
    }

    if (PRE_START_EXPIRABLE.has(r.state) && now >= this.expiresAt(r)) {
      const next: Rollout = { ...r, state: 'expired', updated_at: now, finished_at: now }
      await step(await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'expired', this.system, 'expired_before_start')]))
      return
    }
    if (r.state === 'scheduled') {
      if (now < this.notBefore(r)) return
      if (!(await step(await this.startRollout(r)))) return
    }
    if (!STARTED.has(r.state)) return

    let jobs = await this.store.listJobsByRollout(rolloutId)
    if (now >= this.expiresAt(r)) {
      const writes: VersionedWrite<Job>[] = []
      const events: NewJobEvent[] = []
      for (const j of jobs) {
        if (!WAITING_JOB_STATES.has(j.state)) continue
        const m = this.jobMove(j, 'expired', this.system, 'expired', {}, { terminal_reason: 'expired', blocked_reason: null })
        if (m.ok) { writes.push({ record: m.value.next, expected_version: j.version }); events.push(m.value.event) }
      }
      const next: Rollout = { ...r, state: 'expired', updated_at: now, finished_at: now }
      const res = await this.store.commit({ rollouts: [{ record: next, expected_version: r.version }], jobs: writes, events: [this.rolloutEvent(next, r.state, 'expired', this.system, 'expired'), ...events] })
      if (!res.ok) report.conflicts += 1
      else report.changed += 1 + writes.length
      return
    }

    // Cheap sweep: supersession and cancellation of waiting jobs, without asking any device.
    const rollouts = await this.store.listRollouts()
    for (const j of jobs) {
      if (!WAITING_JOB_STATES.has(j.state)) continue
      const newer = this.supersededBy(r, j, rollouts)
      if (!newer) continue
      const res = await this.applyDecision(j, { action: 'superseded', reason: `superseded_by:${newer.id}` })
      if (res.ok) report.changed += 1
      else report.conflicts += 1
    }
    jobs = await this.store.listJobsByRollout(rolloutId)

    // Failure accounting in the order jobs finished.
    const counted = new Set(r.counted_jobs)
    const newly = jobs.filter((j) => isTerminalJob(j.state) && !counted.has(j.id)).sort((a, b) => (a.finished_at ?? 0) - (b.finished_at ?? 0) || a.order - b.order)
    if (newly.length > 0) {
      let consecutive = r.consecutive_failures
      for (const j of newly) {
        if (FAILURE_JOB_STATES.has(j.state)) consecutive += 1
        else if (SUCCESS_JOB_STATES.has(j.state)) consecutive = 0
      }
      const next: Rollout = { ...r, consecutive_failures: consecutive, counted_jobs: [...r.counted_jobs, ...newly.map((j) => j.id)], updated_at: now }
      if (!(await step(await this.writeRollout(r, next, [])))) return
    }

    if (!RUNNING_ROLLOUT_STATES.has(r.state)) return // paused: nothing more until a human decides

    const final = finalRolloutState(jobs)
    if (final) {
      const s = summarize(r, jobs)
      const next: Rollout = { ...r, state: final, updated_at: now, finished_at: now }
      await step(await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, final, this.system, 'all_targets_finished', summaryDetails(s))]))
      return
    }

    // Failure-stop thresholds.
    const failures = jobs.filter((j) => FAILURE_JOB_STATES.has(j.state)).length
    const finished = jobs.filter((j) => FAILURE_JOB_STATES.has(j.state) || SUCCESS_JOB_STATES.has(j.state)).length
    const breach = thresholdBreach(r.plan.thresholds, { failures, acknowledged: r.failures_acknowledged, consecutive: r.consecutive_failures, finished })
    if (breach) {
      await step(await this.pauseByThreshold(r, breach))
      return
    }

    // Phase advance.
    if (r.state === 'running_canary') {
      const canary = jobs.filter((j) => j.phase === 'canary')
      if (canary.every((j) => isTerminalJob(j.state))) {
        const bad = canary.filter((j) => !CANARY_PASS.has(j.state))
        if (bad.length > 0 && !r.canary_override) {
          await step(await this.pauseByThreshold(r, `canary did not verify on ${bad.map((j) => `${j.target_id} (${j.state})`).join(', ')}`))
          return
        }
        if (r.phase_finished_at === null) {
          if (!(await step(await this.writeRollout(r, { ...r, phase_finished_at: now, updated_at: now }, [])))) return
        }
        const soak = r.plan.canary.mode === 'none' ? 0 : r.plan.canary.soak_ms
        if (r.phase_finished_at !== null && now >= r.phase_finished_at + soak) {
          const next: Rollout = { ...r, state: 'running_batches', current_batch: 0, phase_finished_at: null, updated_at: now }
          if (!(await step(await this.writeRollout(r, next, [this.rolloutEvent(next, 'running_canary', 'running_batches', this.system, 'canary_passed', { soak_ms: soak })])))) return
        }
      }
    }
    if (r.state === 'running_batches') {
      const lastBatch = Math.max(-1, ...jobs.map((j) => (typeof j.phase === 'number' ? j.phase : -1)))
      for (;;) {
        if (r.current_batch > lastBatch) {
          const next: Rollout = { ...r, state: 'verifying', updated_at: now }
          await step(await this.writeRollout(r, next, [this.rolloutEvent(next, 'running_batches', 'verifying', this.system, 'all_batches_offered')]))
          break
        }
        const batch = jobs.filter((j) => j.phase === r!.current_batch)
        if (!batch.every((j) => this.settled(j))) break
        if (r.phase_finished_at === null) {
          if (!(await step(await this.writeRollout(r, { ...r, phase_finished_at: now, updated_at: now }, [])))) return
        }
        if (now < (r.phase_finished_at ?? now) + r.plan.batch.batch_soak_ms) break
        const nextBatch = r.current_batch + 1
        const next: Rollout = { ...r, current_batch: nextBatch, phase_finished_at: null, updated_at: now }
        if (!(await step(await this.writeRollout(r, next, nextBatch <= lastBatch ? [this.rolloutEvent(next, r.state, r.state, this.system, 'batch_started', { batch: nextBatch }, 'recorded')] : [])))) return
      }
    }

    await this.offerJobs(r, report)
  }

  /** A batch counts as settled when each job is finished, unknown (held visibly) or waiting for an offline target. */
  private settled(j: Job): boolean {
    if (isTerminalJob(j.state) || j.state === 'unknown' || j.state === 'reconciling') return true
    return WAITING_JOB_STATES.has(j.state) && (j.state === 'blocked' || !this.env.isOnline(j.target_id))
  }

  private async startRollout(r: Rollout): Promise<Outcome<Rollout>> {
    const now = this.clock.now()
    if (!this.approvalStatus(r).satisfied) {
      await this.store.commit({ events: [this.rolloutEvent(r, r.state, r.state, this.system, 'approvals_missing', {}, 'rejected')] })
      return fail('approvals_missing', 'The approvals do not cover the current plan.')
    }
    const jobs: Job[] = r.targets.map((t) => {
      const id = this.ids.next('job')
      return {
        id, version: 0, rollout_id: r.id, rollout_seq: r.seq, adapter: r.plan.adapter, target_id: t.target_id, location_id: t.location_id,
        payload_hash: r.payload_hash, idempotency_key: `${id}:${r.payload_hash}`, supersedes_key: r.plan.supersedes_key,
        setting_paths: [...r.plan.setting_paths], phase: t.phase, order: t.order, state: 'queued', attempt: 0, max_attempts: r.plan.max_attempts,
        lease: null, reconcile_lease: null, reconcile_attempts: 0, last_reconcile: null, verify_attempts: 0, applied: false, partial: false, last_result: null,
        verification: null, snapshot: null, rollback: null, stop: null, blocked_reason: null, terminal_reason: null, superseded_by: null,
        recovery_actions: [], created_at: now, updated_at: now, finished_at: null,
      }
    })
    const hasCanary = r.targets.some((t) => t.phase === 'canary')
    const to: RolloutState = hasCanary ? 'running_canary' : 'running_batches'
    const next: Rollout = { ...r, state: to, current_batch: hasCanary ? -1 : 0, phase_finished_at: null, started_at: now, updated_at: now }
    const cs: Changeset = {
      rollouts: [{ record: next, expected_version: r.version }],
      jobs: jobs.map((j) => ({ record: j, expected_version: null })),
      events: [
        this.rolloutEvent(next, r.state, to, this.system, 'started', { jobs: jobs.length }),
        ...jobs.map((j) => this.jobEvent(j, 'transition', null, 'queued', this.system, 'requested', { phase: j.phase === 'canary' ? 'canary' : `batch ${j.phase}` })),
      ],
    }
    const res = await this.store.commit(cs)
    return res.ok ? ok(res.value.rollouts[0]) : res
  }

  private async pauseByThreshold(r: Rollout, reason: string): Promise<Outcome<Rollout>> {
    const next: Rollout = { ...r, state: 'paused_by_threshold', paused_from: r.state, pause_reason: reason, updated_at: this.clock.now() }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'paused_by_threshold', this.system, 'paused_by_threshold', { threshold: reason })])
  }

  private async offerJobs(r: Rollout, report: TickReport): Promise<void> {
    if (!RUNNING_ROLLOUT_STATES.has(r.state)) return
    const now = this.clock.now()
    if (now < this.notBefore(r) || !isWindowOpen(r.plan.schedule.window, now)) return
    const eligiblePhase = (j: Job) =>
      r.state === 'verifying' ? true : r.state === 'running_canary' ? j.phase === 'canary' : j.phase === 'canary' || (j.phase as number) <= r.current_batch
    const jobs = await this.store.listJobsByRollout(r.id)
    const waiting = jobs.filter((j) => WAITING_JOB_STATES.has(j.state) && eligiblePhase(j)).sort((a, b) => a.order - b.order)
    if (waiting.length === 0) return

    const active = await this.store.listJobsInStates([...ACTIVE_JOB_STATES])
    const busyTargets = new Set(active.map((j) => j.target_id))
    const perLocation = new Map<string, number>()
    const unknownAt = new Set<string>()
    for (const j of active) {
      perLocation.set(j.location_id, (perLocation.get(j.location_id) ?? 0) + 1)
      if (j.state === 'unknown' || j.state === 'reconciling') unknownAt.add(j.location_id)
    }
    let mine = active.filter((j) => j.rollout_id === r.id).length
    const rollouts = await this.store.listRollouts()
    const heldByEarlier = await this.targetsHeldByEarlierConflicts(r, rollouts)
    const b = r.plan.batch
    for (const j of waiting) {
      if (mine >= b.global_concurrency) break
      if (busyTargets.has(j.target_id)) continue
      if ((perLocation.get(j.location_id) ?? 0) >= b.per_location_concurrency) continue
      if (b.block_location_on_unknown && unknownAt.has(j.location_id)) continue
      if (!this.env.isOnline(j.target_id)) continue
      if (heldByEarlier.has(j.target_id)) continue
      const decision = await this.decide(j, r, rollouts)
      if (decision.action !== 'offerable') {
        const res = await this.applyDecision(j, decision)
        if (!res.ok) report.conflicts += 1
        else if (res.value) report.changed += 1
        continue
      }
      const lease = { token: this.ids.next('lease'), until: now + this.offerLeaseMs, attempt: j.attempt + 1 }
      const m = this.jobMove(j, 'offered', this.system, j.state === 'blocked' ? 'revalidated_and_offered' : 'offered', {
        lease_fingerprint: tokenFingerprint(lease.token),
        attempt: lease.attempt,
        lease_until: lease.until,
      }, { lease, attempt: lease.attempt, blocked_reason: null })
      if (!m.ok) continue
      const res = await this.writeJob(j, m.value.next, [m.value.event])
      if (!res.ok) { report.conflicts += 1; continue }
      report.changed += 1
      report.offered.push(res.value)
      mine += 1
      busyTargets.add(j.target_id)
      perLocation.set(j.location_id, (perLocation.get(j.location_id) ?? 0) + 1)
    }
  }

  private async expireLeases(report: TickReport): Promise<void> {
    const now = this.clock.now()
    for (const j of await this.store.listJobsInStates(['offered', 'acked', 'running', 'reconciling'])) {
      const lease = j.state === 'reconciling' ? j.reconcile_lease : j.lease
      if (!lease || now <= lease.until) continue
      const reason = j.state === 'reconciling' ? 'reconcile_timeout' : j.state === 'offered' ? 'acknowledgement_lost' : 'lease_expired'
      const m = this.jobMove(j, 'unknown', this.system, reason, { was: j.state, lease_fingerprint: tokenFingerprint(lease.token) }, j.state === 'reconciling' ? { reconcile_lease: null } : { lease: null })
      if (!m.ok) continue
      const res = await this.writeJob(j, m.value.next, [m.value.event])
      if (res.ok) report.changed += 1
      else report.conflicts += 1
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Job protocol (offer → ack → running → result → verification; unknown → reconcile)

  async ack(jobId: string, token: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'ack')
    if (job.state !== 'offered') return ok(job) // duplicate acknowledgement
    const m = this.jobMove(job, 'acked', this.system, 'acknowledged', { lease_fingerprint: tokenFingerprint(token) }, { lease: { ...job.lease!, until: this.clock.now() + this.runLeaseMs } })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  async start(jobId: string, token: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'start')
    if (job.state === 'running') return ok(job)
    const m = this.jobMove(job, 'running', this.system, 'started', { lease_fingerprint: tokenFingerprint(token) }, { lease: { ...job.lease!, until: this.clock.now() + this.runLeaseMs } })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  async heartbeat(jobId: string, token: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'heartbeat')
    const next = { ...job, lease: { ...job.lease!, until: this.clock.now() + this.runLeaseMs }, updated_at: this.clock.now() }
    return this.writeJob(job, next, [])
  }

  async recordSnapshot(jobId: string, token: string, snap: { status: 'taken'; ref: string } | { status: 'unsupported' } | { status: 'failed' }): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'snapshot')
    const snapshot = { status: snap.status, ref: snap.status === 'taken' ? snap.ref : null }
    const next = { ...job, snapshot, updated_at: this.clock.now() }
    return this.writeJob(job, next, [this.jobEvent(job, 'recorded', job.state, job.state, this.system, `snapshot_${snap.status}`)])
  }

  async reportResult(jobId: string, token: string, result: { outcome: ResultOutcome; message: string }): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.last_result && job.last_result.token === token) {
      if (job.last_result.outcome === result.outcome) return ok(job) // duplicate delivery
      await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'conflicting_duplicate', { first: job.last_result.outcome, second: result.outcome, lease_fingerprint: tokenFingerprint(token) })] })
      return fail('conflicting_duplicate', 'A different result was already recorded for this delivery; the first one stands.')
    }
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'result')
    const now = this.clock.now()
    const last_result = { token, outcome: result.outcome, at: now }
    const details = { outcome: result.outcome, message: result.message, lease_fingerprint: tokenFingerprint(token) }
    let m: Outcome<{ next: Job; event: NewJobEvent }>
    switch (result.outcome) {
      case 'applied':
        m = this.jobMove(job, 'verifying', this.system, 'result_applied', details, { last_result, applied: true, lease: null })
        break
      case 'failed':
        m = job.stop === 'requested'
          ? this.jobMove(job, 'cancelled', this.system, 'stopped_on_cancel', details, { last_result, lease: null, terminal_reason: 'stopped_on_cancel' })
          : this.jobMove(job, 'failed', this.system, 'result_failed', details, { last_result, lease: null, terminal_reason: 'apply_failed' })
        break
      case 'partial':
        m = this.jobMove(job, 'partially_applied', this.system, 'result_partial', details, { last_result, partial: true, lease: null, terminal_reason: 'partial_application' })
        break
      default:
        m = this.jobMove(job, 'unknown', this.system, 'result_unknown', details, { last_result, lease: null })
    }
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  async recordVerification(jobId: string, v: { outcome: VerifyOutcome; expected: JsonObject; observed: JsonObject }): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.state !== 'verifying') {
      if (isTerminalJob(job.state) && job.verification?.outcome === v.outcome) return ok(job) // duplicate
      return invalid(`A ${job.state} job cannot take a verification result.`)
    }
    const now = this.clock.now()
    const verification = { outcome: v.outcome, expected: redactDetails(v.expected), observed: redactDetails(v.observed), at: now }
    const details = { outcome: v.outcome, expected: verification.expected, observed: verification.observed }
    if (v.outcome === 'inconclusive') {
      const attempts = job.verify_attempts + 1
      if (attempts < this.maxVerifyAttempts) {
        const next = { ...job, verify_attempts: attempts, verification, updated_at: now }
        return this.writeJob(job, next, [this.jobEvent(job, 'recorded', 'verifying', 'verifying', this.system, 'verification_inconclusive', details)])
      }
      const m = this.jobMove(job, 'accepted_but_not_verified', this.system, 'verification_inconclusive_limit', details, { verify_attempts: attempts, verification, terminal_reason: 'not_verifiable' })
      return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
    }
    const to: JobState = v.outcome === 'match' ? 'verified' : v.outcome === 'mismatch' ? 'verification_failed' : 'accepted_but_not_verified'
    const m = this.jobMove(job, to, this.system, `verification_${v.outcome}`, details, {
      verify_attempts: job.verify_attempts + 1,
      verification,
      terminal_reason: to === 'verified' ? null : to === 'verification_failed' ? 'observed_differs_from_expected' : 'verification_unsupported',
    })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  /** Open a reconcile request for an unknown job: the device is asked what it did with this idempotency key. */
  async beginReconcile(jobId: string): Promise<Outcome<{ job: Job; token: string; idempotency_key: string }>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.state !== 'unknown') return invalid(`Only an unknown job can be reconciled (this one is ${job.state}).`)
    const lease = { token: this.ids.next('reconcile'), until: this.clock.now() + this.reconcileLeaseMs, attempt: job.reconcile_attempts + 1 }
    const m = this.jobMove(job, 'reconciling', this.system, 'reconcile_requested', { lease_fingerprint: tokenFingerprint(lease.token), reconcile_attempt: lease.attempt }, { reconcile_lease: lease, reconcile_attempts: lease.attempt })
    if (!m.ok) return m
    const res = await this.writeJob(job, m.value.next, [m.value.event])
    return res.ok ? ok({ job: res.value, token: lease.token, idempotency_key: job.idempotency_key }) : res
  }

  async recordReconcile(jobId: string, token: string, outcome: ReconcileOutcome): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.last_reconcile && job.last_reconcile.token === token) {
      if (job.last_reconcile.outcome === outcome) return ok(job)
      await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'conflicting_duplicate', { first: job.last_reconcile.outcome, second: outcome })] })
      return fail('conflicting_duplicate', 'A different reconcile answer was already recorded; the first one stands.')
    }
    if (job.state !== 'reconciling' || job.reconcile_lease?.token !== token) return this.rejectStale(job, token, 'reconcile')
    const r = await this.store.getRollout(job.rollout_id)
    const now = this.clock.now()
    const base = { reconcile_lease: null, last_reconcile: { token, outcome } }
    const details = { outcome, lease_fingerprint: tokenFingerprint(token) }
    let m: Outcome<{ next: Job; event: NewJobEvent }>
    if (outcome === 'applied') m = this.jobMove(job, 'verifying', this.system, 'reconciled_applied', details, { ...base, applied: true })
    else if (outcome === 'partial') m = this.jobMove(job, 'partially_applied', this.system, 'reconciled_partial', details, { ...base, partial: true, terminal_reason: 'partial_application' })
    else if (outcome === 'unknown') m = this.jobMove(job, 'unknown', this.system, 'reconciled_unknown', details, base)
    else if (r?.state === 'cancelled') m = this.jobMove(job, 'cancelled', this.system, 'reconciled_not_applied', details, { ...base, terminal_reason: 'rollout_cancelled' })
    else if (!r || r.state === 'expired' || now >= this.expiresAt(r)) m = this.jobMove(job, 'expired', this.system, 'reconciled_not_applied', details, { ...base, terminal_reason: 'expired' })
    else if (job.attempt >= job.max_attempts) m = this.jobMove(job, 'failed', this.system, 'reconciled_not_applied', details, { ...base, terminal_reason: 'attempts_exhausted' })
    else m = this.jobMove(job, 'queued', this.system, 'reconciled_not_applied', details, { ...base, lease: null })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  /** An operator settles an unknown or blocked job by hand (after checking the device). */
  async resolveManually(jobId: string, actor: string, note: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    const m = this.jobMove(job, 'resolved_manually', actor, 'resolved_manually', { note }, { terminal_reason: 'resolved_manually', reconcile_lease: null })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  /** Record the outcome of restoring a snapshot for a failed job (state stays; the recovery record changes). */
  async recordRollback(jobId: string, actor: string, status: 'restored' | 'failed' | 'unsupported'): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!FAILURE_JOB_STATES.has(job.state)) return invalid('Only a failed job can be rolled back.')
    if (job.snapshot?.status !== 'taken') return fail('not_allowed', 'There is no snapshot to restore for this job.')
    const next: Job = { ...job, rollback: { status, at: this.clock.now() }, updated_at: this.clock.now() }
    next.recovery_actions = recoveryActionsFor(next, { rollback: this.rollbackSupported(job) })
    return this.writeJob(job, next, [this.jobEvent(job, 'recorded', job.state, job.state, actor, `rollback_${status}`)])
  }

  // -------------------------------------------------------------------------------------------------
  // Helpers

  private holdsLease(job: Job, token: string): boolean {
    return LEASED_JOB_STATES.has(job.state) && job.lease !== null && job.lease.token === token
  }

  private async rejectStale<T>(job: Job, token: string, what: string): Promise<Outcome<T>> {
    await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'stale_lease', { message: what, lease_fingerprint: tokenFingerprint(token) })] })
    return fail('stale_lease', 'This lease is no longer valid for the job; the message was ignored and logged.')
  }

  private rollbackSupported(job: Job): boolean {
    return this.adapters[job.adapter]?.operations.rollback === true
  }

  private jobMove(job: Job, to: JobState, actor: string, reason: string, details: JsonObject = {}, patch: Partial<Job> = {}): Outcome<{ next: Job; event: NewJobEvent }> {
    if (!canTransitionJob(job.state, to)) return invalid(`A job cannot go from ${job.state} to ${to}.`)
    const now = this.clock.now()
    const next: Job = { ...job, ...patch, state: to, updated_at: now, finished_at: isTerminalJob(to) ? now : null }
    next.recovery_actions = recoveryActionsFor(next, { rollback: this.rollbackSupported(job) })
    return ok({ next, event: this.jobEvent(job, 'transition', job.state, to, actor, reason, details) })
  }

  private async writeJob(prev: Job, next: Job, events: NewJobEvent[]): Promise<Outcome<Job>> {
    const res = await this.store.commit({ jobs: [{ record: next, expected_version: prev.version }], events })
    return res.ok ? ok(res.value.jobs[0]) : res
  }

  private async writeRollout(prev: Rollout, next: Rollout, events: NewJobEvent[]): Promise<Outcome<Rollout>> {
    if (next.state !== prev.state && !canTransitionRollout(prev.state, next.state)) return invalid(`A rollout cannot go from ${prev.state} to ${next.state}.`)
    const res = await this.store.commit({ rollouts: [{ record: next, expected_version: prev.version }], events })
    return res.ok ? ok(res.value.rollouts[0]) : res
  }

  private rolloutEvent(r: Rollout, from: RolloutState | null, to: RolloutState, actor: string, reason: string, details: JsonObject = {}, type: JobEvent['type'] = 'transition'): NewJobEvent {
    return { at: this.clock.now(), actor, entity: 'rollout', rollout_id: r.id, job_id: null, target_id: null, type, from, to, reason, payload_hash: r.payload_hash, details: redactDetails(details) }
  }

  private jobEvent(j: Job, type: JobEvent['type'], from: JobState | null, to: JobState, actor: string, reason: string, details: JsonObject = {}): NewJobEvent {
    return { at: this.clock.now(), actor, entity: 'job', rollout_id: j.rollout_id, job_id: j.id, target_id: j.target_id, type, from, to, reason, payload_hash: j.payload_hash, details: redactDetails(details) }
  }

  private planIntact(r: Rollout): boolean {
    try {
      return payloadHash(r.plan) === r.payload_hash
    } catch {
      return false
    }
  }

  private staleBase(plan: Plan): string | null {
    if (!plan.base_version) return null
    const current = this.env.currentBaseVersion(plan.base_version.key)
    if (current !== null && current > plan.base_version.version) {
      return `Stale configuration version: this rollout was built on version ${plan.base_version.version} of "${plan.base_version.key}", but version ${current} exists.`
    }
    return null
  }

  private expiresAt(r: Rollout): number {
    return parseZonedInstant(r.plan.expires_at) ?? -Infinity
  }

  private notBefore(r: Rollout): number {
    return parseZonedInstant(r.plan.schedule.not_before) ?? Infinity
  }

  private supersededBy(r: Rollout, job: Job, rollouts: Rollout[]): Rollout | null {
    const key = r.plan.supersedes_key
    if (key === null) return null
    return rollouts.find((o) => o.id !== r.id && o.seq > r.seq && o.plan.supersedes_key === key && SUPERSEDING.has(o.state) && o.targets.some((t) => t.target_id === job.target_id)) ?? null
  }

  /** When a rollout is approved, queued jobs of older rollouts with the same key on the same targets are superseded at once. */
  private async supersedeOlder(newer: Rollout): Promise<void> {
    const key = newer.plan.supersedes_key
    if (key === null) return
    const targets = new Set(newer.targets.map((t) => t.target_id))
    for (const o of await this.store.listRollouts()) {
      if (o.id === newer.id || o.seq >= newer.seq || o.plan.supersedes_key !== key) continue
      for (const j of await this.store.listJobsByRollout(o.id)) {
        if (WAITING_JOB_STATES.has(j.state) && targets.has(j.target_id)) await this.applyDecision(j, { action: 'superseded', reason: `superseded_by:${newer.id}` })
      }
    }
  }

  private conflictsWith(r: Rollout, o: Rollout): boolean {
    if (o.id === r.id) return false
    const sameKey = r.plan.supersedes_key !== null && r.plan.supersedes_key === o.plan.supersedes_key
    return !sameKey && r.plan.setting_paths.some((a) => o.plan.setting_paths.some((b) => pathsOverlap(a, b)))
  }

  private async findConflicts(r: Rollout, targets: IncludedTarget[]): Promise<RolloutConflict[]> {
    const out: RolloutConflict[] = []
    const mine = new Set(targets.map((t) => t.target_id))
    for (const o of await this.store.listRollouts()) {
      if (!CONFLICT_HOLDING.has(o.state) || !this.conflictsWith(r, o)) continue
      const paths = r.plan.setting_paths.filter((a) => o.plan.setting_paths.some((b) => pathsOverlap(a, b)))
      for (const t of o.targets) if (mine.has(t.target_id)) for (const p of paths) out.push({ target_id: t.target_id, setting_path: p, other_rollout_id: o.id })
    }
    return out
  }

  /**
   * Targets on which an earlier (lower seq) conflicting rollout still has unfinished work. Conflicting jobs on one
   * target run strictly in rollout order, whatever the conflict policy, so two rollouts never overwrite each other
   * concurrently (with policy "reject" such a pair is normally refused at target resolution already).
   */
  private async targetsHeldByEarlierConflicts(r: Rollout, rollouts: Rollout[]): Promise<Set<string>> {
    const held = new Set<string>()
    for (const o of rollouts) {
      if (o.seq >= r.seq || !CONFLICT_HOLDING.has(o.state) || !this.conflictsWith(r, o)) continue
      if (!STARTED.has(o.state)) {
        for (const t of o.targets) held.add(t.target_id) // the earlier rollout has not started: it goes first
        continue
      }
      for (const j of await this.store.listJobsByRollout(o.id)) if (!isTerminalJob(j.state)) held.add(j.target_id)
    }
    return held
  }
}

function notFound<T>(what: 'rollout' | 'job'): Outcome<T> {
  return fail('not_found', `No such ${what}.`)
}

function invalid<T>(message: string): Outcome<T> {
  return fail('invalid_transition', message)
}

function aggregateImpact(list: (ImpactEstimate | null)[]): ImpactEstimate | null {
  const known = list.filter((i): i is ImpactEstimate => i !== null)
  if (known.length === 0) return null
  const missing = list.length - known.length
  let disruption: ImpactEstimate['disruption'] = 'none'
  for (const i of known) if (DISRUPTION_RANK[i.disruption] > DISRUPTION_RANK[disruption]) disruption = i.disruption
  return {
    disruption,
    reboot_required: known.some((i) => i.reboot_required),
    reconnect_required: known.some((i) => i.reconnect_required),
    estimated_downtime_s: Math.max(0, ...known.map((i) => i.estimated_downtime_s)),
    notes: [...new Set(known.flatMap((i) => i.notes)), ...(missing > 0 ? [`No impact estimate for ${missing} target(s).`] : [])],
  }
}

function summaryDetails(s: RolloutSummary): JsonObject {
  return {
    requested: s.requested, applied: s.applied, verified: s.verified, already_satisfied: s.already_satisfied,
    accepted_but_not_verified: s.accepted_but_not_verified, failed: s.failed, unknown: s.unknown, superseded: s.superseded,
  }
}
