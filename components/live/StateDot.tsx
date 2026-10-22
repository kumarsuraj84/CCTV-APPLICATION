import { CircleCheck, CircleHelp, CircleX, Clock, PowerOff, Unplug } from 'lucide-react'
import { CAMERA_STATE_LABEL, type CameraState, type NodeState } from '@/lib/live/rollups'
import { STALE_AFTER_MINUTES } from '@/lib/queries/status'
import { cn } from '@/lib/utils'

// P4-L1: honest states on the Live screens — Live / Offline / Recorder not reachable (unknown: the NVR cannot be reached, so the camera
// itself is not known to have failed) / Not checked / Switched off (maintenance: an administrator switched monitoring of the NVR off).
// Always a word next to the colour (never colour alone); the dot colours are the design tokens for dots (docs/design/drishti-tokens.md).

const DOT: Record<CameraState | NodeState, string> = {
  live: 'bg-[var(--dot-success)]',
  offline: 'bg-[var(--dot-destructive)]',
  unreachable: 'bg-[var(--dot-warning)]',
  not_checked: 'bg-[var(--neutral-strong)]',
  stale: 'bg-[var(--neutral-strong)]',
  off: 'bg-[var(--neutral-strong)] opacity-60',
  empty: 'bg-[var(--border)]',
}

/** A small round dot for a tree node or a camera row; decorative (the words beside it say the state). */
export function StateDot({ state, className }: { state: CameraState | NodeState; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-2.5 shrink-0 rounded-full', DOT[state], className)} />
}

const BADGE: Record<CameraState, string> = {
  live: 'bg-[var(--success-soft)] text-[var(--on-success-soft)]',
  offline: 'bg-[var(--destructive-soft)] text-[var(--on-destructive-soft)]',
  unreachable: 'bg-[var(--warning-soft)] text-[var(--on-warning-soft)]',
  not_checked: 'bg-muted text-muted-foreground',
  stale: 'bg-[var(--warning-soft)] text-[var(--on-warning-soft)]',
  off: 'bg-muted text-[var(--neutral-strong)]',
}
const ICON = { live: CircleCheck, offline: CircleX, unreachable: Unplug, not_checked: CircleHelp, stale: Clock, off: PowerOff } as const
// Review M-2: "recorder", never "NVR" — these hints are shown to CCTV-only viewers too.
const HINT: Partial<Record<CameraState, string>> = {
  unreachable: 'The recorder this camera is on cannot be reached, so whether the camera itself works is not known.',
  stale: `It was live, but has not been checked for more than ${STALE_AFTER_MINUTES} minutes.`,
  off: 'Monitoring of this camera\'s recorder is switched off (for example during maintenance): it is not contacted.',
}

/** The camera's state as a word and an icon (on the wall tiles and camera lists). */
export function CameraStateBadge({ state, className }: { state: CameraState; className?: string }) {
  const Icon = ICON[state]
  return (
    <span title={HINT[state]} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', BADGE[state], className)}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {CAMERA_STATE_LABEL[state]}
    </span>
  )
}
