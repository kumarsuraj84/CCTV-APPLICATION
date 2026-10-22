import { CircleCheck, CircleHelp, CircleX, Clock, PowerOff, Unplug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STALE_AFTER_MINUTES, statusLabel, type Status } from '@/lib/queries/status'

type Kind = Status | 'stale'

const STYLES: Record<Kind, string> = {
  up: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  down: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  unknown: 'bg-muted text-muted-foreground',
  stale: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  off: 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300',
  // P4-L1 review I-3: a camera behind an NVR that cannot be reached — amber (unknown), never the red of offline.
  unreachable: 'bg-[var(--warning-soft)] text-[var(--on-warning-soft)]',
}
const ICONS = { up: CircleCheck, down: CircleX, unknown: CircleHelp, stale: Clock, off: PowerOff, unreachable: Unplug } as const

/**
 * The status as a word and an icon, never colour alone. `stale` (only for a live result) means it has not been checked for longer than
 * the limit: it then reads "Not checked lately", with a clock icon and an explanation as hover text.
 */
export function StatusBadge({ status, stale = false, className }: { status: Status | null | undefined; stale?: boolean; className?: string }) {
  const s: Status = status ?? 'unknown'
  const kind: Kind = s === 'up' && stale ? 'stale' : s
  const Icon = ICONS[kind]
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', STYLES[kind], className)}
      title={kind === 'stale' ? `It was live, but has not been checked for more than ${STALE_AFTER_MINUTES} minutes.`
        // "recorder", not "NVR": the badge is shown to CCTV-only viewers too (P4-L1 review M-2).
        : kind === 'off' ? 'Monitoring of this recorder is switched off: it is not contacted, so its status is not known.'
        : kind === 'unreachable' ? 'The recorder this camera is on cannot be reached, so whether the camera itself works is not known.' : undefined}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {statusLabel(s, stale)}
    </span>
  )
}
