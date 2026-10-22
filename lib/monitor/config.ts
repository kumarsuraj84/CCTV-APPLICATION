import type { MonitorConfig } from '@/lib/monitor/types'

const DAY_SEC = 86_400

/** A whole number from the environment, or undefined when it is not set, empty or not a whole number. */
function whole(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

// Not a whole number: the default. A whole number outside the allowed range is pulled to the nearest limit.
const interval = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = whole(v)
  return n === undefined ? fallback : Math.min(max, Math.max(min, n))
}

export function loadMonitorConfig(env: Record<string, string | undefined> = process.env): MonitorConfig {
  const threshold = whole(env.FAIL_THRESHOLD)
  return {
    deviceCheckSec: interval(env.DEVICE_CHECK_SEC, 60, 10, DAY_SEC),
    cameraCheckSec: interval(env.CAMERA_CHECK_SEC, 300, 10, DAY_SEC),
    pollSec: 5,
    // Zero or negative makes no sense and is ignored (default 2); more than 10 is pulled down to 10.
    failThreshold: threshold !== undefined && threshold >= 1 ? Math.min(10, threshold) : 2,
    deviceConcurrency: 50,
    // How many recorders (NVRs) are checked at the same time (each uses its own connections). P2-5b: RECORDER_CONCURRENCY; the old
    // name STORE_CONCURRENCY is still accepted when the new one is not set.
    recorderConcurrency: interval(whole(env.RECORDER_CONCURRENCY) === undefined ? env.STORE_CONCURRENCY : env.RECORDER_CONCURRENCY, 10, 1, 50),
    rtspPerRecorder: 4,
    tcpTimeoutMs: 3000,
    nvrTimeoutMs: 8000,
    nvrLoginBackoffSec: interval(env.NVR_LOGIN_BACKOFF_SEC, 900, 60, DAY_SEC),
  }
}
