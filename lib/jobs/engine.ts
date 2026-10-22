// The rollout and job orchestration engine (P7-0, review round 1).
//
// A deterministic state machine over an injected JobStore, clock, id generator and environment. It never
// calls a device: adapters are driven by the runner (lib/jobs/runner.ts) or by the agent API, which report
// what happened through the protocol methods here. Every state change is checked against the transition
// tables, written with compare-and-set on the record version, and appended to the event log in the same commit.
//
// Offering is safe by construction:
// - single writer: offers are made only by `tick` and `targetReturned`, which run one at a time per engine
//   (in-process lock) and must carry the offering-lease fence; the store refuses a stale fence;
// - guarded commits: every offer commit is guarded by the versions of the counter slots it read (target,
//   location, rollout-active) and of the rollout row, so two writers that both saw a free location cannot
//   both offer, and no offer lands after a pause or cancel has committed.
import type { AdapterCapabilities } from './adapter'
import {
  DEFAULT_APPROVAL_RULES, approvalSubject, checkNewApproval, evaluateApprovals, impactRisk, maxRisk, requiredApprovals,
  type ApprovalEvaluation, type ApprovalRules,
} from './approvals'
import { canonicalize, findNonNfc, sha256Hex, type JsonObject } from './canonical'
import type { Clock, IdGenerator } from './engine-deps'
import {
  ACTIVE_JOB_STATES, FAILURE_JOB_STATES, LEASED_JOB_STATES, RUNNING_ROLLOUT_STATES, SUCCESS_JOB_STATES, WAITING_JOB_STATES,
  canTransitionJob, canTransitionRollout, isTerminalJob, isTerminalRollout,
} from './machines'
import { pathsOverlap } from './paths'
import { adapterFor, effectiveSettingPaths, kindFor, own, payloadHash, validatePlan } from './plan'
import { assignPhases, finalRolloutState, recoveryActionsFor, summarize, thresholdBreach, type RolloutSummary } from './planner'
import { MAX_MESSAGE_LENGTH, hashFingerprint, redactDetails, redactText, tokenHash, tokenMatches } from './redact'
import type { Guard, JobStore } from './store'
import {
  fail, ok,
  type ExcludedTarget, type Fence, type ImpactEstimate, type IncludedTarget, type Job, type JobEvent, type JobState, type Lease,
  type NewJobEvent, type OfferedJob, type Outcome, type Plan, type ReconcileOutcome, type ResultOutcome, type RiskLevel, type Rollout,
  type RolloutConflict, type RolloutState, type SnapshotRecord, type TargetCandidate, type VerifyOutcome,
} from './types'
import { isWindowOpen, parseZonedInstant } from './window'

/** What the engine needs to know about the world. Supplied by the hub (database, presence, capability matrix) or by tests. */
export interface EngineEnvironment {
  /** The current execution policy version for a plan kind. */
  currentPolicyVersion(kind: string): number
  /** The newest configuration version for a base key (e.g. a Wi-Fi profile id), or null if unknown (an unknown key fails the stale check). */
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
  /** Policy minimum risk per kind (on top of the adapter's minimum). */
  kind_min_risk?: Record<string, RiskLevel>
  /** How long an offer may wait for its acknowledgement. */
  offer_lease_ms?: number
  /** Lease after acknowledgement, start or heartbeat. */
  run_lease_ms?: number
  /** How long a reconcile request may wait for its answer. */
  reconcile_lease_ms?: number
  /** First wait between automatic reconcile requests; doubles each time up to the maximum. */
  reconcile_backoff_ms?: number
  reconcile_backoff_max_ms?: number
  /** Automatic reconcile requests before a human must decide. */
  max_reconcile_attempts?: number
  /** Deadline for verification after a job reached `verifying`. */
  verify_deadline_ms?: number
  /** What an overdue verification becomes. */
  verification_overdue?: 'accepted_but_not_verified' | 'unknown'
  /** Inconclusive verifications before a job is "accepted but not verified". */
  max_verify_attempts?: number
  /** How long a rollout may hold its targets between target resolution and approval. */
  max_pending_approval_ms?: number
  /** Longest plan validity (expiry minus now). */
  max_horizon_ms?: number
  /** Jobs written per commit when cancelling. */
  cancel_batch_size?: number
  /** Freshness of the cached "already satisfied" probe. */
  desired_state_cache_ms?: number
  /** Actor recorded for automatic changes. */
  system_actor?: string
}

export interface TickReport {
  offered: OfferedJob[]
  /** Records written. */
  changed: number
  /** Compare-and-set, guard or fence conflicts met (another writer was faster, or the fence is stale). */
  conflicts: number
}

export type RevalidationDecision =
  | { action: 'offerable' }
  | { action: 'wait'; reason: string }
  | { action: 'expired' | 'cancelled' | 'already_satisfied'; reason: string }
  | { action: 'superseded'; reason: string; by_rollout: string }
  | { action: 'blocked'; reason: string }
  | { action: 'not_waiting'; reason: string }

export const OFFERING_LEASE = 'offering'

const PRE_START_EXPIRABLE: ReadonlySet<RolloutState> = new Set(['targets_resolved', 'pending_approval', 'approved', 'scheduled'])
const AMENDABLE: ReadonlySet<RolloutState> = new Set(['draft', 'validated', 'targets_resolved', 'pending_approval', 'approved', 'scheduled'])
const STARTED: ReadonlySet<RolloutState> = new Set(['running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold'])
const CONFLICT_HOLDING: ReadonlySet<RolloutState> = new Set([
  'targets_resolved', 'pending_approval', 'approved', 'scheduled', 'running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold',
])
const CANARY_PASS: ReadonlySet<JobState> = new Set(['verified', 'already_satisfied', 'superseded'])
const RELEASABLE: ReadonlySet<JobState> = new Set(['unknown', 'reconciling', 'verifying'])
const DISRUPTION_RANK = { none: 0, brief: 1, service_interruption: 2 } as const
export const EFFECTIVE_HASH_DOMAIN = 'drishti.effective.v1'

const slotKeys = (j: Pick<Job, 'target_id' | 'location_id' | 'rollout_id'>) => [`target:${j.target_id}`, `location:${j.location_id}`, `rollout-active:${j.rollout_id}`]

/** Slots a job write changes: entering or leaving an active state changes the counters of its target, location and rollout. */
function bumpsFor(prev: Job | null, next: Job): string[] {
  const was = prev !== null && ACTIVE_JOB_STATES.has(prev.state)
  return was !== ACTIVE_JOB_STATES.has(next.state) ? slotKeys(next) : []
}

interface Ctx {
  fence?: Fence
  report: TickReport
}

export class JobEngine {
  private readonly store: JobStore
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly env: EngineEnvironment
  private readonly adapters: Record<string, AdapterCapabilities>
  private readonly rules: ApprovalRules
  private readonly kindMinRisk: Record<string, RiskLevel>
  private readonly o: Required<Omit<EngineOptions, 'store' | 'clock' | 'ids' | 'env' | 'adapters' | 'approval_rules' | 'kind_min_risk'>>
  private offerLock: Promise<unknown> = Promise.resolve()
  private readonly desiredCache = new Map<string, { result: 'satisfied' | 'not_satisfied' | 'unknown'; at: number }>()

  constructor(o: EngineOptions) {
    this.store = o.store
    this.clock = o.clock
    this.ids = o.ids
    this.env = o.env
    this.adapters = o.adapters
    this.rules = o.approval_rules ?? DEFAULT_APPROVAL_RULES
    this.kindMinRisk = o.kind_min_risk ?? {}
    this.o = {
      offer_lease_ms: o.offer_lease_ms ?? 5 * 60_000,
      run_lease_ms: o.run_lease_ms ?? 15 * 60_000,
      reconcile_lease_ms: o.reconcile_lease_ms ?? 5 * 60_000,
      reconcile_backoff_ms: o.reconcile_backoff_ms ?? 60_000,
      reconcile_backoff_max_ms: o.reconcile_backoff_max_ms ?? 3_600_000,
      max_reconcile_attempts: o.max_reconcile_attempts ?? 5,
      verify_deadline_ms: o.verify_deadline_ms ?? 30 * 60_000,
      verification_overdue: o.verification_overdue ?? 'accepted_but_not_verified',
      max_verify_attempts: o.max_verify_attempts ?? 3,
      max_pending_approval_ms: o.max_pending_approval_ms ?? 7 * 86_400_000,
      max_horizon_ms: o.max_horizon_ms ?? 30 * 86_400_000,
      cancel_batch_size: o.cancel_batch_size ?? 100,
      desired_state_cache_ms: o.desired_state_cache_ms ?? 60_000,
      system_actor: o.system_actor ?? 'system:job-engine',
    }
  }

  private get system(): string {
    return this.o.system_actor
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
    const jobs = await this.store.listJobsByRollout(rolloutId)
    return ok(summarize(r, jobs, await this.leftUnchanged(jobs)))
  }

  /**
   * Targets where a supersession left nothing applied: this rollout's job was superseded by a newer job that ended
   * without applying, or this rollout's job ended without applying after superseding an older one.
   */
  private async leftUnchanged(jobs: Job[]): Promise<string[]> {
    const out = new Set<string>()
    const notApplied = (j: Job | null) => j !== null && isTerminalJob(j.state) && !j.applied && !j.partial && j.state !== 'already_satisfied' && j.state !== 'verified'
    for (const j of jobs) {
      if (j.state === 'superseded' && j.superseded_by_job) {
        let newer = await this.store.getJob(j.superseded_by_job)
        for (let i = 0; newer && newer.state === 'superseded' && newer.superseded_by_job && i < 10; i++) newer = await this.store.getJob(newer.superseded_by_job)
        if (newer && notApplied(newer) && newer.state !== 'superseded') out.add(j.target_id)
      } else if (notApplied(j) && j.state !== 'superseded') {
        const older = (await this.store.listJobsByTarget(j.target_id)).filter((o) => o.superseded_by_job === j.id)
        if (older.length > 0) out.add(j.target_id)
      }
    }
    return [...out]
  }

  /** Which approvals count for the rollout's current approval subject. */
  approvalStatus(r: Rollout): ApprovalEvaluation {
    const ev = evaluateApprovals({
      subject: r.approval_subject,
      authors: r.authors,
      impact_requires_acknowledgement: r.impact_requires_acknowledgement,
      approvals: r.approvals,
      required: requiredApprovals(r.effective_risk, this.rules),
    })
    // Integrity: the stored hash must be the hash of the stored plan, and the stored subject must match the stored state.
    if (!this.planIntact(r) || (r.approval_subject !== null && r.approval_subject !== this.subjectOf(r))) return { ...ev, satisfied: false }
    return ev
  }

  /** Unknown jobs due for an automatic reconcile request (target reachable, backoff elapsed, adapter can answer). */
  async reconcileCandidates(): Promise<Job[]> {
    const now = this.clock.now()
    return (await this.store.listJobsInStates(['unknown'])).filter(
      (j) => !j.needs_manual && (j.next_reconcile_at ?? now) <= now && this.env.isOnline(j.target_id) && this.caps(j)?.operations.reconcile === true,
    )
  }

  /** Jobs in verification whose target is reachable (the runner re-reads their settings). */
  async verificationCandidates(): Promise<Job[]> {
    return (await this.store.listJobsInStates(['verifying'])).filter((j) => this.env.isOnline(j.target_id))
  }

  // -------------------------------------------------------------------------------------------------
  // The offering lease

  /** Take or renew the offering lease. Only the holder's fence lets `tick` and `targetReturned` write. */
  acquireOfferingLease(holder: string, ttl_ms = 60_000): Promise<Outcome<Fence>> {
    return this.store.acquireLease(OFFERING_LEASE, holder, this.clock.now(), ttl_ms)
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.offerLock.then(fn, fn)
    this.offerLock = run.catch(() => undefined)
    return run
  }

  // -------------------------------------------------------------------------------------------------
  // Rollout lifecycle

  async createRollout(input: { title: string; plan: Plan; actor: string }): Promise<Outcome<Rollout>> {
    if (input.actor !== input.plan.requested_by) return fail('not_allowed', 'The plan must name its author as the requester.')
    const hashed = this.hashPlan(input.plan)
    if (!hashed.ok) return hashed
    const now = this.clock.now()
    const r: Rollout = {
      id: this.ids.next('rollout'),
      version: 0,
      seq: await this.store.nextRolloutSeq(),
      title: input.title,
      state: 'draft',
      plan: structuredClone(input.plan),
      payload_hash: hashed.value,
      revision: 0,
      authors: [input.actor],
      approval_subject: null,
      effective_risk: input.plan.risk,
      setting_paths_effective: [],
      targets_resolved_at: null,
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
      finished_acknowledged: 0,
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

  /**
   * Replace the plan before execution. The amender becomes the requester and an author; any real change gives a
   * new hash and revision, returns the rollout to draft and voids every earlier approval (A→B→A included).
   */
  async amendPlan(id: string, plan: Plan, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (STARTED.has(r.state)) return fail('immutable_after_start', 'The plan cannot change once the rollout has started. Cancel it and create a new one.')
    if (!AMENDABLE.has(r.state)) return invalid(`A ${r.state} rollout cannot be changed.`)
    const newPlan: Plan = { ...structuredClone(plan), requested_by: actor }
    const hashed = this.hashPlan(newPlan)
    if (!hashed.ok) return hashed
    if (hashed.value === r.payload_hash) return ok(r)
    const next: Rollout = {
      ...r,
      plan: newPlan,
      payload_hash: hashed.value,
      revision: r.revision + 1,
      authors: addAuthor(r.authors, actor),
      approval_subject: null,
      state: 'draft',
      targets: [],
      excluded: [],
      impact: null,
      impact_requires_acknowledgement: true,
      conflicts: [],
      targets_resolved_at: null,
      setting_paths_effective: [],
      updated_at: this.clock.now(),
    }
    const details = { previous_payload_hash: r.payload_hash, new_payload_hash: hashed.value, revision: next.revision }
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
    const issues = validatePlan(r.plan, { now, adapters: this.adapters, max_horizon_ms: this.o.max_horizon_ms })
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
    const kind = kindFor(this.adapters, plan)
    const required = kind?.required_target_capabilities ?? []
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
    const byId = new Map(included.map((c) => [c.target_id, c]))
    const targets: IncludedTarget[] = phased.value.map((t) => {
      const c = byId.get(t.target_id) as TargetCandidate & { warnings: string[] }
      return { ...t, warnings: c.warnings, effective_hash: effectiveHash(r.payload_hash, c) }
    })
    const settingPaths = effectiveSettingPaths(this.adapters, plan)
    const probe: Rollout = { ...r, setting_paths_effective: settingPaths }
    const conflicts = await this.findConflicts(probe, targets)
    if (conflicts.length > 0 && plan.conflict_policy === 'reject') {
      return fail('conflicting_rollout', 'Another active rollout changes the same setting on some of these targets.', {
        conflicts: conflicts.map((c) => ({ target_id: c.target_id, setting_path: c.setting_path, other_rollout_id: c.other_rollout_id })),
      })
    }
    const impact = aggregateImpact(included.map((c) => c.impact))
    const missingEstimate = included.some((c) => c.impact === null)
    const requiresAck = impact === null || missingEstimate || impact.disruption !== 'none' || impact.reboot_required || impact.reconnect_required
    const effectiveRisk = maxRisk(plan.risk, kind?.min_risk, own(this.kindMinRisk, plan.kind), impactRisk(impact, missingEstimate))
    const now = this.clock.now()
    const next: Rollout = {
      ...r, state: 'targets_resolved', targets, excluded, conflicts, impact, impact_requires_acknowledgement: requiresAck,
      effective_risk: effectiveRisk, setting_paths_effective: settingPaths, revision: r.revision + 1, authors: addAuthor(r.authors, actor),
      targets_resolved_at: now, updated_at: now,
    }
    next.approval_subject = this.subjectOf(next)
    return this.writeRollout(r, next, [
      this.rolloutEvent(next, r.state, 'targets_resolved', actor, 'targets_resolved', {
        included: targets.length,
        excluded: excluded.map((e) => ({ target_id: e.target_id, reasons: e.reasons })),
        conflicts: conflicts.length,
        effective_risk: effectiveRisk,
        approval_subject: next.approval_subject,
      }),
    ])
  }

  /** Ask for approval, or approve at once when the effective risk needs none. The submitter becomes an author. */
  async submit(id: string, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (r.state !== 'targets_resolved') return invalid(`Only a rollout with resolved targets can be submitted (this one is ${r.state}).`)
    const now = this.clock.now()
    const authors = addAuthor(r.authors, actor)
    if (requiredApprovals(r.effective_risk, this.rules) === 0) {
      const next = { ...r, authors, state: 'approved' as const, updated_at: now }
      return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'approved', actor, 'no_approval_required', { effective_risk: r.effective_risk })])
    }
    const next = { ...r, authors, state: 'pending_approval' as const, updated_at: now }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'pending_approval', actor, 'submitted', { effective_risk: r.effective_risk })])
  }

  async approve(id: string, req: { approver: string; subject: string; acknowledged_impact: boolean; note?: string }): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (r.state !== 'pending_approval') return invalid(`Only a rollout waiting for approval can be approved (this one is ${r.state}).`)
    const check = checkNewApproval(
      { subject: r.approval_subject, authors: r.authors, impact_requires_acknowledgement: r.impact_requires_acknowledgement, approvals: r.approvals },
      req,
    )
    if (!check.ok) return check
    const now = this.clock.now()
    const approval = {
      id: this.ids.next('approval'), approver: req.approver, decision: 'approve' as const, subject: req.subject, revision: r.revision,
      payload_hash: r.payload_hash, acknowledged_impact: req.acknowledged_impact, at: now, note: req.note ?? null,
    }
    const withApproval: Rollout = { ...r, approvals: [...r.approvals, approval], updated_at: now }
    const status = this.approvalStatus(withApproval)
    const details = { approval_id: approval.id, acknowledged_impact: approval.acknowledged_impact, counted: status.counted.length, required: status.required, subject: req.subject }
    if (!status.satisfied) {
      return this.writeRollout(r, withApproval, [this.rolloutEvent(withApproval, r.state, r.state, req.approver, 'approval_recorded', details, 'recorded')])
    }
    const next = { ...withApproval, state: 'approved' as const }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'approved', req.approver, 'approved', details)])
  }

  async reject(id: string, req: { approver: string; subject: string; note: string }): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (r.state !== 'pending_approval') return invalid(`Only a rollout waiting for approval can be rejected (this one is ${r.state}).`)
    const check = checkNewApproval(
      { subject: r.approval_subject, authors: r.authors, impact_requires_acknowledgement: false, approvals: r.approvals },
      { approver: req.approver, subject: req.subject, acknowledged_impact: true },
    )
    if (!check.ok) return check
    const now = this.clock.now()
    const decision = {
      id: this.ids.next('approval'), approver: req.approver, decision: 'reject' as const, subject: req.subject, revision: r.revision,
      payload_hash: r.payload_hash, acknowledged_impact: false, at: now, note: req.note,
    }
    const next: Rollout = { ...r, approvals: [...r.approvals, decision], state: 'cancelled', updated_at: now, finished_at: now }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'cancelled', req.approver, 'rejected', { note: req.note })])
  }

  async schedule(id: string, actor: string): Promise<Outcome<Rollout>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (!canTransitionRollout(r.state, 'scheduled')) return invalid(`Only an approved rollout can be scheduled (this one is ${r.state}).`)
    if (!this.approvalStatus(r).satisfied) return fail('approvals_missing', 'The approvals do not cover the current version.')
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
    const finished = jobs.filter((j) => FAILURE_JOB_STATES.has(j.state) || SUCCESS_JOB_STATES.has(j.state)).length
    const byThreshold = r.state === 'paused_by_threshold'
    const next: Rollout = {
      ...r,
      state: r.paused_from,
      paused_from: null,
      pause_reason: null,
      failures_acknowledged: byThreshold ? failures : r.failures_acknowledged,
      finished_acknowledged: byThreshold ? finished : r.finished_acknowledged,
      consecutive_failures: byThreshold ? 0 : r.consecutive_failures,
      canary_override: r.canary_override || (byThreshold && r.paused_from === 'running_canary'),
      updated_at: this.clock.now(),
    }
    return this.writeRollout(r, next, [
      this.rolloutEvent(next, r.state, next.state, actor, byThreshold ? 'resumed_after_threshold' : 'resumed', { note, failures_acknowledged: next.failures_acknowledged }),
    ])
  }

  /**
   * Stop offering; queued jobs are cancelled; jobs in flight are asked to stop when the adapter can, otherwise left to
   * complete (recorded). The rollout row is written first (so no offer can land afterwards: offers are guarded by it),
   * then the jobs in batches. Idempotent: cancelling an ended rollout (cancelled, expired) repeats the job sweep.
   */
  async cancel(id: string, actor: string, reason: string): Promise<Outcome<Rollout>> {
    let r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    const now = this.clock.now()
    if (!isTerminalRollout(r.state)) {
      const next: Rollout = { ...r, state: 'cancelled', updated_at: now, finished_at: now, pause_reason: null }
      const res = await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'cancelled', actor, 'cancelled', { note: reason })])
      if (!res.ok) return res
      r = res.value
    }
    const swept = await this.sweepEndedJobs(r, actor, reason, undefined)
    if (!swept.ok) return swept
    return ok(r)
  }

  /** For an ended rollout: release targets held by unknown, reconciling or verifying jobs after a human checked the devices. */
  async releaseHeld(id: string, actor: string, note: string): Promise<Outcome<{ released: number }>> {
    const r = await this.store.getRollout(id)
    if (!r) return notFound('rollout')
    if (!isTerminalRollout(r.state)) return invalid('Only the jobs of an ended rollout can be released; cancel it first.')
    let released = 0
    for (const j of await this.store.listJobsByRollout(id)) {
      if (!RELEASABLE.has(j.state)) continue
      const m = this.jobMove(j, 'resolved_manually', actor, 'released_by_operator', { note }, { terminal_reason: 'released_by_operator', reconcile_lease: null, verify_lease: null })
      if (!m.ok) continue
      const res = await this.writeJob(j, m.value.next, [m.value.event])
      if (!res.ok) return res
      released += 1
    }
    return ok({ released })
  }

  /** Waiting jobs of an ended rollout are cancelled (or expired); jobs in flight get a stop request or a left-to-complete record. */
  private async sweepEndedJobs(r: Rollout, actor: string, reason: string, fence: Fence | undefined): Promise<Outcome<number>> {
    const canStop = adapterFor(this.adapters, r.plan)?.operations.stop === true
    const to: JobState = r.state === 'expired' ? 'expired' : 'cancelled'
    const terminalReason = r.state === 'expired' ? 'expired' : r.state === 'cancelled' ? 'rollout_cancelled' : 'rollout_ended'
    const now = this.clock.now()
    const writes: { prev: Job; next: Job; event: NewJobEvent }[] = []
    for (const j of await this.store.listJobsByRollout(r.id)) {
      if (WAITING_JOB_STATES.has(j.state)) {
        const m = this.jobMove(j, to, actor, terminalReason, { note: reason }, { terminal_reason: terminalReason, blocked_reason: null, waiting_reason: null })
        if (m.ok) writes.push({ prev: j, next: m.value.next, event: m.value.event })
      } else if (LEASED_JOB_STATES.has(j.state) && j.stop === null) {
        const stop = canStop ? 'requested' as const : 'unsupported_left_to_complete' as const
        writes.push({ prev: j, next: { ...j, stop, updated_at: now }, event: this.jobEvent(j, 'recorded', j.state, j.state, actor, canStop ? 'stop_requested' : 'left_to_complete', { note: reason }) })
      }
    }
    for (let i = 0; i < writes.length; i += this.o.cancel_batch_size) {
      const batch = writes.slice(i, i + this.o.cancel_batch_size)
      const res = await this.store.commit({
        jobs: batch.map((w) => ({ record: w.next, expected_version: w.prev.version })),
        events: batch.map((w) => w.event),
        bump_slots: batch.flatMap((w) => bumpsFor(w.prev, w.next)),
        fence,
      })
      if (!res.ok) return res
    }
    return ok(writes.length)
  }

  // -------------------------------------------------------------------------------------------------
  // Tick: expire leases and deadlines, start scheduled rollouts, advance phases, offer jobs.

  /** One round of the engine. Only the holder of the offering lease may tick: pass its fence. */
  tick(fence: Fence): Promise<TickReport> {
    return this.locked(async () => {
      const ctx: Ctx = { fence, report: { offered: [], changed: 0, conflicts: 0 } }
      await this.expireDeadlines(ctx)
      for (const r of await this.store.listRollouts()) {
        if (isTerminalRollout(r.state)) {
          if ((await this.store.listJobsByRollout(r.id)).some((j) => WAITING_JOB_STATES.has(j.state))) {
            const res = await this.sweepEndedJobs(r, this.system, 'rollout ended', fence)
            if (!res.ok) ctx.report.conflicts += 1
          }
          continue
        }
        await this.advance(r.id, ctx)
      }
      return ctx.report
    })
  }

  /**
   * A target came back: revalidate its waiting jobs now (expire, supersede, block, already satisfied) and offer what
   * may run on THIS target within the caps, through the same guarded commit. Not a full tick.
   */
  targetReturned(targetId: string, fence: Fence): Promise<{ decisions: { job_id: string; decision: RevalidationDecision }[]; offered: OfferedJob[] }> {
    return this.locked(async () => {
      const ctx: Ctx = { fence, report: { offered: [], changed: 0, conflicts: 0 } }
      const decisions: { job_id: string; decision: RevalidationDecision }[] = []
      const rollouts = await this.store.listRollouts()
      for (const j of await this.store.listJobsByTarget(targetId)) {
        if (!WAITING_JOB_STATES.has(j.state)) continue
        const r = rollouts.find((x) => x.id === j.rollout_id)
        if (!r) continue
        const d = await this.decide(j, r, rollouts)
        decisions.push({ job_id: j.id, decision: d })
        if (d.action === 'offerable') {
          if (RUNNING_ROLLOUT_STATES.has(r.state) && this.phaseEligible(r, j)) await this.offerCandidates(r, [j], ctx)
        } else {
          const res = await this.applyDecision(j, d, ctx.fence)
          if (!res.ok) ctx.report.conflicts += 1
        }
      }
      return { decisions, offered: ctx.report.offered }
    })
  }

  /** Re-check a waiting job against everything that may have changed since it was queued. Applies terminal and blocking outcomes (never offers). */
  async revalidate(jobId: string): Promise<Outcome<RevalidationDecision>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    const r = await this.store.getRollout(job.rollout_id)
    if (!r) return notFound('rollout')
    const decision = await this.decide(job, r, await this.store.listRollouts())
    const applied = await this.applyDecision(job, decision, undefined)
    return applied.ok ? ok(decision) : applied
  }

  private async decide(job: Job, r: Rollout, rollouts: Rollout[]): Promise<RevalidationDecision> {
    if (!WAITING_JOB_STATES.has(job.state)) return { action: 'not_waiting', reason: job.state }
    const now = this.clock.now()
    if (r.state === 'cancelled') return { action: 'cancelled', reason: 'rollout_cancelled' }
    if (now >= this.expiresAt(r)) return { action: 'expired', reason: 'expired' }
    const newer = this.supersededBy(r, job, rollouts)
    if (newer) return { action: 'superseded', reason: `superseded_by:${newer.id}`, by_rollout: newer.id }
    if (r.state === 'expired') return { action: 'expired', reason: 'expired' }
    if (!this.planIntact(r) || job.payload_hash !== r.payload_hash || r.targets.find((t) => t.target_id === job.target_id)?.effective_hash !== job.effective_hash) {
      return { action: 'blocked', reason: 'payload_changed' }
    }
    if (!this.approvalStatus(r).satisfied) return { action: 'blocked', reason: 'approval_missing' }
    const adapter = adapterFor(this.adapters, r.plan)
    if (!adapter || adapter.version !== r.plan.adapter_version) return { action: 'blocked', reason: 'adapter_changed' }
    if (this.env.currentPolicyVersion(r.plan.kind) !== r.plan.policy_version) return { action: 'blocked', reason: 'policy_changed' }
    if (this.staleBase(r.plan)) return { action: 'blocked', reason: 'stale_configuration_version' }
    if (!this.env.isOnline(job.target_id)) return { action: 'wait', reason: 'offline' }
    if (now < this.notBefore(r)) return { action: 'wait', reason: 'not_yet' }
    if (!isWindowOpen(r.plan.schedule.window, now)) return { action: 'wait', reason: 'outside_maintenance_window' }
    const el = await this.env.eligibility(job.target_id, r.plan)
    if (!el.eligible) return { action: 'blocked', reason: `ineligible: ${el.reasons.join('; ') || 'no reason given'}` }
    if ((await this.desiredState(job, r.plan)) === 'satisfied') return { action: 'already_satisfied', reason: 'already_satisfied' }
    return { action: 'offerable' }
  }

  /** The read-only "already satisfied" probe, cached per target and effective hash for a short time. */
  private async desiredState(job: Job, plan: Plan): Promise<'satisfied' | 'not_satisfied' | 'unknown'> {
    const key = `${job.target_id}|${job.effective_hash}`
    const now = this.clock.now()
    const hit = this.desiredCache.get(key)
    if (hit && now - hit.at <= this.o.desired_state_cache_ms) return hit.result
    const result = await this.env.desiredState(job.target_id, job.location_id, plan)
    this.desiredCache.set(key, { result, at: now })
    return result
  }

  private async applyDecision(job: Job, d: RevalidationDecision, fence: Fence | undefined): Promise<Outcome<Job | null>> {
    const actor = this.system
    switch (d.action) {
      case 'expired':
      case 'cancelled':
      case 'already_satisfied': {
        const m = this.jobMove(job, d.action, actor, d.reason, {}, { terminal_reason: d.reason, blocked_reason: null, waiting_reason: null })
        return m.ok ? this.writeJob(job, m.value.next, [m.value.event], fence) : m
      }
      case 'superseded': {
        const newerJob = (await this.store.listJobsByTarget(job.target_id)).find((x) => x.rollout_id === d.by_rollout) ?? null
        const m = this.jobMove(job, 'superseded', actor, d.reason, { superseded_by: d.by_rollout, superseded_by_job: newerJob?.id ?? null }, {
          terminal_reason: 'superseded', superseded_by: d.by_rollout, superseded_by_job: newerJob?.id ?? null, blocked_reason: null, waiting_reason: null,
        })
        return m.ok ? this.writeJob(job, m.value.next, [m.value.event], fence) : m
      }
      case 'blocked': {
        if (job.state === 'blocked' && job.blocked_reason === d.reason) return ok(null)
        if (job.state === 'blocked') {
          const next = { ...job, blocked_reason: d.reason, updated_at: this.clock.now() }
          return this.writeJob(job, next, [this.jobEvent(job, 'recorded', 'blocked', 'blocked', actor, d.reason)], fence)
        }
        const m = this.jobMove(job, 'blocked', actor, d.reason, {}, { blocked_reason: d.reason, waiting_reason: null })
        return m.ok ? this.writeJob(job, m.value.next, [m.value.event], fence) : m
      }
      default:
        return ok(null)
    }
  }

  private async advance(rolloutId: string, ctx: Ctx): Promise<void> {
    let r = await this.store.getRollout(rolloutId)
    if (!r || isTerminalRollout(r.state)) return
    const now = this.clock.now()
    const report = ctx.report
    const step = async (res: Outcome<Rollout>): Promise<boolean> => {
      if (!res.ok) { report.conflicts += 1; return false }
      report.changed += 1
      r = res.value
      return true
    }

    if ((r.state === 'targets_resolved' || r.state === 'pending_approval') && r.targets_resolved_at !== null && now - r.targets_resolved_at > this.o.max_pending_approval_ms) {
      const next: Rollout = { ...r, state: 'expired', updated_at: now, finished_at: now }
      await step(await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'expired', this.system, 'approval_window_elapsed')], ctx.fence))
      return
    }
    if (PRE_START_EXPIRABLE.has(r.state) && now >= this.expiresAt(r)) {
      const next: Rollout = { ...r, state: 'expired', updated_at: now, finished_at: now }
      await step(await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'expired', this.system, 'expired_before_start')], ctx.fence))
      return
    }
    if (r.state === 'scheduled') {
      if (now < this.notBefore(r)) return
      if (!(await step(await this.startRollout(r, ctx.fence)))) return
      await this.supersedeOlder(r, ctx)
    }
    if (!STARTED.has(r.state)) return

    let jobs = await this.store.listJobsByRollout(rolloutId)
    if (now >= this.expiresAt(r)) {
      const next: Rollout = { ...r, state: 'expired', updated_at: now, finished_at: now }
      if (await step(await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'expired', this.system, 'expired')], ctx.fence))) {
        const res = await this.sweepEndedJobs(r, this.system, 'expired', ctx.fence)
        if (!res.ok) report.conflicts += 1
      }
      return
    }

    // Cheap sweep: supersession of waiting jobs, without asking any device.
    const rollouts = await this.store.listRollouts()
    for (const j of jobs) {
      if (!WAITING_JOB_STATES.has(j.state)) continue
      const newer = this.supersededBy(r, j, rollouts)
      if (!newer) continue
      const res = await this.applyDecision(j, { action: 'superseded', reason: `superseded_by:${newer.id}`, by_rollout: newer.id }, ctx.fence)
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
      if (!(await step(await this.writeRollout(r, next, [], ctx.fence)))) return
    }

    if (!RUNNING_ROLLOUT_STATES.has(r.state)) return // paused: nothing more until a human decides

    const final = finalRolloutState(jobs)
    if (final) {
      const s = summarize(r, jobs)
      const next: Rollout = { ...r, state: final, updated_at: now, finished_at: now }
      await step(await this.writeRollout(r, next, [this.rolloutEvent(next, r.state, final, this.system, 'all_targets_finished', summaryDetails(s))], ctx.fence))
      return
    }

    const failures = jobs.filter((j) => FAILURE_JOB_STATES.has(j.state)).length
    const finished = jobs.filter((j) => FAILURE_JOB_STATES.has(j.state) || SUCCESS_JOB_STATES.has(j.state)).length
    const breach = thresholdBreach(r.plan.thresholds, { failures, acknowledged: r.failures_acknowledged, consecutive: r.consecutive_failures, finished, finished_acknowledged: r.finished_acknowledged })
    if (breach) {
      await step(await this.pauseByThreshold(r, breach, ctx.fence))
      return
    }

    if (r.state === 'running_canary') {
      const canary = jobs.filter((j) => j.phase === 'canary')
      if (canary.every((j) => isTerminalJob(j.state))) {
        const bad = canary.filter((j) => !CANARY_PASS.has(j.state))
        if (bad.length > 0 && !r.canary_override) {
          await step(await this.pauseByThreshold(r, `canary did not verify on ${bad.map((j) => `${j.target_id} (${j.state})`).join(', ')}`, ctx.fence))
          return
        }
        if (r.phase_finished_at === null) {
          if (!(await step(await this.writeRollout(r, { ...r, phase_finished_at: now, updated_at: now }, [], ctx.fence)))) return
        }
        const soak = r.plan.canary.mode === 'none' ? 0 : r.plan.canary.soak_ms
        if (r.phase_finished_at !== null && now >= r.phase_finished_at + soak) {
          const next: Rollout = { ...r, state: 'running_batches', current_batch: 0, phase_finished_at: null, updated_at: now }
          if (!(await step(await this.writeRollout(r, next, [this.rolloutEvent(next, 'running_canary', 'running_batches', this.system, 'canary_passed', { soak_ms: soak })], ctx.fence)))) return
        }
      }
    }
    if (r.state === 'running_batches') {
      const lastBatch = Math.max(-1, ...jobs.map((j) => (typeof j.phase === 'number' ? j.phase : -1)))
      for (;;) {
        if (r.current_batch > lastBatch) {
          const next: Rollout = { ...r, state: 'verifying', updated_at: now }
          await step(await this.writeRollout(r, next, [this.rolloutEvent(next, 'running_batches', 'verifying', this.system, 'all_batches_offered')], ctx.fence))
          break
        }
        const batch = jobs.filter((j) => j.phase === r!.current_batch)
        if (!batch.every((j) => this.settled(j))) break
        if (r.phase_finished_at === null) {
          if (!(await step(await this.writeRollout(r, { ...r, phase_finished_at: now, updated_at: now }, [], ctx.fence)))) return
        }
        if (now < (r.phase_finished_at ?? now) + r.plan.batch.batch_soak_ms) break
        const nextBatch = r.current_batch + 1
        const next: Rollout = { ...r, current_batch: nextBatch, phase_finished_at: null, updated_at: now }
        if (!(await step(await this.writeRollout(r, next, nextBatch <= lastBatch ? [this.rolloutEvent(next, r.state, r.state, this.system, 'batch_started', { batch: nextBatch }, 'recorded')] : [], ctx.fence)))) return
      }
    }

    if (!RUNNING_ROLLOUT_STATES.has(r.state)) return
    const now2 = this.clock.now()
    if (now2 < this.notBefore(r) || !isWindowOpen(r.plan.schedule.window, now2)) return
    const waiting = (await this.store.listJobsByRollout(r.id)).filter((j) => WAITING_JOB_STATES.has(j.state) && this.phaseEligible(r!, j)).sort((a, b) => a.order - b.order)
    if (waiting.length > 0) await this.offerCandidates(r, waiting, ctx)
  }

  private phaseEligible(r: Rollout, j: Job): boolean {
    if (r.state === 'verifying') return true
    if (r.state === 'running_canary') return j.phase === 'canary'
    return j.phase === 'canary' || (j.phase as number) <= r.current_batch
  }

  /** A batch counts as settled when each job is finished, unknown (held visibly), blocked or waiting for an offline target. */
  private settled(j: Job): boolean {
    if (isTerminalJob(j.state) || j.state === 'unknown' || j.state === 'reconciling') return true
    return WAITING_JOB_STATES.has(j.state) && (j.state === 'blocked' || !this.env.isOnline(j.target_id))
  }

  private async startRollout(r: Rollout, fence: Fence | undefined): Promise<Outcome<Rollout>> {
    const now = this.clock.now()
    if (!this.approvalStatus(r).satisfied) {
      await this.store.commit({ events: [this.rolloutEvent(r, r.state, r.state, this.system, 'approvals_missing', {}, 'rejected')], fence })
      return fail('approvals_missing', 'The approvals do not cover the current version.')
    }
    const jobs: Job[] = r.targets.map((t) => {
      const id = this.ids.next('job')
      return {
        id, version: 0, rollout_id: r.id, rollout_seq: r.seq, adapter: r.plan.adapter, target_id: t.target_id, location_id: t.location_id,
        payload_hash: r.payload_hash, effective_hash: t.effective_hash, idempotency_key: `${id}:${r.payload_hash}`, supersedes_key: r.plan.supersedes_key,
        setting_paths: [...r.setting_paths_effective], phase: t.phase, order: t.order, state: 'queued', attempt: 0, max_attempts: r.plan.max_attempts,
        lease: null, reconcile_lease: null, reconcile_attempts: 0, next_reconcile_at: null, needs_manual: false, last_reconcile: null,
        verify_deadline: null, verify_lease: null, verify_attempts: 0, applied: false, partial: false, last_result: null,
        verification: null, snapshot: null, rollback: null, stop: null, blocked_reason: null, waiting_reason: null, terminal_reason: null,
        superseded_by: null, superseded_by_job: null, recovery_actions: [], created_at: now, updated_at: now, finished_at: null,
      }
    })
    const hasCanary = r.targets.some((t) => t.phase === 'canary')
    const to: RolloutState = hasCanary ? 'running_canary' : 'running_batches'
    const next: Rollout = { ...r, state: to, current_batch: hasCanary ? -1 : 0, phase_finished_at: null, started_at: now, updated_at: now }
    const res = await this.store.commit({
      rollouts: [{ record: next, expected_version: r.version }],
      jobs: jobs.map((j) => ({ record: j, expected_version: null })),
      events: [
        this.rolloutEvent(next, r.state, to, this.system, 'started', { jobs: jobs.length }),
        ...jobs.map((j) => this.jobEvent(j, 'transition', null, 'queued', this.system, 'requested', { phase: j.phase === 'canary' ? 'canary' : `batch ${j.phase}`, effective_hash: j.effective_hash })),
      ],
      fence,
    })
    return res.ok ? ok(res.value.rollouts[0]) : res
  }

  /** When a rollout STARTS, waiting jobs of older rollouts with the same key on the targets it now has jobs for are superseded. */
  private async supersedeOlder(newer: Rollout, ctx: Ctx): Promise<void> {
    const key = newer.plan.supersedes_key
    if (key === null) return
    const targets = new Set(newer.targets.map((t) => t.target_id))
    for (const o of await this.store.listRollouts()) {
      if (o.id === newer.id || o.seq >= newer.seq || o.plan.supersedes_key !== key) continue
      for (const j of await this.store.listJobsByRollout(o.id)) {
        if (!WAITING_JOB_STATES.has(j.state) || !targets.has(j.target_id)) continue
        const res = await this.applyDecision(j, { action: 'superseded', reason: `superseded_by:${newer.id}`, by_rollout: newer.id }, ctx.fence)
        if (res.ok) ctx.report.changed += 1
        else ctx.report.conflicts += 1
      }
    }
  }

  private async pauseByThreshold(r: Rollout, reason: string, fence: Fence | undefined): Promise<Outcome<Rollout>> {
    const next: Rollout = { ...r, state: 'paused_by_threshold', paused_from: r.state, pause_reason: reason, updated_at: this.clock.now() }
    return this.writeRollout(r, next, [this.rolloutEvent(next, r.state, 'paused_by_threshold', this.system, 'paused_by_threshold', { threshold: reason })], fence)
  }

  /**
   * Offer candidate jobs of one rollout within the caps. Slot versions are read BEFORE the data they protect, and
   * every offer commit is guarded by them and by the rollout row, so a concurrent writer can only make it fail.
   */
  private async offerCandidates(r0: Rollout, candidates: Job[], ctx: Ctx): Promise<void> {
    const keys = [...new Set(candidates.flatMap((j) => slotKeys(j)))]
    const slots = await this.store.readSlots(keys)
    const r = await this.store.getRollout(r0.id)
    if (!r || !RUNNING_ROLLOUT_STATES.has(r.state)) return
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
    const now = this.clock.now()
    for (const cand of candidates) {
      const j = await this.store.getJob(cand.id)
      if (!j || !WAITING_JOB_STATES.has(j.state)) continue
      if (mine >= b.global_concurrency) break
      if (busyTargets.has(j.target_id)) continue
      if ((perLocation.get(j.location_id) ?? 0) >= b.per_location_concurrency) continue
      if (b.block_location_on_unknown && unknownAt.has(j.location_id)) continue
      if (!this.env.isOnline(j.target_id)) continue
      const holder = heldByEarlier.get(j.target_id)
      if (holder) {
        const why = `waiting_for_earlier_rollout:${holder}`
        if (j.waiting_reason !== why) {
          const res = await this.writeJob(j, { ...j, waiting_reason: why, updated_at: now }, [this.jobEvent(j, 'recorded', j.state, j.state, this.system, why)], ctx.fence)
          if (!res.ok) ctx.report.conflicts += 1
        }
        continue
      }
      const decision = await this.decide(j, r, rollouts)
      if (decision.action !== 'offerable') {
        const res = await this.applyDecision(j, decision, ctx.fence)
        if (!res.ok) ctx.report.conflicts += 1
        else if (res.value) ctx.report.changed += 1
        continue
      }
      const token = this.ids.next('lease')
      const lease: Lease = { token_hash: tokenHash(token), until: now + this.o.offer_lease_ms, attempt: j.attempt + 1 }
      const m = this.jobMove(j, 'offered', this.system, j.state === 'blocked' ? 'revalidated_and_offered' : 'offered', {
        lease_fingerprint: hashFingerprint(lease.token_hash), attempt: lease.attempt, lease_until: lease.until, effective_hash: j.effective_hash,
      }, { lease, attempt: lease.attempt, blocked_reason: null, waiting_reason: null })
      if (!m.ok) continue
      const [kt, kl, kr] = slotKeys(j)
      const guards: Guard[] = [
        { kind: 'rollout', id: r.id, version: r.version },
        { kind: 'slot', key: kt, version: slots[kt] ?? 0 },
        { kind: 'slot', key: kl, version: slots[kl] ?? 0 },
        { kind: 'slot', key: kr, version: slots[kr] ?? 0 },
      ]
      const res = await this.store.commit({
        jobs: [{ record: m.value.next, expected_version: j.version }], events: [m.value.event], guards, bump_slots: [kt, kl, kr], fence: ctx.fence,
      })
      if (!res.ok) {
        ctx.report.conflicts += 1
        if (res.error.code === 'stale_fence') return
        continue
      }
      for (const k of [kt, kl, kr]) slots[k] = (slots[k] ?? 0) + 1
      ctx.report.changed += 1
      ctx.report.offered.push({ ...res.value.jobs[0], token })
      mine += 1
      busyTargets.add(j.target_id)
      perLocation.set(j.location_id, (perLocation.get(j.location_id) ?? 0) + 1)
    }
  }

  /** Lease, reconcile-request and verification deadlines. */
  private async expireDeadlines(ctx: Ctx): Promise<void> {
    const now = this.clock.now()
    for (const j of await this.store.listJobsInStates(['offered', 'acked', 'running', 'reconciling', 'verifying'])) {
      if (j.state === 'verifying') {
        if (j.verify_deadline === null || now <= j.verify_deadline) continue
        const to = this.o.verification_overdue
        const m = to === 'unknown'
          ? this.jobMove(j, 'unknown', this.system, 'verification_overdue', {}, { verify_lease: null, ...this.unknownPatch(j, now) })
          : this.jobMove(j, 'accepted_but_not_verified', this.system, 'verification_overdue', {}, { verify_lease: null, terminal_reason: 'verification_overdue' })
        if (!m.ok) continue
        const res = await this.writeJob(j, m.value.next, [m.value.event, ...this.needsManualEvent(j, m.value.next)], ctx.fence)
        if (res.ok) ctx.report.changed += 1
        else ctx.report.conflicts += 1
        continue
      }
      const lease = j.state === 'reconciling' ? j.reconcile_lease : j.lease
      if (!lease || now <= lease.until) continue
      const reason = j.state === 'reconciling' ? 'reconcile_timeout' : j.state === 'offered' ? 'acknowledgement_lost' : 'lease_expired'
      const m = this.jobMove(j, 'unknown', this.system, reason, { was: j.state, lease_fingerprint: hashFingerprint(lease.token_hash) }, {
        ...(j.state === 'reconciling' ? { reconcile_lease: null } : { lease: null }),
        ...this.unknownPatch(j, now),
      })
      if (!m.ok) continue
      const res = await this.writeJob(j, m.value.next, [m.value.event, ...this.needsManualEvent(j, m.value.next)], ctx.fence)
      if (res.ok) ctx.report.changed += 1
      else ctx.report.conflicts += 1
    }
  }

  /** Fields for a job entering `unknown`: when to ask next (exponential backoff), or that a human must decide. */
  private unknownPatch(j: Job, now: number, forceManual = false): Partial<Job> {
    const canReconcile = this.caps(j)?.operations.reconcile === true
    if (forceManual || !canReconcile || j.reconcile_attempts >= this.o.max_reconcile_attempts) return { needs_manual: true, next_reconcile_at: null }
    const wait = j.reconcile_attempts === 0 ? 0 : Math.min(this.o.reconcile_backoff_ms * 2 ** (j.reconcile_attempts - 1), this.o.reconcile_backoff_max_ms)
    return { needs_manual: false, next_reconcile_at: now + wait }
  }

  /** An event suitable for an alert when a job starts needing a human. */
  private needsManualEvent(prev: Job, next: Job): NewJobEvent[] {
    if (!next.needs_manual || prev.needs_manual) return []
    return [this.jobEvent(next, 'recorded', next.state, next.state, this.system, 'needs_manual_resolution', {
      reconcile_attempts: next.reconcile_attempts, reconcile_supported: this.caps(next)?.operations.reconcile === true,
    })]
  }

  // -------------------------------------------------------------------------------------------------
  // Job protocol (offer → ack → running → result → verification; unknown → reconcile). Tokens are compared
  // against stored hashes in constant time; raw tokens are never stored.

  async ack(jobId: string, token: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'ack')
    if (job.state !== 'offered') return ok(job) // duplicate acknowledgement
    const m = this.jobMove(job, 'acked', this.system, 'acknowledged', { lease_fingerprint: hashFingerprint(job.lease!.token_hash) }, { lease: { ...job.lease!, until: this.clock.now() + this.o.run_lease_ms } })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  async start(jobId: string, token: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'start')
    if (job.state === 'running') return ok(job)
    const m = this.jobMove(job, 'running', this.system, 'started', { lease_fingerprint: hashFingerprint(job.lease!.token_hash) }, { lease: { ...job.lease!, until: this.clock.now() + this.o.run_lease_ms } })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  /** Extends the run lease of an acknowledged or running job. A heartbeat before the acknowledgement is refused and logged. */
  async heartbeat(jobId: string, token: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'heartbeat')
    if (job.state === 'offered') {
      await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'heartbeat_before_ack', { lease_fingerprint: hashFingerprint(job.lease!.token_hash) })] })
      return fail('not_allowed', 'Acknowledge the job before sending heartbeats.')
    }
    const next = { ...job, lease: { ...job.lease!, until: this.clock.now() + this.o.run_lease_ms }, updated_at: this.clock.now() }
    return this.writeJob(job, next, [this.jobEvent(job, 'recorded', job.state, job.state, this.system, 'heartbeat', { lease_until: next.lease.until })])
  }

  /** Re-check right before executing: lease, job state, payload integrity, approvals, the cancel state and the snapshot rule. */
  async checkBeforeApply(jobId: string, token: string): Promise<Outcome<{ plan: Plan; payload_hash: string; effective_hash: string; idempotency_key: string }>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'apply_check')
    const r = await this.store.getRollout(job.rollout_id)
    if (!r) return notFound('rollout')
    if (r.state === 'cancelled' || r.state === 'expired') return fail('not_allowed', 'The rollout has ended; do not start this job.')
    if (!this.planIntact(r) || job.payload_hash !== r.payload_hash) return fail('payload_hash_mismatch', 'The plan no longer matches the job.')
    if (!this.approvalStatus(r).satisfied) return fail('approvals_missing', 'The approvals do not cover the current version.')
    if (kindFor(this.adapters, r.plan)?.require_snapshot && job.snapshot?.status !== 'taken') return fail('not_allowed', 'A configuration snapshot is required before this change.')
    return ok({ plan: structuredClone(r.plan), payload_hash: job.payload_hash, effective_hash: job.effective_hash, idempotency_key: job.idempotency_key })
  }

  async recordSnapshot(jobId: string, token: string, snap: { status: 'taken'; ref: string; key_ref: string; content_sha256: string; retain_until: number } | { status: 'unsupported' } | { status: 'failed' }): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'snapshot')
    const snapshot: SnapshotRecord = snap.status === 'taken'
      ? { status: 'taken', ref: snap.ref, key_ref: snap.key_ref, content_sha256: snap.content_sha256, retain_until: snap.retain_until }
      : { status: snap.status, ref: null, key_ref: null, content_sha256: null, retain_until: null }
    const r = await this.store.getRollout(job.rollout_id)
    if (snap.status !== 'taken' && r && kindFor(this.adapters, r.plan)?.require_snapshot) {
      const m = this.jobMove(job, 'failed', this.system, 'snapshot_required', { snapshot: snap.status }, { snapshot, lease: null, terminal_reason: 'snapshot_required' })
      return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
    }
    const next = { ...job, snapshot, updated_at: this.clock.now() }
    return this.writeJob(job, next, [this.jobEvent(job, 'recorded', job.state, job.state, this.system, `snapshot_${snap.status}`, snap.status === 'taken' ? { content_sha256: snap.content_sha256, key_ref: snap.key_ref } : {})])
  }

  async reportResult(jobId: string, token: string, result: { outcome: ResultOutcome; message: string }): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    const message = redactText(result.message, MAX_MESSAGE_LENGTH)
    if (job.last_result && tokenMatches(token, job.last_result.token_hash)) {
      if (job.last_result.outcome === result.outcome) return ok(job) // duplicate delivery
      await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'conflicting_duplicate', { first: job.last_result.outcome, second: result.outcome, lease_fingerprint: hashFingerprint(job.last_result.token_hash) })] })
      return fail('conflicting_duplicate', 'A different result was already recorded for this delivery; the first one stands.')
    }
    if (!this.holdsLease(job, token)) return this.rejectStale(job, token, 'result')
    const now = this.clock.now()
    const last_result = { token_hash: job.lease!.token_hash, outcome: result.outcome, at: now }
    const details = { outcome: result.outcome, message, lease_fingerprint: hashFingerprint(job.lease!.token_hash) }
    let m: Outcome<{ next: Job; event: NewJobEvent }>
    switch (result.outcome) {
      case 'applied':
        m = this.jobMove(job, 'verifying', this.system, 'result_applied', details, { last_result, applied: true, lease: null, verify_deadline: now + this.o.verify_deadline_ms })
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
        m = this.jobMove(job, 'unknown', this.system, 'result_unknown', details, { last_result, lease: null, ...this.unknownPatch(job, now) })
    }
    if (!m.ok) return m
    return this.writeJob(job, m.value.next, [m.value.event, ...this.needsManualEvent(job, m.value.next)])
  }

  /** Open a verification request for a job in `verifying`; the returned token must accompany the verification result. */
  async beginVerification(jobId: string): Promise<Outcome<{ job: Job; token: string }>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.state !== 'verifying') return invalid(`Only a job in verification can be verified (this one is ${job.state}).`)
    const token = this.ids.next('verify')
    const next: Job = { ...job, verify_lease: { token_hash: tokenHash(token), until: job.verify_deadline ?? this.clock.now() + this.o.verify_deadline_ms, attempt: job.verify_attempts + 1 }, updated_at: this.clock.now() }
    const res = await this.writeJob(job, next, [])
    return res.ok ? ok({ job: res.value, token }) : res
  }

  async recordVerification(jobId: string, token: string, v: { outcome: VerifyOutcome; expected: JsonObject; observed: JsonObject }): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    const tokenOk = tokenMatches(token, job.verify_lease?.token_hash)
    if (job.state !== 'verifying') {
      if (tokenOk && isTerminalJob(job.state) && job.verification?.outcome === v.outcome) return ok(job) // duplicate
      if (!tokenOk) return this.rejectStale(job, token, 'verification')
      return invalid(`A ${job.state} job cannot take a verification result.`)
    }
    if (!tokenOk) return this.rejectStale(job, token, 'verification')
    const now = this.clock.now()
    const verification = { outcome: v.outcome, expected: redactDetails(v.expected), observed: redactDetails(v.observed), at: now }
    const details = { outcome: v.outcome, expected: verification.expected, observed: verification.observed }
    if (v.outcome === 'inconclusive') {
      const attempts = job.verify_attempts + 1
      if (attempts < this.o.max_verify_attempts) {
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

  /** Open a reconcile request for an unknown job. Automatic requests wait for the backoff; `force` is an operator's explicit request. */
  async beginReconcile(jobId: string, opts: { force?: boolean } = {}): Promise<Outcome<{ job: Job; token: string; idempotency_key: string }>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.state !== 'unknown') return invalid(`Only an unknown job can be reconciled (this one is ${job.state}).`)
    const now = this.clock.now()
    if (!opts.force) {
      if (job.needs_manual) return fail('not_allowed', 'Automatic reconciliation gave up on this job; a person must check the device.')
      if (job.next_reconcile_at !== null && job.next_reconcile_at > now) return fail('not_yet', 'The next reconcile request is not due yet.')
    }
    const token = this.ids.next('reconcile')
    const lease: Lease = { token_hash: tokenHash(token), until: now + this.o.reconcile_lease_ms, attempt: job.reconcile_attempts + 1 }
    const m = this.jobMove(job, 'reconciling', this.system, 'reconcile_requested', { lease_fingerprint: hashFingerprint(lease.token_hash), reconcile_attempt: lease.attempt, forced: opts.force === true }, { reconcile_lease: lease, reconcile_attempts: lease.attempt })
    if (!m.ok) return m
    const res = await this.writeJob(job, m.value.next, [m.value.event])
    return res.ok ? ok({ job: res.value, token, idempotency_key: job.idempotency_key }) : res
  }

  async recordReconcile(jobId: string, token: string, outcome: ReconcileOutcome): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (job.last_reconcile && tokenMatches(token, job.last_reconcile.token_hash)) {
      if (job.last_reconcile.outcome === outcome) return ok(job)
      await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'conflicting_duplicate', { first: job.last_reconcile.outcome, second: outcome })] })
      return fail('conflicting_duplicate', 'A different reconcile answer was already recorded; the first one stands.')
    }
    if (job.state !== 'reconciling' || !tokenMatches(token, job.reconcile_lease?.token_hash)) return this.rejectStale(job, token, 'reconcile')
    const r = await this.store.getRollout(job.rollout_id)
    const now = this.clock.now()
    const base = { reconcile_lease: null, last_reconcile: { token_hash: job.reconcile_lease!.token_hash, outcome } }
    const details = { outcome, lease_fingerprint: hashFingerprint(job.reconcile_lease!.token_hash) }
    let m: Outcome<{ next: Job; event: NewJobEvent }>
    if (outcome === 'applied') m = this.jobMove(job, 'verifying', this.system, 'reconciled_applied', details, { ...base, applied: true, verify_deadline: now + this.o.verify_deadline_ms })
    else if (outcome === 'partial') m = this.jobMove(job, 'partially_applied', this.system, 'reconciled_partial', details, { ...base, partial: true, terminal_reason: 'partial_application' })
    else if (outcome === 'unknown' || outcome === 'unsupported') m = this.jobMove(job, 'unknown', this.system, `reconciled_${outcome}`, details, { ...base, ...this.unknownPatch(job, now, outcome === 'unsupported') })
    else if (r?.state === 'cancelled') m = this.jobMove(job, 'cancelled', this.system, 'reconciled_not_applied', details, { ...base, terminal_reason: 'rollout_cancelled' })
    else if (!r || r.state === 'expired' || now >= this.expiresAt(r)) m = this.jobMove(job, 'expired', this.system, 'reconciled_not_applied', details, { ...base, terminal_reason: 'expired' })
    else if (job.attempt >= job.max_attempts) m = this.jobMove(job, 'failed', this.system, 'reconciled_not_applied', details, { ...base, terminal_reason: 'attempts_exhausted' })
    else m = this.jobMove(job, 'queued', this.system, 'reconciled_not_applied', details, { ...base, lease: null, next_reconcile_at: null })
    if (!m.ok) return m
    return this.writeJob(job, m.value.next, [m.value.event, ...this.needsManualEvent(job, m.value.next)])
  }

  /** An operator settles an unknown, blocked, verifying or reconciling job by hand (after checking the device). */
  async resolveManually(jobId: string, actor: string, note: string): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    const m = this.jobMove(job, 'resolved_manually', actor, 'resolved_manually', { note }, { terminal_reason: 'resolved_manually', reconcile_lease: null, verify_lease: null })
    return m.ok ? this.writeJob(job, m.value.next, [m.value.event]) : m
  }

  /**
   * Record the outcome of restoring a snapshot for a failed job (state stays; the recovery record changes). A
   * restore itself should run as a recovery rollout (lib/jobs/recovery.ts) with its own approval and lease.
   */
  async recordRollback(jobId: string, actor: string, status: 'restored' | 'failed' | 'unsupported'): Promise<Outcome<Job>> {
    const job = await this.store.getJob(jobId)
    if (!job) return notFound('job')
    if (!FAILURE_JOB_STATES.has(job.state)) return invalid('Only a failed job can be rolled back.')
    if (job.snapshot?.status !== 'taken') return fail('not_allowed', 'There is no snapshot to restore for this job.')
    const next: Job = { ...job, rollback: { status, at: this.clock.now() }, updated_at: this.clock.now() }
    next.recovery_actions = recoveryActionsFor(next, { rollback: this.caps(job)?.operations.rollback === true })
    return this.writeJob(job, next, [this.jobEvent(job, 'recorded', job.state, job.state, actor, `rollback_${status}`)])
  }

  // -------------------------------------------------------------------------------------------------
  // Helpers

  private caps(job: Pick<Job, 'adapter'>): AdapterCapabilities | undefined {
    return own(this.adapters, job.adapter)
  }

  private hashPlan(plan: Plan): Outcome<string> {
    const nonNfc = findNonNfc(plan)
    if (nonNfc) return fail('invalid_plan', `${nonNfc} is not in Unicode NFC form; send the NFC text.`)
    try {
      return ok(payloadHash(plan))
    } catch (e) {
      return fail('invalid_plan', `The plan is not plain JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private subjectOf(r: Rollout): string {
    return approvalSubject({
      rollout_id: r.id, revision: r.revision, payload_hash: r.payload_hash, targets: r.targets, excluded: r.excluded, impact: r.impact,
      impact_requires_acknowledgement: r.impact_requires_acknowledgement, effective_risk: r.effective_risk,
    })
  }

  private holdsLease(job: Job, token: string): boolean {
    return LEASED_JOB_STATES.has(job.state) && job.lease !== null && tokenMatches(token, job.lease.token_hash)
  }

  private async rejectStale<T>(job: Job, token: string, what: string): Promise<Outcome<T>> {
    await this.store.commit({ events: [this.jobEvent(job, 'rejected', job.state, job.state, this.system, 'stale_lease', { message: what, lease_fingerprint: hashFingerprint(tokenHash(token)) })] })
    return fail('stale_lease', 'This token is no longer valid for the job; the message was ignored and logged.')
  }

  private jobMove(job: Job, to: JobState, actor: string, reason: string, details: JsonObject = {}, patch: Partial<Job> = {}): Outcome<{ next: Job; event: NewJobEvent }> {
    if (!canTransitionJob(job.state, to)) return invalid(`A job cannot go from ${job.state} to ${to}.`)
    const now = this.clock.now()
    const next: Job = { ...job, ...patch, state: to, updated_at: now, finished_at: isTerminalJob(to) ? now : null }
    next.recovery_actions = recoveryActionsFor(next, { rollback: this.caps(job)?.operations.rollback === true })
    return ok({ next, event: this.jobEvent(job, 'transition', job.state, to, actor, reason, details) })
  }

  private async writeJob(prev: Job, next: Job, events: NewJobEvent[], fence?: Fence): Promise<Outcome<Job>> {
    const res = await this.store.commit({ jobs: [{ record: next, expected_version: prev.version }], events, bump_slots: bumpsFor(prev, next), fence })
    return res.ok ? ok(res.value.jobs[0]) : res
  }

  private async writeRollout(prev: Rollout, next: Rollout, events: NewJobEvent[], fence?: Fence): Promise<Outcome<Rollout>> {
    if (next.state !== prev.state && !canTransitionRollout(prev.state, next.state)) return invalid(`A rollout cannot go from ${prev.state} to ${next.state}.`)
    const res = await this.store.commit({ rollouts: [{ record: next, expected_version: prev.version }], events, fence })
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
    if (current === null) return `Stale configuration version: "${plan.base_version.key}" is not a known configuration, so its current version cannot be confirmed.`
    if (current > plan.base_version.version) {
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

  /** A newer rollout with the same key that has STARTED (so it has a job for the target) supersedes a waiting job. */
  private supersededBy(r: Rollout, job: Job, rollouts: Rollout[]): Rollout | null {
    const key = r.plan.supersedes_key
    if (key === null) return null
    return rollouts.find((o) => o.id !== r.id && o.seq > r.seq && o.plan.supersedes_key === key && o.started_at !== null && o.targets.some((t) => t.target_id === job.target_id)) ?? null
  }

  private pathsOf(r: Rollout): string[] {
    return r.setting_paths_effective.length ? r.setting_paths_effective : r.plan.setting_paths
  }

  private conflictsWith(r: Rollout, o: Rollout): boolean {
    if (o.id === r.id) return false
    const sameKey = r.plan.supersedes_key !== null && r.plan.supersedes_key === o.plan.supersedes_key
    return !sameKey && this.pathsOf(r).some((a) => this.pathsOf(o).some((b) => pathsOverlap(a, b)))
  }

  private async findConflicts(r: Rollout, targets: IncludedTarget[]): Promise<RolloutConflict[]> {
    const out: RolloutConflict[] = []
    const mine = new Set(targets.map((t) => t.target_id))
    for (const o of await this.store.listRollouts()) {
      if (!CONFLICT_HOLDING.has(o.state) || !this.conflictsWith(r, o)) continue
      const paths = this.pathsOf(r).filter((a) => this.pathsOf(o).some((b) => pathsOverlap(a, b)))
      for (const t of o.targets) if (mine.has(t.target_id)) for (const p of paths) out.push({ target_id: t.target_id, setting_path: p, other_rollout_id: o.id })
    }
    return out
  }

  /**
   * Targets on which an earlier (lower seq) conflicting rollout still has unfinished work, with that rollout's id.
   * Conflicting jobs on one target run strictly in rollout order, whatever the conflict policy.
   */
  private async targetsHeldByEarlierConflicts(r: Rollout, rollouts: Rollout[]): Promise<Map<string, string>> {
    const held = new Map<string, string>()
    for (const o of rollouts) {
      if (o.seq >= r.seq || !CONFLICT_HOLDING.has(o.state) || !this.conflictsWith(r, o)) continue
      if (!STARTED.has(o.state)) {
        for (const t of o.targets) if (!held.has(t.target_id)) held.set(t.target_id, o.id)
        continue
      }
      for (const j of await this.store.listJobsByRollout(o.id)) if (!isTerminalJob(j.state) && !held.has(j.target_id)) held.set(j.target_id, o.id)
    }
    return held
  }
}

function addAuthor(authors: string[], actor: string): string[] {
  return authors.includes(actor) ? authors : [...authors, actor]
}

/** What exactly runs on one target: the plan hash plus that target's identity and resolved inputs. */
export function effectiveHash(payload: string, c: Pick<TargetCandidate, 'target_id' | 'location_id' | 'model' | 'firmware' | 'effective_inputs'>): string {
  return sha256Hex(`${EFFECTIVE_HASH_DOMAIN}\n${canonicalize({
    payload_hash: payload, target_id: c.target_id, location_id: c.location_id, model: c.model, firmware: c.firmware, inputs: c.effective_inputs ?? null,
  })}`)
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
