// Pure planning helpers (P7-0): target order, canary and batch assignment, failure thresholds, summaries,
// final rollout state and recovery actions.
import { FAILURE_JOB_STATES, SUCCESS_JOB_STATES, WAITING_JOB_STATES, isTerminalJob } from './machines'
import { fail, ok, type CanarySpec, type IncludedTarget, type Job, type JobState, type Outcome, type RecoveryAction, type RolloutState, type Thresholds } from './types'

export { pathsOverlap } from './paths'

interface Placed {
  target_id: string
  location_id: string
}

export type PhasedTarget = Omit<IncludedTarget, 'effective_hash'>

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Deterministic order: locations sorted, targets sorted within a location, taken round-robin so batches spread over locations. */
export function orderTargets<T extends Placed>(targets: T[]): T[] {
  const byLoc = new Map<string, T[]>()
  for (const t of targets) {
    const list = byLoc.get(t.location_id) ?? []
    list.push(t)
    byLoc.set(t.location_id, list)
  }
  const queues = [...byLoc.keys()].sort(cmp).map((k) => (byLoc.get(k) as T[]).sort((a, b) => cmp(a.target_id, b.target_id)))
  const out: T[] = []
  for (let i = 0; out.length < targets.length; i++) for (const q of queues) if (i < q.length) out.push(q[i])
  return out
}

/** Orders the targets and marks each as canary or a batch number. */
export function assignPhases(targets: Placed[], canary: CanarySpec, batchSize: number): Outcome<PhasedTarget[]> {
  const ordered = orderTargets(targets)
  const canaryIds = new Set<string>()
  if (canary.mode === 'explicit') {
    const included = new Set(ordered.map((t) => t.target_id))
    const missing = canary.target_ids.filter((id) => !included.has(id))
    if (missing.length > 0) return fail('invalid_plan', 'A canary target is not among the included targets.', { missing })
    for (const id of canary.target_ids) canaryIds.add(id)
  } else if (canary.mode === 'first_n') {
    for (const t of ordered.slice(0, canary.count)) canaryIds.add(t.target_id)
  } else if (canary.mode === 'per_location') {
    const perLoc = new Map<string, number>()
    for (const t of ordered) {
      const n = perLoc.get(t.location_id) ?? 0
      if (n < canary.per_location) { canaryIds.add(t.target_id); perLoc.set(t.location_id, n + 1) }
    }
  }
  const canaries = ordered.filter((t) => canaryIds.has(t.target_id))
  const rest = ordered.filter((t) => !canaryIds.has(t.target_id))
  const out: PhasedTarget[] = []
  for (const t of canaries) out.push({ target_id: t.target_id, location_id: t.location_id, order: out.length, phase: 'canary', warnings: [] })
  rest.forEach((t, i) => out.push({ target_id: t.target_id, location_id: t.location_id, order: out.length, phase: Math.floor(i / batchSize), warnings: [] }))
  return ok(out)
}

export interface FailureStats {
  /** Failures in the rollout so far. */
  failures: number
  /** Failures a human already decided about (when resuming after a threshold pause). */
  acknowledged: number
  consecutive: number
  /** Targets finished (success or failure). */
  finished: number
  /** Targets finished when the human decided (default 0). */
  finished_acknowledged?: number
}

/**
 * The reason to pause, or null. Only failures since the last human decision can trip a threshold, and the
 * percentage is computed over what finished since that decision (new failures / new finishes).
 */
export function thresholdBreach(t: Thresholds, s: FailureStats): string | null {
  const fresh = s.failures - s.acknowledged
  if (fresh <= 0) return null
  if (fresh >= t.stop_after_failures) return `${fresh} failures (limit ${t.stop_after_failures})`
  if (s.consecutive >= t.stop_after_consecutive_failures) return `${s.consecutive} failures in a row (limit ${t.stop_after_consecutive_failures})`
  const finishedSince = s.finished - (s.finished_acknowledged ?? 0)
  if (finishedSince >= t.pct_min_finished && (fresh * 100) / finishedSince >= t.stop_after_failure_pct) {
    return `${Math.round((fresh * 100) / finishedSince)}% of targets finished since the last decision failed (limit ${t.stop_after_failure_pct}%)`
  }
  return null
}

export interface RolloutSummary {
  targets: number
  excluded: number
  requested: number
  by_state: Record<JobState, number>
  /** Jobs whose change reached the device (result or reconciliation said applied). */
  applied: number
  partial: number
  verified: number
  already_satisfied: number
  accepted_but_not_verified: number
  /** apply_failed + verification_failed + partial. */
  failed: number
  apply_failed: number
  verification_failed: number
  unknown: number
  /** Unknown jobs on which automatic reconciliation gave up. */
  needs_manual: number
  in_progress: number
  waiting: number
  blocked: number
  cancelled: number
  expired: number
  superseded: number
  resolved_manually: number
  finished: number
  /** Some targets succeeded and some failed (or one was partially applied): no atomic transaction across targets. */
  is_partial: boolean
  /** Targets where neither this rollout nor the one that superseded it (or was superseded by it) applied anything. */
  left_unchanged: string[]
}

export const ALL_JOB_STATES: JobState[] = [
  'queued', 'blocked', 'offered', 'acked', 'running', 'verifying', 'unknown', 'reconciling', 'verified', 'already_satisfied',
  'accepted_but_not_verified', 'verification_failed', 'failed', 'partially_applied', 'cancelled', 'expired', 'superseded', 'resolved_manually',
]

export function summarize(rollout: { targets: readonly unknown[]; excluded: readonly unknown[] }, jobs: Job[], leftUnchanged: string[] = []): RolloutSummary {
  const by = Object.fromEntries(ALL_JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>
  for (const j of jobs) by[j.state] += 1
  const count = (set: ReadonlySet<JobState>) => jobs.filter((j) => set.has(j.state)).length
  const failed = count(FAILURE_JOB_STATES)
  const succeeded = count(SUCCESS_JOB_STATES)
  const partial = jobs.filter((j) => j.partial).length
  return {
    targets: rollout.targets.length,
    excluded: rollout.excluded.length,
    requested: jobs.length,
    by_state: by,
    applied: jobs.filter((j) => j.applied).length,
    partial,
    verified: by.verified,
    already_satisfied: by.already_satisfied,
    accepted_but_not_verified: by.accepted_but_not_verified,
    failed,
    apply_failed: by.failed,
    verification_failed: by.verification_failed,
    unknown: by.unknown + by.reconciling,
    needs_manual: jobs.filter((j) => j.needs_manual && !isTerminalJob(j.state)).length,
    in_progress: by.offered + by.acked + by.running + by.verifying,
    waiting: count(WAITING_JOB_STATES),
    blocked: by.blocked,
    cancelled: by.cancelled,
    expired: by.expired,
    superseded: by.superseded,
    resolved_manually: by.resolved_manually,
    finished: jobs.filter((j) => isTerminalJob(j.state)).length,
    is_partial: partial > 0 || (succeeded > 0 && failed > 0),
    left_unchanged: [...leftUnchanged].sort(),
  }
}

/** The end state once every job is terminal; null while any job is open. */
export function finalRolloutState(jobs: Job[]): RolloutState | null {
  if (jobs.some((j) => !isTerminalJob(j.state))) return null
  const live = jobs.filter((j) => j.state !== 'superseded')
  if (live.length === 0) return 'superseded'
  if (live.every((j) => j.state === 'resolved_manually')) return 'completed_manually'
  const failures = live.filter((j) => FAILURE_JOB_STATES.has(j.state)).length
  const successes = live.filter((j) => SUCCESS_JOB_STATES.has(j.state)).length
  if (failures === 0) return 'completed'
  return successes > 0 ? 'partially_failed' : 'failed'
}

/** What an operator can do about a job. */
export function recoveryActionsFor(job: Job, ops: { rollback: boolean }): RecoveryAction[] {
  if (job.state === 'unknown' || job.state === 'reconciling') return job.needs_manual ? ['manual'] : ['reconcile', 'retry_after_reconcile', 'manual']
  if (!FAILURE_JOB_STATES.has(job.state)) return []
  const out: RecoveryAction[] = []
  if (ops.rollback && job.snapshot?.status === 'taken' && job.rollback?.status !== 'restored') out.push('restore_snapshot')
  out.push('manual')
  return out
}
