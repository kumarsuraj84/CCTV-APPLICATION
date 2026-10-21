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

  async loadDevices() { return this.devices }
  async loadNvrs() { return this.nvrs }
  async loadStoreJobs(ids?: string[]) { return ids ? this.stores.filter((s) => ids.includes(s.id)) : this.stores }
  async applyResults(orgId: string, results: CheckResult[], threshold: number) { this.applied.push({ orgId, results, threshold }) }
  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]) { this.ipsSaved.push({ orgId, rows }) }
  async touchHeartbeat(now: Date) { this.heartbeats.push(now) }
  async recordStartupGap() { return this.gapRecorded }
  async readRequest() { return this.request }
  async markRunStarted(at: Date, total: number) { this.started.push({ at, total }); this.request = { ...this.request, runStartedAt: at } }
  async markProgress(done: number, total: number) { this.progress.push([done, total]) }
  async markRunFinished(at: Date) { this.finished.push(at) }
  results() { return this.applied.flatMap((a) => a.results) }
}
