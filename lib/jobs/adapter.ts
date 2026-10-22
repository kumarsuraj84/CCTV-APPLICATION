// Adapter interface (P7-0): how the engine's runner talks to one kind of target (Windows agent, Wi-Fi AP
// vendor interface, fake). Every call is about one target. The engine itself never calls an adapter; the
// runner (lib/jobs/runner.ts) or the agent API does, and reports the answers to the engine.
//
// Adapters must redact at source: messages, expected/observed maps and snapshots never carry secret values
// (passphrases, admin passwords, SNMP communities, keys). The engine redacts again and caps message length,
// but that is a second line of defence, not the first.
import type { JsonObject } from './canonical'
import type { EpochMs, ImpactEstimate, Plan, PreflightIssue, ReconcileOutcome, RiskLevel, VerifyOutcome } from './types'

export interface KindCapabilities {
  /** Target capabilities this kind needs (from the capability matrix). */
  required_target_capabilities: string[]
  /** The lowest risk this kind may run at; a requester cannot go below it. */
  min_risk?: RiskLevel
  /** When true a configuration snapshot must be taken before apply; without one the job fails. */
  require_snapshot?: boolean
}

export interface AdapterCapabilities {
  adapter_id: string
  /** Version of the adapter code; plans name it and are blocked when it changes. */
  version: string
  /** fake: orchestration tests only; experimental: unvalidated vendor adapter; lab_validated: proven on named hardware. */
  maturity: 'fake' | 'experimental' | 'lab_validated'
  /** Plan kinds this adapter performs. */
  kinds: Record<string, KindCapabilities>
  operations: { snapshot: boolean; rollback: boolean; stop: boolean; verify: boolean; reconcile: boolean }
  /**
   * The settings a plan really changes, derived by the adapter from the plan (dot-separated paths). Used for
   * conflict detection; the requester's `setting_paths` is only checked against it. Without it the engine
   * falls back to the declaration (weaker).
   */
  describeSettingPaths?(plan: Plan): string[]
}

export interface AdapterTarget {
  target_id: string
  location_id: string
}

/** What the device must check before executing: the plan it receives must hash to these values. */
export interface ExecutionHashes {
  payload_hash: string
  effective_hash: string
}

export interface PreflightResult {
  issues: PreflightIssue[]
  impact: ImpactEstimate | null
}

export type SnapshotResult =
  | { status: 'taken'; ref: string; key_ref: string; content_sha256: string; retain_until: EpochMs }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }

/**
 * The answer to an apply request. `delivered: false` means the hub got no answer: the device may or may
 * not have applied the change (lost acknowledgement, timeout, connection dropped), so the job becomes
 * `unknown` and must be reconciled; it is never re-sent blindly.
 */
export type ApplyResponse =
  | { delivered: true; outcome: 'applied' | 'failed' | 'partial'; message: string }
  /** `acknowledged: true`: the device confirmed receipt before the answer was lost (the job is then acked, and becomes unknown when its run lease ends). */
  | { delivered: false; reason: 'unreachable' | 'timeout' | 'lost_response'; acknowledged?: boolean }

/** The device's own record of a job (its journal or a read-back), keyed by the idempotency key. `unsupported`: it cannot say at all. */
export type ReconcileResponse = { reachable: true; state: ReconcileOutcome } | { reachable: false }

export interface VerifyResponse {
  outcome: VerifyOutcome
  /** Redacted, diff-friendly maps of setting path to value; secrets appear only as references or "[redacted]". */
  expected: JsonObject
  observed: JsonObject
}

export type RollbackResult = { status: 'restored' | 'failed' | 'unsupported' }
export type StopResult = { status: 'stopping' | 'unsupported' }

export interface JobAdapter {
  describeCapabilities(): AdapterCapabilities
  /** Read-only checks before execution: issues and the expected impact. */
  preflight(target: AdapterTarget, plan: Plan): Promise<PreflightResult>
  /** Capture the current configuration as an encrypted blob reference (may be unsupported). */
  snapshot(target: AdapterTarget): Promise<SnapshotResult>
  /** Apply the plan. The same idempotency key must never apply twice; refuse a plan that does not hash to `hashes`. */
  apply(target: AdapterTarget, plan: Plan, idempotencyKey: string, hashes: ExecutionHashes): Promise<ApplyResponse>
  /** "What is your state for this job?" */
  reconcile(target: AdapterTarget, idempotencyKey: string): Promise<ReconcileResponse>
  /** Re-read the settings and compare them with the desired state of the plan. */
  verify(target: AdapterTarget, plan: Plan): Promise<VerifyResponse>
  /** Restore a snapshot (may be unsupported). Normally reached through a recovery rollout (lib/jobs/recovery.ts). */
  rollback(target: AdapterTarget, snapshotRef: string): Promise<RollbackResult>
  /** Ask a running job to stop (may be unsupported: then it is left to complete). */
  stop(target: AdapterTarget, idempotencyKey: string): Promise<StopResult>
}
