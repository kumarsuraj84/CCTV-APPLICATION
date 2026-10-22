// Review round 1 of P7-0: every probe of the independent review (P1-P9) and the minor findings, written as
// failing tests first. Fakes only.
import { describe, expect, it } from 'vitest'
import {
  FAKE_CAPABILITIES, analyseEvents, approvedRollout, createWorld, makeCandidate, makePlan, must, secretRef, setupEngine, type World,
} from '@/lib/jobs/testing'
import { payloadHash, validatePlan } from '@/lib/jobs/plan'
import { canTransitionRollout } from '@/lib/jobs/machines'
import { redactDetails, REDACTED } from '@/lib/jobs/redact'
import { thresholdBreach } from '@/lib/jobs/planner'
import { InMemoryJobStore } from '@/lib/jobs/store'
import { JobEngine } from '@/lib/jobs/engine'
import { FakeAdapter } from '@/lib/jobs/fake-adapter'
import { buildRestorePlan } from '@/lib/jobs/recovery'
import type { NewJobEvent, Plan } from '@/lib/jobs/types'

const NOW = Date.parse('2026-11-02T04:30:00Z')
const stores = (n: number, loc = 'store-1') => Array.from({ length: n }, (_, i) => makeCandidate(`ap${i + 1}`, loc))
const aps = (n: number, location = 'store-1', prefix = 'ap') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, location }))

async function resolvedRollout(s: ReturnType<typeof setupEngine>, plan: Plan, cands = stores(2), actor = plan.requested_by) {
  const r = must(await s.engine.createRollout({ title: 't', plan, actor }))
  must(await s.engine.validate(r.id, actor))
  return must(await s.engine.resolveTargets(r.id, cands, actor))
}

describe('I1: four-eyes rule covers every author of the current version', () => {
  it('createRollout refuses when the actor is not the requester named in the plan', async () => {
    const s = setupEngine()
    const r = await s.engine.createRollout({ title: 't', plan: makePlan({ requested_by: 'alice' }), actor: 'mallory' })
    expect(!r.ok && r.error.code).toBe('not_allowed')
  })

  it('probe P1: A creates, B amends, A approves → refused (A is still an author)', async () => {
    const s = setupEngine()
    const plan = makePlan({ requested_by: 'alice' })
    const r = must(await s.engine.createRollout({ title: 't', plan, actor: 'alice' }))
    const amended = must(await s.engine.amendPlan(r.id, { ...plan, params: { ...(plan.params as object), note: 'b' } }, 'bob'))
    expect(amended.plan.requested_by).toBe('bob')
    expect(amended.authors.sort()).toEqual(['alice', 'bob'])
    must(await s.engine.validate(r.id, 'bob'))
    must(await s.engine.resolveTargets(r.id, stores(1), 'bob'))
    const p = must(await s.engine.submit(r.id, 'bob'))
    for (const who of ['alice', 'bob']) {
      const a = await s.engine.approve(r.id, { approver: who, subject: p.approval_subject!, acknowledged_impact: true })
      expect(!a.ok && a.error.code, who).toBe('approver_is_author')
    }
    expect(must(await s.engine.approve(r.id, { approver: 'carol', subject: p.approval_subject!, acknowledged_impact: true })).state).toBe('approved')
  })

  it('the submitter and the person who resolved the targets are authors too', async () => {
    const s = setupEngine()
    const plan = makePlan({ requested_by: 'alice' })
    const r = must(await s.engine.createRollout({ title: 't', plan, actor: 'alice' }))
    must(await s.engine.validate(r.id, 'alice'))
    must(await s.engine.resolveTargets(r.id, stores(1), 'rita'))
    const p = must(await s.engine.submit(r.id, 'sam'))
    expect(p.authors.sort()).toEqual(['alice', 'rita', 'sam'])
    for (const who of ['rita', 'sam']) {
      const a = await s.engine.approve(r.id, { approver: who, subject: p.approval_subject!, acknowledged_impact: true })
      expect(!a.ok && a.error.code, who).toBe('approver_is_author')
    }
  })
})

describe('I2: approvals cover the whole approval subject of the current revision', () => {
  it('the subject changes with every amend and every target resolution', async () => {
    const s = setupEngine()
    const r1 = await resolvedRollout(s, makePlan())
    expect(r1.approval_subject).toMatch(/^[0-9a-f]{64}$/)
    const a = must(await s.engine.amendPlan(r1.id, makePlan({ params: { x: 1 } }), 'user-requester'))
    const back = must(await s.engine.amendPlan(r1.id, makePlan(), 'user-requester'))
    expect(back.revision).toBeGreaterThan(a.revision)
    must(await s.engine.validate(r1.id, 'user-requester'))
    const r2 = must(await s.engine.resolveTargets(r1.id, stores(2), 'user-requester'))
    expect(r2.payload_hash).toBe(r1.payload_hash)
    expect(r2.approval_subject).not.toBe(r1.approval_subject)
  })

  it('probe P2: approve with 1 target, amend away and back, resolve 50 targets → fresh approvals needed', async () => {
    const s = setupEngine()
    const plan = makePlan({ target_selector: { organisation_wide: true } })
    const r = await resolvedRollout(s, plan, stores(1))
    const p = must(await s.engine.submit(r.id, 'user-requester'))
    expect(must(await s.engine.approve(r.id, { approver: 'boss', subject: p.approval_subject!, acknowledged_impact: true })).state).toBe('approved')
    must(await s.engine.amendPlan(r.id, { ...plan, params: { evil: true } }, 'user-requester'))
    must(await s.engine.amendPlan(r.id, plan, 'user-requester'))
    must(await s.engine.validate(r.id, 'user-requester'))
    must(await s.engine.resolveTargets(r.id, stores(50), 'user-requester'))
    const again = must(await s.engine.submit(r.id, 'user-requester'))
    expect(again.state).toBe('pending_approval')
    expect(s.engine.approvalStatus(again).counted).toHaveLength(0)
    expect(s.engine.approvalStatus(again).ignored[0].reason).toBe('subject_changed')
    const sch = await s.engine.schedule(r.id, 'user-requester')
    expect(sch.ok).toBe(false)
  })

  it('an approval naming another subject is refused', async () => {
    const s = setupEngine()
    const r = await resolvedRollout(s, makePlan())
    must(await s.engine.submit(r.id, 'user-requester'))
    const res = await s.engine.approve(r.id, { approver: 'boss', subject: r.payload_hash, acknowledged_impact: true })
    expect(!res.ok && res.error.code).toBe('subject_mismatch')
  })
})

describe('I3: the requester cannot lower the risk', () => {
  it('probe P9: risk "low" on a kind whose adapter declares "high" needs two approvers', async () => {
    const caps = { ...FAKE_CAPABILITIES, kinds: { ...FAKE_CAPABILITIES.kinds, 'wifi.profile.apply': { ...FAKE_CAPABILITIES.kinds['wifi.profile.apply'], min_risk: 'high' as const } } }
    const s = setupEngine({ adapters: { fake: caps } })
    const r = await resolvedRollout(s, makePlan({ risk: 'low' }))
    expect(r.effective_risk).toBe('high')
    const p = must(await s.engine.submit(r.id, 'user-requester'))
    expect(p.state).toBe('pending_approval')
    expect(must(await s.engine.approve(r.id, { approver: 'a1', subject: p.approval_subject!, acknowledged_impact: true })).state).toBe('pending_approval')
    expect(must(await s.engine.approve(r.id, { approver: 'a2', subject: p.approval_subject!, acknowledged_impact: true })).state).toBe('approved')
  })

  it('an impact with reconnection makes it at least medium', async () => {
    const s = setupEngine()
    const r = await resolvedRollout(s, makePlan({ risk: 'low' }))
    expect(r.effective_risk).toBe('medium')
    expect(must(await s.engine.submit(r.id, 'user-requester')).state).toBe('pending_approval')
  })

  it('a policy minimum per kind applies too', async () => {
    const s = setupEngine({ kind_min_risk: { 'wifi.profile.apply': 'high' } })
    const none = { disruption: 'none' as const, reboot_required: false, reconnect_required: false, estimated_downtime_s: 0, notes: [] }
    const r = await resolvedRollout(s, makePlan({ risk: 'low' }), [makeCandidate('ap1', 'store-1', { impact: none })])
    expect(r.effective_risk).toBe('high')
  })
})

describe('I4: offering is safe by construction', () => {
  it('tick needs the offering lease; a holder that lost it cannot offer (stale fence)', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const old = must(await s.engine.acquireOfferingLease('worker-a', 10_000))
    s.clock.advance(20_000)
    must(await s.engine.acquireOfferingLease('worker-b', 10_000))
    const rep = await s.engine.tick(old)
    expect(rep.offered).toEqual([])
    expect(rep.conflicts).toBeGreaterThan(0)
  })

  it('probe P3: many concurrent targetReturned and tick calls never exceed the caps', async () => {
    const s = setupEngine()
    const cands = [...stores(6, 'store-1'), ...stores(6, 'store-2').map((c) => ({ ...c, target_id: `b${c.target_id}` }))]
    for (const c of cands) s.env.online.add(c.target_id)
    const plan = makePlan({ canary: { mode: 'none' }, target_selector: { organisation_wide: true }, batch: { batch_size: 12, global_concurrency: 2, per_location_concurrency: 1, block_location_on_unknown: false, batch_soak_ms: 0 } })
    await approvedRollout(s.engine, plan, cands)
    const fence = must(await s.engine.acquireOfferingLease('w', 60_000))
    await s.engine.tick(fence) // start
    await Promise.all([...cands.map((c) => s.engine.targetReturned(c.target_id, fence)), s.engine.tick(fence), s.engine.tick(fence)])
    const a = analyseEvents(await s.store.listEvents(), new Map(cands.map((c) => [c.target_id, c.location_id])))
    expect(Math.max(...a.maxActivePerLocation.values())).toBe(1)
    expect(Math.max(...a.maxActivePerRollout.values())).toBe(2)
  })

  it('two engines writing at once with the same fence still cannot break the caps (commit guards)', async () => {
    const store = new InMemoryJobStore()
    const s = setupEngine({ store })
    const cands = stores(6)
    await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' }, batch: { batch_size: 6, global_concurrency: 3, per_location_concurrency: 1, block_location_on_unknown: false, batch_soak_ms: 0 } }), cands)
    let n = 0
    const twin = new JobEngine({ store, clock: s.clock, ids: { next: (p) => `twin-${p}-${++n}` }, env: s.env, adapters: { fake: FAKE_CAPABILITIES } })
    const fence = must(await s.engine.acquireOfferingLease('w', 60_000))
    await s.engine.tick(fence) // starts; every target is offline, nothing is offered
    for (const c of cands) s.env.online.add(c.target_id)
    // Two writers that each think they own offering race for the single free slot at store-1.
    const reps = await Promise.all([s.engine.tick(fence), twin.tick(fence), s.engine.targetReturned('ap2', fence), twin.targetReturned('ap3', fence)])
    const a = analyseEvents(await store.listEvents(), new Map(cands.map((c) => [c.target_id, c.location_id])))
    expect(a.maxActivePerLocation.get('store-1')).toBe(1)
    expect(reps.reduce((k, r) => k + r.offered.length, 0)).toBe(1)
    expect((reps[0] as { conflicts: number }).conflicts + (reps[1] as { conflicts: number }).conflicts).toBeGreaterThan(0)
  })

  it('no offer lands after a pause has committed (rollout-row guard)', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const fence = must(await s.engine.acquireOfferingLease('w', 60_000))
    const real = s.store.commit.bind(s.store)
    let paused = false
    s.store.commit = async (cs) => {
      if (!paused && cs.jobs?.some((w) => w.record.state === 'offered')) { paused = true; must(await s.engine.pause(r.id, 'ops', 'stop now')) }
      return real(cs)
    }
    const rep = await s.engine.tick(fence)
    expect(rep.offered).toEqual([])
    expect((await s.engine.listJobs(r.id))[0].state).toBe('queued')
  })

  it('targetReturned offers only for that target, not a full tick', async () => {
    const s = setupEngine()
    for (const id of ['ap1', 'ap2']) s.env.online.add(id)
    const plan = makePlan({ canary: { mode: 'none' }, target_selector: { location_ids: ['store-1', 'store-2'] } })
    const r = await approvedRollout(s.engine, plan, [makeCandidate('ap1', 'store-1'), makeCandidate('ap2', 'store-2')])
    const fence = must(await s.engine.acquireOfferingLease('w', 60_000))
    s.env.online.delete('ap1')
    s.env.online.delete('ap2')
    await s.engine.tick(fence) // starts, nothing online
    s.env.online.add('ap1')
    s.env.online.add('ap2')
    const back = await s.engine.targetReturned('ap1', fence)
    expect(back.offered.map((j) => j.target_id)).toEqual(['ap1'])
    expect((await s.engine.listJobs(r.id)).find((j) => j.target_id === 'ap2')!.state).toBe('queued')
  })
})

describe('I5: verification has a deadline and a token', () => {
  async function verifying(opts: Parameters<typeof setupEngine>[0] = {}) {
    const s = setupEngine({ verify_deadline_ms: 120_000, ...opts })
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const [job] = (await s.tick()).offered
    must(await s.engine.reportResult(job.id, job.token, { outcome: 'applied', message: '' }))
    return { s, r, job }
  }

  it('recordVerification needs the token of beginVerification', async () => {
    const { s, job } = await verifying()
    const bad = await s.engine.recordVerification(job.id, 'forged', { outcome: 'match', expected: {}, observed: {} })
    expect(!bad.ok && bad.error.code).toBe('stale_lease')
    const v = must(await s.engine.beginVerification(job.id))
    expect(must(await s.engine.recordVerification(job.id, v.token, { outcome: 'match', expected: {}, observed: {} })).state).toBe('verified')
  })

  it('probe P4: a job stuck in verifying is released at its deadline (accepted but not verified, overdue)', async () => {
    const { s, job } = await verifying()
    s.clock.advance(120_001)
    await s.tick()
    const j = (await s.engine.getJob(job.id))!
    expect(j.state).toBe('accepted_but_not_verified')
    expect(j.terminal_reason).toBe('verification_overdue')
  })

  it('the overdue outcome can be "unknown" by policy', async () => {
    const { s, job } = await verifying({ verification_overdue: 'unknown' })
    s.clock.advance(120_001)
    await s.tick()
    expect((await s.engine.getJob(job.id))!.state).toBe('unknown')
  })

  it('verifying and reconciling jobs can be resolved by hand', async () => {
    const { s, job } = await verifying()
    expect(must(await s.engine.resolveManually(job.id, 'ops', 'checked on site')).state).toBe('resolved_manually')
  })

  it('an expired rollout can still be cancelled (idempotent) and its held targets released', async () => {
    const s = setupEngine({ offer_lease_ms: 60_000 })
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' }, expires_at: '2026-11-02T06:00:00Z' }), stores(1))
    await s.tick()
    s.clock.advance(61_000)
    await s.tick() // unknown
    s.clock.set('2026-11-02T06:00:00Z')
    await s.tick()
    expect((await s.engine.getRollout(r.id))!.state).toBe('expired')
    expect(must(await s.engine.cancel(r.id, 'ops', 'tidy up')).state).toBe('expired')
    const rel = must(await s.engine.releaseHeld(r.id, 'ops', 'AP checked by hand; old change not present.'))
    expect(rel.released).toBe(1)
    expect((await s.engine.listJobs(r.id))[0].state).toBe('resolved_manually')
  })
})

describe('I6: unknown jobs escalate instead of looping', () => {
  it('probe P5: an unreachable device gives a bounded number of events over 100 steps and ends needing a human', async () => {
    const w = createWorld(aps(1), { offer_lease_ms: 60_000, reconcile_lease_ms: 60_000, max_reconcile_attempts: 4, reconcile_backoff_ms: 60_000 })
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response', times: 1 })
    w.fake.inject({ target_id: 'ap1', step: 'reconcile', mode: 'fail' })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    for (let i = 0; i < 100; i++) { await w.runner.step(); w.clock.advance(60_000) }
    const j = (await w.engine.listJobs(r.id))[0]
    expect(j.state).toBe('unknown')
    expect(j.needs_manual).toBe(true)
    expect(j.reconcile_attempts).toBe(4)
    expect(j.recovery_actions).toEqual(['manual'])
    const ev = await w.store.listEvents({ job_id: j.id })
    expect(ev.length).toBeLessThanOrEqual(20)
    expect(ev.some((e) => e.reason === 'needs_manual_resolution')).toBe(true)
    expect(must(await w.engine.summary(r.id)).needs_manual).toBe(1)
  })

  it('backoff grows between reconcile attempts', async () => {
    const w = createWorld(aps(1), { offer_lease_ms: 60_000, reconcile_lease_ms: 60_000, max_reconcile_attempts: 6, reconcile_backoff_ms: 60_000 })
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response', times: 1 })
    w.fake.inject({ target_id: 'ap1', step: 'reconcile', mode: 'unknown' })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    for (let i = 0; i < 60; i++) { await w.runner.step(); w.clock.advance(30_000) }
    const begins = (await w.store.listEvents({ job_id: (await w.engine.listJobs(r.id))[0].id })).filter((e) => e.reason === 'reconcile_requested').map((e) => e.at)
    const gaps = begins.slice(1).map((t, i) => t - begins[i])
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1])
    expect(gaps.at(-1)!).toBeGreaterThan(gaps[0])
  })

  it('a device that cannot answer reconcile requests ("unsupported") needs a human at once', async () => {
    const w = createWorld(aps(1), { offer_lease_ms: 60_000 })
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response', times: 1 })
    w.fake.inject({ target_id: 'ap1', step: 'reconcile', mode: 'unsupported' })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    for (let i = 0; i < 5; i++) { await w.runner.step(); w.clock.advance(61_000) }
    const j = (await w.engine.listJobs(r.id))[0]
    expect(j).toMatchObject({ state: 'unknown', needs_manual: true, reconcile_attempts: 1 })
  })

  it('the runner respects operations.reconcile = false and operations.verify = false', async () => {
    // Two locations: ap1's unknown job holds store-1 (as it should), ap2 in store-2 proceeds.
    const w = createWorld([{ id: 'ap1', location: 'store-1' }, { id: 'ap2', location: 'store-2' }], { offer_lease_ms: 60_000, fakeCapabilities: { operations: { snapshot: false, rollback: false, stop: false, verify: false, reconcile: false } } })
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response', times: 1 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' }, target_selector: { location_ids: ['store-1', 'store-2'] } }), w.candidates())
    for (let i = 0; i < 10; i++) { await w.runner.step(); w.clock.advance(61_000) }
    expect(w.fake.calls.reconcile).toBe(0)
    expect(w.fake.calls.verify).toBe(0)
    const jobs = await w.engine.listJobs(r.id)
    expect(jobs.find((j) => j.target_id === 'ap1')).toMatchObject({ state: 'unknown', needs_manual: true })
    expect(jobs.find((j) => j.target_id === 'ap2')!.state).toBe('accepted_but_not_verified')
  })
})

describe('I7: the hash covers exactly the bytes that execute', () => {
  it('probe P6: NFD and NFC SSIDs hash the same, so the NFD plan is refused before it can be approved', async () => {
    const nfd = makePlan({ params: { ssid: 'Café' } })
    const nfc = makePlan({ params: { ssid: 'Café' } })
    expect(payloadHash(nfd)).toBe(payloadHash(nfc))
    const s = setupEngine()
    const r = await s.engine.createRollout({ title: 't', plan: nfd, actor: nfd.requested_by })
    expect(!r.ok && r.error.code).toBe('invalid_plan')
    expect(validatePlan(nfd, { now: NOW, adapters: { fake: FAKE_CAPABILITIES } }).map((i) => i.field)).toContain('params')
    expect(validatePlan(nfc, { now: NOW, adapters: { fake: FAKE_CAPABILITIES } })).toEqual([])
  })
})

describe('I8: execution inputs are inside the hash', () => {
  const opts = { now: NOW, adapters: { fake: FAKE_CAPABILITIES } }
  it('secret references must be immutable versioned references', () => {
    expect(validatePlan(makePlan({ params: { passphrase_ref: 'vault:wifi/staff' } }), opts).map((i) => i.field)).toContain('params')
    expect(validatePlan(makePlan({ params: { note: 'vault:wifi/staff' } }), opts).map((i) => i.field)).toContain('params')
    expect(validatePlan(makePlan({ params: { passphrase: { ref: 'vault:x', version: 2 } } }), opts).map((i) => i.field)).toContain('params')
    expect(validatePlan(makePlan({ params: { passphrase_ref: secretRef('vault:wifi/staff', 7) } }), opts)).toEqual([])
  })

  it('the adapter version is part of the plan and must match the registered adapter', () => {
    expect(validatePlan(makePlan({ adapter_version: '0.0.0' }), opts).map((i) => i.field)).toContain('adapter_version')
    expect(payloadHash(makePlan({ adapter_version: '9' }))).not.toBe(payloadHash(makePlan()))
  })

  it('probe P8: each job carries a per-target effective hash that is part of the approval subject', async () => {
    const s = setupEngine()
    const r1 = await resolvedRollout(s, makePlan(), [makeCandidate('ap1', 'store-1', { effective_inputs: { vlan: 20 } }), makeCandidate('ap2', 'store-1', { effective_inputs: { vlan: 30 } })])
    const [t1, t2] = r1.targets
    expect(t1.effective_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(t1.effective_hash).not.toBe(t2.effective_hash)
    const r2 = await resolvedRollout(s, makePlan(), [makeCandidate('ap1', 'store-1', { effective_inputs: { vlan: 21 } }), makeCandidate('ap2', 'store-1', { effective_inputs: { vlan: 30 } })])
    expect(r2.targets[0].effective_hash).not.toBe(t1.effective_hash)
  })

  it('the adapter receives the hashes and refuses a plan that does not match them', async () => {
    const fake = new FakeAdapter()
    fake.addDevice('ap1', 'store-1')
    const plan = makePlan()
    const T = { target_id: 'ap1', location_id: 'store-1' }
    expect(await fake.apply(T, plan, 'k', { payload_hash: 'f'.repeat(64), effective_hash: 'e'.repeat(64) })).toMatchObject({ delivered: true, outcome: 'failed' })
    expect(await fake.apply(T, plan, 'k2', { payload_hash: payloadHash(plan), effective_hash: 'e'.repeat(64) })).toMatchObject({ delivered: true, outcome: 'applied' })
  })
})

describe('I9: supersession happens when the newer rollout starts and has a job for the target', () => {
  it('probe P7: approval alone supersedes nothing; if the newer job is cancelled the target is reported unchanged in both', async () => {
    const w = createWorld(aps(1))
    w.fake.setOnline('ap1', false)
    const a = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await w.runner.step()
    const b = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' }, params: { ssid: 'CK-Staff', security: 'wpa2-psk', passphrase_ref: secretRef('vault:wifi/staff', 8) }, schedule: { not_before: '2026-11-02T08:00:00Z', window: null } }), w.candidates())
    await w.runner.step()
    expect((await w.engine.listJobs(a.id))[0].state).toBe('queued')
    w.clock.set('2026-11-02T08:00:00Z')
    await w.runner.step()
    const old = (await w.engine.listJobs(a.id))[0]
    expect(old.state).toBe('superseded')
    expect(old.superseded_by).toBe(b.id)
    must(await w.engine.cancel(b.id, 'ops', 'not now'))
    expect(must(await w.engine.summary(a.id)).left_unchanged).toEqual(['ap1'])
    expect(must(await w.engine.summary(b.id)).left_unchanged).toEqual(['ap1'])
    expect(w.fake.executions('ap1')).toBe(0)
  })
})

describe('minor findings', () => {
  it('m1: user-supplied adapter and kind names never hit prototype properties', () => {
    const o = { now: NOW, adapters: { fake: FAKE_CAPABILITIES } }
    expect(validatePlan(makePlan({ adapter: '__proto__' }), o).map((i) => i.field)).toContain('adapter')
    expect(validatePlan(makePlan({ adapter: 'constructor' }), o).map((i) => i.field)).toContain('adapter')
    expect(validatePlan(makePlan({ kind: 'toString' }), o).map((i) => i.field)).toContain('kind')
  })

  it('m3: more secret shapes are redacted, also inside free text', () => {
    const out = redactDetails({ wpa_key: 'a', pre_shared_key: 'b', snmp_community: 'c', ssid_key: 'd', 'ssid.staff.key': 'e', message: 'login failed: password=hunter2 user=admin' })
    expect(out).toMatchObject({ wpa_key: REDACTED, pre_shared_key: REDACTED, snmp_community: REDACTED, ssid_key: REDACTED, 'ssid.staff.key': REDACTED })
    expect(String(out.message)).not.toContain('hunter2')
    expect(String(out.message)).toContain('user=admin')
  })

  it('m3: result messages are capped', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const [job] = (await s.tick()).offered
    must(await s.engine.reportResult(job.id, job.token, { outcome: 'failed', message: 'x'.repeat(5000) }))
    const ev = (await s.store.listEvents({ job_id: job.id })).at(-1)!
    expect(String(ev.details.message).length).toBeLessThanOrEqual(512)
  })

  it('m4: the store holds only token hashes; raw tokens are returned once to the caller', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const [job] = (await s.tick()).offered
    const stored = (await s.engine.getJob(job.id))!
    expect(JSON.stringify(stored)).not.toContain(job.token)
    expect(stored.lease!.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('m5: a heartbeat before the acknowledgement is refused and logged, the lease is not extended', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const [job] = (await s.tick()).offered
    const res = await s.engine.heartbeat(job.id, job.token)
    expect(!res.ok && res.error.code).toBe('not_allowed')
    expect((await s.engine.getJob(job.id))!.lease!.until).toBe(job.lease!.until)
    expect((await s.store.listEvents({ job_id: job.id })).at(-1)).toMatchObject({ type: 'rejected', reason: 'heartbeat_before_ack' })
  })

  it('m6: dead rollout transitions are gone', () => {
    expect(canTransitionRollout('verifying', 'running_batches')).toBe(false)
    expect(canTransitionRollout('running_canary', 'verifying')).toBe(false)
  })

  it('m7: a kind that requires a snapshot fails the job when no snapshot could be taken; the record has the encryption fields', async () => {
    const w = createWorld(aps(2), { fakeCapabilities: { kinds: { 'wifi.profile.apply': { required_target_capabilities: ['ssid.write'], require_snapshot: true } } } })
    w.fake.setUnsupported('ap2', ['snapshot'])
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await w.runner.runUntilSettled(w.clock, 10_000)
    const jobs = await w.engine.listJobs(r.id)
    const ap1 = jobs.find((j) => j.target_id === 'ap1')!
    expect(ap1.snapshot).toMatchObject({ status: 'taken', ref: expect.any(String), key_ref: expect.any(String), content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), retain_until: expect.any(Number) })
    expect(jobs.find((j) => j.target_id === 'ap2')).toMatchObject({ state: 'failed', terminal_reason: 'snapshot_required' })
    expect(w.fake.executions('ap2')).toBe(0)
  })

  it('m8: the runner re-checks the job right before apply (a stale lease is not applied)', async () => {
    const s = setupEngine({ offer_lease_ms: 1000 })
    s.env.online.add('ap1')
    await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    const [job] = (await s.tick()).offered
    expect((await s.engine.checkBeforeApply(job.id, job.token)).ok).toBe(true)
    s.clock.advance(1001)
    await s.tick()
    const res = await s.engine.checkBeforeApply(job.id, job.token)
    expect(!res.ok && res.error.code).toBe('stale_lease')
  })

  it('m9: an unknown base-version key fails the stale check', async () => {
    const s = setupEngine()
    s.env.base.clear()
    const r = must(await s.engine.createRollout({ title: 't', plan: makePlan(), actor: 'user-requester' }))
    const v = await s.engine.validate(r.id, 'user-requester')
    expect(!v.ok && v.error.code).toBe('stale_configuration_version')
  })

  it('m10: the adapter derives the setting paths; the declaration must be consistent with them', async () => {
    const o = { now: NOW, adapters: { fake: FAKE_CAPABILITIES } }
    expect(validatePlan(makePlan({ setting_paths: ['radio.5g'] }), o).map((i) => i.field)).toContain('setting_paths')
    const s = setupEngine()
    const r = await resolvedRollout(s, makePlan())
    expect(r.setting_paths_effective).toEqual(['ssid.staff.passphrase_ref', 'ssid.staff.security', 'ssid.staff.ssid'])
  })

  it('m11: a job held behind an earlier conflicting rollout shows why', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    const a = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' }, schedule: { not_before: '2026-11-02T09:00:00Z', window: null } }), stores(1))
    const b = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' }, supersedes_key: 'other', conflict_policy: 'wait', params: { security: 'wpa3-sae' } }), stores(1))
    await s.tick()
    const j = (await s.engine.listJobs(b.id))[0]
    expect(j.state).toBe('queued')
    expect(j.waiting_reason).toBe(`waiting_for_earlier_rollout:${a.id}`)
  })

  it('m11: a rollout cannot hold its targets in approval forever', async () => {
    const s = setupEngine({ max_pending_approval_ms: 3_600_000 })
    const r = await resolvedRollout(s, makePlan())
    must(await s.engine.submit(r.id, 'user-requester'))
    s.clock.advance(3_600_001)
    await s.tick()
    expect((await s.engine.getRollout(r.id))!.state).toBe('expired')
  })

  it('m12: the expiry cannot be beyond the horizon', () => {
    const o = { now: NOW, adapters: { fake: FAKE_CAPABILITIES }, max_horizon_ms: 30 * 86_400_000 }
    expect(validatePlan(makePlan({ expires_at: '2027-01-01T00:00:00Z' }), o).map((i) => i.field)).toContain('expires_at')
  })

  it('m13: cancel works in batches and can be repeated', async () => {
    const s = setupEngine({ cancel_batch_size: 50 })
    const cands = stores(130)
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' }, target_selector: { organisation_wide: true } }), cands)
    await s.tick()
    let commits = 0
    const real = s.store.commit.bind(s.store)
    s.store.commit = async (cs) => { commits++; return real(cs) }
    must(await s.engine.cancel(r.id, 'ops', 'stop'))
    expect(commits).toBeGreaterThanOrEqual(3)
    expect((await s.engine.listJobs(r.id)).every((j) => j.state === 'cancelled')).toBe(true)
    expect(must(await s.engine.cancel(r.id, 'ops', 'again')).state).toBe('cancelled')
  })

  it('m14: events are ordered by sequence, not wall time', async () => {
    const st = new InMemoryJobStore()
    const ev = (at: number): NewJobEvent => ({ at, actor: 'u', entity: 'rollout', rollout_id: 'r', job_id: null, target_id: null, type: 'recorded', from: null, to: 'draft', reason: 'x', payload_hash: 'h', details: {} })
    expect((await st.commit({ events: [ev(5)] })).ok).toBe(true)
    expect((await st.commit({ events: [ev(3)] })).ok).toBe(true)
    expect((await st.listEvents()).map((e) => [e.seq, e.at])).toEqual([[1, 5], [2, 3]])
  })

  it('m15: the percentage threshold counts only failures and finishes since the last resume', () => {
    const th = { stop_after_failures: 99, stop_after_failure_pct: 50, pct_min_finished: 2, stop_after_consecutive_failures: 99 }
    // 4 of 10 failed before resume (acknowledged); after resume 1 of 4 failed: 25% → no pause.
    expect(thresholdBreach(th, { failures: 5, acknowledged: 4, consecutive: 1, finished: 14, finished_acknowledged: 10 })).toBeNull()
    expect(thresholdBreach(th, { failures: 6, acknowledged: 4, consecutive: 1, finished: 14, finished_acknowledged: 10 })).toMatch(/%/)
  })

  it('m16: the "already satisfied" probe is cached for a short time', async () => {
    const s = setupEngine({ desired_state_cache_ms: 30_000 })
    let probes = 0
    s.env.desiredStateProbe = async () => { probes++; return 'not_satisfied' }
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' }, schedule: { not_before: '2026-11-02T04:30:00Z', window: { kind: 'absolute', start: '2026-11-02T05:00:00Z', end: '2026-11-02T06:00:00Z' } } }), stores(1))
    await s.tick()
    const j = (await s.engine.listJobs(r.id))[0]
    await s.engine.revalidate(j.id)
    await s.engine.revalidate(j.id)
    expect(probes).toBe(0) // window closed: no device read at all
    s.clock.set('2026-11-02T05:00:00Z')
    s.env.desiredStateProbe = async () => { probes++; return 'not_satisfied' }
    s.env.online.delete('ap1')
    s.env.online.add('ap1')
    await s.engine.revalidate(j.id)
    await s.engine.revalidate(j.id)
    expect(probes).toBe(1)
    s.clock.advance(30_001)
    await s.engine.revalidate(j.id)
    expect(probes).toBe(2)
  })

  it('m17: a rollout whose jobs were all resolved by hand ends completed_manually', async () => {
    const s = setupEngine({ offer_lease_ms: 1000 })
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(1))
    await s.tick()
    s.clock.advance(1001)
    await s.tick()
    must(await s.engine.resolveManually((await s.engine.listJobs(r.id))[0].id, 'ops', 'done by hand'))
    await s.tick()
    expect((await s.engine.getRollout(r.id))!.state).toBe('completed_manually')
  })
})

describe('rollback is a recovery job with its own lease and approval', () => {
  it('a restore plan needs approval and waits for any active job on the same target', async () => {
    const w: World = createWorld([{ id: 'ap1', location: 'store-1' }, { id: 'ap2', location: 'store-1', config: { 'ssid.staff.ssid': 'OLD', 'ssid.staff.security': 'wpa', 'ssid.staff.passphrase_ref': secretRef('vault:wifi/staff', 6) } }])
    w.fake.inject({ target_id: 'ap2', step: 'apply', mode: 'partial', times: 1 })
    const thresholds = { stop_after_failures: 5, stop_after_failure_pct: 100, pct_min_finished: 10, stop_after_consecutive_failures: 5 }
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' }, thresholds }), w.candidates())
    await w.runner.runUntilSettled(w.clock, 10_000)
    expect(w.fake.config('ap2')['ssid.staff.passphrase_ref']).toEqual(secretRef('vault:wifi/staff', 7))
    const restore = buildRestorePlan((await w.engine.getRollout(r.id))!, await w.engine.listJobs(r.id), { requested_by: 'ops', now: w.clock.now(), adapter_version: FAKE_CAPABILITIES.version })
    expect(restore.kind).toBe('recovery.restore_snapshot')
    expect(restore.target_selector.target_ids).toEqual(['ap2'])
    // Another job holds ap2 while the restore is waiting.
    w.fake.inject({ target_id: 'ap2', step: 'apply', mode: 'lost_response', times: 1 })
    const other = await approvedRollout(w.engine, makePlan({ kind: 'wifi.radio.apply', canary: { mode: 'none' }, supersedes_key: 'radio', params: { channel: 'auto' }, setting_paths: ['radio'], base_version: null }), w.candidates((id) => id === 'ap2'))
    await w.runner.step()
    const rr = must(await w.engine.createRollout({ title: 'restore', plan: restore, actor: 'ops' }))
    must(await w.engine.validate(rr.id, 'ops'))
    must(await w.engine.resolveTargets(rr.id, w.candidates((id) => id === 'ap2'), 'ops'))
    const sub = must(await w.engine.submit(rr.id, 'ops'))
    expect(sub.state).toBe('pending_approval')
    must(await w.engine.approve(rr.id, { approver: 'lead', subject: sub.approval_subject!, acknowledged_impact: true }))
    must(await w.engine.schedule(rr.id, 'ops'))
    await w.runner.step()
    expect((await w.engine.listJobs(rr.id))[0].state).toBe('queued')
    await w.runner.runUntilSettled(w.clock, 60_000)
    expect((await w.engine.getRollout(rr.id))!.state).toBe('completed')
    expect((await w.engine.getRollout(other.id))!.state).toMatch(/completed|partially_failed|failed/)
    expect(w.fake.config('ap2')['ssid.staff.passphrase_ref']).toEqual(secretRef('vault:wifi/staff', 6))
  })
})
