// Explicit transition tables for rollouts and jobs (P7-0). Every state change in the engine is checked here.
import type { JobState, RolloutState } from './types'

export const ROLLOUT_TRANSITIONS: Record<RolloutState, RolloutState[]> = {
  draft: ['validated', 'cancelled'],
  validated: ['targets_resolved', 'draft', 'cancelled'],
  targets_resolved: ['pending_approval', 'approved', 'draft', 'cancelled', 'expired'],
  pending_approval: ['approved', 'draft', 'cancelled', 'expired'],
  approved: ['scheduled', 'draft', 'cancelled', 'expired'],
  scheduled: ['running_canary', 'running_batches', 'draft', 'cancelled', 'expired'],
  running_canary: ['running_batches', 'verifying', 'paused', 'paused_by_threshold', 'completed', 'partially_failed', 'failed', 'superseded', 'cancelled', 'expired'],
  running_batches: ['verifying', 'paused', 'paused_by_threshold', 'completed', 'partially_failed', 'failed', 'superseded', 'cancelled', 'expired'],
  verifying: ['running_batches', 'paused', 'paused_by_threshold', 'completed', 'partially_failed', 'failed', 'superseded', 'cancelled', 'expired'],
  paused: ['running_canary', 'running_batches', 'verifying', 'cancelled', 'expired'],
  paused_by_threshold: ['running_canary', 'running_batches', 'verifying', 'cancelled', 'expired'],
  completed: [],
  partially_failed: [],
  failed: [],
  cancelled: [],
  superseded: [],
  expired: [],
}

export const JOB_TRANSITIONS: Record<JobState, JobState[]> = {
  queued: ['offered', 'blocked', 'already_satisfied', 'cancelled', 'expired', 'superseded'],
  blocked: ['offered', 'already_satisfied', 'cancelled', 'expired', 'superseded', 'resolved_manually'],
  // A result with the valid lease token implies receipt, so a result may arrive without a separate acknowledgement.
  offered: ['acked', 'running', 'verifying', 'failed', 'partially_applied', 'unknown', 'cancelled'],
  acked: ['running', 'verifying', 'failed', 'partially_applied', 'unknown', 'cancelled'],
  running: ['verifying', 'failed', 'partially_applied', 'unknown', 'cancelled'],
  verifying: ['verified', 'verification_failed', 'accepted_but_not_verified'],
  // Never back to queued or offered directly: the device must be asked first.
  unknown: ['reconciling', 'resolved_manually'],
  reconciling: ['unknown', 'verifying', 'queued', 'failed', 'partially_applied', 'cancelled', 'expired'],
  verified: [],
  already_satisfied: [],
  accepted_but_not_verified: [],
  verification_failed: [],
  failed: [],
  partially_applied: [],
  cancelled: [],
  expired: [],
  superseded: [],
  resolved_manually: [],
}

/** Job states that hold the target: no other management job may be offered to it meanwhile. */
export const ACTIVE_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['offered', 'acked', 'running', 'verifying', 'unknown', 'reconciling'])
/** Job states that hold a lease token. */
export const LEASED_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['offered', 'acked', 'running'])
/** Waiting to be offered. */
export const WAITING_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['queued', 'blocked'])
/** Failure outcomes (count toward thresholds). */
export const FAILURE_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['failed', 'verification_failed', 'partially_applied'])
/** Success outcomes. */
export const SUCCESS_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['verified', 'already_satisfied', 'accepted_but_not_verified'])
export const RUNNING_ROLLOUT_STATES: ReadonlySet<RolloutState> = new Set<RolloutState>(['running_canary', 'running_batches', 'verifying'])

export function canTransitionRollout(from: RolloutState, to: RolloutState): boolean {
  return ROLLOUT_TRANSITIONS[from].includes(to)
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to)
}

export function isTerminalRollout(s: RolloutState): boolean {
  return ROLLOUT_TRANSITIONS[s].length === 0
}

export function isTerminalJob(s: JobState): boolean {
  return JOB_TRANSITIONS[s].length === 0
}
