import type { MonitorConfig } from '@/lib/monitor/types'

/** A whole number from the environment, or undefined when it is not set, empty or not a whole number. */
function whole(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

// A check interval below the minimum is raised to it; nonsense gives the default.
const interval = (v: string | undefined, fallback: number, min: number): number => {
  const n = whole(v)
  return n === undefined ? fallback : Math.max(n, min)
}

export function loadMonitorConfig(env: Record<string, string | undefined> = process.env): MonitorConfig {
  const threshold = whole(env.FAIL_THRESHOLD)
  return {
    deviceCheckSec: interval(env.DEVICE_CHECK_SEC, 60, 10),
    cameraCheckSec: interval(env.CAMERA_CHECK_SEC, 300, 10),
    pollSec: 5,
    // A threshold below 1 makes no sense; it is ignored.
    failThreshold: threshold !== undefined && threshold >= 1 ? threshold : 2,
    deviceConcurrency: 50,
    storeConcurrency: 10,
    rtspPerStore: 4,
    tcpTimeoutMs: 3000,
    nvrTimeoutMs: 8000,
  }
}
