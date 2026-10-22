import { describe, expect, it } from 'vitest'
import { approvedRollout, makeCandidate, makePlan, must, setupEngine } from '@/lib/jobs/testing'
import { payloadHash } from '@/lib/jobs/plan'

const stores = (n: number, loc = 'store-1') => Array.from({ length: n }, (_, i) => makeCandidate(`ap${i + 1}`, loc))

async function created(plan = makePlan()) {
  const s = setupEngine()
  const r = must(await s.engine.createRollout({ title: 'Staff SSID', plan, actor: plan.requested_by }))
  return { ...s, r }
}

describe('creating and validating a rollout', () => {
  it('starts as a draft with the payload hash of its plan', async () => {
    const { r } = await created()
    expect(r.state).toBe('draft')
    expect(r.payload_hash).toBe(payloadHash(makePlan()))
    expect(r.version).toBe(1)
  })

  it('refuses a plan that is not plain JSON', async () => {
    const s = setupEngine()
    const r = await s.engine.createRollout({ title: 'x', plan: makePlan({ params: { bad: NaN } }), actor: 'u' })
    expect(!r.ok && r.error.code).toBe('invalid_plan')
  })

  it('validates a good plan', async () => {
    const { engine, r } = await created()
    expect(must(await engine.validate(r.id, 'u')).state).toBe('validated')
  })

  it('refuses validation with the list of problems and stays a draft', async () => {
    const { engine } = await created()
    const bad = must(await engine.createRollout({ title: 'bad', plan: makePlan({ max_attempts: 0 }), actor: 'u' }))
    const v = await engine.validate(bad.id, 'u')
    expect(!v.ok && v.error.code).toBe('invalid_plan')
    expect((await engine.getRollout(bad.id))!.state).toBe('draft')
  })

  it('refuses a stale configuration version (built on N while N+1 exists)', async () => {
    const { engine, env, r } = await created()
    env.base.set('profile-staff', 8)
    const v = await engine.validate(r.id, 'u')
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.error.code).toBe('stale_configuration_version')
      expect(v.error.message).toMatch(/stale configuration version/i)
    }
  })

  it('refuses a plan written against an older policy version', async () => {
    const { engine, env, r } = await created()
    env.defaultPolicyVersion = 4
    const v = await engine.validate(r.id, 'u')
    expect(!v.ok && v.error.code).toBe('invalid_plan')
  })

  it('cannot resolve targets before validation (typed invalid transition)', async () => {
    const { engine, r } = await created()
    const res = await engine.resolveTargets(r.id, stores(2), 'u')
    expect(!res.ok && res.error.code).toBe('invalid_transition')
  })

  it('returns not_found for an unknown rollout', async () => {
    const s = setupEngine()
    const v = await s.engine.validate('nope', 'u')
    expect(!v.ok && v.error.code).toBe('not_found')
  })
})

describe('target resolution', () => {
  async function validated(plan = makePlan()) {
    const s = await created(plan)
    must(await s.engine.validate(s.r.id, 'u'))
    return s
  }

  it('includes compatible targets, orders them and records the impact', async () => {
    const { engine, r } = await validated()
    const res = must(await engine.resolveTargets(r.id, stores(3), 'u'))
    expect(res.state).toBe('targets_resolved')
    expect(res.targets.map((t) => [t.target_id, t.phase])).toEqual([['ap1', 'canary'], ['ap2', 0], ['ap3', 0]])
    expect(res.excluded).toEqual([])
    expect(res.impact).toMatchObject({ disruption: 'brief', reconnect_required: true })
    expect(res.impact_requires_acknowledgement).toBe(true)
  })

  it('excludes incompatible, unsupported, unselected, duplicate, missing and preflight-blocked targets with reasons', async () => {
    const plan = makePlan({ target_selector: { target_ids: ['ap1', 'ap2', 'ap3', 'ap4', 'ap5', 'ap9'] } })
    const { engine, r } = await validated(plan)
    const res = must(await engine.resolveTargets(r.id, [
      makeCandidate('ap1', 'store-1'),
      makeCandidate('ap2', 'store-1', { compatible: false, model: 'WAC104', incompatibility_reasons: ['Model WAC104 has no documented configuration interface.'] }),
      makeCandidate('ap3', 'store-1', { capabilities: ['inventory.read'] }),
      makeCandidate('ap4', 'store-1', { preflight_issues: [{ code: 'fw', message: 'Firmware 1.0 is older than 10.8.', severity: 'blocking' }] }),
      makeCandidate('ap5', 'store-1', { preflight_issues: [{ code: 'note', message: 'Uplink is Wi-Fi mesh.', severity: 'warning' }] }),
      makeCandidate('ap1', 'store-1'),
      makeCandidate('ap7', 'store-1'),
    ], 'u'))
    const reasons = Object.fromEntries(res.excluded.map((e) => [e.target_id, e.reasons.join(' | ')]))
    expect(res.targets.map((t) => t.target_id).sort()).toEqual(['ap1', 'ap5'])
    expect(res.targets.find((t) => t.target_id === 'ap5')!.warnings).toEqual(['Uplink is Wi-Fi mesh.'])
    expect(reasons.ap2).toMatch(/WAC104/)
    expect(reasons.ap3).toMatch(/missing capability: ssid\.write/)
    expect(reasons.ap4).toMatch(/Firmware 1\.0/)
    expect(reasons.ap7).toMatch(/not selected/)
    expect(reasons.ap9).toMatch(/not found/)
    expect(res.excluded.filter((e) => e.target_id === 'ap1')).toHaveLength(1)
    expect(reasons.ap1).toMatch(/duplicate/)
  })

  it('refuses when nothing remains and keeps the rollout validated', async () => {
    const { engine, r } = await validated()
    const res = await engine.resolveTargets(r.id, [makeCandidate('ap1', 'store-1', { compatible: false })], 'u')
    expect(!res.ok && res.error.code).toBe('no_targets')
    expect((await engine.getRollout(r.id))!.state).toBe('validated')
  })

  it('selects by location and model', async () => {
    const plan = makePlan({ target_selector: { location_ids: ['store-1', 'store-2'], models: ['WAX615'] } })
    const { engine, r } = await validated(plan)
    const res = must(await engine.resolveTargets(r.id, [
      makeCandidate('a', 'store-1'), makeCandidate('b', 'store-2'), makeCandidate('c', 'store-3'), makeCandidate('d', 'store-1', { model: 'WAX610' }),
    ], 'u'))
    expect(res.targets.map((t) => t.target_id).sort()).toEqual(['a', 'b'])
    expect(res.excluded.map((e) => e.target_id).sort()).toEqual(['c', 'd'])
  })

  it('needs no impact acknowledgement when nothing is disrupted', async () => {
    const { engine, r } = await validated()
    const res = must(await engine.resolveTargets(r.id, [makeCandidate('ap1', 'store-1', { impact: { disruption: 'none', reboot_required: false, reconnect_required: false, estimated_downtime_s: 0, notes: [] } })], 'u'))
    expect(res.impact_requires_acknowledgement).toBe(false)
  })
})

describe('approvals', () => {
  async function resolved(plan = makePlan()) {
    const s = await created(plan)
    must(await s.engine.validate(s.r.id, 'u'))
    must(await s.engine.resolveTargets(s.r.id, stores(2), 'u'))
    return s
  }

  it('low risk needs no approval: submit goes straight to approved', async () => {
    const { engine, r } = await resolved(makePlan({ risk: 'low' }))
    expect(must(await engine.submit(r.id, 'u')).state).toBe('approved')
  })

  it('medium risk needs one approver who is not the requester', async () => {
    const { engine, r } = await resolved()
    const p = must(await engine.submit(r.id, 'u'))
    expect(p.state).toBe('pending_approval')
    const self = await engine.approve(r.id, { approver: 'user-requester', payload_hash: p.payload_hash, acknowledged_impact: true })
    expect(!self.ok && self.error.code).toBe('approver_is_requester')
    const a = must(await engine.approve(r.id, { approver: 'boss', payload_hash: p.payload_hash, acknowledged_impact: true }))
    expect(a.state).toBe('approved')
  })

  it('high risk needs two distinct approvers', async () => {
    const { engine, r } = await resolved(makePlan({ risk: 'high' }))
    const p = must(await engine.submit(r.id, 'u'))
    const one = must(await engine.approve(r.id, { approver: 'a1', payload_hash: p.payload_hash, acknowledged_impact: true }))
    expect(one.state).toBe('pending_approval')
    const dup = await engine.approve(r.id, { approver: 'a1', payload_hash: p.payload_hash, acknowledged_impact: true })
    expect(!dup.ok && dup.error.code).toBe('duplicate_approver')
    expect(must(await engine.approve(r.id, { approver: 'a2', payload_hash: p.payload_hash, acknowledged_impact: true })).state).toBe('approved')
  })

  it('an approval must name the hash the approver reviewed', async () => {
    const { engine, r } = await resolved()
    must(await engine.submit(r.id, 'u'))
    const res = await engine.approve(r.id, { approver: 'boss', payload_hash: 'f'.repeat(64), acknowledged_impact: true })
    expect(!res.ok && res.error.code).toBe('payload_hash_mismatch')
  })

  it('needs the impact acknowledged when it disrupts clients', async () => {
    const { engine, r } = await resolved()
    const p = must(await engine.submit(r.id, 'u'))
    const res = await engine.approve(r.id, { approver: 'boss', payload_hash: p.payload_hash, acknowledged_impact: false })
    expect(!res.ok && res.error.code).toBe('impact_not_acknowledged')
  })

  it('payload changed after approval: approvals become invalid, the rollout returns to draft and cannot be scheduled', async () => {
    const { engine, r } = await resolved()
    const p = must(await engine.submit(r.id, 'u'))
    must(await engine.approve(r.id, { approver: 'boss', payload_hash: p.payload_hash, acknowledged_impact: true }))
    const amended = must(await engine.amendPlan(r.id, makePlan({ params: { ssid: 'CK-Staff', security: 'wpa3-sae', passphrase_ref: 'vault:wifi/staff/v7' } }), 'user-requester'))
    expect(amended.state).toBe('draft')
    expect(amended.payload_hash).not.toBe(p.payload_hash)
    expect(amended.approvals).toHaveLength(1)
    expect(engine.approvalStatus(amended).satisfied).toBe(false)
    expect(engine.approvalStatus(amended).ignored[0].reason).toBe('payload_changed')
    const sch = await engine.schedule(r.id, 'u')
    expect(!sch.ok && sch.error.code).toBe('invalid_transition')
    // Going through the steps again needs a fresh approval of the new hash.
    must(await engine.validate(r.id, 'u'))
    must(await engine.resolveTargets(r.id, stores(2), 'u'))
    expect(must(await engine.submit(r.id, 'u')).state).toBe('pending_approval')
  })

  it('an amendment that changes nothing keeps the approvals and the state', async () => {
    const { engine, r } = await resolved()
    const p = must(await engine.submit(r.id, 'u'))
    must(await engine.approve(r.id, { approver: 'boss', payload_hash: p.payload_hash, acknowledged_impact: true }))
    const same = must(await engine.amendPlan(r.id, makePlan(), 'user-requester'))
    expect(same.state).toBe('approved')
  })

  it('a rejection cancels the rollout', async () => {
    const { engine, r } = await resolved()
    const p = must(await engine.submit(r.id, 'u'))
    const res = must(await engine.reject(r.id, { approver: 'boss', payload_hash: p.payload_hash, note: 'Not during the sale.' }))
    expect(res.state).toBe('cancelled')
  })

  it('the plan cannot be amended once running', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan(), stores(1))
    await s.engine.tick()
    const res = await s.engine.amendPlan(r.id, makePlan({ params: { x: 1 } }), 'user-requester')
    expect(!res.ok && res.error.code).toBe('immutable_after_start')
  })
})

describe('scheduling, start and events', () => {
  it('does not start before not_before and starts at it', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    const r = await approvedRollout(s.engine, makePlan({ schedule: { not_before: '2026-11-02T05:00:00Z', window: null } }), stores(1))
    expect(r.state).toBe('scheduled')
    await s.engine.tick()
    expect((await s.engine.getRollout(r.id))!.state).toBe('scheduled')
    s.clock.set('2026-11-02T05:00:00Z')
    const rep = await s.engine.tick()
    expect((await s.engine.getRollout(r.id))!.state).toBe('running_canary')
    expect(rep.offered.map((j) => j.target_id)).toEqual(['ap1'])
  })

  it('creates one queued job per included target, each with the payload hash and an idempotency key', async () => {
    const s = setupEngine()
    const r = await approvedRollout(s.engine, makePlan(), stores(3))
    await s.engine.tick()
    const jobs = await s.engine.listJobs(r.id)
    expect(jobs).toHaveLength(3)
    for (const j of jobs) {
      expect(j.state).toBe('queued')
      expect(j.payload_hash).toBe(r.payload_hash)
      expect(j.idempotency_key).toBe(`${j.id}:${r.payload_hash}`)
    }
  })

  it('records every rollout state change as an event with actor, from, to and the payload hash', async () => {
    const s = setupEngine()
    const r = await approvedRollout(s.engine, makePlan(), stores(1))
    const ev = (await s.store.listEvents({ rollout_id: r.id })).filter((e) => e.entity === 'rollout' && e.type === 'transition')
    expect(ev.map((e) => `${e.from}>${e.to}`)).toEqual([
      'null>draft', 'draft>validated', 'validated>targets_resolved', 'targets_resolved>pending_approval', 'pending_approval>approved', 'approved>scheduled',
    ])
    expect(ev.every((e) => e.payload_hash === r.payload_hash)).toBe(true)
    expect(ev[4].actor).toBe('approver-1')
  })

  it('expires a rollout that was never started', async () => {
    const s = setupEngine()
    const r = await approvedRollout(s.engine, makePlan({ schedule: { not_before: '2026-11-20T00:00:00Z', window: null }, expires_at: '2026-11-21T00:00:00Z' }), stores(1))
    s.clock.set('2026-11-21T00:00:00Z')
    await s.engine.tick()
    expect((await s.engine.getRollout(r.id))!.state).toBe('expired')
  })

  it('pause and resume a running rollout; nothing is offered while paused', async () => {
    const s = setupEngine()
    for (const c of stores(3)) s.env.online.add(c.target_id)
    const r = await approvedRollout(s.engine, makePlan({ canary: { mode: 'none' } }), stores(3))
    await s.engine.tick() // starts, offers
    const paused = must(await s.engine.pause(r.id, 'ops', 'Store asked to wait.'))
    expect(paused.state).toBe('paused')
    expect((await s.engine.tick()).offered).toEqual([])
    const resumed = must(await s.engine.resume(r.id, 'ops', 'Store is ready.'))
    expect(resumed.state).toBe('running_batches')
  })

  it('cannot resume a rollout that is not paused', async () => {
    const s = setupEngine()
    const r = await approvedRollout(s.engine, makePlan(), stores(1))
    const res = await s.engine.resume(r.id, 'ops', 'x')
    expect(!res.ok && res.error.code).toBe('invalid_transition')
  })
})
