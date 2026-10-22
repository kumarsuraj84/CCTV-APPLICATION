// A scriptable fake adapter (P7-0) for orchestration tests and local demonstrations. It simulates devices with
// a configuration map and, by default, a local execution journal keyed by idempotency key. It proves
// orchestration only; it says nothing about how any real device (NETGEAR AP, Windows PC) behaves.
// Test-only: application code must not import it (ESLint no-restricted-imports).
//
// Scriptable: latency (moves the injected clock), failure injection per target and step, lost acknowledgements
// (applied but no response), lost results after receipt, lost requests, partial application, false success,
// devices going offline and online, state drift, unsupported operations per device, reconcile answering
// "unknown" or "unsupported", and devices WITHOUT a journal (a repeated key executes again).
import type {
  AdapterCapabilities,
  AdapterTarget,
  ApplyResponse,
  ExecutionHashes,
  JobAdapter,
  PreflightResult,
  ReconcileResponse,
  RollbackResult,
  SnapshotResult,
  StopResult,
  VerifyResponse,
} from './adapter'
import { canonicalize, sha256Hex, type JsonObject, type JsonValue } from './canonical'
import { isSecretRef, payloadHash } from './plan'
import { RESTORE_KIND } from './recovery'
import { redactDetails } from './redact'
import type { ImpactEstimate, Plan, PreflightIssue } from './types'

export type FaultStep = 'apply' | 'reconcile' | 'verify' | 'snapshot'
export type FaultMode =
  /** apply: delivered failure, nothing changed; verify: inconclusive; snapshot: failed; reconcile: unreachable. */
  | 'fail'
  /** apply: the device applies the change, but the response is lost (lost acknowledgement). */
  | 'lost_response'
  /** apply: the device confirms receipt and applies, then the result is lost. */
  | 'lost_result'
  /** apply: the request never reaches the device (nothing applied, no response). */
  | 'lost_request'
  /** apply: some settings applied, reported as partial. */
  | 'partial'
  /** apply: the device says "applied" but changes nothing. */
  | 'false_success'
  /** reconcile: the device cannot say. */
  | 'unknown'
  /** reconcile: the device cannot answer reconcile requests at all. */
  | 'unsupported'

export interface Fault {
  target_id: string | '*'
  step: FaultStep
  mode: FaultMode
  /** How many times the fault fires (default: until removed). */
  times?: number
}

type Unsupported = 'snapshot' | 'verify' | 'rollback' | 'stop'

interface Device {
  location_id: string
  online: boolean
  config: Record<string, JsonValue>
  journal: Map<string, 'applied' | 'partial' | 'failed'>
  /** Plans received per key (what the hub sent), for read-back reconciliation on devices without a journal. */
  received: Map<string, Plan>
  executions: number
  unsupported: Set<Unsupported>
  preflight: PreflightIssue[]
  stopRequested: Set<string>
}

export interface FakeAdapterOptions {
  /** Anything with advance(ms): the fake clock. Latency moves it; nothing waits for real time. */
  clock?: { now(): number; advance?(ms: number): number | void }
  latency_ms?: number
  capabilities?: Partial<AdapterCapabilities>
  impact?: ImpactEstimate
  /** false: devices keep no execution journal (a repeated idempotency key executes again; reconcile reads back). */
  journal?: boolean
}

/** Where each fake kind writes its settings. */
const KIND_PREFIX: Record<string, string> = {
  'wifi.profile.apply': 'ssid.staff',
  'wifi.mac_rule.apply': 'mac_acl.staff',
  'wifi.radio.apply': 'radio',
  'desktop.wallpaper': 'desktop.wallpaper',
}

function restoreParams(plan: Plan): { restores: { target_id: string; snapshot_ref: string }[]; setting_paths: string[] } {
  const p = (plan.params ?? {}) as { restores?: { target_id: string; snapshot_ref: string }[]; setting_paths?: string[] }
  return { restores: p.restores ?? [], setting_paths: p.setting_paths ?? [] }
}

/** The settings a plan asks for: its parameters flattened under the kind's prefix (versioned secret references are single values). */
export function desiredSettings(plan: Plan): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  const walk = (prefix: string, v: JsonValue) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !isSecretRef(v)) {
      for (const [k, inner] of Object.entries(v)) walk(`${prefix}.${k}`, inner)
    } else out[prefix] = v
  }
  walk(Object.hasOwn(KIND_PREFIX, plan.kind) ? KIND_PREFIX[plan.kind] : 'settings', plan.params)
  return out
}

export function fakeCapabilities(overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
  return {
    adapter_id: 'fake',
    version: '1.0.0',
    maturity: 'fake',
    kinds: {
      'wifi.profile.apply': { required_target_capabilities: ['ssid.write'] },
      'wifi.mac_rule.apply': { required_target_capabilities: ['mac_acl.write'] },
      'wifi.radio.apply': { required_target_capabilities: [] },
      'desktop.wallpaper': { required_target_capabilities: [] },
      [RESTORE_KIND]: { required_target_capabilities: [], min_risk: 'medium' },
    },
    describeSettingPaths: (plan) => (plan.kind === RESTORE_KIND ? restoreParams(plan).setting_paths : Object.keys(desiredSettings(plan))),
    ...overrides,
    operations: { snapshot: true, rollback: true, stop: false, verify: true, reconcile: true, ...overrides.operations },
  }
}

export interface ApplyLogEntry {
  target_id: string
  idempotency_key: string
  payload_hash: string
  effective_hash: string
  at: number
}

export class FakeAdapter implements JobAdapter {
  private readonly devices = new Map<string, Device>()
  private faults: (Fault & { left: number })[] = []
  private readonly snapshots = new Map<string, { target_id: string; config: Record<string, JsonValue> }>()
  private snapCount = 0
  private readonly caps: AdapterCapabilities
  private readonly impact: ImpactEstimate
  private readonly journal: boolean
  /** Every real execution (with a journal, a repeat of a journalled key is not an execution). */
  readonly applyLog: ApplyLogEntry[] = []
  /** How often each operation was called. */
  readonly calls = { apply: 0, reconcile: 0, verify: 0, snapshot: 0, rollback: 0, stop: 0, preflight: 0 }

  constructor(private readonly opts: FakeAdapterOptions = {}) {
    this.caps = fakeCapabilities(opts.capabilities)
    this.impact = opts.impact ?? { disruption: 'brief', reboot_required: false, reconnect_required: true, estimated_downtime_s: 20, notes: ['Clients reconnect.'] }
    this.journal = opts.journal ?? true
  }

  // ---- scripting -----------------------------------------------------------------------------------

  addDevice(targetId: string, locationId: string, config: Record<string, JsonValue> = {}, online = true): void {
    this.devices.set(targetId, {
      location_id: locationId, online, config: structuredClone(config), journal: new Map(), received: new Map(), executions: 0,
      unsupported: new Set(), preflight: [], stopRequested: new Set(),
    })
  }

  setOnline(targetId: string, online: boolean): void {
    this.device(targetId).online = online
  }

  isOnline(targetId: string): boolean {
    return this.devices.get(targetId)?.online === true
  }

  inject(f: Fault): void {
    this.faults.push({ ...f, left: f.times ?? Infinity })
  }

  clearFaults(targetId?: string): void {
    this.faults = targetId === undefined ? [] : this.faults.filter((f) => f.target_id !== targetId)
  }

  drift(targetId: string, path: string, value: JsonValue): void {
    this.device(targetId).config[path] = value
  }

  setUnsupported(targetId: string, ops: Unsupported[]): void {
    this.device(targetId).unsupported = new Set(ops)
  }

  setPreflightIssues(targetId: string, issues: PreflightIssue[]): void {
    this.device(targetId).preflight = issues
  }

  config(targetId: string): Record<string, JsonValue> {
    return structuredClone(this.device(targetId).config)
  }

  executions(targetId: string): number {
    return this.device(targetId).executions
  }

  journalState(targetId: string, key: string): 'applied' | 'partial' | 'failed' | undefined {
    return this.device(targetId).journal.get(key)
  }

  // ---- adapter interface ---------------------------------------------------------------------------

  describeCapabilities(): AdapterCapabilities {
    return this.caps
  }

  async preflight(target: AdapterTarget, plan: Plan): Promise<PreflightResult> {
    this.calls.preflight += 1
    this.wait()
    const issues = [...this.device(target.target_id).preflight]
    if (!Object.hasOwn(this.caps.kinds, plan.kind)) issues.push({ code: 'unsupported_kind', message: `The fake adapter does not perform "${plan.kind}".`, severity: 'blocking' })
    return { issues, impact: this.impact }
  }

  async snapshot(target: AdapterTarget): Promise<SnapshotResult> {
    this.calls.snapshot += 1
    this.wait()
    const d = this.device(target.target_id)
    if (!this.caps.operations.snapshot || d.unsupported.has('snapshot')) return { status: 'unsupported' }
    if (!d.online || this.fault(target.target_id, 'snapshot') === 'fail') return { status: 'failed', message: 'Device did not answer.' }
    this.snapCount += 1
    const ref = `fake-snapshot-${this.snapCount}`
    this.snapshots.set(ref, { target_id: target.target_id, config: structuredClone(d.config) })
    return { status: 'taken', ref, key_ref: 'fake-kms:snapshots/v1', content_sha256: sha256Hex(canonicalize(d.config)), retain_until: this.now() + 30 * 86_400_000 }
  }

  async apply(target: AdapterTarget, plan: Plan, idempotencyKey: string, hashes: ExecutionHashes): Promise<ApplyResponse> {
    this.calls.apply += 1
    this.wait()
    const d = this.device(target.target_id)
    if (!d.online) return { delivered: false, reason: 'unreachable' }
    if (payloadHash(plan) !== hashes.payload_hash) return { delivered: true, outcome: 'failed', message: 'Refused: the plan does not match the approved payload hash.' }
    const seen = this.journal ? d.journal.get(idempotencyKey) : undefined
    if (seen) return { delivered: true, outcome: seen, message: 'Already done for this job (journal).' }
    if (d.stopRequested.has(idempotencyKey)) {
      d.journal.set(idempotencyKey, 'failed')
      return { delivered: true, outcome: 'failed', message: 'Stopped on request.' }
    }
    const mode = this.fault(target.target_id, 'apply')
    if (mode === 'lost_request') return { delivered: false, reason: 'timeout' }
    d.received.set(idempotencyKey, plan)
    if (mode === 'fail') {
      d.journal.set(idempotencyKey, 'failed')
      return { delivered: true, outcome: 'failed', message: 'The device refused the change.' }
    }
    this.applyLog.push({ target_id: target.target_id, idempotency_key: idempotencyKey, payload_hash: hashes.payload_hash, effective_hash: hashes.effective_hash, at: this.now() })
    d.executions += 1
    const desired = this.desiredFor(target.target_id, plan)
    if (mode === 'false_success') {
      d.journal.set(idempotencyKey, 'applied')
      return { delivered: true, outcome: 'applied', message: 'OK' }
    }
    if (mode === 'partial') {
      // Apply every differing setting except the last one, so the result really differs from the desired state.
      const differing = Object.keys(desired).sort().filter((k) => JSON.stringify(d.config[k]) !== JSON.stringify(desired[k]))
      for (const k of differing.slice(0, -1)) d.config[k] = structuredClone(desired[k])
      d.journal.set(idempotencyKey, 'partial')
      return { delivered: true, outcome: 'partial', message: 'Some settings were applied.' }
    }
    if (plan.kind === RESTORE_KIND) d.config = structuredClone(desired)
    else Object.assign(d.config, structuredClone(desired))
    d.journal.set(idempotencyKey, 'applied')
    if (mode === 'lost_response') return { delivered: false, reason: 'lost_response' }
    if (mode === 'lost_result') return { delivered: false, reason: 'lost_response', acknowledged: true }
    return { delivered: true, outcome: 'applied', message: 'Applied.' }
  }

  async reconcile(target: AdapterTarget, idempotencyKey: string): Promise<ReconcileResponse> {
    this.calls.reconcile += 1
    this.wait()
    const d = this.device(target.target_id)
    const mode = d.online ? this.fault(target.target_id, 'reconcile') : null
    if (!d.online || mode === 'fail') return { reachable: false }
    if (mode === 'unknown') return { reachable: true, state: 'unknown' }
    if (mode === 'unsupported') return { reachable: true, state: 'unsupported' }
    if (!this.journal) {
      // No journal: read back. Applied when the current configuration has what the received plan asked for.
      const plan = d.received.get(idempotencyKey)
      if (!plan) return { reachable: true, state: 'not_applied' }
      const desired = this.desiredFor(target.target_id, plan)
      return { reachable: true, state: Object.keys(desired).every((k) => JSON.stringify(d.config[k]) === JSON.stringify(desired[k])) ? 'applied' : 'not_applied' }
    }
    const j = d.journal.get(idempotencyKey)
    return { reachable: true, state: j === 'applied' ? 'applied' : j === 'partial' ? 'partial' : 'not_applied' }
  }

  async verify(target: AdapterTarget, plan: Plan): Promise<VerifyResponse> {
    this.calls.verify += 1
    this.wait()
    const d = this.device(target.target_id)
    const desired = this.desiredFor(target.target_id, plan)
    const expected = redactDetails(desired as JsonObject)
    if (!this.caps.operations.verify || d.unsupported.has('verify')) return { outcome: 'unsupported', expected, observed: {} }
    if (!d.online || this.fault(target.target_id, 'verify') === 'fail') return { outcome: 'inconclusive', expected, observed: {} }
    const observedRaw: JsonObject = {}
    for (const k of Object.keys(desired)) if (Object.hasOwn(d.config, k)) observedRaw[k] = d.config[k]
    const match = Object.keys(desired).every((k) => JSON.stringify(d.config[k]) === JSON.stringify(desired[k]))
    return { outcome: match ? 'match' : 'mismatch', expected, observed: redactDetails(observedRaw) }
  }

  async rollback(target: AdapterTarget, snapshotRef: string): Promise<RollbackResult> {
    this.calls.rollback += 1
    this.wait()
    const d = this.device(target.target_id)
    if (!this.caps.operations.rollback || d.unsupported.has('rollback')) return { status: 'unsupported' }
    const snap = this.snapshots.get(snapshotRef)
    if (!d.online || !snap || snap.target_id !== target.target_id) return { status: 'failed' }
    d.config = structuredClone(snap.config)
    return { status: 'restored' }
  }

  async stop(target: AdapterTarget, idempotencyKey: string): Promise<StopResult> {
    this.calls.stop += 1
    this.wait()
    const d = this.device(target.target_id)
    if (!this.caps.operations.stop || d.unsupported.has('stop')) return { status: 'unsupported' }
    d.stopRequested.add(idempotencyKey)
    return { status: 'stopping' }
  }

  // ---- internals -----------------------------------------------------------------------------------

  /** Desired settings for one device (a restore plan's desired state is that device's snapshot). */
  private desiredFor(targetId: string, plan: Plan): Record<string, JsonValue> {
    if (plan.kind !== RESTORE_KIND) return desiredSettings(plan)
    const entry = restoreParams(plan).restores.find((r) => r.target_id === targetId)
    const snap = entry ? this.snapshots.get(entry.snapshot_ref) : undefined
    return snap ? structuredClone(snap.config) : {}
  }

  private device(targetId: string): Device {
    const d = this.devices.get(targetId)
    if (!d) throw new Error(`fake adapter: unknown device ${targetId}`)
    return d
  }

  private fault(targetId: string, step: FaultStep): FaultMode | null {
    const f = this.faults.find((x) => x.step === step && (x.target_id === targetId || x.target_id === '*') && x.left > 0)
    if (!f) return null
    f.left -= 1
    return f.mode
  }

  private wait(): void {
    const ms = this.opts.latency_ms ?? 0
    if (ms > 0) this.opts.clock?.advance?.(ms)
  }

  private now(): number {
    return this.opts.clock?.now() ?? 0
  }
}
