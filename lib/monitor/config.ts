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
    storeConcurrency: 10,
    rtspPerStore: 4,
    tcpTimeoutMs: 3000,
    nvrTimeoutMs: 8000,
  }
}
