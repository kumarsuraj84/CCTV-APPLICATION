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

// Final fix X (release 1 review C, "safe defaults at 216 NVRs"; ruling NB-5): the defaults below are the reviewed politeness settings for
// the real estate (216 NVRs, about 4,630 cameras): devices and NVR reachability every 60 s (50 at a time, 3 s TCP timeout), cameras every
// 300 s with 10 NVRs at a time and at most 4 video checks per NVR (8 s NVR timeout, 5 s RTSP timeout), one lane per NVR, an NVR called
// down after 3 failed reachability checks (cameras after 2), the login back-off 15 minutes doubling to 6 hours, and at most 10 NVRs that
// were never proven contacted per camera round (doubling while they succeed). docs/drishti/runbooks/monitoring-rollout.md.
export function loadMonitorConfig(env: Record<string, string | undefined> = process.env): MonitorConfig {
  const threshold = whole(env.FAIL_THRESHOLD)
  const recorderThreshold = whole(env.RECORDER_FAIL_THRESHOLD)
  const backoffSec = interval(env.NVR_LOGIN_BACKOFF_SEC, 900, 60, DAY_SEC)
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
    nvrLoginBackoffSec: backoffSec,
    nvrLoginBackoffMaxSec: interval(env.NVR_LOGIN_BACKOFF_MAX_SEC, Math.max(21_600, backoffSec), backoffSec, DAY_SEC),
    recorderFailThreshold: recorderThreshold !== undefined && recorderThreshold >= 1 ? Math.min(10, recorderThreshold) : 3,
    newRecordersPerRound: interval(env.MONITOR_NEW_RECORDERS_PER_ROUND, 10, 1, 500),
  }
}
