import { describe, expect, it } from 'vitest'
import {
  ACTIVE_JOB_STATES,
  JOB_TRANSITIONS,
  ROLLOUT_TRANSITIONS,
  canTransitionJob,
  canTransitionRollout,
  isTerminalJob,
  isTerminalRollout,
} from '@/lib/jobs/machines'
import type { JobState, RolloutState } from '@/lib/jobs/types'

const ROLLOUT_TERMINAL: RolloutState[] = ['completed', 'completed_manually', 'partially_failed', 'failed', 'cancelled', 'superseded', 'expired']
const JOB_TERMINAL: JobState[] = ['verified', 'already_satisfied', 'accepted_but_not_verified', 'verification_failed', 'failed', 'partially_applied', 'cancelled', 'expired', 'superseded', 'resolved_manually']

describe('rollout transition table', () => {
  it('lists every state', () => {
    expect(Object.keys(ROLLOUT_TRANSITIONS).sort()).toEqual([
      'approved', 'cancelled', 'completed', 'completed_manually', 'draft', 'expired', 'failed', 'partially_failed', 'paused', 'paused_by_threshold',
      'pending_approval', 'running_batches', 'running_canary', 'scheduled', 'superseded', 'targets_resolved', 'validated', 'verifying',
    ])
  })

  it('terminal states have no way out', () => {
    for (const s of ROLLOUT_TERMINAL) {
      expect(isTerminalRollout(s)).toBe(true)
      expect(ROLLOUT_TRANSITIONS[s]).toEqual([])
    }
  })

  it('follows the documented order before execution', () => {
    expect(canTransitionRollout('draft', 'validated')).toBe(true)
    expect(canTransitionRollout('validated', 'targets_resolved')).toBe(true)
    expect(canTransitionRollout('targets_resolved', 'pending_approval')).toBe(true)
    expect(canTransitionRollout('pending_approval', 'approved')).toBe(true)
    expect(canTransitionRollout('approved', 'scheduled')).toBe(true)
    expect(canTransitionRollout('scheduled', 'running_canary')).toBe(true)
    expect(canTransitionRollout('running_canary', 'running_batches')).toBe(true)
    expect(canTransitionRollout('running_batches', 'verifying')).toBe(true)
    expect(canTransitionRollout('verifying', 'completed')).toBe(true)
  })

  it('cannot skip validation, target resolution or approval', () => {
    expect(canTransitionRollout('draft', 'targets_resolved')).toBe(false)
    expect(canTransitionRollout('draft', 'approved')).toBe(false)
    expect(canTransitionRollout('validated', 'approved')).toBe(false)
    expect(canTransitionRollout('pending_approval', 'scheduled')).toBe(false)
    expect(canTransitionRollout('targets_resolved', 'scheduled')).toBe(false)
    expect(canTransitionRollout('draft', 'running_canary')).toBe(false)
  })

  it('a running rollout cannot go back to draft (the payload is immutable once started)', () => {
    for (const s of ['running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold'] as RolloutState[]) {
      expect(canTransitionRollout(s, 'draft')).toBe(false)
    }
  })

  it('every non-terminal state can be cancelled', () => {
    for (const s of Object.keys(ROLLOUT_TRANSITIONS) as RolloutState[]) {
      if (!isTerminalRollout(s)) expect(canTransitionRollout(s, 'cancelled'), s).toBe(true)
    }
  })

  it('pauses return only to running states', () => {
    expect(ROLLOUT_TRANSITIONS.paused).toEqual(expect.arrayContaining(['running_canary', 'running_batches', 'verifying', 'cancelled']))
    expect(canTransitionRollout('paused_by_threshold', 'completed')).toBe(false)
    expect(canTransitionRollout('paused', 'approved')).toBe(false)
  })

  it('every target state of the table is itself a state', () => {
    const states = new Set(Object.keys(ROLLOUT_TRANSITIONS))
    for (const tos of Object.values(ROLLOUT_TRANSITIONS)) for (const t of tos) expect(states.has(t)).toBe(true)
  })
})

describe('job transition table', () => {
  it('terminal states have no way out', () => {
    for (const s of JOB_TERMINAL) {
      expect(isTerminalJob(s)).toBe(true)
      expect(JOB_TRANSITIONS[s]).toEqual([])
    }
    expect(Object.keys(JOB_TRANSITIONS)).toHaveLength(18)
  })

  it('unknown is never re-queued or re-offered directly: only reconciling or a manual resolution leaves it', () => {
    expect(JOB_TRANSITIONS.unknown.sort()).toEqual(['reconciling', 'resolved_manually'])
  })

  it('only reconciliation (not_applied) puts a job back in the queue after it was offered', () => {
    const toQueued = (Object.keys(JOB_TRANSITIONS) as JobState[]).filter((s) => JOB_TRANSITIONS[s].includes('queued'))
    expect(toQueued).toEqual(['reconciling'])
  })

  it('a lost lease leads to unknown from every leased state', () => {
    for (const s of ['offered', 'acked', 'running'] as JobState[]) expect(canTransitionJob(s, 'unknown')).toBe(true)
  })

  it('verification outcomes come only from verifying', () => {
    for (const s of Object.keys(JOB_TRANSITIONS) as JobState[]) {
      if (s === 'verifying') continue
      expect(canTransitionJob(s, 'verified'), s).toBe(false)
      expect(canTransitionJob(s, 'verification_failed'), s).toBe(false)
      expect(canTransitionJob(s, 'accepted_but_not_verified'), s).toBe(false)
    }
  })

  it('an in-flight job cannot be expired or superseded', () => {
    for (const s of ACTIVE_JOB_STATES) {
      expect(canTransitionJob(s, 'expired'), s).toBe(s === 'reconciling')
      expect(canTransitionJob(s, 'superseded'), s).toBe(false)
    }
  })

  it('active states are the ones that hold the target', () => {
    expect([...ACTIVE_JOB_STATES].sort()).toEqual(['acked', 'offered', 'reconciling', 'running', 'unknown', 'verifying'])
  })
})
