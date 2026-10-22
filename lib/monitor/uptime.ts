import type { AdminClient } from '@/lib/admin/types'
import { getWorkerHealth } from '@/lib/monitor/health'
import { formatDateTime } from '@/lib/time'

export type UptimeWindow = '24h' | '7d' | '30d'
export const WINDOW_HOURS: Record<UptimeWindow, number> = { '24h': 24, '7d': 168, '30d': 720 }

/**
 * Uptime percent per target, or null when nothing has been observed yet. The ids must come from rows the caller was already allowed to
 * read (this uses the service role), and the organisation comes from the caller's profile.
 *
 * asOf measures up to an earlier moment than now. The pages use it while monitoring is not running: the time since the last sign of life
 * is no data, not downtime.
 */
export async function uptimeFor(
  admin: AdminClient,
  orgId: string,
  type: 'camera' | 'device' | 'nvr',
  ids: string[],
  window: UptimeWindow,
  asOf?: Date,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(ids.map((id) => [id, null]))
  if (ids.length === 0) return out
  const { data, error } = await admin.rpc('targets_uptime', {
    p_org: orgId,
    p_type: type,
    p_ids: ids,
    p_window: `${WINDOW_HOURS[window]} hours`,
    ...(asOf ? { p_now: asOf.toISOString() } : {}),
  })
  if (error) throw new Error('Could not read uptime.')
  for (const row of data ?? []) out.set(row.target_id, row.uptime_pct === null ? null : Number(row.uptime_pct))
  return out
}

export type MonitoringState = {
  /** The worker has shown a sign of life recently. */
  running: boolean
  /** While it is not running: the last time it was seen alive, or null when it never was (or that could not be read). Uptime is measured up to here. */
  lastSeenAt: Date | null
}

/** Whether monitoring is running, using the same rule as the health page. Never throws: when the state cannot be read it counts as not running. */
export async function getMonitoringState(admin: AdminClient, now = new Date()): Promise<MonitoringState> {
  try {
    const h = await getWorkerHealth(admin, now)
    if (h.ok) return { running: true, lastSeenAt: null }
    return { running: false, lastSeenAt: h.heartbeatAgeSec === null ? null : new Date(now.getTime() - h.heartbeatAgeSec * 1000) }
  } catch {
    return { running: false, lastSeenAt: null }
  }
}

/**
 * Uptime for the pages: up to now while monitoring runs; up to the last sign of life while it does not; no data at all when it never ran.
 * A stoppage therefore shows as no data and never as downtime.
 */
export async function uptimeForPage(
  admin: AdminClient,
  orgId: string,
  type: 'camera' | 'device' | 'nvr',
  ids: string[],
  window: UptimeWindow,
  monitoring: MonitoringState,
): Promise<Map<string, number | null>> {
  if (monitoring.running) return uptimeFor(admin, orgId, type, ids, window)
  if (!monitoring.lastSeenAt) return new Map(ids.map((id) => [id, null]))
  return uptimeFor(admin, orgId, type, ids, window, monitoring.lastSeenAt)
}

/** Added to an uptime label while monitoring is stopped, so it is clear the figures stop at the last sign of life. */
export function uptimeSuffix(m: MonitoringState): string {
  return !m.running && m.lastSeenAt ? ` (until ${formatDateTime(m.lastSeenAt)})` : ''
}
