// A scriptable fake adapter (P7-0) for orchestration tests and local demonstrations. It simulates devices with
// a configuration map and a local execution journal keyed by idempotency key. It proves orchestration only;
// it says nothing about how any real device (NETGEAR AP, Windows PC) behaves.
//
// Scriptable: latency (moves the injected clock), failure injection per target and step, lost acknowledgements
// (applied but no response), lost requests, partial application, false success, devices going offline and
// online, state drift, unsupported operations per device, reconcile answering "unknown".
import type {
  AdapterCapabilities,
  AdapterTarget,
  ApplyResponse,
  JobAdapter,
  PreflightResult,
  ReconcileResponse,
  RollbackResult,
  SnapshotResult,
  StopResult,
  VerifyResponse,
} from './adapter'
import type { JsonObject, JsonValue } from './canonical'
import { payloadHash } from './plan'
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
}

const DEFAULT_CAPS: AdapterCapabilities = {
  adapter_id: 'fake',
  maturity: 'fake',
  kinds: {
    'wifi.profile.apply': { required_target_capabilities: ['ssid.write'] },
    'wifi.mac_rule.apply': { required_target_capabilities: ['mac_acl.write'] },
    'desktop.wallpaper': { required_target_capabilities: [] },
  },
  operations: { snapshot: true, rollback: true, stop: false, verify: true, reconcile: true },
}

/** The settings a plan asks for: its parameters flattened under its first setting path. */
export function desiredSettings(plan: Plan): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  const walk = (prefix: string, v: JsonValue) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, inner] of Object.entries(v)) walk(`${prefix}.${k}`, inner)
    } else out[prefix] = v
  }
  walk(plan.setting_paths[0] ?? 'settings', plan.params)
  return out
}

export interface ApplyLogEntry {
  target_id: string
  idempotency_key: string
  payload_hash: string
  at: number
}

export class FakeAdapter implements JobAdapter {
  private readonly devices = new Map<string, Device>()
  private faults: (Fault & { left: number })[] = []
  private readonly snapshots = new Map<string, { target_id: string; config: Record<string, JsonValue> }>()
  private snapCount = 0
  private readonly caps: AdapterCapabilities
  private readonly impact: ImpactEstimate
  /** Every real execution (a repeat of a journalled key is not an execution). */
  readonly applyLog: ApplyLogEntry[] = []

  constructor(private readonly opts: FakeAdapterOptions = {}) {
    this.caps = { ...DEFAULT_CAPS, ...opts.capabilities, operations: { ...DEFAULT_CAPS.operations, ...opts.capabilities?.operations } }
    this.impact = opts.impact ?? { disruption: 'brief', reboot_required: false, reconnect_required: true, estimated_downtime_s: 20, notes: ['Clients reconnect.'] }
  }

  // ---- scripting -----------------------------------------------------------------------------------

  addDevice(targetId: string, locationId: string, config: Record<string, JsonValue> = {}, online = true): void {
    this.devices.set(targetId, { location_id: locationId, online, config: { ...config }, journal: new Map(), executions: 0, unsupported: new Set(), preflight: [], stopRequested: new Set() })
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
    return { ...this.device(targetId).config }
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
    this.wait()
    const issues = [...this.device(target.target_id).preflight]
    if (!this.caps.kinds[plan.kind]) issues.push({ code: 'unsupported_kind', message: `The fake adapter does not perform "${plan.kind}".`, severity: 'blocking' })
    return { issues, impact: this.impact }
  }

  async snapshot(target: AdapterTarget): Promise<SnapshotResult> {
    this.wait()
    const d = this.device(target.target_id)
    if (!this.caps.operations.snapshot || d.unsupported.has('snapshot')) return { status: 'unsupported' }
    if (!d.online || this.fault(target.target_id, 'snapshot') === 'fail') return { status: 'failed', message: 'Device did not answer.' }
    this.snapCount += 1
    const ref = `fake-snapshot-${this.snapCount}`
    this.snapshots.set(ref, { target_id: target.target_id, config: { ...d.config } })
    return { status: 'taken', ref }
  }

  async apply(target: AdapterTarget, plan: Plan, idempotencyKey: string): Promise<ApplyResponse> {
    this.wait()
    const d = this.device(target.target_id)
    if (!d.online) return { delivered: false, reason: 'unreachable' }
    const seen = d.journal.get(idempotencyKey)
    if (seen) return { delivered: true, outcome: seen, message: 'Already done for this job (journal).' }
    if (d.stopRequested.has(idempotencyKey)) {
      d.journal.set(idempotencyKey, 'failed')
      return { delivered: true, outcome: 'failed', message: 'Stopped on request.' }
    }
    const mode = this.fault(target.target_id, 'apply')
    if (mode === 'lost_request') return { delivered: false, reason: 'timeout' }
    if (mode === 'fail') {
      d.journal.set(idempotencyKey, 'failed')
      return { delivered: true, outcome: 'failed', message: 'The device refused the change.' }
    }
    const desired = desiredSettings(plan)
    this.applyLog.push({ target_id: target.target_id, idempotency_key: idempotencyKey, payload_hash: payloadHash(plan), at: this.now() })
    d.executions += 1
    if (mode === 'false_success') {
      d.journal.set(idempotencyKey, 'applied')
      return { delivered: true, outcome: 'applied', message: 'OK' }
    }
    if (mode === 'partial') {
      // Apply every differing setting except the last one, so the result really differs from the desired state.
      const differing = Object.keys(desired).sort().filter((k) => JSON.stringify(d.config[k]) !== JSON.stringify(desired[k]))
      for (const k of differing.slice(0, -1)) d.config[k] = desired[k]
      d.journal.set(idempotencyKey, 'partial')
      return { delivered: true, outcome: 'partial', message: 'Some settings were applied.' }
    }
    Object.assign(d.config, desired)
    d.journal.set(idempotencyKey, 'applied')
    if (mode === 'lost_response') return { delivered: false, reason: 'lost_response' }
    if (mode === 'lost_result') return { delivered: false, reason: 'lost_response', acknowledged: true }
    return { delivered: true, outcome: 'applied', message: 'Applied.' }
  }

  async reconcile(target: AdapterTarget, idempotencyKey: string): Promise<ReconcileResponse> {
    this.wait()
    const d = this.device(target.target_id)
    const mode = d.online ? this.fault(target.target_id, 'reconcile') : null
    if (!d.online || mode === 'fail') return { reachable: false }
    if (mode === 'unknown') return { reachable: true, state: 'unknown' }
    const j = d.journal.get(idempotencyKey)
    return { reachable: true, state: j === 'applied' ? 'applied' : j === 'partial' ? 'partial' : 'not_applied' }
  }

  async verify(target: AdapterTarget, plan: Plan): Promise<VerifyResponse> {
    this.wait()
    const d = this.device(target.target_id)
    const desired = desiredSettings(plan)
    const expected = redactDetails(desired as JsonObject)
    if (!this.caps.operations.verify || d.unsupported.has('verify')) return { outcome: 'unsupported', expected, observed: {} }
    if (!d.online || this.fault(target.target_id, 'verify') === 'fail') return { outcome: 'inconclusive', expected, observed: {} }
    const observedRaw: JsonObject = {}
    for (const k of Object.keys(desired)) if (k in d.config) observedRaw[k] = d.config[k]
    const match = Object.keys(desired).every((k) => JSON.stringify(d.config[k]) === JSON.stringify(desired[k]))
    return { outcome: match ? 'match' : 'mismatch', expected, observed: redactDetails(observedRaw) }
  }

  async rollback(target: AdapterTarget, snapshotRef: string): Promise<RollbackResult> {
    this.wait()
    const d = this.device(target.target_id)
    if (!this.caps.operations.rollback || d.unsupported.has('rollback')) return { status: 'unsupported' }
    const snap = this.snapshots.get(snapshotRef)
    if (!d.online || !snap || snap.target_id !== target.target_id) return { status: 'failed' }
    d.config = { ...snap.config }
    return { status: 'restored' }
  }

  async stop(target: AdapterTarget, idempotencyKey: string): Promise<StopResult> {
    this.wait()
    const d = this.device(target.target_id)
    if (!this.caps.operations.stop || d.unsupported.has('stop')) return { status: 'unsupported' }
    d.stopRequested.add(idempotencyKey)
    return { status: 'stopping' }
  }

  // ---- internals -----------------------------------------------------------------------------------

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
