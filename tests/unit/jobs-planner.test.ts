import { describe, expect, it } from 'vitest'
import { assignPhases, finalRolloutState, orderTargets, pathsOverlap, recoveryActionsFor, summarize, thresholdBreach } from '@/lib/jobs/planner'
import type { Job, JobState } from '@/lib/jobs/types'

const t = (target_id: string, location_id: string) => ({ target_id, location_id })

describe('orderTargets', () => {
  it('interleaves locations round-robin so early batches spread over locations', () => {
    const order = orderTargets([t('a2', 'L1'), t('b1', 'L2'), t('a1', 'L1'), t('a3', 'L1'), t('c1', 'L3')])
    expect(order.map((x) => x.target_id)).toEqual(['a1', 'b1', 'c1', 'a2', 'a3'])
  })

  it('is independent of input order', () => {
    const a = orderTargets([t('x', 'L2'), t('y', 'L1'), t('z', 'L1')])
    const b = orderTargets([t('z', 'L1'), t('x', 'L2'), t('y', 'L1')])
    expect(a).toEqual(b)
  })
})

describe('assignPhases', () => {
  const five = ['ap1', 'ap2', 'ap3', 'ap4', 'ap5'].map((id) => t(id, 'store-1'))

  it('first_n takes the first targets as canary and splits the rest into batches', () => {
    const r = assignPhases(five, { mode: 'first_n', count: 1, soak_ms: 0 }, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.map((x) => [x.target_id, x.phase])).toEqual([['ap1', 'canary'], ['ap2', 0], ['ap3', 0], ['ap4', 1], ['ap5', 1]])
    expect(r.value.map((x) => x.order)).toEqual([0, 1, 2, 3, 4])
  })

  it('per_location takes the first target of every location by default', () => {
    const r = assignPhases([t('a1', 'L1'), t('a2', 'L1'), t('b1', 'L2'), t('b2', 'L2')], { mode: 'per_location', per_location: 1, soak_ms: 0 }, 5)
    expect(r.ok && r.value.filter((x) => x.phase === 'canary').map((x) => x.target_id)).toEqual(['a1', 'b1'])
  })

  it('explicit canaries must be among the included targets', () => {
    const r = assignPhases(five, { mode: 'explicit', target_ids: ['ap3'], soak_ms: 0 }, 10)
    expect(r.ok && r.value.find((x) => x.target_id === 'ap3')!.phase).toBe('canary')
    const bad = assignPhases(five, { mode: 'explicit', target_ids: ['ap9'], soak_ms: 0 }, 10)
    expect(bad.ok).toBe(false)
  })

  it('no canary: everything is in batches', () => {
    const r = assignPhases(five, { mode: 'none' }, 3)
    expect(r.ok && r.value.map((x) => x.phase)).toEqual([0, 0, 0, 1, 1])
  })

  it('a canary count larger than the targets makes everything canary', () => {
    const r = assignPhases(five.slice(0, 2), { mode: 'first_n', count: 5, soak_ms: 0 }, 3)
    expect(r.ok && r.value.every((x) => x.phase === 'canary')).toBe(true)
  })
})

describe('pathsOverlap', () => {
  it('overlaps on equal paths and on parent/child, not on name prefixes', () => {
    expect(pathsOverlap('ssid.staff', 'ssid.staff')).toBe(true)
    expect(pathsOverlap('ssid', 'ssid.staff.passphrase')).toBe(true)
    expect(pathsOverlap('ssid.staff.passphrase', 'ssid')).toBe(true)
    expect(pathsOverlap('ssid.staff', 'ssid.staffroom')).toBe(false)
    expect(pathsOverlap('ssid.guest', 'ssid.staff')).toBe(false)
  })
})

describe('thresholdBreach', () => {
  const th = { stop_after_failures: 2, stop_after_failure_pct: 50, pct_min_finished: 4, stop_after_consecutive_failures: 3 }

  it('trips on the absolute count of failures since the last human decision', () => {
    expect(thresholdBreach(th, { failures: 1, acknowledged: 0, consecutive: 1, finished: 10 })).toBeNull()
    expect(thresholdBreach(th, { failures: 2, acknowledged: 0, consecutive: 1, finished: 10 })).toMatch(/failures/)
    expect(thresholdBreach(th, { failures: 3, acknowledged: 2, consecutive: 0, finished: 10 })).toBeNull()
  })

  it('trips on consecutive failures', () => {
    const loose = { ...th, stop_after_failures: 99 }
    expect(thresholdBreach(loose, { failures: 3, acknowledged: 0, consecutive: 3, finished: 20 })).toMatch(/in a row/)
  })

  it('trips on the percentage only once enough targets finished, and only with a new failure', () => {
    const loose = { ...th, stop_after_failures: 99, stop_after_consecutive_failures: 99 }
    expect(thresholdBreach(loose, { failures: 2, acknowledged: 0, consecutive: 1, finished: 3 })).toBeNull()
    expect(thresholdBreach(loose, { failures: 2, acknowledged: 0, consecutive: 1, finished: 4 })).toMatch(/%/)
    expect(thresholdBreach(loose, { failures: 2, acknowledged: 2, consecutive: 0, finished: 4 })).toBeNull()
  })
})

function job(state: JobState, extra: Partial<Job> = {}): Job {
  return {
    id: `j-${Math.random()}`, version: 1, rollout_id: 'r', rollout_seq: 1, adapter: 'fake', target_id: 't', location_id: 'L', payload_hash: 'h', idempotency_key: 'k',
    supersedes_key: null, setting_paths: ['a'], phase: 0, order: 0, state, attempt: 1, max_attempts: 1, lease: null, reconcile_lease: null,
    reconcile_attempts: 0, next_reconcile_at: null, needs_manual: false, last_reconcile: null, verify_deadline: null, verify_lease: null, verify_attempts: 0,
    effective_hash: 'e', waiting_reason: null, superseded_by_job: null, applied: false, partial: false, last_result: null, verification: null, snapshot: null, rollback: null,
    stop: null, blocked_reason: null, terminal_reason: null, superseded_by: null, recovery_actions: [], created_at: 0, updated_at: 0, finished_at: null, ...extra,
  }
}

const snap = (ref: string) => ({ status: 'taken' as const, ref, key_ref: 'kms:k', content_sha256: 'c'.repeat(64), retain_until: 1 })

describe('summarize', () => {
  it('keeps requested, applied, verified, failed and unknown apart', () => {
    const jobs = [
      job('verified', { applied: true }),
      job('accepted_but_not_verified', { applied: true }),
      job('verification_failed', { applied: true }),
      job('failed'),
      job('partially_applied', { partial: true }),
      job('unknown'),
      job('reconciling'),
      job('queued'),
      job('already_satisfied'),
    ]
    const s = summarize({ targets: jobs.map(() => null), excluded: [1, 2] }, jobs)
    expect(s).toMatchObject({
      targets: 9, excluded: 2, requested: 9, applied: 3, verified: 1, already_satisfied: 1, accepted_but_not_verified: 1,
      failed: 3, apply_failed: 1, verification_failed: 1, partial: 1, unknown: 2, waiting: 1, in_progress: 0, finished: 6, is_partial: true,
    })
    const total = Object.values(s.by_state).reduce((a, b) => a + b, 0)
    expect(total).toBe(jobs.length)
  })

  it('is not partial when everything succeeded', () => {
    const s = summarize({ targets: [null, null], excluded: [] }, [job('verified', { applied: true }), job('already_satisfied')])
    expect(s.is_partial).toBe(false)
  })
})

describe('finalRolloutState', () => {
  it('completed, partially_failed, failed or superseded from the job outcomes', () => {
    expect(finalRolloutState([job('verified'), job('already_satisfied')])).toBe('completed')
    expect(finalRolloutState([job('verified'), job('failed')])).toBe('partially_failed')
    expect(finalRolloutState([job('verification_failed'), job('failed')])).toBe('failed')
    expect(finalRolloutState([job('superseded'), job('superseded')])).toBe('superseded')
    expect(finalRolloutState([job('superseded'), job('verified')])).toBe('completed')
    expect(finalRolloutState([job('resolved_manually')])).toBe('completed_manually')
    expect(finalRolloutState([job('resolved_manually'), job('verified')])).toBe('completed')
  })

  it('is null while any job is still open', () => {
    expect(finalRolloutState([job('verified'), job('unknown')])).toBeNull()
  })
})

describe('recoveryActionsFor', () => {
  it('offers snapshot restore only when a snapshot exists and the adapter can roll back', () => {
    const withSnap = job('verification_failed', { snapshot: snap('snap-1') })
    expect(recoveryActionsFor(withSnap, { rollback: true })).toEqual(['restore_snapshot', 'manual'])
    expect(recoveryActionsFor(withSnap, { rollback: false })).toEqual(['manual'])
    expect(recoveryActionsFor(job('verification_failed'), { rollback: true })).toEqual(['manual'])
  })

  it('unknown needs reconciliation before any retry', () => {
    expect(recoveryActionsFor(job('unknown'), { rollback: true })).toEqual(['reconcile', 'retry_after_reconcile', 'manual'])
  })

  it('a partial application offers restore and manual repair', () => {
    expect(recoveryActionsFor(job('partially_applied', { snapshot: snap('s') }), { rollback: true })).toEqual(['restore_snapshot', 'manual'])
  })

  it('an unknown job that needs a human offers only manual resolution', () => {
    expect(recoveryActionsFor(job('unknown', { needs_manual: true }), { rollback: true })).toEqual(['manual'])
  })

  it('successful jobs need nothing', () => {
    expect(recoveryActionsFor(job('verified'), { rollback: true })).toEqual([])
  })
})
