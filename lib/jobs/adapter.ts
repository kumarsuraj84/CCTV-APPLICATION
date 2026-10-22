// Adapter interface (P7-0): how the engine's runner talks to one kind of target (Windows agent, Wi-Fi AP
// vendor interface, fake). Every call is about one target. The engine itself never calls an adapter; the
// runner (lib/jobs/runner.ts) or the agent API does, and reports the answers to the engine.
import type { JsonObject } from './canonical'
import type { ImpactEstimate, Plan, PreflightIssue, ReconcileOutcome, VerifyOutcome } from './types'

export interface AdapterCapabilities {
  adapter_id: string
  /** fake: orchestration tests only; experimental: unvalidated vendor adapter; lab_validated: proven on named hardware. */
  maturity: 'fake' | 'experimental' | 'lab_validated'
  /** Plan kinds this adapter performs, with the target capabilities each needs (from the capability matrix). */
  kinds: Record<string, { required_target_capabilities: string[] }>
  operations: { snapshot: boolean; rollback: boolean; stop: boolean; verify: boolean; reconcile: boolean }
}

export interface AdapterTarget {
  target_id: string
  location_id: string
}

export interface PreflightResult {
  issues: PreflightIssue[]
  impact: ImpactEstimate | null
}

export type SnapshotResult = { status: 'taken'; ref: string } | { status: 'unsupported' } | { status: 'failed'; message: string }

/**
 * The answer to an apply request. `delivered: false` means the hub got no answer: the device may or may
 * not have applied the change (lost acknowledgement, timeout, connection dropped), so the job becomes
 * `unknown` and must be reconciled; it is never re-sent blindly.
 */
export type ApplyResponse =
  | { delivered: true; outcome: 'applied' | 'failed' | 'partial'; message: string }
  /** `acknowledged: true`: the device confirmed receipt before the answer was lost (the job is then acked, and becomes unknown when its run lease ends). */
  | { delivered: false; reason: 'unreachable' | 'timeout' | 'lost_response'; acknowledged?: boolean }

/** The device's own record of a job (its journal), keyed by the idempotency key. */
export type ReconcileResponse = { reachable: true; state: ReconcileOutcome } | { reachable: false }

export interface VerifyResponse {
  outcome: VerifyOutcome
  /** Redacted, diff-friendly maps of setting path to value; secrets appear only as "[redacted]". */
  expected: JsonObject
  observed: JsonObject
}

export type RollbackResult = { status: 'restored' | 'failed' | 'unsupported' }
export type StopResult = { status: 'stopping' | 'unsupported' }

export interface JobAdapter {
  describeCapabilities(): AdapterCapabilities
  /** Read-only checks before execution: issues and the expected impact. */
  preflight(target: AdapterTarget, plan: Plan): Promise<PreflightResult>
  /** Capture the current configuration as an opaque, encrypted blob reference (may be unsupported). */
  snapshot(target: AdapterTarget): Promise<SnapshotResult>
  /** Apply the plan. The same idempotency key must never apply twice. */
  apply(target: AdapterTarget, plan: Plan, idempotencyKey: string): Promise<ApplyResponse>
  /** "What is your state for this job?" */
  reconcile(target: AdapterTarget, idempotencyKey: string): Promise<ReconcileResponse>
  /** Re-read the settings and compare them with the desired state of the plan. */
  verify(target: AdapterTarget, plan: Plan): Promise<VerifyResponse>
  /** Restore a snapshot (may be unsupported). */
  rollback(target: AdapterTarget, snapshotRef: string): Promise<RollbackResult>
  /** Ask a running job to stop (may be unsupported: then it is left to complete). */
  stop(target: AdapterTarget, idempotencyKey: string): Promise<StopResult>
}
