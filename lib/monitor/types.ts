import type { ProbeResult } from '@/lib/probes'
import type { NvrChannel } from '@/lib/nvr/isapi'
import type { NvrEndpoint } from '@/lib/nvr/client'
import type { RtspTarget } from '@/lib/rtsp/describe'

export type TargetType = 'camera' | 'device' | 'nvr'
export type CheckResult = { type: TargetType; id: string; ok: boolean; at: string; method?: string; error?: string; cause?: 'nvr_down' }
export type DeviceJob = { id: string; org_id: string; ip: string; tcp_port: number | null }
export type NvrJob = { id: string; org_id: string; ip: string; rtsp_port: number }
export type StoreJob = {
  id: string; org_id: string; code: string; ip: string; rtsp_port: number; http_port: number; username: string; password: string
  nvr_status: 'up' | 'down' | 'unknown'
  cameras: { id: string; channel: number; camera_ip: string | null }[]
}
export type WorkerRequest = { requestedAt: Date | null; runStartedAt: Date | null }

export interface MonitorDb {
  loadDevices(): Promise<DeviceJob[]>
  loadNvrs(): Promise<NvrJob[]>
  loadStoreJobs(storeIds?: string[]): Promise<StoreJob[]>
  applyResults(orgId: string, results: CheckResult[], threshold: number): Promise<void>
  saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]): Promise<void>
  touchHeartbeat(now: Date): Promise<void>
  recordStartupGap(now: Date, maxSilenceMs: number): Promise<boolean>
  readRequest(): Promise<WorkerRequest>
  markRunStarted(at: Date, total: number): Promise<void>
  markProgress(done: number, total: number): Promise<void>
  markRunFinished(at: Date): Promise<void>
}

/**
 * rtsp answers with the final RTSP status code of a DESCRIBE (0 = nothing answered): 200 means the camera is live,
 * 401 means it answered but refused the login.
 */
export type Probes = {
  tcp: (host: string, port: number, timeoutMs?: number) => Promise<ProbeResult>
  icmp: (host: string, timeoutMs?: number) => Promise<ProbeResult>
  rtsp: (t: RtspTarget) => Promise<{ code: number }>
  nvr: (ep: NvrEndpoint) => { channelStatus(): Promise<Map<number, boolean>>; channels(): Promise<NvrChannel[]> }
}

export type MonitorConfig = {
  deviceCheckSec: number; cameraCheckSec: number; pollSec: number; failThreshold: number
  deviceConcurrency: number; storeConcurrency: number; rtspPerStore: number; tcpTimeoutMs: number; nvrTimeoutMs: number
}
