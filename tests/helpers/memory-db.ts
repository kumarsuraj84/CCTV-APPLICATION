import { isNvrKnownDown } from '@/lib/monitor/nvr-state'
import { registerEndpoints } from '@/lib/security/targets'
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, RecorderJob, WorkerRequest } from '@/lib/monitor/types'

/** In-memory MonitorDb: remembers every call so tests can look at what the checks decided. */
export class MemoryDb implements MonitorDb {
  devices: DeviceJob[] = []
  nvrs: NvrJob[] = []
  /** P2-5b: one job per recorder (NVR), with only the cameras mapped to it. */
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
    // Like the real data layer: whether the NVR is known to be down is decided here, once.
    return jobs.map((s) => ({ ...s, knownDown: isNvrKnownDown(s.nvr_status, s.nvr_checked_at, staleBefore) }))
  }
  private pick(ids?: string[]) { return ids ? this.recorders.filter((s) => ids.includes(s.id)) : this.recorders }
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
}
