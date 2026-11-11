import { createHash } from 'node:crypto'
import { isNvrKnownDown } from '@/lib/monitor/nvr-state'
import { decideLogin, reportLogin, type LoginGate, type LoginOutcome, type LoginState } from '@/lib/nvr/login-policy'
import { registerEndpoints } from '@/lib/security/targets'
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, RecorderJob, WorkerRequest } from '@/lib/monitor/types'

/** In-memory MonitorDb: remembers every call so tests can look at what the checks decided. */
export class MemoryDb implements MonitorDb {
  devices: DeviceJob[] = []
  nvrs: NvrJob[] = []
  /** P2-5b: one job per recorder (NVR), with only the cameras mapped to it. Its `password` is the saved one (read through readPassword). */
  recorders: RecorderJob[] = []
  applied: { orgId: string; results: CheckResult[]; threshold: number }[] = []
  ipsSaved: { orgId: string; rows: { cameraId: string; ip: string }[] }[] = []
  heartbeats: Date[] = []
  request: WorkerRequest = { requestedAt: null, runStartedAt: null }
  started: { at: Date; total: number }[] = []
  progress: [number, number][] = []
  finished: Date[] = []
  gapRecorded = false
  gaps: { from: Date; to: Date }[] = []
  rounds: { kind: 'devices' | 'cameras'; at: Date }[] = []
  staleBefore: (Date | undefined)[] = []
  /**
   * Final fix X: the shared NVR login state, by the same rules as the database (lib/nvr/login-policy.ts). It lives in this object like
   * in the database: a new runner (a restart, a new lease epoch) on the same MemoryDb sees it.
   */
  logins = new Map<string, LoginState>()
  loginReports: { recorderId: string; outcome: LoginOutcome }[] = []
  passwordReads: string[] = []

  // Like the real data layer (P2-6, lib/monitor/supabase-db.ts): what is read is a registered endpoint (lib/security/targets.ts), so the
  // real probes may reach it and nothing else.
  async loadDevices() {
    registerEndpoints(this.devices.map((d) => ({ host: d.ip, port: d.tcp_port })))
    return this.devices
  }
  async loadNvrs() {
    registerEndpoints(this.nvrs.map((n) => ({ host: n.ip, port: n.rtsp_port })))
    return this.nvrs
  }
  async loadRecorderJobs(ids?: string[], staleBefore?: Date) {
    this.staleBefore.push(staleBefore)
    const jobs = this.pick(ids)
    registerEndpoints(jobs.flatMap((s) => [{ host: s.ip, port: s.http_port }, { host: s.ip, port: s.rtsp_port }]))
    // Like the real data layer: whether the NVR is known to be down is decided here, once; no password is read here any more.
    return jobs.map((s) => ({ ...s, password: '', knownDown: isNvrKnownDown(s.nvr_status, s.nvr_checked_at, staleBefore) }))
  }
  private pick(ids?: string[]) { return ids ? this.recorders.filter((s) => ids.includes(s.id)) : this.recorders }
  /** The saved login of a recorder, as the database's nvr_login_version (null: no password saved). */
  version(id: string): string | null {
    const r = this.recorders.find((x) => x.id === id)
    if (!r || r.password === '') return null
    return createHash('md5').update(`${r.ip}|${r.http_port}|${r.rtsp_port}|${r.username}|${r.password}`).digest('hex')
  }
  async loginGate(ids: string[], o: { claim: boolean; now: number }) {
    const out = new Map<string, LoginGate>()
    for (const id of [...new Set(ids)].sort()) {
      if (!this.recorders.some((r) => r.id === id)) continue
      const r = decideLogin(this.logins.get(id), this.version(id), o.now, { claim: o.claim })
      if (r.state) this.logins.set(id, r.state)
      out.set(id, r.gate)
    }
    return out
  }
  async reportLogin(id: string, version: string, outcome: LoginOutcome, now: number, cfg: { baseSec: number; maxSec: number }) {
    this.loginReports.push({ recorderId: id, outcome })
    const r = reportLogin(this.logins.get(id), this.version(id), version, outcome, now, cfg)
    if (r.state) this.logins.set(id, r.state)
  }
  async readPassword(id: string, version: string) {
    this.passwordReads.push(id)
    if (this.version(id) !== version) return null
    return this.recorders.find((r) => r.id === id)?.password || null
  }
  async recordGap(from: Date, to: Date) { this.gaps.push({ from, to }) }
  async markRound(kind: 'devices' | 'cameras', at: Date) { this.rounds.push({ kind, at }) }
  async applyResults(orgId: string, results: CheckResult[], threshold: number) { this.applied.push({ orgId, results, threshold }) }
  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string; recorderId: string }[]) { this.ipsSaved.push({ orgId, rows }) }
  async touchHeartbeat(now: Date) { this.heartbeats.push(now) }
  async recordStartupGap(now?: Date, maxSilenceMs?: number) { void now; void maxSilenceMs; return this.gapRecorded }
  async readRequest() { return this.request }
  async markRunStarted(at: Date, total: number) { this.started.push({ at, total }); this.request = { ...this.request, runStartedAt: at, runFinishedAt: null } }
  async markProgress(done: number, total: number) { this.progress.push([done, total]) }
  async markRunFinished(at: Date) { this.finished.push(at); this.request = { ...this.request, runFinishedAt: at } }
  results() { return this.applied.flatMap((a) => a.results) }
  /** Test helper: every NVR's login counts as proven already (an estate that was running before; no staggered start). */
  provenAll(now: number) {
    for (const r of this.recorders) {
      const v = this.version(r.id)
      if (v) this.logins.set(r.id, { ...reportLogin(undefined, v, v, 'ok', now).state! })
    }
  }
}
