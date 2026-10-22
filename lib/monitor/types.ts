import type { ProbeResult } from '@/lib/probes'
import type { NvrChannel } from '@/lib/nvr/isapi'
import type { NvrEndpoint } from '@/lib/nvr/client'
import type { RtspTarget } from '@/lib/rtsp/describe'

// P2-5b: the worker runs on the recorder model. An NVR is a recorder (recorders.id); its results are ('recorder', recorder id). A camera
// is checked through the recorder of its ACTIVE channel mapping only; a camera without one is never probed.
export type TargetType = 'camera' | 'device' | 'recorder'
/**
 * One check result. `recorder` (camera results only): the recorder (NVR) whose round produced it. The database applies a camera result
 * only while the camera is still mapped to that recorder (review M-3: a late result of the camera's previous NVR is ignored).
 */
export type CheckResult = { type: TargetType; id: string; ok: boolean; at: string; method?: string; error?: string; cause?: 'nvr_down'; recorder?: string }
export type DeviceJob = { id: string; org_id: string; ip: string; tcp_port: number | null }
/** One NVR's own reachability check: `id` is the recorder id. */
export type NvrJob = { id: string; org_id: string; location_id: string; ip: string; rtsp_port: number }
/**
 * The cameras of ONE recorder (NVR). A location with three NVRs is three jobs. `id` is the recorder id; `code` is its location's code
 * (for log lines only), `name` the recorder's name. The address, ports, user name and password are this recorder's own.
 */
export type RecorderJob = {
  id: string; org_id: string; location_id: string; code: string; name: string
  ip: string; rtsp_port: number; http_port: number; username: string; password: string
  nvr_status: 'up' | 'down' | 'unknown'
  /** When the NVR's own reachability check last ran (ISO time); null if never. */
  nvr_checked_at: string | null
  /** The NVR is known to be down right now (its "down" is recent enough to trust): its cameras are down for the same reason and its password was not read. Decided once, by the data layer. */
  knownDown: boolean
  /** The cameras whose active mapping is this recorder, with the channel of that mapping. */
  cameras: { id: string; channel: number; camera_ip: string | null }[]
}
export type WorkerRequest = {
  requestedAt: Date | null
  runStartedAt: Date | null
  /** When the last run finished; null while one is unfinished. Optional so that a data layer that does not know it can leave it out. */
  runFinishedAt?: Date | null
}

export interface MonitorDb {
  loadDevices(): Promise<DeviceJob[]>
  /** Every monitored recorder (switched on, asset enabled and not archived, location active): their own TCP check. */
  loadNvrs(): Promise<NvrJob[]>
  /**
   * One job per monitored recorder (optionally only these recorder ids), with the cameras mapped to it. staleBefore: an NVR "down" last
   * checked before this time is out of date. The password of a recorder that is down and not out of date, or that has no cameras, is
   * not read (nothing needs it) and comes back as ''.
   */
  loadRecorderJobs(recorderIds?: string[], staleBefore?: Date): Promise<RecorderJob[]>
  applyResults(orgId: string, results: CheckResult[], threshold: number): Promise<void>
  /** Camera addresses an NVR reported; `recorderId` is that NVR: an address is saved only while the camera is still mapped to it. */
  saveCameraIps(orgId: string, rows: { cameraId: string; ip: string; recorderId: string }[]): Promise<void>
  touchHeartbeat(now: Date): Promise<void>
  /** Remembers a period when the worker was not running (it is left out of uptime). */
  recordGap(from: Date, to: Date): Promise<void>
  /** Remembers when a scheduled round of this kind (devices and NVRs, or cameras) last finished. */
  markRound(kind: 'devices' | 'cameras', at: Date): Promise<void>
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
  nvr: (ep: NvrEndpoint, opts?: { timeoutMs?: number }) => { channelStatus(): Promise<Map<number, boolean>>; channels(): Promise<NvrChannel[]> }
}

export type MonitorConfig = {
  deviceCheckSec: number; cameraCheckSec: number; pollSec: number; failThreshold: number
  /** How many recorders (NVRs) are checked at the same time; RTSP checks per recorder. */
  deviceConcurrency: number; recorderConcurrency: number; rtspPerRecorder: number; tcpTimeoutMs: number; nvrTimeoutMs: number
  /** After an NVR refuses the login, it is left alone for this long (seconds), so a wrong password cannot lock the account. */
  nvrLoginBackoffSec: number
}
