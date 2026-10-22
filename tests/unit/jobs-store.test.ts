import { describe, expect, it } from 'vitest'
import { InMemoryJobStore } from '@/lib/jobs/store'
import type { Job, NewJobEvent, Rollout } from '@/lib/jobs/types'
import { makePlan } from '@/lib/jobs/testing'

function rollout(id: string): Rollout {
  return {
    id, version: 0, seq: 1, title: 't', state: 'draft', plan: makePlan(), payload_hash: 'h', approvals: [], targets: [], excluded: [],
    impact: null, impact_requires_acknowledgement: false, conflicts: [], current_batch: -1, phase_finished_at: null, paused_from: null,
    pause_reason: null, failures_acknowledged: 0, consecutive_failures: 0, counted_jobs: [], canary_override: false, created_by: 'u', created_at: 0, updated_at: 0, started_at: null, finished_at: null,
  }
}

function job(id: string, target: string, state: Job['state'] = 'queued'): Job {
  return {
    id, version: 0, rollout_id: 'r1', rollout_seq: 1, adapter: 'fake', target_id: target, location_id: 'L', payload_hash: 'h', idempotency_key: `${id}:h`,
    supersedes_key: null, setting_paths: ['a'], phase: 0, order: 0, state, attempt: 0, max_attempts: 1, lease: null, reconcile_lease: null,
    reconcile_attempts: 0, last_reconcile: null, verify_attempts: 0, applied: false, partial: false, last_result: null, verification: null, snapshot: null, rollback: null,
    stop: null, blocked_reason: null, terminal_reason: null, superseded_by: null, recovery_actions: [], created_at: 0, updated_at: 0, finished_at: null,
  }
}

const ev = (at: number, reason = 'x'): NewJobEvent => ({
  at, actor: 'u', entity: 'rollout', rollout_id: 'r1', job_id: null, target_id: null, type: 'transition', from: null, to: 'draft', reason, payload_hash: 'h', details: {},
})

describe('InMemoryJobStore', () => {
  it('creates records at version 1 and returns copies', async () => {
    const s = new InMemoryJobStore()
    const r = await s.commit({ rollouts: [{ record: rollout('r1'), expected_version: null }] })
    expect(r.ok && r.value.rollouts[0].version).toBe(1)
    const a = await s.getRollout('r1')
    a!.title = 'changed'
    expect((await s.getRollout('r1'))!.title).toBe('t')
  })

  it('compare-and-set: a write with a stale version is refused and nothing in the changeset is written', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ rollouts: [{ record: rollout('r1'), expected_version: null }], jobs: [{ record: job('j1', 't1'), expected_version: null }] })
    const j = (await s.getJob('j1'))!
    const first = await s.commit({ jobs: [{ record: { ...j, state: 'offered' }, expected_version: j.version }] })
    expect(first.ok).toBe(true)
    const r = (await s.getRollout('r1'))!
    const stale = await s.commit({
      rollouts: [{ record: { ...r, title: 'new' }, expected_version: r.version }],
      jobs: [{ record: { ...j, state: 'cancelled' }, expected_version: j.version }],
      events: [ev(1)],
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('version_conflict')
    expect((await s.getJob('j1'))!.state).toBe('offered')
    expect((await s.getRollout('r1'))!.title).toBe('t')
    expect(await s.listEvents()).toHaveLength(0)
  })

  it('refuses to create a record that exists, and to update one that does not', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ jobs: [{ record: job('j1', 't1'), expected_version: null }] })
    expect((await s.commit({ jobs: [{ record: job('j1', 't1'), expected_version: null }] })).ok).toBe(false)
    expect((await s.commit({ jobs: [{ record: job('j2', 't1'), expected_version: 1 }] })).ok).toBe(false)
  })

  it('refuses the same record twice in one changeset', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ jobs: [{ record: job('j1', 't1'), expected_version: null }] })
    const r = await s.commit({ jobs: [{ record: job('j1', 't1'), expected_version: 1 }, { record: job('j1', 't1'), expected_version: 1 }] })
    expect(r.ok).toBe(false)
  })

  it('events get consecutive sequence numbers and cannot go back in time', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ events: [ev(5), ev(5)] })
    await s.commit({ events: [ev(7)] })
    expect((await s.listEvents()).map((e) => e.seq)).toEqual([1, 2, 3])
    const back = await s.commit({ events: [ev(6)] })
    expect(back.ok).toBe(false)
    expect(await s.listEvents()).toHaveLength(3)
  })

  it('lists jobs by rollout, by target and by state', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ jobs: [{ record: job('j1', 't1'), expected_version: null }, { record: job('j2', 't2', 'offered'), expected_version: null }, { record: { ...job('j3', 't1'), rollout_id: 'r2' }, expected_version: null }] })
    expect((await s.listJobsByRollout('r1')).map((j) => j.id)).toEqual(['j1', 'j2'])
    expect((await s.listJobsByTarget('t1')).map((j) => j.id)).toEqual(['j1', 'j3'])
    expect((await s.listJobsInStates(['offered'])).map((j) => j.id)).toEqual(['j2'])
  })

  it('filters events by rollout and job', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ events: [ev(1), { ...ev(2), rollout_id: 'r2' }, { ...ev(3), job_id: 'j1', entity: 'job' }] })
    expect(await s.listEvents({ rollout_id: 'r2' })).toHaveLength(1)
    expect(await s.listEvents({ job_id: 'j1' })).toHaveLength(1)
  })

  it('hands out increasing rollout sequence numbers', async () => {
    const s = new InMemoryJobStore()
    expect(await s.nextRolloutSeq()).toBe(1)
    expect(await s.nextRolloutSeq()).toBe(2)
  })

  it('events are frozen copies: changing a returned event changes nothing', async () => {
    const s = new InMemoryJobStore()
    await s.commit({ events: [ev(1, 'original')] })
    const [e] = await s.listEvents()
    try { (e as { reason: string }).reason = 'edited' } catch { /* frozen */ }
    expect((await s.listEvents())[0].reason).toBe('original')
  })
})
