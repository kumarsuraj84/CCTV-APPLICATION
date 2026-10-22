'use client'

import { useId, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { describeBlocks, formatClock, MINUTES_PER_DAY, minuteAt, type Block } from '@/lib/streams/timeline'
import { cn } from '@/lib/utils'

const TICKS = [0, 6, 12, 18, 24]

/**
 * A 24 hour bar for one day: recordings are drawn as blocks, and the start time is picked by clicking or dragging on the bar. The bar is a
 * slider for the keyboard (arrow keys move a minute, with Shift ten minutes, Page Up and Page Down an hour, Home and End the ends of the
 * day), and its text alternative lists the recordings. Times are the clock people see (India time, 24 hour).
 */
export function DayTimeline({
  label,
  blocks,
  minute,
  onPick,
  disabled = false,
}: {
  /** What the day is called, for example "Thursday 22 October 2026". */
  label: string
  blocks: readonly Block[]
  /** The chosen minute of the day (0 to 1439), or null. */
  minute: number | null
  onPick: (minute: number) => void
  disabled?: boolean
}) {
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const summary = useId()

  const pickAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    onPick(minuteAt((clientX - rect.left) / rect.width))
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.currentTarget.focus()
    pickAt(e.clientX)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) pickAt(e.clientX)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const here = minute ?? blocks[0]?.startMin ?? 0
    const step = e.shiftKey ? 10 : 1
    const moves: Record<string, number> = { ArrowRight: here + step, ArrowUp: here + step, ArrowLeft: here - step, ArrowDown: here - step, PageUp: here + 60, PageDown: here - 60, Home: 0, End: MINUTES_PER_DAY - 1 }
    if (!(e.key in moves)) return
    e.preventDefault()
    onPick(Math.min(MINUTES_PER_DAY - 1, Math.max(0, moves[e.key])))
  }

  return (
    <div role="group" aria-label={`Recordings on ${label}`} aria-describedby={summary}>
      <p id={summary} className="sr-only">{describeBlocks(blocks)}</p>
      <div
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Start time"
        aria-orientation="horizontal"
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={MINUTES_PER_DAY - 1}
        aria-valuenow={minute ?? 0}
        aria-valuetext={minute === null ? 'No time chosen' : formatClock(minute)}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        style={{ touchAction: 'pan-y' }}
        className={cn(
          'relative h-14 w-full cursor-crosshair overflow-hidden rounded-md border bg-muted outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        {TICKS.slice(1, -1).map((h) => (
          <span key={h} aria-hidden="true" className="absolute inset-y-0 w-px bg-border" style={{ left: `${(h * 100) / 24}%` }} />
        ))}
        {blocks.map((b) => (
          <span key={b.startMin} aria-hidden="true" className="absolute inset-y-2 min-w-[3px] rounded-sm bg-primary/70" style={{ left: `${b.left}%`, width: `${b.width}%` }} />
        ))}
        {minute !== null && (
          <span aria-hidden="true" className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${(minute * 100) / MINUTES_PER_DAY}%` }}>
            <span className="absolute -top-px left-1/2 size-2 -translate-x-1/2 rounded-full bg-foreground" />
          </span>
        )}
      </div>
      <div aria-hidden="true" className="relative mt-1 h-4 text-[11px] text-muted-foreground">
        {TICKS.map((h) => (
          <span key={h} className={cn('absolute top-0', h === 0 ? 'left-0' : h === 24 ? 'right-0' : '-translate-x-1/2')} style={h === 0 || h === 24 ? undefined : { left: `${(h * 100) / 24}%` }}>
            {String(h).padStart(2, '0')}:00
          </span>
        ))}
      </div>
    </div>
  )
}
