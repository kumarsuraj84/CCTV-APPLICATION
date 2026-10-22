import { isNvrKnownDown } from '@/lib/monitor/nvr-state'
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, StoreJob, WorkerRequest } from '@/lib/monitor/types'

/** In-memory MonitorDb: remembers every call so tests can look at what the checks decided. */
export class MemoryDb implements MonitorDb {
  devices: DeviceJob[] = []
  nvrs: NvrJob[] = []
  stores: StoreJob[] = []
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

  async loadDevices() { return this.devices }
  async loadNvrs() { return this.nvrs }
  async loadStoreJobs(ids?: string[], staleBefore?: Date) {
    this.staleBefore.push(staleBefore)
    // Like the real data layer: whether the NVR is known to be down is decided here, once.
    return this.pick(ids).map((s) => ({ ...s, knownDown: isNvrKnownDown(s.nvr_status, s.nvr_checked_at, staleBefore) }))
  }
  private pick(ids?: string[]) { return ids ? this.stores.filter((s) => ids.includes(s.id)) : this.stores }
  async recordGap(from: Date, to: Date) { this.gaps.push({ from, to }) }
  async markRound(kind: 'devices' | 'cameras', at: Date) { this.rounds.push({ kind, at }) }
  async applyResults(orgId: string, results: CheckResult[], threshold: number) { this.applied.push({ orgId, results, threshold }) }
  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]) { this.ipsSaved.push({ orgId, rows }) }
  async touchHeartbeat(now: Date) { this.heartbeats.push(now) }
  async recordStartupGap(now?: Date, maxSilenceMs?: number) { void now; void maxSilenceMs; return this.gapRecorded }
  async readRequest() { return this.request }
  async markRunStarted(at: Date, total: number) { this.started.push({ at, total }); this.request = { ...this.request, runStartedAt: at, runFinishedAt: null } }
  async markProgress(done: number, total: number) { this.progress.push([done, total]) }
  async markRunFinished(at: Date) { this.finished.push(at); this.request = { ...this.request, runFinishedAt: at } }
  results() { return this.applied.flatMap((a) => a.results) }
}
