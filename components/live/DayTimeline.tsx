'use client'

import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  DAY_SECONDS,
  describeBlocks,
  EDGE_DWELL_MS,
  EDGE_PAN_FRACTION,
  EDGE_REPEAT_MS,
  edgeAction,
  edgeSide,
  formatClock,
  formatClockSeconds,
  fractionOf,
  FULL_DAY,
  isFullDay,
  keyMove,
  panView,
  secondAt,
  snapToRecording,
  spansInView,
  viewTicks,
  zoomView,
  type Span,
  type View,
} from '@/lib/streams/timeline'
import { cn } from '@/lib/utils'

/** One wheel step or button press zooms by this much. */
const ZOOM_STEP = 0.5

/**
 * The day's recordings on a bar (P4-L2: LG-10 click-to-start snapped to the nearest recording and the time under the pointer, LG-11 zoom
 * with the mouse wheel, the buttons or + / −, and "Whole day", LG-12 dwelling at the edge pans a zoomed-in bar or — guarded — opens the
 * previous / next day, LG-13 the arrow keys move 30 seconds, with Shift 5 minutes). The bar is a slider for the keyboard and its text
 * alternative lists the recordings. Times are the clock people see (India time, 24 hour). LG-17: when the list of recordings could not be
 * read, the bar says so and any time can still be chosen.
 */
export function DayTimeline({
  label,
  spans,
  second,
  position = null,
  view,
  onView,
  onPick,
  onEdgeDay,
  canPreviousDay = false,
  canNextDay = false,
  disabled = false,
  unknown = false,
}: {
  /** What the day is called, for example "Thursday 22 October 2026". */
  label: string
  spans: readonly Span[]
  /** The chosen start (seconds of the day), or null. */
  second: number | null
  /** Where the playing picture is now (seconds of this day), or null. */
  position?: number | null
  view: View
  onView: (view: View) => void
  onPick: (second: number) => void
  onEdgeDay?: (direction: 'previous' | 'next') => void
  canPreviousDay?: boolean
  canNextDay?: boolean
  disabled?: boolean
  /** LG-17: the list of recordings is not available (drawn as unknown, not as "no recordings"). */
  unknown?: boolean
}) {
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const summary = useId()
  const [hover, setHover] = useState<{ sec: number; fraction: number } | null>(null)
  // The latest props for the timers and the native wheel listener.
  const latest = useRef({ view, onView, onEdgeDay, canPreviousDay, canNextDay })
  useEffect(() => {
    latest.current = { view, onView, onEdgeDay, canPreviousDay, canNextDay }
  })
  const dwell = useRef<{ side: 'left' | 'right'; timer: ReturnType<typeof setTimeout> | null; dayDone: boolean } | null>(null)

  const fractionAt = (clientX: number): number | null => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    return (clientX - rect.left) / rect.width
  }
  const pickAt = (clientX: number) => {
    const f = fractionAt(clientX)
    if (f === null) return
    const sec = secondAt(view, f)
    onPick(unknown ? sec : (snapToRecording(spans, sec) ?? sec))
  }
  const stopDwell = () => {
    if (dwell.current?.timer) clearTimeout(dwell.current.timer)
    dwell.current = null
  }
  const runDwell = (side: 'left' | 'right') => {
    const d = dwell.current
    if (!d || d.side !== side) return
    const l = latest.current
    const action = edgeAction(l.view, side, { canPreviousDay: l.canPreviousDay, canNextDay: l.canNextDay })
    if (action === 'pan-left' || action === 'pan-right') {
      const step = (l.view.end - l.view.start) * EDGE_PAN_FRACTION
      l.onView(panView(l.view, action === 'pan-left' ? -step : step))
      d.timer = setTimeout(() => runDwell(side), EDGE_REPEAT_MS)
    } else if ((action === 'previous-day' || action === 'next-day') && !d.dayDone) {
      // Once per stay at the edge: leaving the edge and coming back is needed to move another day.
      d.dayDone = true
      d.timer = null
      l.onEdgeDay?.(action === 'previous-day' ? 'previous' : 'next')
    } else d.timer = null
  }
  useEffect(() => () => stopDwell(), [])

  // The mouse wheel zooms around the pointer (a native listener: React's wheel listener cannot stop the page from scrolling).
  useEffect(() => {
    const el = track.current
    if (!el || disabled) return
    const wheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      e.preventDefault()
      const l = latest.current
      const focus = secondAt(l.view, (e.clientX - rect.left) / rect.width)
      l.onView(zoomView(l.view, focus, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [disabled])

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return
    stopDwell()
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.currentTarget.focus()
    pickAt(e.clientX)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    const f = fractionAt(e.clientX)
    if (f === null) return
    setHover({ sec: secondAt(view, f), fraction: Math.min(1, Math.max(0, f)) })
    if (dragging.current) {
      pickAt(e.clientX)
      return
    }
    if (e.pointerType !== 'mouse') return
    const side = edgeSide(f)
    if (side === null) return stopDwell()
    if (dwell.current?.side === side) return
    stopDwell()
    dwell.current = { side, timer: null, dayDone: false }
    dwell.current.timer = setTimeout(() => runDwell(side), EDGE_DWELL_MS)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const leave = () => {
    setHover(null)
    stopDwell()
  }
  const keepInView = (sec: number) => {
    if (sec < view.start || sec >= view.end) onView(panView(view, sec - (view.start + view.end) / 2))
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const here = second ?? spans[0]?.startSec ?? 0
    const delta = keyMove(e.key, e.shiftKey)
    let to: number | null = null
    if (delta !== null) to = here + delta
    else if (e.key === 'Home') to = view.start
    else if (e.key === 'End') to = Math.min(DAY_SECONDS - 1, view.end - 1)
    else if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      return onView(zoomView(view, here, ZOOM_STEP))
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      return onView(zoomView(view, here, 1 / ZOOM_STEP))
    } else if (e.key === '0') {
      e.preventDefault()
      return onView(FULL_DAY)
    }
    if (to === null) return
    e.preventDefault()
    const sec = Math.min(DAY_SECONDS - 1, Math.max(0, to))
    keepInView(sec)
    onPick(sec)
  }

  const zoomed = !isFullDay(view)
  const focus = second ?? (view.start + view.end) / 2
  const drawn = spansInView(spans, view)
  const ticks = viewTicks(view)
  const at = (sec: number) => `${Math.min(100, Math.max(0, fractionOf(view, sec) * 100))}%`
  const visible = (sec: number | null): sec is number => sec !== null && sec >= view.start && sec <= view.end
  const blocks = spans.map((s) => ({ startMin: Math.floor(s.startSec / 60), endMin: Math.ceil(s.endSec / 60), left: 0, width: 0 }))

  return (
    <div role="group" aria-label={`Recordings on ${label}`} aria-describedby={summary} className="space-y-1">
      <p id={summary} className="sr-only">
        {unknown ? 'The list of recordings is not available.' : describeBlocks(blocks)}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {zoomed ? `Showing ${formatClock(Math.floor(view.start / 60))} to ${formatClock(Math.ceil(view.end / 60))}` : 'Showing the whole day'}
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="outline" disabled={disabled || view.end - view.start <= 600} onClick={() => onView(zoomView(view, focus, ZOOM_STEP))}>
            <ZoomIn aria-hidden="true" /> Zoom in
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={disabled || !zoomed} onClick={() => onView(zoomView(view, focus, 1 / ZOOM_STEP))}>
            <ZoomOut aria-hidden="true" /> Zoom out
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={disabled || !zoomed} onClick={() => onView(FULL_DAY)}>
            <Maximize2 aria-hidden="true" /> Whole day
          </Button>
        </div>
      </div>
      <div
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Start time"
        aria-orientation="horizontal"
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={DAY_SECONDS - 1}
        aria-valuenow={second ?? 0}
        aria-valuetext={second === null ? 'No time chosen' : formatClockSeconds(second)}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={leave}
        onKeyDown={key}
        style={{
          touchAction: 'pan-y',
          ...(unknown ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in oklab, currentColor 12%, transparent) 6px 12px)' } : {}),
        }}
        className={cn(
          'relative h-14 w-full cursor-crosshair overflow-hidden rounded-md border bg-muted text-muted-foreground outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        {ticks.map((t) => (
          <span key={t.sec} aria-hidden="true" className={cn('absolute inset-y-0 w-px', t.major ? 'bg-border' : 'bg-border/50')} style={{ left: at(t.sec) }} />
        ))}
        {drawn.map((b) => (
          <span key={b.startSec} aria-hidden="true" className="absolute inset-y-2 min-w-[3px] rounded-sm bg-primary/70" style={{ left: `${b.left}%`, width: `${b.width}%` }} />
        ))}
        {visible(position) && <span aria-hidden="true" className="absolute inset-y-1 w-0.5 -translate-x-1/2 bg-amber-500" style={{ left: at(position) }} />}
        {visible(second) && (
          <span aria-hidden="true" className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: at(second) }}>
            <span className="absolute -top-px left-1/2 size-2 -translate-x-1/2 rounded-full bg-foreground" />
          </span>
        )}
        {hover && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0.5 z-10 -translate-x-1/2 rounded bg-foreground px-1 py-0.5 font-mono text-[11px] text-background"
            style={{ left: `${Math.min(94, Math.max(6, hover.fraction * 100))}%` }}
          >
            {formatClockSeconds(hover.sec)}
          </span>
        )}
      </div>
      <div aria-hidden="true" className="relative h-4 text-[11px] text-muted-foreground">
        {ticks
          .filter((t, i) => (zoomed ? i % Math.ceil(ticks.length / 6) === 0 : t.major))
          .map((t) => {
            const edge = t.sec <= view.start ? 'left-0' : t.sec >= view.end ? 'right-0' : '-translate-x-1/2'
            return (
              <span key={t.sec} className={cn('absolute top-0', edge)} style={t.sec <= view.start || t.sec >= view.end ? undefined : { left: at(t.sec) }}>
                {t.label}
              </span>
            )
          })}
      </div>
      {unknown && <p className="text-xs text-amber-800 dark:text-amber-300">The list of recordings is not available, so the bar cannot show them. Any time can still be chosen and tried.</p>}
    </div>
  )
}
