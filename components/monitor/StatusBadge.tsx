import { CircleCheck, CircleHelp, CircleX, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STALE_AFTER_MINUTES, statusLabel, type Status } from '@/lib/queries/status'

type Kind = Status | 'stale'

const STYLES: Record<Kind, string> = {
  up: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  down: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  unknown: 'bg-muted text-muted-foreground',
  stale: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
}
const ICONS = { up: CircleCheck, down: CircleX, unknown: CircleHelp, stale: Clock } as const

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
      title={kind === 'stale' ? `It was live, but has not been checked for more than ${STALE_AFTER_MINUTES} minutes.` : undefined}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {statusLabel(s, stale)}
    </span>
  )
}
