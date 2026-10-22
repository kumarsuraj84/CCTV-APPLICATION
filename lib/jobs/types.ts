// Types of the rollout and job orchestration engine (P7-0). No database, no network: the engine works
// through the JobStore interface, an injected clock and an injected id generator.
import type { JsonObject, JsonValue } from './canonical'

/** Epoch milliseconds (UTC). Every time inside the engine is one of these; plans carry ISO-8601 texts with an explicit offset. */
export type EpochMs = number

export type RiskLevel = 'low' | 'medium' | 'high'

// ---------------------------------------------------------------------------------------------------
// Plan: the immutable execution payload. Every field influences execution and is covered by payload_hash.

export interface ArtifactRef {
  /** Library id of the script, package or configuration profile. */
  id: string
  /** Immutable version of that artifact. */
  version: string
  /** Lower-case hex SHA-256 of the artifact content. */
  sha256: string
}

/**
 * Which targets the requester chose, as captured when the plan was written. Filters combine with AND;
 * an empty or absent filter does not restrict. `organisation_wide` must be set explicitly to target everything.
 */
export interface TargetSelector {
  target_ids?: string[]
  location_ids?: string[]
  models?: string[]
  organisation_wide?: boolean
}

/** A maintenance window. Times are explicit about their zone: absolute instants carry an offset, daily windows name an IANA zone. */
export type MaintenanceWindow =
  | { kind: 'absolute'; start: string; end: string }
  | {
      kind: 'daily'
      /** IANA time zone, e.g. "Asia/Kolkata". */
      time_zone: string
      /** "HH:MM" 24-hour local time. A window whose end is not after its start crosses midnight. */
      start: string
      end: string
      /** Days on which the window opens (0 = Sunday .. 6 = Saturday, local to time_zone). Absent: every day. */
      days?: number[]
    }

export type CanarySpec =
  | { mode: 'none' }
  /** Explicit canary targets (must be among the included targets). */
  | { mode: 'explicit'; target_ids: string[]; soak_ms: number }
  /** The first N included targets in order. */
  | { mode: 'first_n'; count: number; soak_ms: number }
  /** The first `per_location` included targets of every location (default rule: one per location). */
  | { mode: 'per_location'; per_location: number; soak_ms: number }

export interface BatchSpec {
  /** Targets per batch after the canary. */
  batch_size: number
  /** Most active jobs of this rollout at any moment. */
  global_concurrency: number
  /** Most active management jobs at one location (counted across all rollouts) while this rollout offers. Default 1. */
  per_location_concurrency: number
  /** When true, a job in `unknown` (or reconciling) at a location stops new offers at that location. */
  block_location_on_unknown: boolean
  /** Wait between the end of one batch and the start of the next. */
  batch_soak_ms: number
}

export interface Thresholds {
  /** Pause after this many failures since the last human decision (>= 1). */
  stop_after_failures: number
  /** Pause when failures are at least this percentage of finished targets (0..100), once `pct_min_finished` targets have finished. */
  stop_after_failure_pct: number
  pct_min_finished: number
  /** Pause after this many failures in a row (>= 1). */
  stop_after_consecutive_failures: number
}

export interface Plan {
  /** What is done, e.g. "wifi.profile.apply", "desktop.wallpaper", "software.install". */
  kind: string
  /** Adapter id that executes it, e.g. "fake", "windows-agent", "netgear-wax-experimental". */
  adapter: string
  artifact: ArtifactRef
  /** Exact parameters (plain JSON; secrets are references, never values). */
  params: JsonValue
  /** Version of the execution policy the plan was checked against. */
  policy_version: number
  target_selector: TargetSelector
  /** The configuration version this plan was built on (stale check), or null. */
  base_version: { key: string; version: number } | null
  /** Jobs with the same key replace older queued ones (e.g. "wifi:profile:<id>:<location>", "desktop:wallpaper"). */
  supersedes_key: string | null
  /** Settings this plan changes, dot-separated (e.g. "ssid.staff.passphrase"). Used for conflict detection. */
  setting_paths: string[]
  /** What to do when another active rollout touches the same target and setting: refuse this one, or wait for the earlier one. */
  conflict_policy: 'reject' | 'wait'
  schedule: { not_before: string; window: MaintenanceWindow | null }
  /** After this instant nothing new is offered and queued jobs expire. */
  expires_at: string
  canary: CanarySpec
  batch: BatchSpec
  thresholds: Thresholds
  /** Offers per target before giving up (only `not_applied` after reconciliation is retried). */
  max_attempts: number
  risk: RiskLevel
  requested_by: string
}

// ---------------------------------------------------------------------------------------------------
// Rollout.

export type RolloutState =
  | 'draft'
  | 'validated'
  | 'targets_resolved'
  | 'pending_approval'
  | 'approved'
  | 'scheduled'
  | 'running_canary'
  | 'running_batches'
  | 'verifying'
  | 'paused'
  | 'paused_by_threshold'
  | 'completed'
  | 'partially_failed'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'expired'

export interface Approval {
  id: string
  approver: string
  decision: 'approve' | 'reject'
  /** The payload hash the approver saw. An approval counts only while it equals the rollout's payload hash. */
  payload_hash: string
  acknowledged_impact: boolean
  at: EpochMs
  note: string | null
}

/** A target offered to resolution, as found by the caller (inventory + capability matrix + presence). */
export interface TargetCandidate {
  target_id: string
  location_id: string
  model: string | null
  firmware: string | null
  /** Operations/capabilities this target supports (from the capability matrix). */
  capabilities: string[]
  /** False when the capability matrix or firmware rules rule the target out. */
  compatible: boolean
  incompatibility_reasons: string[]
  online: boolean
  /** Issues found by adapter preflight (only for online targets; offline ones are rechecked on return). */
  preflight_issues: PreflightIssue[]
  impact: ImpactEstimate | null
}

export interface PreflightIssue {
  code: string
  message: string
  /** `blocking` excludes the target; `warning` is recorded and shown. */
  severity: 'blocking' | 'warning'
}

export interface ImpactEstimate {
  disruption: 'none' | 'brief' | 'service_interruption'
  reboot_required: boolean
  reconnect_required: boolean
  estimated_downtime_s: number
  notes: string[]
}

export interface IncludedTarget {
  target_id: string
  location_id: string
  order: number
  /** 'canary' or the batch number (0-based). */
  phase: 'canary' | number
  warnings: string[]
}

export interface ExcludedTarget {
  target_id: string
  location_id: string | null
  reasons: string[]
}

export interface RolloutConflict {
  target_id: string
  setting_path: string
  other_rollout_id: string
}

export interface Rollout {
  id: string
  /** Fencing version: incremented by the store on every write (compare-and-set). */
  version: number
  /** Creation order; "newer" means a higher seq. */
  seq: number
  title: string
  state: RolloutState
  plan: Plan
  payload_hash: string
  approvals: Approval[]
  targets: IncludedTarget[]
  excluded: ExcludedTarget[]
  impact: ImpactEstimate | null
  /** True when the impact needs every approver to acknowledge it (disruption or reconnection). */
  impact_requires_acknowledgement: boolean
  conflicts: RolloutConflict[]
  /** -1 while in the canary, then the batch being offered. */
  current_batch: number
  /** When the current phase (canary or batch) finished; soak time counts from here. */
  phase_finished_at: EpochMs | null
  paused_from: RolloutState | null
  pause_reason: string | null
  /** Failures already seen by a human when resuming after a threshold pause. */
  failures_acknowledged: number
  consecutive_failures: number
  /** Jobs already counted for the failure counters (in the order they finished). */
  counted_jobs: string[]
  /** Set when a human resumed after a canary failure: the canary no longer blocks the batches. */
  canary_override: boolean
  created_by: string
  created_at: EpochMs
  updated_at: EpochMs
  started_at: EpochMs | null
  finished_at: EpochMs | null
}

// ---------------------------------------------------------------------------------------------------
// Job (one per included target).

export type JobState =
  | 'queued'
  | 'blocked'
  | 'offered'
  | 'acked'
  | 'running'
  | 'verifying'
  | 'unknown'
  | 'reconciling'
  | 'verified'
  | 'already_satisfied'
  | 'accepted_but_not_verified'
  | 'verification_failed'
  | 'failed'
  | 'partially_applied'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'resolved_manually'

export interface Lease {
  token: string
  until: EpochMs
  attempt: number
}

export type ResultOutcome = 'applied' | 'failed' | 'partial' | 'unknown'
export type ReconcileOutcome = 'applied' | 'not_applied' | 'partial' | 'unknown'
export type VerifyOutcome = 'match' | 'mismatch' | 'inconclusive' | 'unsupported'

export type RecoveryAction = 'reconcile' | 'retry_after_reconcile' | 'restore_snapshot' | 'manual'

export interface VerificationRecord {
  outcome: VerifyOutcome
  /** Redacted expected and observed values (a diff-friendly map of setting path to value). */
  expected: JsonObject
  observed: JsonObject
  at: EpochMs
}

export interface Job {
  id: string
  version: number
  rollout_id: string
  rollout_seq: number
  /** Adapter id of the plan (copied so recovery options can be computed from the job alone). */
  adapter: string
  target_id: string
  location_id: string
  payload_hash: string
  /** job id + payload hash: what the device journal uses to recognise a repeat. */
  idempotency_key: string
  supersedes_key: string | null
  setting_paths: string[]
  phase: 'canary' | number
  order: number
  state: JobState
  /** Number of offers made so far. */
  attempt: number
  max_attempts: number
  lease: Lease | null
  /** Token of an open reconcile request. */
  reconcile_lease: Lease | null
  reconcile_attempts: number
  /** The last reconcile token answered and its answer (duplicate answers are idempotent). */
  last_reconcile: { token: string; outcome: ReconcileOutcome } | null
  verify_attempts: number
  /** Separate flags so requested/applied/verified/failed/unknown never collapse into one status. */
  applied: boolean
  partial: boolean
  /** The last lease token whose result was accepted, and that result (for duplicate detection). */
  last_result: { token: string; outcome: ResultOutcome; at: EpochMs } | null
  verification: VerificationRecord | null
  snapshot: { status: 'taken' | 'unsupported' | 'failed'; ref: string | null } | null
  rollback: { status: 'restored' | 'failed' | 'unsupported'; at: EpochMs } | null
  stop: 'requested' | 'unsupported_left_to_complete' | null
  blocked_reason: string | null
  terminal_reason: string | null
  superseded_by: string | null
  recovery_actions: RecoveryAction[]
  created_at: EpochMs
  updated_at: EpochMs
  finished_at: EpochMs | null
}

// ---------------------------------------------------------------------------------------------------
// Events: append-only, one per state change (and per refused protocol message). Never contain secrets.

export interface JobEvent {
  seq: number
  at: EpochMs
  actor: string
  entity: 'rollout' | 'job'
  rollout_id: string
  job_id: string | null
  target_id: string | null
  /** transition: a state change; rejected: a refused message (stale token, conflicting duplicate); recorded: data without a state change. */
  type: 'transition' | 'rejected' | 'recorded'
  from: string | null
  to: string | null
  reason: string
  payload_hash: string
  details: JsonObject
}

export type NewJobEvent = Omit<JobEvent, 'seq'>

// ---------------------------------------------------------------------------------------------------
// Results.

export type JobErrorCode =
  | 'not_found'
  | 'invalid_transition'
  | 'invalid_plan'
  | 'stale_configuration_version'
  | 'conflicting_rollout'
  | 'no_targets'
  | 'payload_hash_mismatch'
  | 'approver_is_requester'
  | 'duplicate_approver'
  | 'impact_not_acknowledged'
  | 'approvals_missing'
  | 'immutable_after_start'
  | 'stale_lease'
  | 'conflicting_duplicate'
  | 'version_conflict'
  | 'not_allowed'

export interface JobError {
  code: JobErrorCode
  message: string
  details?: JsonObject
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: JobError }

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value }
}

export function fail<T = never>(code: JobErrorCode, message: string, details?: JsonObject): Outcome<T> {
  return details ? { ok: false, error: { code, message, details } } : { ok: false, error: { code, message } }
}
