// Property-style randomized test of the orchestration engine (P7-0). Seeded RNG, fake clock, fake adapter:
// random worlds (targets, locations, faults, presence changes, policy/eligibility/base-version changes, pauses,
// cancels, duplicate and forged messages, plan amendments by other people, a second rollout that supersedes or
// conflicts, devices with and without an execution journal, and concurrent callers: a second engine on the same
// store plus parallel targetReturned calls) with invariants checked after every action. A failure prints the seed.
// Default 300 runs; JOBS_PROPERTY_RUNS=2000 for CI or nightly runs.
import { describe, expect, it } from 'vitest'
import { analyseEvents, approvedRollout, createWorld, makePlan, must, secretRef, seededRandom, type World } from '@/lib/jobs/testing'
import { ACTIVE_JOB_STATES, isTerminalJob, isTerminalRollout } from '@/lib/jobs/machines'
import { ALL_JOB_STATES, summarize } from '@/lib/jobs/planner'
import { JobEngine } from '@/lib/jobs/engine'
import type { FaultMode } from '@/lib/jobs/fake-adapter'
import type { CanarySpec, Plan, Rollout } from '@/lib/jobs/types'

const RUNS = Number(process.env.JOBS_PROPERTY_RUNS ?? 300)

type Rng = () => number
const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))

function randomPlan(rng: Rng, overrides: Partial<Plan>, start = Date.parse('2026-11-02T04:30:00Z')): Plan {
  const canary: CanarySpec = pick(rng, [
    { mode: 'none' },
    { mode: 'first_n', count: int(rng, 1, 2), soak_ms: int(rng, 0, 120) * 1000 },
    { mode: 'per_location', per_location: 1, soak_ms: int(rng, 0, 60) * 1000 },
  ] as CanarySpec[])
  return makePlan({
    canary,
    risk: pick(rng, ['low', 'medium', 'high'] as const),
    // A quarter of the plans expire within hours, so expiry happens mid-run.
    expires_at: new Date(start + (rng() < 0.25 ? int(rng, 10, 90) * 60_000 : 7 * 86_400_000)).toISOString(),
    max_attempts: int(rng, 1, 3),
    base_version: rng() < 0.5 ? { key: 'profile-staff', version: 7 } : null,
    target_selector: { organisation_wide: true },
    schedule: { not_before: new Date(start + int(rng, 0, 600) * 1000).toISOString(), window: null },
    batch: {
      batch_size: int(rng, 1, 3),
      global_concurrency: int(rng, 1, 3),
      per_location_concurrency: int(rng, 1, 2),
      block_location_on_unknown: rng() < 0.5,
      batch_soak_ms: int(rng, 0, 30) * 1000,
    },
    thresholds: {
      stop_after_failures: int(rng, 1, 4),
      stop_after_failure_pct: int(rng, 30, 100),
      pct_min_finished: int(rng, 1, 4),
      stop_after_consecutive_failures: int(rng, 1, 3),
    },
    ...overrides,
  })
}

interface RunState {
  w: World
  rollouts: string[]
  terminalSeen: Map<string, string>
  versions: Map<string, number>
}

async function checkInvariants(s: RunState, seed: number, where: string): Promise<void> {
  const ctx = `seed ${seed} at ${where}`
  const { w } = s
  const all = await w.store.listJobsInStates(ALL_JOB_STATES)
  const active = all.filter((j) => ACTIVE_JOB_STATES.has(j.state))

  // 1. Never two active jobs for one target.
  const perTarget = new Map<string, number>()
  for (const j of active) perTarget.set(j.target_id, (perTarget.get(j.target_id) ?? 0) + 1)
  for (const [t, n] of perTarget) expect(n, `${ctx}: ${n} active jobs on ${t}`).toBe(1)

  // 4a. Never exceeds a rollout's global cap.
  const rollouts = new Map<string, Rollout>()
  for (const id of s.rollouts) rollouts.set(id, (await w.engine.getRollout(id))!)
  for (const [id, r] of rollouts) {
    const mine = active.filter((j) => j.rollout_id === id).length
    expect(mine, `${ctx}: rollout ${id} has ${mine} active > cap ${r.plan.batch.global_concurrency}`).toBeLessThanOrEqual(r.plan.batch.global_concurrency)
  }

  // 2. Never executes an unapproved or changed payload; no idempotency key executes twice (also without a device journal).
  const jobsById = new Map(all.map((j) => [j.id, j]))
  const keys = new Set<string>()
  for (const e of w.fake.applyLog) {
    expect(keys.has(e.idempotency_key), `${ctx}: idempotency key executed twice`).toBe(false)
    keys.add(e.idempotency_key)
    const job = jobsById.get(e.idempotency_key.split(':')[0])
    expect(job, `${ctx}: execution for an unknown job`).toBeDefined()
    expect(job!.payload_hash, `${ctx}: executed payload differs from the job`).toBe(e.payload_hash)
    expect(job!.effective_hash, `${ctx}: executed effective hash differs from the job`).toBe(e.effective_hash)
    const r = rollouts.get(job!.rollout_id)!
    expect(r.payload_hash, `${ctx}: executed payload differs from the rollout`).toBe(e.payload_hash)
    expect(w.engine.approvalStatus(r).satisfied, `${ctx}: executed without valid approvals`).toBe(true)
  }

  for (const [id, r] of rollouts) {
    // Four eyes: no counted approval comes from an author of the current version.
    for (const a of w.engine.approvalStatus(r).counted) expect(r.authors.includes(a.approver), `${ctx}: author ${a.approver} counted as approver`).toBe(false)
    // 6. Counters consistent.
    const jobs = all.filter((j) => j.rollout_id === id)
    const sm = summarize(r, jobs)
    const total = Object.values(sm.by_state).reduce((a, b) => a + b, 0)
    expect(total, ctx).toBe(jobs.length)
    expect(sm.verified, ctx).toBeLessThanOrEqual(sm.applied)
    expect(sm.applied, ctx).toBeLessThanOrEqual(sm.requested)
    expect(sm.failed, ctx).toBe(sm.apply_failed + sm.verification_failed + sm.by_state.partially_applied)
    expect(sm.finished + sm.waiting + sm.in_progress + sm.unknown, ctx).toBe(sm.requested)
    if (jobs.length > 0) expect(jobs.length, ctx).toBe(r.targets.length)
    const seen = s.terminalSeen.get(id)
    if (seen) expect(r.state, `${ctx}: terminal rollout changed`).toBe(seen)
    else if (isTerminalRollout(r.state)) s.terminalSeen.set(id, r.state)
  }

  for (const j of all) {
    const v = s.versions.get(j.id) ?? 0
    expect(j.version, `${ctx}: version went back`).toBeGreaterThanOrEqual(v)
    s.versions.set(j.id, j.version)
    if (j.state === 'verified' || j.state === 'verification_failed' || j.state === 'accepted_but_not_verified') expect(j.applied, ctx).toBe(true)
    if (j.state === 'already_satisfied') expect(w.fake.applyLog.some((e) => e.idempotency_key === j.idempotency_key), ctx).toBe(false)
  }
}

async function checkLog(s: RunState, seed: number): Promise<void> {
  const ctx = `seed ${seed}`
  const events = await s.w.store.listEvents()
  // 5. Event log ordered by sequence and complete: replay gives the stored states.
  const a = analyseEvents(events)
  expect(a.problems, ctx).toEqual([])
  const caps = new Map<string, number>()
  for (const id of s.rollouts) {
    const r = (await s.w.engine.getRollout(id))!
    caps.set(id, r.plan.batch.per_location_concurrency)
    expect(a.rolloutStates.get(id), ctx).toBe(r.state)
    for (const j of await s.w.engine.listJobs(id)) {
      expect(a.jobStates.get(j.id), `${ctx}: replayed state of ${j.id}`).toBe(j.state)
      // 3. Never retries an unknown job without reconciliation.
      const h = a.history.get(j.id) ?? []
      let offers = 0
      for (let i = 0; i < h.length; i++) {
        if (h[i].startsWith('queued>offered') || h[i].startsWith('blocked>offered')) {
          offers += 1
          if (offers > 1) expect(h.slice(0, i).reverse().find((x) => x.includes('>queued')), `${ctx}: re-offer without reconcile: ${h.join(' | ')}`).toBe('reconciling>queued:reconciled_not_applied')
        }
        expect(h[i].startsWith('unknown>queued') || h[i].startsWith('unknown>offered'), ctx).toBe(false)
      }
      expect(offers, `${ctx}: offers beyond max_attempts`).toBeLessThanOrEqual(j.max_attempts)
    }
  }
  // 4b. Each offer respects the OFFERING rollout's own per-location cap (active jobs at that location, all rollouts).
  const state = new Map<string, string>()
  const where = new Map<string, { location: string }>()
  const locationOfTarget = s.w.locations
  for (const e of events) {
    if (e.type !== 'transition' || e.entity !== 'job') continue
    state.set(e.job_id!, e.to!)
    where.set(e.job_id!, { location: locationOfTarget.get(e.target_id!) ?? '?' })
    if (e.to === 'offered') {
      const loc = where.get(e.job_id!)!.location
      const atLoc = [...state].filter(([id, st]) => ACTIVE_JOB_STATES.has(st as never) && where.get(id)!.location === loc).length
      expect(atLoc, `${ctx}: offer at ${loc} exceeds the cap of rollout ${e.rollout_id}`).toBeLessThanOrEqual(caps.get(e.rollout_id) ?? 0)
    }
  }
  // Events never carry a raw lease, verify or reconcile token.
  const text = JSON.stringify(events)
  expect(/"(twin-)?(lease|verify|reconcile)-\d+"/.test(text), `${ctx}: token in events`).toBe(false)
}

const coverage = new Map<string, number>()
async function recordCoverage(w: World): Promise<void> {
  for (const e of await w.store.listEvents()) {
    if (e.type === 'rejected' || e.reason === 'needs_manual_resolution' || e.reason === 'heartbeat') coverage.set(`${e.type}:${e.reason}`, (coverage.get(`${e.type}:${e.reason}`) ?? 0) + 1)
    if (e.type !== 'transition') continue
    const k = `${e.entity}:${e.from}>${e.to}${e.reason === 'reconciled_not_applied' ? ':not_applied' : ''}`
    coverage.set(k, (coverage.get(k) ?? 0) + 1)
  }
}

async function oneRun(seed: number): Promise<void> {
  const rng = seededRandom(seed)
  const locations = int(rng, 1, 3)
  const v7 = { 'ssid.staff.ssid': 'CK-Staff', 'ssid.staff.security': 'wpa2-psk', 'ssid.staff.passphrase_ref': secretRef('vault:wifi/staff', 7) }
  const devices = Array.from({ length: int(rng, 2, 7) }, (_, i) => ({ id: `t${i}`, location: `L${i % locations}`, ...(rng() < 0.15 ? { config: v7 } : {}) }))
  const journal = rng() < 0.7
  const w = createWorld(devices, { offer_lease_ms: 120_000, run_lease_ms: 300_000, reconcile_lease_ms: 120_000, verify_deadline_ms: 900_000, reconcile_backoff_ms: 60_000, max_reconcile_attempts: 3, journal })
  let twinIds = 0
  const twin = new JobEngine({
    store: w.store, clock: w.clock, ids: { next: (p) => `twin-${p}-${++twinIds}` }, env: w.env, adapters: { fake: w.fake.describeCapabilities() },
    offer_lease_ms: 120_000, run_lease_ms: 300_000, reconcile_lease_ms: 120_000, verify_deadline_ms: 900_000, reconcile_backoff_ms: 60_000, max_reconcile_attempts: 3,
  })
  const modes: FaultMode[] = ['lost_response', 'lost_result', 'lost_request', 'fail', 'partial', 'false_success']
  for (const d of devices) {
    if (rng() < 0.35) w.fake.inject({ target_id: d.id, step: 'apply', mode: pick(rng, modes), times: rng() < 0.7 ? 1 : 3 })
    if (rng() < 0.1) w.fake.inject({ target_id: d.id, step: 'reconcile', mode: pick(rng, ['unknown', 'fail'] as const), times: int(rng, 1, 4) })
    if (rng() < 0.1) w.fake.setUnsupported(d.id, ['verify'])
    if (rng() < 0.2) w.fake.setOnline(d.id, false)
  }
  const first = await approvedRollout(w.engine, randomPlan(rng, {}), w.candidates().map((c) => ({ ...c, online: true })))
  const s: RunState = { w, rollouts: [first.id], terminalSeen: new Map(), versions: new Map() }
  let secondCreated = false
  const steps = int(rng, 30, 70)
  for (let i = 0; i < steps; i++) {
    const roll = rng()
    const ids = s.rollouts
    if (roll < 0.45) await w.runner.step()
    else if (roll < 0.52) {
      // Concurrent callers: the runner, a second engine on the same store and parallel targetReturned calls.
      const fence = must(await w.engine.acquireOfferingLease('test', 3_600_000))
      await Promise.all([w.runner.step(), twin.tick(fence), ...devices.slice(0, 3).map((d) => (rng() < 0.5 ? twin : w.engine).targetReturned(d.id, fence))])
    } else if (roll < 0.68) w.clock.advance(int(rng, 0, 400) * 1000)
    else if (roll < 0.74) { const d = pick(rng, devices); w.fake.setOnline(d.id, !w.fake.isOnline(d.id)); if (w.fake.isOnline(d.id)) await w.targetReturned(d.id) }
    else if (roll < 0.76) await w.engine.pause(pick(rng, ids), 'ops', 'random pause')
    else if (roll < 0.79) await w.engine.resume(pick(rng, ids), 'ops', 'random resume')
    else if (roll < 0.8) await w.engine.cancel(pick(rng, ids), 'ops', 'random cancel')
    else if (roll < 0.83) {
      // Environment changes mid-run: policy version, eligibility, base version.
      const what = int(rng, 0, 2)
      if (what === 0) w.env.defaultPolicyVersion = rng() < 0.5 ? 4 : 3
      else if (what === 1) { const d = pick(rng, devices); if (w.env.ineligible.has(d.id)) w.env.ineligible.delete(d.id); else w.env.ineligible.set(d.id, ['enrolment revoked']) }
      else w.env.base.set('profile-staff', rng() < 0.5 ? 8 : 7)
    } else if (roll < 0.86) {
      // Amending after start must fail; before start it voids the approvals (and the amender becomes an author).
      const id = pick(rng, ids)
      const r = (await w.engine.getRollout(id))!
      const actor = pick(rng, ['user-requester', 'other-actor', 'approver-1'])
      const res = await w.engine.amendPlan(id, { ...r.plan, params: { ...(r.plan.params as object), note: `amended ${i}` } }, actor)
      if (['running_canary', 'running_batches', 'verifying', 'paused', 'paused_by_threshold'].includes(r.state)) expect(!res.ok && res.error.code, `seed ${seed}`).toBe('immutable_after_start')
    } else if (roll < 0.9) {
      // Duplicate and forged result deliveries.
      const jobs = await w.engine.listJobs(pick(rng, ids))
      const done = jobs.find((j) => j.last_result && w.runner.deliveredTokens.has(j.id))
      if (done) {
        const before = await w.engine.getJob(done.id)
        const dup = await w.engine.reportResult(done.id, w.runner.deliveredTokens.get(done.id)!, { outcome: done.last_result!.outcome, message: 'dup' })
        expect(dup.ok, `seed ${seed}: duplicate refused`).toBe(true)
        expect((await w.engine.getJob(done.id))!.state).toBe(before!.state)
      }
      const any = jobs[0]
      if (any) {
        const before = await w.engine.getJob(any.id)
        const forged = await w.engine.reportResult(any.id, 'lease-forged', { outcome: 'applied', message: 'forged' })
        expect(forged.ok, `seed ${seed}: forged accepted`).toBe(false)
        expect((await w.engine.getJob(any.id))!.state).toBe(before!.state)
      }
    } else if (!secondCreated) {
      secondCreated = true
      const kind = pick(rng, ['supersede', 'conflict', 'independent'] as const)
      const overrides: Partial<Plan> = kind === 'supersede'
        ? { params: { ssid: 'CK-Staff', security: 'wpa2-psk', passphrase_ref: secretRef('vault:wifi/staff', 8) } }
        : kind === 'conflict'
          ? { supersedes_key: 'wifi:security-hardening', setting_paths: ['ssid.staff.security'], conflict_policy: 'wait', params: { security: 'wpa3-sae' } }
          : { kind: 'wifi.radio.apply', supersedes_key: 'radio', setting_paths: ['radio.channel'], params: { channel: 'auto' }, base_version: null }
      const built = randomPlan(rng, overrides, w.clock.now())
      // Written against the versions current now (they may have moved since the first rollout).
      const plan: Plan = {
        ...built,
        policy_version: w.env.currentPolicyVersion(built.kind),
        base_version: built.base_version ? { key: built.base_version.key, version: w.env.currentBaseVersion(built.base_version.key) ?? 7 } : null,
      }
      const second = await approvedRollout(w.engine, plan, w.candidates().map((c) => ({ ...c, online: true })))
      s.rollouts.push(second.id)
    }
    await checkInvariants(s, seed, `step ${i}`)
  }

  // Heal the world and let everything finish (liveness).
  w.fake.clearFaults()
  w.env.defaultPolicyVersion = 3
  w.env.ineligible.clear()
  w.env.base.set('profile-staff', 7)
  for (const d of devices) w.fake.setOnline(d.id, true)
  for (let i = 0; i < 400; i++) {
    await w.runner.step()
    w.clock.advance(60_000)
    for (const r of await w.engine.listOpenRollouts()) if (r.state === 'paused_by_threshold' || r.state === 'paused') await w.engine.resume(r.id, 'ops', 'heal')
    // Jobs that gave up on automatic reconciliation are settled by a person.
    for (const j of await w.engine.jobsInStates(['unknown'])) if (j.needs_manual) await w.engine.resolveManually(j.id, 'ops', 'checked by hand')
    // A rollout written against a policy or configuration version that is no longer current never runs: a person cancels it.
    for (const j of await w.engine.jobsInStates(['blocked'])) {
      if (j.blocked_reason === 'policy_changed' || j.blocked_reason === 'stale_configuration_version') await w.engine.cancel(j.rollout_id, 'ops', 'written against an old version')
    }
    const open = (await w.engine.listOpenRollouts()).filter((r) => s.rollouts.includes(r.id))
    const jobsOpen = (await Promise.all(s.rollouts.map((id) => w.engine.listJobs(id)))).flat().filter((j) => !isTerminalJob(j.state))
    if (open.every((r) => r.state === 'draft') && jobsOpen.length === 0) break
  }
  await checkInvariants(s, seed, 'end')
  for (const id of s.rollouts) {
    const r = (await w.engine.getRollout(id))!
    if (r.state !== 'draft') {
      const detail = (await w.engine.listJobs(id)).map((j) => `${j.target_id}:${j.state}:${j.blocked_reason ?? ''}:${j.waiting_reason ?? ''}`).join(', ')
      expect(isTerminalRollout(r.state), `seed ${seed}: rollout ${id} still ${r.state} (${detail})`).toBe(true)
    }
    for (const j of await w.engine.listJobs(id)) expect(isTerminalJob(j.state), `seed ${seed}: job ${j.id} still ${j.state}`).toBe(true)
  }
  await checkLog(s, seed)
  await recordCoverage(w)
}

describe('property: random worlds keep the invariants', () => {
  it(`holds for ${RUNS} seeded runs`, { timeout: 900_000 }, async () => {
    for (let seed = 1; seed <= RUNS; seed++) await oneRun(seed)
    const reached = [
      'job:offered>unknown', 'job:acked>unknown', 'job:acked>running', 'job:running>verifying', 'job:running>failed', 'job:running>partially_applied',
      'job:unknown>reconciling', 'job:reconciling>verifying', 'job:reconciling>queued:not_applied', 'job:reconciling>unknown',
      'job:queued>superseded', 'job:queued>already_satisfied', 'job:queued>blocked', 'job:blocked>offered', 'job:verifying>verification_failed',
      'job:verifying>accepted_but_not_verified', 'job:queued>cancelled', 'job:queued>expired', 'job:unknown>resolved_manually',
      'rollout:running_batches>paused_by_threshold', 'rollout:running_canary>paused_by_threshold', 'rollout:verifying>partially_failed',
      'rejected:stale_lease', 'recorded:heartbeat', 'recorded:needs_manual_resolution',
    ]
    if (RUNS >= 300) for (const k of reached) expect(coverage.get(k) ?? 0, `path never reached: ${k}`).toBeGreaterThan(0)
  })
})
