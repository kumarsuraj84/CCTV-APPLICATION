import { formatDateTime } from '@/lib/time'

type RoundTimes = { lastDevicesRoundAt: string | null; lastCamerasRoundAt: string | null; runFinishedAt: string | null }

const valid = (iso: string | null): Date | null => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * When something was last checked, for Home: the most recent of the last devices-and-NVRs round, the last cameras round and the last
 * full ("check now") run, whichever finished last. Null when none has finished yet.
 */
export function lastCheckedAt(w: RoundTimes): Date | null {
  const times = [w.lastDevicesRoundAt, w.lastCamerasRoundAt, w.runFinishedAt].map(valid).filter((d): d is Date => d !== null)
  if (times.length === 0) return null
  return times.reduce((a, b) => (b.getTime() > a.getTime() ? b : a))
}

/** When each kind of scheduled round last finished, in plain words, for the Monitoring page (which labels them "Devices and NVRs" and "Cameras"). */
export function describeRounds(w: RoundTimes): { devices: string; cameras: string } {
  const say = (iso: string | null) => {
    const d = valid(iso)
    return d ? `Last round finished ${formatDateTime(d)}` : 'No round has finished yet'
  }
  return { devices: say(w.lastDevicesRoundAt), cameras: say(w.lastCamerasRoundAt) }
}
