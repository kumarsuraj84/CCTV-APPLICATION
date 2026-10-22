'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { dayLabel, dayString, monthGrid, monthLabel, WEEKDAY_NAMES } from '@/lib/streams/calendar'
import { cn } from '@/lib/utils'

/**
 * A month to pick a day from. Days the NVR marks as having recordings get a dot and "has recordings" in their name, but they are only a
 * hint (the NVR's days can differ from the days shown, near midnight), so every day can be opened. Arrow keys move between days, Page Up
 * and Page Down change the month.
 */
export function DayCalendar({
  year,
  month,
  selected,
  today,
  marked,
  onSelect,
  onMonth,
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
}) {
  const grid = monthGrid(year, month)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const inMonth = (d: string) => d.startsWith(`${dayString(year, month, 1).slice(0, 7)}-`)
  const selectedDay = inMonth(selected) ? Number(selected.slice(8)) : null
  const todayDay = inMonth(today) ? Number(today.slice(8)) : null
  const tabbable = selectedDay ?? todayDay ?? 1
  const last = grid.flat().filter((d): d is number => d !== null).length

  const onKey = (e: KeyboardEvent, day: number) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      onMonth(e.key === 'PageUp' ? -1 : 1)
      return
    }
    let next: number | null = null
    if (e.key in step) next = day + step[e.key]
    else if (e.key === 'Home') next = 1
    else if (e.key === 'End') next = last
    if (next === null) return
    e.preventDefault()
    buttons.current.get(Math.min(last, Math.max(1, next)))?.focus()
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Button type="button" size="icon" variant="outline" aria-label="Previous month" onClick={() => onMonth(-1)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <h3 className="text-sm font-semibold" aria-live="polite">{monthLabel(year, month)}</h3>
        <Button type="button" size="icon" variant="outline" aria-label="Next month" onClick={() => onMonth(1)}>
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
        <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" /> Days with recordings, as marked by the NVR. You can open any day.
      </p>
    </div>
  )
}
