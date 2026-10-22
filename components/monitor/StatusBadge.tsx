import { CircleCheck, CircleHelp, CircleX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { statusLabel, type Status } from '@/lib/queries/status'

const STYLES: Record<Status, string> = {
  up: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  down: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  unknown: 'bg-muted text-muted-foreground',
}
const ICONS = { up: CircleCheck, down: CircleX, unknown: CircleHelp } as const

/** The status as a word and an icon, never colour alone. */
export function StatusBadge({ status, className }: { status: Status | null | undefined; className?: string }) {
  const s: Status = status ?? 'unknown'
  const Icon = ICONS[s]
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', STYLES[s], className)}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {statusLabel(s)}
    </span>
  )
}
