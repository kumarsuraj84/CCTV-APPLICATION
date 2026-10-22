'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { dayLabel, daysInMonth, dayString, monthGrid, monthLabel, shiftMonth, WEEKDAY_NAMES } from '@/lib/streams/calendar'
import { cn } from '@/lib/utils'

/**
 * A month to pick a day from. Days that may have recordings get a dot and "has recordings" in their name (P4-L2: shown days, with the
 * recorder's clock offset applied on the server), but they are only a hint, so every day can be opened. Arrow keys move between days and carry on
 * into the previous or next month at the edges; Page Up and Page Down change the month. The month buttons are marked unavailable at the
 * ends of the range that can be shown (the parent says which).
 */
export function DayCalendar({
  year,
  month,
  selected,
  today,
  marked,
  onSelect,
  onMonth,
  canPrev,
  canNext,
}: {
  year: number
  month: number
  /** The chosen day, `yyyy-mm-dd`. */
  selected: string
  /** Today on the shown clock, `yyyy-mm-dd`. */
  today: string
  /** Days of this month the NVR marks. */
  marked: readonly number[]
  onSelect: (day: string) => void
  onMonth: (delta: number) => void
  /** Whether the previous / next month may be shown. */
  canPrev: boolean
  canNext: boolean
}) {
  const grid = monthGrid(year, month)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const inMonth = (d: string) => d.startsWith(`${dayString(year, month, 1).slice(0, 7)}-`)
  const selectedDay = inMonth(selected) ? Number(selected.slice(8)) : null
  const todayDay = inMonth(today) ? Number(today.slice(8)) : null
  const tabbable = selectedDay ?? todayDay ?? 1
  const last = grid.flat().filter((d): d is number => d !== null).length

  // After the month changes, the focus goes to this day of the new month.
  const pending = useRef<number | null>(null)
  useEffect(() => {
    const d = pending.current
    pending.current = null
    if (d !== null) buttons.current.get(d)?.focus()
  }, [year, month])

  const focusDay = (d: number) => buttons.current.get(Math.min(last, Math.max(1, d)))?.focus()
  const goMonth = (delta: -1 | 1, day: number) => {
    if (delta === -1 ? !canPrev : !canNext) return false
    const to = shiftMonth(year, month, delta)
    pending.current = Math.min(daysInMonth(to.year, to.month), Math.max(1, day))
    onMonth(delta)
    return true
  }
  const onKey = (e: KeyboardEvent, day: number) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      goMonth(e.key === 'PageUp' ? -1 : 1, day)
      return
    }
    let target: number
    if (e.key in step) target = day + step[e.key]
    else if (e.key === 'Home') target = 1
    else if (e.key === 'End') target = last
    else return
    e.preventDefault()
    if (target < 1) {
      const to = shiftMonth(year, month, -1)
      if (!goMonth(-1, daysInMonth(to.year, to.month) + target)) focusDay(1) // at the first month there is nowhere to go
    } else if (target > last) {
      if (!goMonth(1, target - last)) focusDay(last)
    } else focusDay(target)
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Button type="button" size="icon" variant="outline" aria-label="Previous month" aria-disabled={!canPrev} title={canPrev ? undefined : "Not available: the calendar goes back 12 months."} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => canPrev && onMonth(-1)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <h3 className="text-sm font-semibold" aria-live="polite">{monthLabel(year, month)}</h3>
        <Button type="button" size="icon" variant="outline" aria-label="Next month" aria-disabled={!canNext} title={canNext ? undefined : "Not available: this is the current month."} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => canNext && onMonth(1)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <table className="w-full table-fixed border-separate border-spacing-0.5 text-center text-sm">
        <caption className="sr-only">{monthLabel(year, month)}. Pick a day.</caption>
        <thead>
          <tr>
            {WEEKDAY_NAMES.map((name) => (
              <th key={name} scope="col" abbr={name} className="pb-1 text-xs font-medium text-muted-foreground">
                {name.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week, w) => (
            <tr key={w}>
              {week.map((day, i) => {
                if (day === null) return <td key={i} />
                const text = dayString(year, month, day)
                const isMarked = marked.includes(day)
                const isSelected = text === selected
                const isToday = text === today
                return (
                  <td key={i}>
                    <button
                      ref={(el) => {
                        if (el) buttons.current.set(day, el)
                        else buttons.current.delete(day)
                      }}
                      type="button"
                      tabIndex={day === tabbable ? 0 : -1}
                      aria-label={`${dayLabel(year, month, day)}${isMarked ? ', has recordings' : ''}`}
                      aria-pressed={isSelected}
                      aria-current={isToday ? 'date' : undefined}
                      onClick={() => onSelect(text)}
                      onKeyDown={(e) => onKey(e, day)}
                      className={cn(
                        'relative flex h-10 w-full flex-col items-center justify-center rounded-md border border-transparent text-sm outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                        isToday && 'border-border font-semibold',
                        isSelected && 'bg-primary text-primary-foreground hover:bg-primary/90',
                      )}
                    >
                      <span aria-hidden="true">{day}</span>
                      <span aria-hidden="true" className={cn('absolute bottom-1 size-1.5 rounded-full', isMarked ? (isSelected ? 'bg-primary-foreground' : 'bg-primary') : 'bg-transparent')} />
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" /> Days with recordings (India time, the NVR&rsquo;s own clock offset applied). The marks are a guide: you can open any day.
      </p>
    </div>
  )
}
