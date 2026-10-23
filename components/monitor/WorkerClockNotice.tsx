import { Clock } from 'lucide-react'

// Release 1 clean-ups (P2-7 re-review R-2): the checker's clock against the database's (measured at every heartbeat,
// lib/monitor/health.ts). Results are dated by the worker, so a clock that is off changes what the pages say (docs/drishti/worker-lease.md
// section 9). Shown on the Monitoring page only beyond the warning limit (30 s).

function amount(sec: number): string {
  const s = Math.abs(sec)
  if (s < 90) return `${s} seconds`
  const min = Math.round(s / 60)
  if (min < 120) return `${min} minutes`
  const hours = Math.round(min / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

export function WorkerClockNotice({ skewSec, warning }: { skewSec: number | null; warning: boolean }) {
  if (!warning || skewSec === null) return null
  const ahead = skewSec > 0
  return (
    <p role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        The checker&apos;s clock is {amount(skewSec)} {ahead ? 'ahead of' : 'behind'} the database&apos;s.{' '}
        {ahead
          ? 'Results far ahead are dated at the database time, and “Check now” can look answered too early.'
          : 'Results look older than they are, so items can show “Not checked lately”.'}{' '}
        Turn on time sync on the checker&apos;s computer.
      </span>
    </p>
  )
}
