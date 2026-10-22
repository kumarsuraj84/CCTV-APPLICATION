import { describe, expect, it } from 'vitest'
import { approvedRollout, makeCandidate, makePlan, must, setupEngine } from '@/lib/jobs/testing'
import type { Plan } from '@/lib/jobs/types'
import type { JobStore } from '@/lib/jobs/store'

const OFFER_LEASE = 60_000
const RUN_LEASE = 300_000

/** One target, no canary, low risk: the first tick offers the job. */
async function offeredJob(planOverrides: Partial<Plan> = {}) {
  const s = setupEngine({ offer_lease_ms: OFFER_LEASE, run_lease_ms: RUN_LEASE, reconcile_lease_ms: OFFER_LEASE })
  s.env.online.add('ap1')
  const r = await approvedRollout(s.engine, makePlan({ risk: 'low', canary: { mode: 'none' }, ...planOverrides }), [makeCandidate('ap1', 'store-1')])
  const rep = await s.engine.tick()
  expect(rep.offered).toHaveLength(1)
  const job = rep.offered[0]
  return { ...s, r, job, token: job.lease!.token }
}

const jobEvents = async (store: JobStore, jobId: string) => (await store.listEvents({ job_id: jobId }))

describe('offer and acknowledgement', () => {
  it('an offer carries a lease token, an expiry and the attempt number', async () => {
    const { job, clock } = await offeredJob()
    expect(job.state).toBe('offered')
    expect(job.lease).toEqual({ token: expect.any(String), until: clock.now() + OFFER_LEASE, attempt: 1 })
    expect(job.attempt).toBe(1)
  })

  it('acknowledging with the token moves to acked and extends the lease to the run lease', async () => {
    const { engine, job, token, clock } = await offeredJob()
    const acked = must(await engine.ack(job.id, token))
    expect(acked.state).toBe('acked')
    expect(acked.lease!.until).toBe(clock.now() + RUN_LEASE)
  })

  it('a duplicate acknowledgement is idempotent: same outcome, no new event', async () => {
    const { engine, store, job, token } = await offeredJob()
    must(await engine.ack(job.id, token))
    const before = (await jobEvents(store, job.id)).length
    const again = must(await engine.ack(job.id, token))
    expect(again.state).toBe('acked')
    expect((await jobEvents(store, job.id)).length).toBe(before)
  })

  it('an acknowledgement with a wrong token is refused and logged, and changes nothing', async () => {
    const { engine, store, job } = await offeredJob()
    const res = await engine.ack(job.id, 'lease-forged')
    expect(!res.ok && res.error.code).toBe('stale_lease')
    expect((await engine.getJob(job.id))!.state).toBe('offered')
    const last = (await jobEvents(store, job.id)).at(-1)!
    expect(last).toMatchObject({ type: 'rejected', reason: 'stale_lease' })
  })

  it('start moves an acknowledged job to running', async () => {
    const { engine, job, token } = await offeredJob()
    must(await engine.ack(job.id, token))
    expect(must(await engine.start(job.id, token)).state).toBe('running')
  })

  it('a heartbeat extends the lease of a running job', async () => {
    const { engine, job, token, clock } = await offeredJob()
    must(await engine.ack(job.id, token))
    clock.advance(200_000)
    const hb = must(await engine.heartbeat(job.id, token))
    expect(hb.lease!.until).toBe(clock.now() + RUN_LEASE)
  })

  it('events never contain the lease token, only a fingerprint', async () => {
    const { engine, store, job, token } = await offeredJob()
    must(await engine.ack(job.id, token))
    const text = JSON.stringify(await store.listEvents())
    expect(text).not.toContain(token)
    expect(text).toContain('lease_fingerprint')
  })
})

describe('results', () => {
  it('applied goes to verifying with the applied flag; a match verifies it and completes the rollout', async () => {
    const { engine, job, token, r } = await offeredJob()
    must(await engine.ack(job.id, token))
    const res = must(await engine.reportResult(job.id, token, { outcome: 'applied', message: 'ok' }))
    expect(res.state).toBe('verifying')
    expect(res.applied).toBe(true)
    const v = must(await engine.recordVerification(job.id, { outcome: 'match', expected: { 'ssid.staff.security': 'wpa2-psk' }, observed: { 'ssid.staff.security': 'wpa2-psk' } }))
    expect(v.state).toBe('verified')
    await engine.tick()
    expect((await engine.getRollout(r.id))!.state).toBe('completed')
  })

  it('a result without a separate acknowledgement is accepted (the result proves receipt)', async () => {
    const { engine, job, token } = await offeredJob()
    expect(must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' })).state).toBe('verifying')
  })

  it('duplicate delivery of the same result is idempotent', async () => {
    const { engine, store, job, token } = await offeredJob()
    must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' }))
    const n = (await jobEvents(store, job.id)).length
    const again = must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' }))
    expect(again.state).toBe('verifying')
    expect((await jobEvents(store, job.id)).length).toBe(n)
  })

  it('a second, different result for the same lease is refused and logged', async () => {
    const { engine, store, job, token } = await offeredJob()
    must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' }))
    const res = await engine.reportResult(job.id, token, { outcome: 'failed', message: 'no' })
    expect(!res.ok && res.error.code).toBe('conflicting_duplicate')
    expect((await jobEvents(store, job.id)).at(-1)).toMatchObject({ type: 'rejected', reason: 'conflicting_duplicate' })
    expect((await engine.getJob(job.id))!.state).toBe('verifying')
  })

  it('apply failure is "failed" and is never verified', async () => {
    const { engine, job, token } = await offeredJob()
    const res = must(await engine.reportResult(job.id, token, { outcome: 'failed', message: 'Device refused the setting.' }))
    expect(res.state).toBe('failed')
    expect(res.applied).toBe(false)
    expect(res.recovery_actions).toEqual(['manual'])
    const v = await engine.recordVerification(job.id, { outcome: 'match', expected: {}, observed: {} })
    expect(!v.ok && v.error.code).toBe('invalid_transition')
  })

  it('verification failure is distinct from apply failure and keeps expected versus observed', async () => {
    const { engine, job, token } = await offeredJob()
    must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' }))
    const v = must(await engine.recordVerification(job.id, { outcome: 'mismatch', expected: { 'ssid.staff.vlan': 20, 'ssid.staff.passphrase': 'secret!' }, observed: { 'ssid.staff.vlan': 1 } }))
    expect(v.state).toBe('verification_failed')
    expect(v.applied).toBe(true)
    expect(v.verification!.expected).toEqual({ 'ssid.staff.vlan': 20, 'ssid.staff.passphrase': '[redacted]' })
    expect(v.verification!.observed).toEqual({ 'ssid.staff.vlan': 1 })
  })

  it('verification that cannot be done is "accepted but not verified", never verified', async () => {
    const { engine, job, token } = await offeredJob()
    must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' }))
    expect(must(await engine.recordVerification(job.id, { outcome: 'unsupported', expected: {}, observed: {} })).state).toBe('accepted_but_not_verified')
  })

  it('inconclusive verification is retried and ends as accepted but not verified after the limit', async () => {
    const { engine, job, token } = await offeredJob()
    must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' }))
    expect(must(await engine.recordVerification(job.id, { outcome: 'inconclusive', expected: {}, observed: {} })).state).toBe('verifying')
    expect(must(await engine.recordVerification(job.id, { outcome: 'inconclusive', expected: {}, observed: {} })).state).toBe('verifying')
    expect(must(await engine.recordVerification(job.id, { outcome: 'inconclusive', expected: {}, observed: {} })).state).toBe('accepted_but_not_verified')
  })

  it('a partial application is its own outcome with the partial flag', async () => {
    const { engine, job, token } = await offeredJob()
    const res = must(await engine.reportResult(job.id, token, { outcome: 'partial', message: 'Radio settings applied, SSID failed.' }))
    expect(res.state).toBe('partially_applied')
    expect(res.partial).toBe(true)
  })

  it('a device that reports "unknown" itself goes to unknown', async () => {
    const { engine, job, token } = await offeredJob()
    expect(must(await engine.reportResult(job.id, token, { outcome: 'unknown', message: 'Rebooted mid-change.' })).state).toBe('unknown')
  })

  it('records a snapshot reference with the lease token', async () => {
    const { engine, job, token } = await offeredJob()
    const res = must(await engine.recordSnapshot(job.id, token, { status: 'taken', ref: 'snap-blob-1' }))
    expect(res.snapshot).toEqual({ status: 'taken', ref: 'snap-blob-1' })
    const bad = await engine.recordSnapshot(job.id, 'other', { status: 'taken', ref: 'x' })
    expect(!bad.ok && bad.error.code).toBe('stale_lease')
  })
})

describe('lease expiry and reconciliation (no blind retry)', () => {
  it('lost acknowledgement: an expired offer becomes unknown, and is not offered again by later ticks', async () => {
    const { engine, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const j = (await engine.getJob(job.id))!
    expect(j.state).toBe('unknown')
    expect(j.terminal_reason).toBeNull()
    expect(j.recovery_actions).toEqual(['reconcile', 'retry_after_reconcile', 'manual'])
    clock.advance(10 * OFFER_LEASE)
    expect((await engine.tick()).offered).toEqual([])
    expect((await engine.getJob(job.id))!.attempt).toBe(1)
  })

  it('a running job whose lease runs out becomes unknown', async () => {
    const { engine, job, token, clock } = await offeredJob()
    must(await engine.ack(job.id, token))
    clock.advance(RUN_LEASE + 1)
    await engine.tick()
    expect((await engine.getJob(job.id))!.state).toBe('unknown')
  })

  it('a late result for a lease that has already expired is refused and logged (stale lease token)', async () => {
    const { engine, store, job, token, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const res = await engine.reportResult(job.id, token, { outcome: 'applied', message: '' })
    expect(!res.ok && res.error.code).toBe('stale_lease')
    expect((await jobEvents(store, job.id)).at(-1)).toMatchObject({ type: 'rejected', reason: 'stale_lease' })
  })

  it('a result that arrives late but before the engine noticed the expiry is still accepted', async () => {
    const { engine, job, token, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    expect(must(await engine.reportResult(job.id, token, { outcome: 'applied', message: '' })).state).toBe('verifying')
  })

  it('unknown → reconcile → applied → verifying → verified, without a second offer', async () => {
    const { engine, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    expect((await engine.reconcileCandidates()).map((j) => j.id)).toEqual([job.id])
    const rq = must(await engine.beginReconcile(job.id))
    expect(rq.idempotency_key).toBe(job.idempotency_key)
    const after = must(await engine.recordReconcile(job.id, rq.token, 'applied'))
    expect(after.state).toBe('verifying')
    expect(after.applied).toBe(true)
    expect(must(await engine.recordVerification(job.id, { outcome: 'match', expected: {}, observed: {} })).state).toBe('verified')
    expect((await engine.getJob(job.id))!.attempt).toBe(1)
  })

  it('unknown → reconcile → not_applied → one new offer with a new token; the old token is refused', async () => {
    const { engine, job, token, clock } = await offeredJob({ max_attempts: 2 })
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const rq = must(await engine.beginReconcile(job.id))
    expect(must(await engine.recordReconcile(job.id, rq.token, 'not_applied')).state).toBe('queued')
    const rep = await engine.tick()
    expect(rep.offered).toHaveLength(1)
    const again = rep.offered[0]
    expect(again.attempt).toBe(2)
    expect(again.idempotency_key).toBe(job.idempotency_key)
    expect(again.lease!.token).not.toBe(token)
    const stale = await engine.reportResult(job.id, token, { outcome: 'applied', message: '' })
    expect(!stale.ok && stale.error.code).toBe('stale_lease')
  })

  it('not_applied with no attempts left fails the job instead of retrying', async () => {
    const { engine, job, clock } = await offeredJob({ max_attempts: 1 })
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const rq = must(await engine.beginReconcile(job.id))
    const res = must(await engine.recordReconcile(job.id, rq.token, 'not_applied'))
    expect(res.state).toBe('failed')
    expect(res.terminal_reason).toBe('attempts_exhausted')
  })

  it('reconcile answer "unknown" keeps the job unknown and visible', async () => {
    const { engine, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const rq = must(await engine.beginReconcile(job.id))
    const res = must(await engine.recordReconcile(job.id, rq.token, 'unknown'))
    expect(res.state).toBe('unknown')
    expect(res.reconcile_attempts).toBe(1)
  })

  it('reconcile "partial" is a partial application', async () => {
    const { engine, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const rq = must(await engine.beginReconcile(job.id))
    expect(must(await engine.recordReconcile(job.id, rq.token, 'partial')).state).toBe('partially_applied')
  })

  it('a reconcile request that is never answered falls back to unknown; its token is then stale', async () => {
    const { engine, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const rq = must(await engine.beginReconcile(job.id))
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    expect((await engine.getJob(job.id))!.state).toBe('unknown')
    const late = await engine.recordReconcile(job.id, rq.token, 'applied')
    expect(!late.ok && late.error.code).toBe('stale_lease')
  })

  it('a duplicate reconcile answer is idempotent', async () => {
    const { engine, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const rq = must(await engine.beginReconcile(job.id))
    must(await engine.recordReconcile(job.id, rq.token, 'applied'))
    expect(must(await engine.recordReconcile(job.id, rq.token, 'applied')).state).toBe('verifying')
  })

  it('reconcile cannot start for a job that is not unknown', async () => {
    const { engine, job } = await offeredJob()
    const res = await engine.beginReconcile(job.id)
    expect(!res.ok && res.error.code).toBe('invalid_transition')
  })

  it('reconcile candidates are only unknown jobs whose target is online', async () => {
    const { engine, env, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    env.online.delete('ap1')
    expect(await engine.reconcileCandidates()).toEqual([])
    env.online.add('ap1')
    expect((await engine.reconcileCandidates()).map((j) => j.id)).toEqual([job.id])
  })

  it('an operator can resolve an unknown job by hand, with a note', async () => {
    const { engine, store, job, clock } = await offeredJob()
    clock.advance(OFFER_LEASE + 1)
    await engine.tick()
    const res = must(await engine.resolveManually(job.id, 'ops', 'Checked on site: the AP has the new profile.'))
    expect(res.state).toBe('resolved_manually')
    expect((await jobEvents(store, job.id)).at(-1)).toMatchObject({ actor: 'ops', to: 'resolved_manually' })
  })
})

describe('fencing and exclusivity', () => {
  it('a write based on an old read is refused (compare-and-set), so two writers cannot both win', async () => {
    const s = await offeredJob()
    // A second engine on the same store, interleaved: while engine A commits its ack, engine B reports a result first.
    const realCommit = s.store.commit.bind(s.store)
    let interleaved = false
    s.store.commit = async (cs) => {
      if (!interleaved && cs.jobs?.some((w) => w.record.state === 'acked')) {
        interleaved = true
        must(await s.engine.reportResult(s.job.id, s.token, { outcome: 'applied', message: '' }))
      }
      return realCommit(cs)
    }
    const ack = await s.engine.ack(s.job.id, s.token)
    expect(!ack.ok && ack.error.code).toBe('version_conflict')
    expect((await s.engine.getJob(s.job.id))!.state).toBe('verifying')
  })

  it('every write increments the job version', async () => {
    const { engine, job, token } = await offeredJob()
    const v0 = job.version
    const a = must(await engine.ack(job.id, token))
    const b = must(await engine.start(job.id, token))
    expect([a.version, b.version]).toEqual([v0 + 1, v0 + 2])
  })

  it('one active management job per target, across rollouts', async () => {
    const s = setupEngine()
    s.env.online.add('ap1')
    const first = await approvedRollout(s.engine, makePlan({ risk: 'low', canary: { mode: 'none' } }), [makeCandidate('ap1', 'store-1')])
    const second = await approvedRollout(s.engine, makePlan({ risk: 'low', canary: { mode: 'none' }, supersedes_key: 'radio', setting_paths: ['radio.5g'] }), [makeCandidate('ap1', 'store-1')])
    const rep = await s.engine.tick()
    expect(rep.offered.map((j) => j.rollout_id)).toEqual([first.id])
    const j1 = rep.offered[0]
    must(await s.engine.reportResult(j1.id, j1.lease!.token, { outcome: 'applied', message: '' }))
    expect((await s.engine.tick()).offered).toEqual([])
    must(await s.engine.recordVerification(j1.id, { outcome: 'match', expected: {}, observed: {} }))
    const rep2 = await s.engine.tick()
    expect(rep2.offered.map((j) => j.rollout_id)).toEqual([second.id])
  })
})
