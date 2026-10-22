// Recovery as a job (P7-0, review round 1): restoring a snapshot is itself a change to a device, so it is
// a rollout of kind "recovery.restore_snapshot" with its own approval (at least medium risk), lease,
// per-target exclusivity, verification and audit, never a side door. This builds that plan from a finished
// rollout; it goes through the normal create → validate → resolve → submit → approve → schedule flow.
import { canonicalize, sha256Hex } from './canonical'
import { FAILURE_JOB_STATES } from './machines'
import type { Job, Plan, Rollout } from './types'

export const RESTORE_KIND = 'recovery.restore_snapshot'

export interface RestoreOptions {
  requested_by: string
  now: number
  adapter_version: string
  /** How long the restore plan stays valid (default one day). */
  valid_ms?: number
}

/** Failed targets with a snapshot that was taken and not yet restored. */
export function restorableJobs(jobs: Job[]): Job[] {
  return jobs.filter((j) => FAILURE_JOB_STATES.has(j.state) && j.snapshot?.status === 'taken' && j.snapshot.ref !== null && j.rollback?.status !== 'restored')
}

export function buildRestorePlan(rollout: Rollout, jobs: Job[], o: RestoreOptions): Plan {
  const restorable = restorableJobs(jobs)
  const restores = restorable.map((j) => ({ target_id: j.target_id, snapshot_ref: j.snapshot!.ref as string, content_sha256: j.snapshot!.content_sha256 ?? '' }))
  const paths = rollout.setting_paths_effective.length ? rollout.setting_paths_effective : rollout.plan.setting_paths
  return {
    kind: RESTORE_KIND,
    adapter: rollout.plan.adapter,
    adapter_version: o.adapter_version,
    artifact: { id: `restore-of-${rollout.id}`, version: String(rollout.revision), sha256: sha256Hex(canonicalize(restores)) },
    params: { restores, setting_paths: paths },
    policy_version: rollout.plan.policy_version,
    target_selector: { target_ids: restorable.map((j) => j.target_id) },
    base_version: null,
    supersedes_key: null,
    setting_paths: paths,
    conflict_policy: 'wait',
    schedule: { not_before: new Date(o.now).toISOString(), window: rollout.plan.schedule.window },
    expires_at: new Date(o.now + (o.valid_ms ?? 86_400_000)).toISOString(),
    canary: { mode: 'none' },
    batch: { batch_size: 1, global_concurrency: 1, per_location_concurrency: 1, block_location_on_unknown: true, batch_soak_ms: 0 },
    thresholds: { stop_after_failures: 1, stop_after_failure_pct: 100, pct_min_finished: 1, stop_after_consecutive_failures: 1 },
    max_attempts: 1,
    risk: 'medium',
    requested_by: o.requested_by,
  }
}
