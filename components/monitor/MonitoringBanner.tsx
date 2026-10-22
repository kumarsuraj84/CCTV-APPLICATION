import { TriangleAlert } from 'lucide-react'
import type { MonitoringState } from '@/lib/monitor/uptime'
import { formatDateTime } from '@/lib/time'

/** Shown on every status screen while the monitoring worker is not running, because then the statuses may be out of date. */
export function MonitoringBanner({ monitoring }: { monitoring: MonitoringState }) {
  if (monitoring.running) return null
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">Monitoring is not running</p>
        <p>
          What you see may be out of date{monitoring.lastSeenAt ? ` (monitoring was last running at ${formatDateTime(monitoring.lastSeenAt)})` : ''}. The time monitoring is off is not counted as downtime. Ask an administrator to start it.
        </p>
      </div>
    </div>
  )
}
