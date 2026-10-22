// Deterministic helpers for tests and local simulations: a controllable clock, sequential ids,
// a seeded random generator and a plan builder. Nothing here reads real time or real randomness.
// Test-only: application code must not import it (ESLint no-restricted-imports).
import type { AdapterCapabilities } from './adapter'
import type { Clock, IdGenerator } from './engine-deps'
import { JobEngine, type EngineEnvironment, type EngineOptions, type RevalidationDecision, type TickReport } from './engine'
import { sha256Hex, type JsonValue } from './canonical'
import { FakeAdapter, fakeCapabilities } from './fake-adapter'
import { RolloutRunner } from './runner'
import { InMemoryJobStore } from './store'
import type { Fence, JobEvent, OfferedJob, Outcome, Plan, Rollout, SecretRef, TargetCandidate } from './types'

/** Capabilities of the fake Wi-Fi adapter used in tests. */
export const FAKE_CAPABILITIES: AdapterCapabilities = fakeCapabilities()

/** A versioned secret reference with a deterministic fingerprint (tests only; real fingerprints come from the vault). */
export function secretRef(ref: string, version: number): SecretRef {
  return { ref, version, fingerprint: sha256Hex(`${ref}#${version}`) }
}

/** A mutable environment: tests switch targets online/offline, bump policy and base versions, mark targets ineligible or already satisfied. */
export class TestEnvironment implements EngineEnvironment {
  readonly online = new Set<string>()
  readonly policy = new Map<string, number>()
  readonly base = new Map<string, number>()
  readonly ineligible = new Map<string, string[]>()
  readonly satisfied = new Set<string>()
  /** Called by desiredState when set, instead of the `satisfied` set. */
  desiredStateProbe: ((targetId: string, plan: Plan) => Promise<'satisfied' | 'not_satisfied' | 'unknown'>) | null = null
  defaultPolicyVersion = 3

  /** Called by isOnline when set, instead of the `online` set. */
  isOnlineProbe: ((targetId: string) => boolean) | null = null

  constructor() {
    this.base.set('profile-staff', 7)
  }

  currentPolicyVersion(kind: string): number {
    return this.policy.get(kind) ?? this.defaultPolicyVersion
  }
  currentBaseVersion(key: string): number | null {
    return this.base.get(key) ?? null
  }
  isOnline(targetId: string): boolean {
    return this.isOnlineProbe ? this.isOnlineProbe(targetId) : this.online.has(targetId)
  }
  async eligibility(targetId: string): Promise<{ eligible: boolean; reasons: string[] }> {
    const reasons = this.ineligible.get(targetId)
    return reasons ? { eligible: false, reasons } : { eligible: true, reasons: [] }
  }
  async desiredState(targetId: string, _locationId: string, plan: Plan): Promise<'satisfied' | 'not_satisfied' | 'unknown'> {
    if (this.desiredStateProbe) return this.desiredStateProbe(targetId, plan)
    return this.satisfied.has(targetId) ? 'satisfied' : 'not_satisfied'
  }
}

export interface EngineSetup {
  engine: JobEngine
  store: InMemoryJobStore
  clock: FakeClock
  env: TestEnvironment
  /** The test's offering lease (holder "test"), renewed on every call. */
  fence(): Promise<Fence>
  /** engine.tick with the test's fence. */
  tick(): Promise<TickReport>
  /** engine.targetReturned with the test's fence. */
  targetReturned(targetId: string): Promise<{ decisions: { job_id: string; decision: RevalidationDecision }[]; offered: OfferedJob[] }>
}

/** An engine over an in-memory store with a fake clock, sequential ids and the test environment. */
export function setupEngine(options: Partial<Omit<EngineOptions, 'store' | 'clock' | 'ids' | 'env'>> & { clock?: FakeClock; store?: InMemoryJobStore } = {}): EngineSetup {
  const clock = options.clock ?? new FakeClock()
  const store = options.store ?? new InMemoryJobStore()
  const env = new TestEnvironment()
  const engine = new JobEngine({ adapters: { fake: FAKE_CAPABILITIES }, ...options, store, clock, ids: sequentialIds(), env })
  const fence = async () => must(await engine.acquireOfferingLease('test', 3_600_000))
  return {
    engine, store, clock, env, fence,
    tick: async () => engine.tick(await fence()),
    targetReturned: async (id) => engine.targetReturned(id, await fence()),
  }
}

/** Unwraps an Outcome in a test, failing loudly with the error. */
export function must<T>(o: Outcome<T>): T {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`)
  return o.value
}

/**
 * Takes a plan through create, validate, resolve, submit, the approvals it needs and schedule.
 * `approvers` default to one approver for medium risk and two for high.
 */
export async function approvedRollout(engine: JobEngine, plan: Plan, candidates: TargetCandidate[], approvers: string[] = ['approver-1', 'approver-2']): Promise<Rollout> {
  const r = must(await engine.createRollout({ title: 'test rollout', plan, actor: plan.requested_by }))
  must(await engine.validate(r.id, plan.requested_by))
  must(await engine.resolveTargets(r.id, candidates, plan.requested_by))
  let cur = must(await engine.submit(r.id, plan.requested_by))
  for (const a of approvers) {
    if (cur.state !== 'pending_approval') break
    cur = must(await engine.approve(r.id, { approver: a, subject: cur.approval_subject as string, acknowledged_impact: true }))
  }
  return must(await engine.schedule(r.id, plan.requested_by))
}

export interface World extends EngineSetup {
  fake: FakeAdapter
  runner: RolloutRunner
  /** Candidates for every fake device (online flag from the fake). */
  candidates(filter?: (targetId: string, locationId: string) => boolean): TargetCandidate[]
  locations: Map<string, string>
}

/**
 * Engine + fake adapter + runner wired together: presence comes from the fake devices, the "already satisfied"
 * check re-reads the fake device. Devices start online with the old staff profile.
 */
export function createWorld(devices: { id: string; location: string; config?: Record<string, JsonValue> }[], options: Partial<Omit<EngineOptions, 'store' | 'clock' | 'ids' | 'env'>> & { latency_ms?: number; fakeCapabilities?: Partial<AdapterCapabilities>; journal?: boolean } = {}): World {
  const clock = new FakeClock()
  const fake = new FakeAdapter({ clock, latency_ms: options.latency_ms, capabilities: options.fakeCapabilities, journal: options.journal })
  const s = setupEngine({ ...options, adapters: { fake: fake.describeCapabilities() }, clock })
  const locations = new Map<string, string>()
  for (const d of devices) {
    fake.addDevice(d.id, d.location, d.config ?? { 'ssid.staff.ssid': 'CK-Staff', 'ssid.staff.security': 'wpa2-psk', 'ssid.staff.passphrase_ref': secretRef('vault:wifi/staff', 6) as unknown as JsonValue })
    locations.set(d.id, d.location)
  }
  s.env.isOnlineProbe = (id) => fake.isOnline(id)
  s.env.desiredStateProbe = async (id, plan) => {
    // The "already satisfied" probe is a read-back: not available when the adapter cannot verify.
    if (!fake.describeCapabilities().operations.verify) return 'unknown'
    const v = await fake.verify({ target_id: id, location_id: locations.get(id) ?? '' }, plan)
    return v.outcome === 'match' ? 'satisfied' : v.outcome === 'mismatch' ? 'not_satisfied' : 'unknown'
  }
  // Same lease holder as the test helpers, so tests can mix runner steps with direct targetReturned calls.
  const runner = new RolloutRunner(s.engine, { fake }, 'test')
  return {
    ...s,
    fake,
    runner,
    locations,
    candidates: (filter) =>
      devices.filter((d) => !filter || filter(d.id, d.location)).map((d) => makeCandidate(d.id, d.location, { online: fake.isOnline(d.id) })),
  }
}

export interface EventAnalysis {
  /** Problems with the log itself: gaps in seq, time going back, a transition whose "from" is not the previous "to". */
  problems: string[]
  maxActivePerTarget: Map<string, number>
  maxActivePerLocation: Map<string, number>
  maxActivePerRollout: Map<string, number>
  /** State of every job and rollout after replaying the log. */
  jobStates: Map<string, string>
  rolloutStates: Map<string, string>
  /** For each job, the ordered list of transitions "from>to:reason". */
  history: Map<string, string[]>
}

const ACTIVE = new Set(['offered', 'acked', 'running', 'verifying', 'unknown', 'reconciling'])

/**
 * Replays the event log: checks it is complete and consistent, and measures how many jobs were active at once.
 * Events name targets, not locations, so pass the location of each target to get per-location maxima.
 */
export function analyseEvents(events: JobEvent[], locationOf: Map<string, string> = new Map()): EventAnalysis {
  const a: EventAnalysis = {
    problems: [], maxActivePerTarget: new Map(), maxActivePerLocation: new Map(), maxActivePerRollout: new Map(),
    jobStates: new Map(), rolloutStates: new Map(), history: new Map(),
  }
  const jobInfo = new Map<string, { target: string; rollout: string; location: string }>()
  let lastSeq = 0
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, Math.max(m.get(k) ?? 0, v))
  // The order is the sequence number, not the wall time (writers' clocks may differ).
  for (const e of events) {
    if (e.seq !== lastSeq + 1) a.problems.push(`seq ${e.seq} after ${lastSeq}`)
    lastSeq = e.seq
    if (e.type !== 'transition') continue
    if (e.entity === 'rollout') {
      const prev = a.rolloutStates.get(e.rollout_id) ?? null
      if (prev !== e.from) a.problems.push(`rollout ${e.rollout_id}: from ${e.from} but was ${prev} (seq ${e.seq})`)
      a.rolloutStates.set(e.rollout_id, e.to as string)
      continue
    }
    const id = e.job_id as string
    const prev = a.jobStates.get(id) ?? null
    if (prev !== e.from) a.problems.push(`job ${id}: from ${e.from} but was ${prev} (seq ${e.seq})`)
    a.jobStates.set(id, e.to as string)
    const h = a.history.get(id) ?? []
    h.push(`${e.from}>${e.to}:${e.reason}`)
    a.history.set(id, h)
    if (!jobInfo.has(id)) jobInfo.set(id, { target: e.target_id as string, rollout: e.rollout_id, location: locationOf.get(e.target_id as string) ?? '?' })
    // Count after every transition.
    const perTarget = new Map<string, number>()
    const perRollout = new Map<string, number>()
    const perLocation = new Map<string, number>()
    for (const [jid, st] of a.jobStates) {
      if (!ACTIVE.has(st)) continue
      const info = jobInfo.get(jid)!
      perTarget.set(info.target, (perTarget.get(info.target) ?? 0) + 1)
      perRollout.set(info.rollout, (perRollout.get(info.rollout) ?? 0) + 1)
      perLocation.set(info.location, (perLocation.get(info.location) ?? 0) + 1)
    }
    for (const [k, v] of perTarget) bump(a.maxActivePerTarget, k, v)
    for (const [k, v] of perRollout) bump(a.maxActivePerRollout, k, v)
    for (const [k, v] of perLocation) bump(a.maxActivePerLocation, k, v)
  }
  return a
}

export function makeCandidate(target_id: string, location_id: string, overrides: Partial<TargetCandidate> = {}): TargetCandidate {
  return {
    target_id,
    location_id,
    model: 'WAX615',
    firmware: '10.8.3.1',
    capabilities: ['ssid.write', 'mac_acl.write'],
    compatible: true,
    incompatibility_reasons: [],
    online: true,
    preflight_issues: [],
    impact: { disruption: 'brief', reboot_required: false, reconnect_required: true, estimated_downtime_s: 20, notes: ['Clients reconnect to the staff network.'] },
    ...overrides,
  }
}

export class FakeClock implements Clock {
  private t: number
  constructor(start: number | string = '2026-11-02T04:30:00Z') {
    this.t = typeof start === 'string' ? Date.parse(start) : start
  }
  now(): number {
    return this.t
  }
  advance(ms: number): number {
    if (ms < 0) throw new Error('a clock does not go back')
    this.t += ms
    return this.t
  }
  set(at: number | string): void {
    const v = typeof at === 'string' ? Date.parse(at) : at
    if (v < this.t) throw new Error('a clock does not go back')
    this.t = v
  }
}

export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>()
  return {
    next(prefix: string): string {
      const n = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, n)
      return `${prefix}-${n}`
    },
  }
}

/** mulberry32: small, fast, seeded. Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SHA = 'a'.repeat(64)

/** A valid plan for a fake staff-SSID passphrase change; override any field. */
export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    kind: 'wifi.profile.apply',
    adapter: 'fake',
    adapter_version: '1.0.0',
    artifact: { id: 'profile-staff', version: '7', sha256: SHA },
    params: { ssid: 'CK-Staff', security: 'wpa2-psk', passphrase_ref: secretRef('vault:wifi/staff', 7) as unknown as JsonValue },
    policy_version: 3,
    target_selector: { location_ids: ['store-1'] },
    base_version: { key: 'profile-staff', version: 7 },
    supersedes_key: 'wifi:profile:staff',
    setting_paths: ['ssid.staff'],
    conflict_policy: 'reject',
    schedule: { not_before: '2026-11-02T04:30:00Z', window: null },
    expires_at: '2026-11-09T04:30:00Z',
    canary: { mode: 'first_n', count: 1, soak_ms: 60_000 },
    batch: { batch_size: 2, global_concurrency: 2, per_location_concurrency: 1, block_location_on_unknown: true, batch_soak_ms: 0 },
    thresholds: { stop_after_failures: 2, stop_after_failure_pct: 50, pct_min_finished: 4, stop_after_consecutive_failures: 2 },
    max_attempts: 2,
    risk: 'medium',
    requested_by: 'user-requester',
    ...overrides,
  }
}
