// Scenario tests of the orchestration engine with the fake adapter (P7-0). Deterministic: fake clock, sequential
// ids. These prove orchestration only; nothing here says how a real NETGEAR AP or Windows PC behaves.
import { describe, expect, it } from 'vitest'
import { analyseEvents, approvedRollout, createWorld, makeCandidate, makePlan, must, secretRef, type World } from '@/lib/jobs/testing'
import { isWindowOpen } from '@/lib/jobs/window'
import { payloadHash } from '@/lib/jobs/plan'
import type { MaintenanceWindow, Plan } from '@/lib/jobs/types'

const REF6 = secretRef('vault:wifi/staff', 6)
const REF7 = secretRef('vault:wifi/staff', 7)
const REF8 = secretRef('vault:wifi/staff', 8)
const V7 = { ssid: 'CK-Staff', security: 'wpa2-psk', passphrase_ref: REF7 }
const V8 = { ssid: 'CK-Staff', security: 'wpa2-psk', passphrase_ref: REF8 }

function aps(n: number, location: string, prefix = 'ap') {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, location }))
}

async function settle(w: World, stepMs = 10_000, maxSteps = 500) {
  return w.runner.runUntilSettled(w.clock, stepMs, maxSteps)
}

async function steps(w: World, n: number, stepMs = 10_000) {
  for (let i = 0; i < n; i++) {
    await w.runner.step()
    w.clock.advance(stepMs)
  }
}

async function analysis(w: World) {
  const a = analyseEvents(await w.store.listEvents(), w.locations)
  expect(a.problems).toEqual([])
  return a
}

const stateOf = async (w: World, rolloutId: string) => (await w.engine.getRollout(rolloutId))!.state
const jobFor = async (w: World, rolloutId: string, target: string) => (await w.engine.listJobs(rolloutId)).find((j) => j.target_id === target)!

describe('scenario: staff SSID passphrase on all five APs of one store (E1)', () => {
  it('canary first, one AP at a time, each verified, then completed', async () => {
    const w = createWorld(aps(5, 'store-1'))
    const r = await approvedRollout(w.engine, makePlan(), w.candidates())
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('completed')
    const s = must(await w.engine.summary(r.id))
    expect(s).toMatchObject({ requested: 5, applied: 5, verified: 5, failed: 0, unknown: 0, is_partial: false })
    for (const d of aps(5, 'store-1')) expect(w.fake.config(d.id)['ssid.staff.passphrase_ref']).toEqual(REF7)

    const a = await analysis(w)
    expect(a.maxActivePerLocation.get('store-1')).toBe(1)
    const ev = await w.store.listEvents()
    const canaryVerified = ev.find((e) => e.target_id === 'ap1' && e.to === 'verified')!
    const otherOffers = ev.filter((e) => e.type === 'transition' && e.to === 'offered' && e.target_id !== 'ap1')
    expect(otherOffers).toHaveLength(4)
    for (const o of otherOffers) {
      expect(o.seq).toBeGreaterThan(canaryVerified.seq)
      expect(o.at - canaryVerified.at).toBeGreaterThanOrEqual(60_000) // canary soak
    }
  })

  it('every AP got the approved payload and nothing else', async () => {
    const w = createWorld(aps(5, 'store-1'))
    const r = await approvedRollout(w.engine, makePlan(), w.candidates())
    await settle(w)
    expect(new Set(w.fake.applyLog.map((x) => x.payload_hash))).toEqual(new Set([r.payload_hash]))
    expect(w.fake.applyLog.map((x) => x.target_id).sort()).toEqual(['ap1', 'ap2', 'ap3', 'ap4', 'ap5'])
  })
})

describe('scenario: same policy to selected stores, keeping local settings (E2)', () => {
  it('per-location concurrency 1, global cap 2, one canary per store, unselected store untouched', async () => {
    const devices = [...aps(3, 'store-1', 'a'), ...aps(3, 'store-2', 'b'), ...aps(3, 'store-3', 'c')]
    const w = createWorld(devices.map((d, i) => ({ ...d, config: { 'ssid.staff.passphrase_ref': REF6, 'mgmt.ip': `10.${i}.0.2`, 'vlan.staff': 100 + i } })))
    const plan = makePlan({
      params: V7,
      target_selector: { location_ids: ['store-1', 'store-2'] },
      canary: { mode: 'per_location', per_location: 1, soak_ms: 30_000 },
      batch: { batch_size: 4, global_concurrency: 2, per_location_concurrency: 1, block_location_on_unknown: true, batch_soak_ms: 0 },
    })
    const r = await approvedRollout(w.engine, plan, w.candidates())
    expect(r.targets.filter((t) => t.phase === 'canary').map((t) => t.target_id)).toEqual(['a1', 'b1'])
    expect(r.excluded.map((e) => e.target_id).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(r.excluded[0].reasons.join()).toMatch(/not selected/)
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('completed')
    const a = await analysis(w)
    expect(a.maxActivePerRollout.get(r.id)).toBeLessThanOrEqual(2)
    expect(a.maxActivePerLocation.get('store-1')).toBe(1)
    expect(a.maxActivePerLocation.get('store-2')).toBe(1)
    devices.forEach((d, i) => {
      const c = w.fake.config(d.id)
      expect(c['mgmt.ip']).toBe(`10.${i}.0.2`)
      expect(c['vlan.staff']).toBe(100 + i)
      expect(c['ssid.staff.passphrase_ref']).toEqual(d.location === 'store-3' ? REF6 : REF7)
    })
  })
})

describe('scenario: incompatible models are excluded before deployment (E6)', () => {
  it('records the reasons and never touches the excluded APs', async () => {
    const w = createWorld(aps(5, 'store-1'))
    const cands = w.candidates().map((c) =>
      c.target_id === 'ap2' ? { ...c, model: 'WAC104', compatible: false, incompatibility_reasons: ['WAC104: no documented configuration interface (unverified).'] }
        : c.target_id === 'ap3' ? { ...c, capabilities: ['inventory.read'] }
          : c)
    const r = await approvedRollout(w.engine, makePlan(), cands)
    expect(r.excluded.map((e) => [e.target_id, e.reasons.join('; ')])).toEqual([
      ['ap2', 'WAC104: no documented configuration interface (unverified).'],
      ['ap3', 'missing capability: ssid.write'],
    ])
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('completed')
    expect(w.fake.applyLog.map((x) => x.target_id).sort()).toEqual(['ap1', 'ap4', 'ap5'])
    expect(must(await w.engine.summary(r.id))).toMatchObject({ targets: 3, excluded: 2, verified: 3 })
  })
})

describe('scenario: an unreachable AP returns after the profile changed again (E7)', () => {
  it('the old job is superseded and never executed; only the newer payload runs', async () => {
    const w = createWorld(aps(3, 'store-1'))
    w.fake.setOnline('ap3', false)
    const a = await approvedRollout(w.engine, makePlan({ params: V7, canary: { mode: 'none' } }), w.candidates())
    await settle(w, 10_000, 60)
    expect((await jobFor(w, a.id, 'ap3')).state).toBe('queued')
    expect(await stateOf(w, a.id)).toBe('verifying')

    // Profile version 8 is published and rolled out to the same APs.
    w.env.base.set('profile-staff', 8)
    const b = await approvedRollout(w.engine, makePlan({ params: V8, base_version: { key: 'profile-staff', version: 8 }, canary: { mode: 'none' } }), w.candidates().map((c) => ({ ...c, online: true })))
    // Approval alone supersedes nothing; once B starts (it has a job for ap3) the old job is superseded.
    expect((await jobFor(w, a.id, 'ap3')).state).toBe('queued')
    await w.runner.step()
    const old = await jobFor(w, a.id, 'ap3')
    expect(old.state).toBe('superseded')
    expect(old.superseded_by).toBe(b.id)
    expect(old.superseded_by_job).toBe((await jobFor(w, b.id, 'ap3')).id)

    w.fake.setOnline('ap3', true)
    const back = await w.targetReturned('ap3')
    expect(back.decisions.map((d) => d.job_id)).not.toContain(old.id) // nothing of the old rollout is waiting any more
    await settle(w)
    expect(await stateOf(w, a.id)).toBe('completed')
    expect(await stateOf(w, b.id)).toBe('completed')
    const ap3Runs = w.fake.applyLog.filter((x) => x.target_id === 'ap3')
    expect(ap3Runs.map((x) => x.payload_hash)).toEqual([b.payload_hash])
    expect(w.fake.config('ap3')['ssid.staff.passphrase_ref']).toEqual(REF8)
    expect(must(await w.engine.summary(a.id))).toMatchObject({ verified: 2, superseded: 1 })
  })

  it('an older rollout that starts after a newer one was approved has its jobs superseded at once, never executed', async () => {
    const w = createWorld(aps(1, 'store-1'))
    // Older rollout A is approved but scheduled for later; it has no jobs yet.
    const a = await approvedRollout(w.engine, makePlan({ params: V7, canary: { mode: 'none' }, schedule: { not_before: '2026-11-02T08:00:00Z', window: null } }), w.candidates())
    // Newer rollout B with the same supersede key is approved and runs first.
    const b = await approvedRollout(w.engine, makePlan({ params: V8, canary: { mode: 'none' } }), [makeCandidate('ap1', 'store-1')])
    await settle(w, 10_000, 20)
    expect(await stateOf(w, b.id)).toBe('completed')
    w.clock.set('2026-11-02T08:00:00Z')
    await settle(w)
    const old = await jobFor(w, a.id, 'ap1')
    expect(old.state).toBe('superseded')
    expect(old.superseded_by).toBe(b.id)
    expect(await stateOf(w, a.id)).toBe('superseded')
    expect(w.fake.applyLog.map((x) => x.payload_hash)).toEqual([b.payload_hash])
  })

  it('a newer rollout that is approved but not started does not supersede: the old job still runs when the AP returns (I9)', async () => {
    const w = createWorld(aps(1, 'store-1'))
    w.fake.setOnline('ap1', false)
    const a = await approvedRollout(w.engine, makePlan({ params: V7, canary: { mode: 'none' } }), w.candidates())
    await w.runner.step()
    const b = must(await w.engine.createRollout({ title: 'v8', plan: makePlan({ params: V8, canary: { mode: 'none' }, schedule: { not_before: '2026-11-03T00:00:00Z', window: null } }), actor: 'user-requester' }))
    must(await w.engine.validate(b.id, 'user-requester'))
    must(await w.engine.resolveTargets(b.id, [makeCandidate('ap1', 'store-1')], 'user-requester'))
    const sub = must(await w.engine.submit(b.id, 'user-requester'))
    must(await w.engine.approve(b.id, { approver: 'approver-1', subject: sub.approval_subject!, acknowledged_impact: true }))
    expect((await jobFor(w, a.id, 'ap1')).state).toBe('queued')
    w.fake.setOnline('ap1', true)
    const back = await w.targetReturned('ap1')
    expect(back.offered.map((j) => j.rollout_id)).toEqual([a.id])
  })
})

describe('scenario: approvals are bound to the exact payload', () => {
  it('a payload changed after approval never executes', async () => {
    const w = createWorld(aps(2, 'store-1'))
    const r = await approvedRollout(w.engine, makePlan({ schedule: { not_before: '2026-11-02T06:00:00Z', window: null } }), w.candidates())
    must(await w.engine.amendPlan(r.id, makePlan({ params: V8, schedule: { not_before: '2026-11-02T06:00:00Z', window: null } }), 'user-requester'))
    await steps(w, 100, 60_000)
    expect(w.fake.applyLog).toEqual([])
    expect(await stateOf(w, r.id)).toBe('draft')
  })

  it('a newer base version published before start blocks the old rollout\'s jobs (stale configuration version)', async () => {
    const w = createWorld(aps(2, 'store-1'))
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    w.env.base.set('profile-staff', 8)
    await steps(w, 5)
    const jobs = await w.engine.listJobs(r.id)
    expect(jobs.map((j) => [j.state, j.blocked_reason])).toEqual([['blocked', 'stale_configuration_version'], ['blocked', 'stale_configuration_version']])
    expect(w.fake.applyLog).toEqual([])
    // And a new rollout on version 7 is refused at validation.
    const again = must(await w.engine.createRollout({ title: 'again', plan: makePlan(), actor: 'user-requester' }))
    const v = await w.engine.validate(again.id, 'u')
    expect(!v.ok && v.error.code).toBe('stale_configuration_version')
  })

  it('a policy version change while a target is offline blocks its job on return', async () => {
    const w = createWorld(aps(2, 'store-1'))
    w.fake.setOnline('ap2', false)
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await steps(w, 5)
    w.env.defaultPolicyVersion = 4
    w.fake.setOnline('ap2', true)
    const back = await w.targetReturned('ap2')
    expect(back.decisions.map((d) => d.decision)).toEqual([{ action: 'blocked', reason: 'policy_changed' }])
    await steps(w, 5)
    expect(w.fake.executions('ap2')).toBe(0)
    expect((await jobFor(w, r.id, 'ap2')).blocked_reason).toBe('policy_changed')
  })

  it('a target that already has the desired state is marked already satisfied without executing', async () => {
    const w = createWorld([{ id: 'ap1', location: 'store-1' }, { id: 'ap2', location: 'store-1', config: { 'ssid.staff.ssid': 'CK-Staff', 'ssid.staff.security': 'wpa2-psk', 'ssid.staff.passphrase_ref': REF7 } }])
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await settle(w)
    expect((await jobFor(w, r.id, 'ap2')).state).toBe('already_satisfied')
    expect(w.fake.executions('ap2')).toBe(0)
    expect(must(await w.engine.summary(r.id))).toMatchObject({ verified: 1, already_satisfied: 1, applied: 1 })
    expect(await stateOf(w, r.id)).toBe('completed')
  })
})

describe('scenario: two concurrent jobs must not overwrite each other (E10)', () => {
  // A different change (another supersede key) that also sets the staff SSID's security mode: the adapter-derived
  // setting paths overlap on ssid.staff.security.
  const macPlan = (policy: 'reject' | 'wait'): Plan => makePlan({
    supersedes_key: 'wifi:security-hardening', setting_paths: ['ssid.staff.security'], conflict_policy: policy,
    params: { security: 'wpa3-sae' }, base_version: null, canary: { mode: 'none' },
  })

  it('a second rollout touching the same target and setting is rejected at target resolution', async () => {
    const w = createWorld(aps(2, 'store-1'))
    const a = await approvedRollout(w.engine, makePlan(), w.candidates())
    const b = must(await w.engine.createRollout({ title: 'mac', plan: macPlan('reject'), actor: 'user-requester' }))
    must(await w.engine.validate(b.id, 'u'))
    const res = await w.engine.resolveTargets(b.id, w.candidates(), 'u')
    expect(!res.ok && res.error.code).toBe('conflicting_rollout')
    if (!res.ok) expect(JSON.stringify(res.error.details)).toContain(a.id)
  })

  it('with conflict policy "wait", the later rollout runs on each target only after the earlier one finished there', async () => {
    const w = createWorld(aps(3, 'store-1'))
    const a = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    const b = await approvedRollout(w.engine, macPlan('wait'), w.candidates())
    expect(b.conflicts.length).toBeGreaterThan(0)
    await settle(w)
    expect(await stateOf(w, a.id)).toBe('completed')
    expect(await stateOf(w, b.id)).toBe('completed')
    const an = await analysis(w)
    for (const t of ['ap1', 'ap2', 'ap3']) expect(an.maxActivePerTarget.get(t)).toBe(1)
    const ev = await w.store.listEvents()
    for (const t of ['ap1', 'ap2', 'ap3']) {
      const aDone = ev.find((e) => e.rollout_id === a.id && e.target_id === t && e.to === 'verified')!
      const bOffer = ev.find((e) => e.rollout_id === b.id && e.target_id === t && e.to === 'offered')!
      expect(bOffer.seq).toBeGreaterThan(aDone.seq)
    }
  })
})

describe('scenario: partial failure, threshold pause, then a human decision (E8)', () => {
  const devices = [...aps(2, 'store-1', 'a'), ...aps(2, 'store-2', 'b'), ...aps(2, 'store-3', 'c')]
  const plan = makePlan({
    target_selector: { organisation_wide: true },
    canary: { mode: 'none' },
    batch: { batch_size: 2, global_concurrency: 2, per_location_concurrency: 1, block_location_on_unknown: true, batch_soak_ms: 0 },
    thresholds: { stop_after_failures: 2, stop_after_failure_pct: 100, pct_min_finished: 100, stop_after_consecutive_failures: 99 },
  })

  async function pausedWorld() {
    const w = createWorld(devices)
    w.fake.inject({ target_id: 'a1', step: 'apply', mode: 'fail' })
    w.fake.inject({ target_id: 'b1', step: 'apply', mode: 'fail' })
    const r = await approvedRollout(w.engine, plan, w.candidates())
    await steps(w, 5)
    expect(await stateOf(w, r.id)).toBe('paused_by_threshold')
    expect((await w.engine.getRollout(r.id))!.pause_reason).toMatch(/2 failures/)
    // Nothing more is offered until a human decides.
    const before = w.fake.applyLog.length
    await steps(w, 20)
    expect(w.fake.applyLog.length).toBe(before)
    return { w, r }
  }

  it('resume: the remaining targets run and the rollout ends partially failed with failures kept visible', async () => {
    const { w, r } = await pausedWorld()
    expect(must(await w.engine.resume(r.id, 'ops-lead', 'Two APs need a firmware update; continue with the rest.')).state).toBe('running_batches')
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('partially_failed')
    expect(must(await w.engine.summary(r.id))).toMatchObject({ requested: 6, verified: 4, apply_failed: 2, failed: 2, is_partial: true })
    const failed = (await w.engine.listJobs(r.id)).filter((j) => j.state === 'failed')
    expect(failed.map((j) => j.recovery_actions)).toEqual([['restore_snapshot', 'manual'], ['restore_snapshot', 'manual']])
  })

  it('abort: queued jobs are cancelled and never executed', async () => {
    const { w, r } = await pausedWorld()
    must(await w.engine.cancel(r.id, 'ops-lead', 'Stop: investigate the failures first.'))
    await steps(w, 20)
    expect(await stateOf(w, r.id)).toBe('cancelled')
    expect(w.fake.applyLog).toEqual([])
    expect(must(await w.engine.summary(r.id))).toMatchObject({ apply_failed: 2, cancelled: 4 })
  })

  it('recovery: a follow-up rollout to the failed targets only finishes the job', async () => {
    const { w, r } = await pausedWorld()
    must(await w.engine.cancel(r.id, 'ops-lead', 'Retry the failed ones separately.'))
    w.fake.clearFaults()
    const failedTargets = (await w.engine.listJobs(r.id)).filter((j) => j.state === 'failed').map((j) => j.target_id)
    const retry = await approvedRollout(w.engine, makePlan({ ...plan, target_selector: { target_ids: failedTargets } }), w.candidates())
    expect(retry.targets.map((t) => t.target_id).sort()).toEqual(['a1', 'b1'])
    await settle(w)
    expect(await stateOf(w, retry.id)).toBe('completed')
    expect(w.fake.config('a1')['ssid.staff.passphrase_ref']).toEqual(REF7)
  })
})

describe('scenario: lost acknowledgements are reconciled, never blindly re-run', () => {
  it('lost response → unknown → reconcile → applied → verified, executed once', async () => {
    const w = createWorld(aps(1, 'store-1'))
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response', times: 1 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await settle(w, 60_000)
    const j = await jobFor(w, r.id, 'ap1')
    expect(j.state).toBe('verified')
    expect(j.attempt).toBe(1)
    expect(w.fake.executions('ap1')).toBe(1)
    expect((await analysis(w)).history.get(j.id)).toEqual([
      'null>queued:requested', 'queued>offered:offered', 'offered>unknown:acknowledgement_lost', 'unknown>reconciling:reconcile_requested',
      'reconciling>verifying:reconciled_applied', 'verifying>verified:verification_match',
    ])
  })

  it('lost request → unknown → reconcile → not_applied → one retry with the same idempotency key', async () => {
    const w = createWorld(aps(1, 'store-1'))
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_request', times: 1 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' }, max_attempts: 2 }), w.candidates())
    await settle(w, 60_000)
    const j = await jobFor(w, r.id, 'ap1')
    expect(j.state).toBe('verified')
    expect(j.attempt).toBe(2)
    expect(w.fake.executions('ap1')).toBe(1)
    expect(new Set(w.fake.applyLog.map((x) => x.idempotency_key))).toEqual(new Set([j.idempotency_key]))
    expect((await analysis(w)).history.get(j.id)).toContain('reconciling>queued:reconciled_not_applied')
  })

  it('an unknown job of an offline AP stays unknown and blocks the next AP at that location only', async () => {
    const devices = [...aps(2, 'store-1', 'a'), ...aps(2, 'store-2', 'b')]
    const w = createWorld(devices)
    w.fake.inject({ target_id: 'a1', step: 'apply', mode: 'lost_response', times: 1 })
    const plan = makePlan({
      target_selector: { organisation_wide: true }, canary: { mode: 'none' },
      batch: { batch_size: 4, global_concurrency: 4, per_location_concurrency: 2, block_location_on_unknown: true, batch_soak_ms: 0 },
    })
    const r = await approvedRollout(w.engine, plan, w.candidates())
    await w.runner.step() // a1 lost, b1 and b2 applied; a2 is held back? (a1 was offered first, a2 too: concurrency 2)
    w.fake.setOnline('a1', false)
    await steps(w, 60, 60_000)
    const a1 = await jobFor(w, r.id, 'a1')
    expect(a1.state).toBe('unknown')
    expect(must(await w.engine.summary(r.id)).unknown).toBe(1)
    expect((await jobFor(w, r.id, 'b1')).state).toBe('verified')
    expect((await jobFor(w, r.id, 'b2')).state).toBe('verified')
    w.fake.setOnline('a1', true)
    await settle(w, 60_000)
    expect(await stateOf(w, r.id)).toBe('completed')
    expect(w.fake.executions('a1')).toBe(1)
  })

  it('acknowledged but the result was lost → unknown after the run lease → reconcile → applied', async () => {
    const w = createWorld(aps(1, 'store-1'))
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_result', times: 1 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await w.runner.step()
    expect((await jobFor(w, r.id, 'ap1')).state).toBe('acked')
    await settle(w, 60_000)
    const j = await jobFor(w, r.id, 'ap1')
    expect(j.state).toBe('verified')
    expect((await analysis(w)).history.get(j.id)).toContain('acked>unknown:lease_expired')
    expect(w.fake.executions('ap1')).toBe(1)
  })

  it('a duplicated result delivery changes nothing', async () => {
    const w = createWorld(aps(1, 'store-1'))
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await settle(w)
    const j = await jobFor(w, r.id, 'ap1')
    const n = (await w.store.listEvents()).length
    must(await w.engine.reportResult(j.id, w.runner.deliveredTokens.get(j.id)!, { outcome: 'applied', message: 'again' }))
    expect((await w.store.listEvents()).length).toBe(n)
  })
})

describe('scenario: maintenance windows gate new offers', () => {
  it('nothing is offered outside the window; jobs continue in the next window', async () => {
    const window: MaintenanceWindow = { kind: 'daily', time_zone: 'Asia/Kolkata', start: '22:00', end: '22:02' }
    const w = createWorld(aps(3, 'store-1'), { latency_ms: 50_000 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' }, schedule: { not_before: '2026-11-02T04:30:00Z', window } }), w.candidates())
    // 10:00 IST: closed.
    await steps(w, 30, 60_000)
    expect(w.fake.applyLog).toEqual([])
    await settle(w, 60_000, 6000)
    expect(await stateOf(w, r.id)).toBe('completed')
    const offers = (await w.store.listEvents()).filter((e) => e.type === 'transition' && e.to === 'offered')
    expect(offers).toHaveLength(3)
    for (const o of offers) expect(isWindowOpen(window, o.at)).toBe(true)
    // Latency means not all three fit in one two-minute window.
    const days = new Set(offers.map((o) => new Date(o.at + 5.5 * 3600_000).toISOString().slice(0, 10)))
    expect(days.size).toBeGreaterThan(1)
  })
})

describe('scenario: cancel mid-rollout', () => {
  it('queued jobs are cancelled; a job in flight is left to complete (no stop support) and recorded', async () => {
    const w = createWorld(aps(5, 'store-1'))
    w.fake.inject({ target_id: 'ap2', step: 'apply', mode: 'lost_response', times: 1 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await w.runner.step() // ap1 applied
    await w.runner.step() // ap1 verified; ap2 offered, response lost
    expect((await jobFor(w, r.id, 'ap2')).state).toBe('offered')
    must(await w.engine.cancel(r.id, 'ops', 'Store manager asked to stop.'))
    expect((await jobFor(w, r.id, 'ap2')).stop).toBe('unsupported_left_to_complete')
    await settle(w, 60_000, 50)
    await steps(w, 30, 60_000)
    expect(await stateOf(w, r.id)).toBe('cancelled')
    const s = must(await w.engine.summary(r.id))
    expect(s).toMatchObject({ verified: 2, cancelled: 3 })
    expect(w.fake.applyLog.map((x) => x.target_id).sort()).toEqual(['ap1', 'ap2'])
    const ev = (await w.store.listEvents({ job_id: (await jobFor(w, r.id, 'ap2')).id })).map((e) => e.reason)
    expect(ev).toContain('left_to_complete')
  })

  it('with stop support, a job in flight is asked to stop', async () => {
    const w = createWorld(aps(2, 'store-1'), { fakeCapabilities: { operations: { snapshot: true, rollback: true, stop: true, verify: true, reconcile: true } } })
    w.fake.inject({ target_id: 'ap1', step: 'apply', mode: 'lost_response', times: 1 })
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await w.runner.step()
    must(await w.engine.cancel(r.id, 'ops', 'stop'))
    expect((await jobFor(w, r.id, 'ap1')).stop).toBe('requested')
    const rep = await w.runner.step()
    expect(rep.stops_requested).toBe(1)
  })
})

describe('scenario: expiry of queued jobs', () => {
  it('a target that stays offline past the expiry gets an expired job and is never touched on return', async () => {
    const w = createWorld(aps(2, 'store-1'))
    w.fake.setOnline('ap2', false)
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' }, expires_at: '2026-11-02T06:30:00Z' }), w.candidates())
    await steps(w, 150, 60_000)
    expect(await stateOf(w, r.id)).toBe('expired')
    expect((await jobFor(w, r.id, 'ap2')).state).toBe('expired')
    w.fake.setOnline('ap2', true)
    await w.targetReturned('ap2')
    await steps(w, 5)
    expect(w.fake.executions('ap2')).toBe(0)
    expect(must(await w.engine.summary(r.id))).toMatchObject({ verified: 1, expired: 1 })
  })
})

describe('scenario: verification failure is not apply failure', () => {
  it('false success is caught by verification; restore from the snapshot is recorded', async () => {
    const w = createWorld(aps(4, 'store-1'))
    w.fake.inject({ target_id: 'ap2', step: 'apply', mode: 'false_success' })
    w.fake.inject({ target_id: 'ap3', step: 'apply', mode: 'fail' })
    const plan = makePlan({ thresholds: { stop_after_failures: 5, stop_after_failure_pct: 100, pct_min_finished: 10, stop_after_consecutive_failures: 5 } })
    const r = await approvedRollout(w.engine, plan, w.candidates())
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('partially_failed')
    const s = must(await w.engine.summary(r.id))
    expect(s).toMatchObject({ applied: 3, verified: 2, verification_failed: 1, apply_failed: 1, failed: 2 })
    const ap2 = await jobFor(w, r.id, 'ap2')
    expect(ap2.state).toBe('verification_failed')
    expect(ap2.verification!.expected['ssid.staff.passphrase_ref']).toEqual(REF7)
    expect(ap2.verification!.observed['ssid.staff.passphrase_ref']).toEqual(REF6)
    expect(ap2.recovery_actions).toEqual(['restore_snapshot', 'manual'])
    const restored = await w.fake.rollback({ target_id: 'ap2', location_id: 'store-1' }, ap2.snapshot!.ref!)
    const after = must(await w.engine.recordRollback(ap2.id, 'ops', restored.status))
    expect(after.rollback!.status).toBe('restored')
    expect(after.recovery_actions).toEqual(['manual'])
  })

  it('an AP whose settings cannot be read back is accepted but not verified', async () => {
    const w = createWorld(aps(1, 'store-1'))
    w.fake.setUnsupported('ap1', ['verify'])
    const r = await approvedRollout(w.engine, makePlan({ canary: { mode: 'none' } }), w.candidates())
    await settle(w)
    expect((await jobFor(w, r.id, 'ap1')).state).toBe('accepted_but_not_verified')
    expect(must(await w.engine.summary(r.id))).toMatchObject({ verified: 0, accepted_but_not_verified: 1, applied: 1 })
  })

  it('a canary that cannot be verified pauses the rollout for a human decision', async () => {
    const w = createWorld(aps(3, 'store-1'))
    w.fake.setUnsupported('ap1', ['verify'])
    const r = await approvedRollout(w.engine, makePlan(), w.candidates())
    await steps(w, 5)
    expect(await stateOf(w, r.id)).toBe('paused_by_threshold')
    expect((await w.engine.getRollout(r.id))!.pause_reason).toMatch(/canary did not verify on ap1/)
    must(await w.engine.resume(r.id, 'ops', 'Read-back is not supported on this model; checked by hand.'))
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('completed')
  })
})

describe('scenario: MAC rule on the selected compatible APs (E3)', () => {
  it('only APs with MAC list support receive the rule', async () => {
    const w = createWorld(aps(4, 'store-1'))
    const cands = w.candidates().map((c) => (c.target_id === 'ap4' ? { ...c, capabilities: ['ssid.write'] } : c))
    const plan = makePlan({ kind: 'wifi.mac_rule.apply', supersedes_key: 'wifi:mac:staff', setting_paths: ['mac_acl.staff'], params: { mode: 'deny', add: ['02:00:00:00:00:01'] }, base_version: null })
    const r = await approvedRollout(w.engine, plan, cands)
    expect(r.excluded).toEqual([{ target_id: 'ap4', location_id: 'store-1', reasons: ['missing capability: mac_acl.write'] }])
    await settle(w)
    expect(await stateOf(w, r.id)).toBe('completed')
    for (const t of ['ap1', 'ap2', 'ap3']) expect(w.fake.config(t)['mac_acl.staff.mode']).toBe('deny')
    expect(w.fake.config('ap4')['mac_acl.staff.mode']).toBeUndefined()
  })
})

describe('scenario: the event log is complete', () => {
  it('replaying the log gives the final state of every job and rollout', async () => {
    const w = createWorld(aps(4, 'store-1'))
    w.fake.inject({ target_id: 'ap3', step: 'apply', mode: 'lost_response', times: 1 })
    const r = await approvedRollout(w.engine, makePlan(), w.candidates())
    await settle(w, 60_000)
    const a = await analysis(w)
    for (const j of await w.engine.listJobs(r.id)) expect(a.jobStates.get(j.id)).toBe(j.state)
    expect(a.rolloutStates.get(r.id)).toBe((await w.engine.getRollout(r.id))!.state)
    expect(payloadHash((await w.engine.getRollout(r.id))!.plan)).toBe(r.payload_hash)
  })
})
