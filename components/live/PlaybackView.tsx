'use client'

import { Play } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { listDaySegmentsAction, listRecordedDaysAction, openPlaybackAction } from '@/lib/actions/playback'
import { clampDay, dayLabel, monthInBounds, shiftMonth } from '@/lib/streams/calendar'
import { fastMinutes, isSpeed, MAX_FAST_MINUTES, SPEEDS, speedLabel, vodUrl, type Speed } from '@/lib/streams/speed'
import {
  blockAt,
  dayBlocks,
  DEFAULT_LENGTH,
  formatClock,
  formatShortDateTime,
  LENGTH_CHOICES,
  nextBlockStart,
  parseClock,
  parseDay,
  startIso,
} from '@/lib/streams/timeline'
import { DayCalendar } from './DayCalendar'
import { DayTimeline } from './DayTimeline'
import { FastPlayer } from './FastPlayer'
import { PlaybackPlayer } from './PlaybackPlayer'

/** Fast playback (2x, 4x, 8x): offered ('available'), wanted but ffmpeg is not set up here ('not-set-up': the screen says so), or not for this person ('hidden': only 1x, no word about it). */
export type FastPlayback = 'available' | 'not-set-up' | 'hidden'

export type PlaybackCamera = { id: string; name: string; storeCode: string }

type Segments = { start: string; end: string }[]
type DaysLoaded = { key: string; days: number[]; error: string | null }
type DayLoaded = { key: string; segments: Segments; truncated: boolean; skipped: number; error: string | null }
type Session = { id: number; minutes: number; label: string; startIso: string } & ({ kind: 'live'; token: string } | { kind: 'fast'; src: string; speed: Speed })

const COULD_NOT_REACH = 'Could not reach the server.'

/**
 * Playback for one camera: a month to pick the day from, the day's recordings on a 24 hour bar, a start time (click or drag on the bar, or
 * type HH:MM), a length, and the picture. Times are the clock people see (India time, 24 hour).
 */
export function PlaybackView({ camera, today, initialDay, fastPlayback = 'hidden' }: { camera: PlaybackCamera; today: string; initialDay: string; fastPlayback?: FastPlayback }) {
  const startDay = clampDay(parseDay(initialDay) ? initialDay : today, today)
  const first = parseDay(startDay)!
  const [day, setDay] = useState(startDay)
  const [view, setView] = useState({ year: first.y, month: first.m })
  const [pick, setPick] = useState<{ day: string; minute: number } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [clockError, setClockError] = useState<string | null>(null)
  const [length, setLength] = useState<number>(DEFAULT_LENGTH)
  const [speed, setSpeed] = useState<Speed>(1)
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [playError, setPlayError] = useState<string | null>(null)
  const [daysLoaded, setDaysLoaded] = useState<DaysLoaded | null>(null)
  const [dayLoaded, setDayLoaded] = useState<DayLoaded | null>(null)
  const playerBox = useRef<HTMLDivElement>(null)
  const playButton = useRef<HTMLButtonElement>(null)
  const nextId = useRef(1)
  const ids = useId()

  // The NVR calendar for the month on the screen (a hint only).
  const monthKey = `${view.year}-${view.month}`
  useEffect(() => {
    let off = false
    listRecordedDaysAction(camera.id, view.year, view.month)
      .then((r) => { if (!off) setDaysLoaded({ key: monthKey, days: r.ok ? r.days : [], error: r.ok ? null : r.error }) })
      .catch(() => { if (!off) setDaysLoaded({ key: monthKey, days: [], error: COULD_NOT_REACH }) })
    return () => { off = true }
  }, [camera.id, view.year, view.month, monthKey])
  const marks = daysLoaded?.key === monthKey ? daysLoaded : null

  // The recordings of the chosen day.
  useEffect(() => {
    let off = false
    listDaySegmentsAction(camera.id, day)
      .then((r) => { if (!off) setDayLoaded(r.ok ? { key: day, segments: r.segments, truncated: r.truncated, skipped: r.skipped, error: null } : { key: day, segments: [], truncated: false, skipped: 0, error: r.error }) })
      .catch(() => { if (!off) setDayLoaded({ key: day, segments: [], truncated: false, skipped: 0, error: COULD_NOT_REACH }) })
    return () => { off = true }
  }, [camera.id, day])
  const loaded = dayLoaded?.key === day ? dayLoaded : null

  const blocks = useMemo(() => dayBlocks(day, loaded?.segments ?? []), [day, loaded])
  const parsed = parseDay(day)
  const label = parsed ? dayLabel(parsed.y, parsed.m, parsed.d) : day
  // Until a time is picked, the first recording of the day is the start.
  const minute = pick?.day === day ? pick.minute : (blocks[0]?.startMin ?? null)
  const clock = draft ?? (minute === null ? '' : formatClock(minute))
  const inRecording = minute !== null && blockAt(blocks, minute) !== null
  const later = minute !== null ? nextBlockStart(blocks, minute) : null

  const choose = (m: number) => {
    setPick({ day, minute: m })
    setDraft(null)
    setClockError(null)
  }
  const commitClock = () => {
    if (draft === null) return
    const m = parseClock(draft)
    if (m === null) {
      setClockError('Type the time as 24-hour HH:MM, for example 14:30.')
      return
    }
    choose(m)
  }
  // The calendar goes back 12 months from the current month and no further forward than the current month.
  const before = shiftMonth(view.year, view.month, -1)
  const after = shiftMonth(view.year, view.month, 1)
  const canPrev = monthInBounds(before.year, before.month, today)
  const canNext = monthInBounds(after.year, after.month, today)
  const changeMonth = (delta: number) => setView((v) => {
    const to = shiftMonth(v.year, v.month, delta)
    return monthInBounds(to.year, to.month, today) ? to : v
  })
  const selectDay = (d: string) => {
    setDay(d)
    setPlayError(null)
    // A time that was typed for another day is not carried over.
    setDraft(null)
    setClockError(null)
    // Keep the address in step so the page can be shared or reloaded (the server page reads ?day=).
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('day', d)
      window.history.replaceState(null, '', url)
    } catch {
      // the address bar is not essential
    }
  }

  // Without ffmpeg on the server only 1x is offered, whatever was chosen before.
  const fast = fastPlayback === 'available'
  const playSpeed: Speed = fast ? speed : 1

  const start = async (iso: string, minutes: number, text: string, at: Speed = playSpeed) => {
    setPlayError(null)
    const label = `${camera.storeCode}, ${camera.name}, ${text}`
    if (at !== 1) {
      // Fast playback needs no token: the picture is the video route's answer to a plain video element.
      const clip = fastMinutes(minutes)
      setSession({ id: nextId.current++, kind: 'fast', src: vodUrl({ camera: camera.id, start: iso, minutes: clip }), speed: at, minutes: clip, label, startIso: iso })
      setTimeout(() => playerBox.current?.focus(), 0)
      return
    }
    setBusy(true)
    try {
      const res = await openPlaybackAction(camera.id, iso, minutes)
      if (!res.ok) {
        setPlayError(res.error)
        toast.error(res.error)
        return
      }
      setSession({ id: nextId.current++, kind: 'live', token: res.token, minutes, label, startIso: iso })
      // The picture takes the focus so a keyboard or screen reader user lands on it.
      setTimeout(() => playerBox.current?.focus(), 0)
    } catch {
      setPlayError(COULD_NOT_REACH)
      toast.error(COULD_NOT_REACH)
    } finally {
      setBusy(false)
    }
  }
  const play = () => {
    // A time that was typed but not yet confirmed counts when Play is pressed.
    const m = draft !== null ? parseClock(draft) : minute
    if (m === null) {
      setClockError('Type the time as 24-hour HH:MM, for example 14:30.')
      return
    }
    if (draft !== null) choose(m)
    void start(startIso(day, m), length, `${label}, ${formatClock(m)}`)
  }
  const stop = () => {
    setSession(null)
    setTimeout(() => playButton.current?.focus(), 0)
  }
  const carryOn = (seconds: number) => {
    if (!session) return
    const from = new Date(Date.parse(session.startIso) + seconds * 1000)
    const remaining = Math.max(1, Math.ceil((session.minutes * 60 - seconds) / 60))
    void start(from.toISOString(), remaining, `from ${formatShortDateTime(from.toISOString())}`, session.kind === 'fast' ? session.speed : 1)
  }

  const playLabel = playSpeed === 1 ? `Play ${length} minutes` : `Play ${fastMinutes(length)} minutes at ${speedLabel(playSpeed)}`
  // Under the speed: why only 1x is offered, or that fast playback is shorter than the longest normal playback.
  const fastHelp = fastPlayback === 'not-set-up' ? 'Fast playback is not set up on this server.' : fastPlayback === 'hidden' ? null : playSpeed !== 1 && length > MAX_FAST_MINUTES ? `Fast playback shows at most ${MAX_FAST_MINUTES} minutes.` : null

  const summary = !loaded
    ? 'Loading the recordings…'
    : loaded.error
      ? ''
      : blocks.length === 0
        ? 'No recordings on this day.'
        : `${blocks.length} ${blocks.length === 1 ? 'recording' : 'recordings'} on this day, from ${formatClock(blocks[0].startMin)} to ${formatClock(blocks[blocks.length - 1].endMin)}.`

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <div className="min-w-0">
          <DayCalendar year={view.year} month={view.month} selected={day} today={today} marked={marks?.days ?? []} onSelect={selectDay} onMonth={changeMonth} canPrev={canPrev} canNext={canNext} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => { const t = parseDay(today)!; setView({ year: t.y, month: t.m }); selectDay(today) }}>
              Today
            </Button>
            {marks?.error && <p role="status" className="text-xs text-muted-foreground">Could not mark the days with recordings: {marks.error}</p>}
          </div>
        </div>

        <section aria-labelledby={`${ids}-day`} className="min-w-0 space-y-3">
          <div>
            <h2 id={`${ids}-day`} className="text-sm font-semibold">{label}</h2>
            <p className="text-xs text-muted-foreground">Times are India time (IST), 24-hour.</p>
          </div>

          {loaded?.error && <p role="alert" className="text-sm text-destructive">{loaded.error}</p>}
          <div aria-live="polite" className="text-sm">
            {!loaded?.error && <p className="text-muted-foreground">{summary}</p>}
            {loaded && !loaded.error && loaded.truncated && (
              <p className="text-amber-800 dark:text-amber-300">There are too many recordings on this day to show them all. The first part is shown.</p>
            )}
            {loaded && !loaded.error && loaded.skipped > 0 && <p className="text-amber-800 dark:text-amber-300">Some recordings could not be read.</p>}
          </div>

          <DayTimeline label={label} blocks={blocks} minute={minute} onPick={choose} disabled={!loaded || !!loaded.error} />

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-time`}>Start time</Label>
              <Input
                id={`${ids}-time`}
                value={clock}
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="HH:MM"
                aria-describedby={`${ids}-time-help`}
                aria-invalid={clockError !== null}
                className="w-24"
                onChange={(e) => { setDraft(e.target.value); setClockError(null) }}
                onBlur={commitClock}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitClock() }
                  if (e.key === 'Escape') { setDraft(null); setClockError(null) }
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-length`}>Length</Label>
              <select
                id={`${ids}-length`}
                value={length}
                onChange={(e) => setLength(Number(e.target.value))}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
              >
                {LENGTH_CHOICES.map((n) => <option key={n} value={n}>{n} minutes</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-speed`}>Speed</Label>
              <select
                id={`${ids}-speed`}
                value={playSpeed}
                onChange={(e) => { const n = Number(e.target.value); if (isSpeed(n)) setSpeed(n) }}
                aria-describedby={fastHelp === null ? undefined : `${ids}-speed-help`}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
              >
                {(fast ? SPEEDS : SPEEDS.filter((s) => s === 1)).map((s) => <option key={s} value={s}>{speedLabel(s)}</option>)}
              </select>
            </div>
            <Button ref={playButton} type="button" onClick={play} disabled={busy || (minute === null && draft === null)}>
              <Play aria-hidden="true" /> {busy ? 'Opening…' : playLabel}
            </Button>
          </div>
          {fastHelp !== null && <p id={`${ids}-speed-help`} className="text-xs text-muted-foreground">{fastHelp}</p>}
          <p id={`${ids}-time-help`} className={clockError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {clockError ?? 'Click or drag on the bar, use the arrow keys on it, or type the time (24-hour, for example 14:30).'}
          </p>
          {minute !== null && loaded && !loaded.error && !inRecording && blocks.length > 0 && (
            <p className="text-xs text-muted-foreground" role="status">
              There is no recording at {formatClock(minute)}.{later !== null && (
                <> The next one starts at {formatClock(later)}. <button type="button" className="underline" onClick={() => choose(later)}>Use {formatClock(later)}</button></>
              )}
            </p>
          )}
          {playError && <p role="alert" className="text-sm text-destructive">{playError}</p>}
        </section>
      </div>

      {session && (
        <div ref={playerBox} tabIndex={-1} className="space-y-2 outline-none" aria-label="Playback">
          <h2 className="text-sm font-semibold">Playing {session.label}</h2>
          {session.kind === 'fast' ? (
            <FastPlayer key={session.id} src={session.src} minutes={session.minutes} speed={session.speed} label={session.label} onStop={stop} onContinue={carryOn} />
          ) : (
            <PlaybackPlayer key={session.id} token={session.token} minutes={session.minutes} label={session.label} onStop={stop} onContinue={carryOn} />
          )}
        </div>
      )}
    </div>
  )
}
