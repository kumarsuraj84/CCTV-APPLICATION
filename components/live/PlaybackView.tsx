'use client'

import { Play } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { listDaySegmentsAction, listRecordedDaysAction, oldestRecordingAction, openFastPlaybackAction, openPlaybackAction } from '@/lib/actions/playback'
import { clampDay, dayLabel, dayNavigation, monthInBounds, shiftMonth } from '@/lib/streams/calendar'
import { fastMinutes, isSpeed, MAX_FAST_MINUTES, SPEEDS, speedLabel, type Speed } from '@/lib/streams/speed'
import {
  DAY_SECONDS,
  daySpans,
  DEFAULT_LENGTH,
  formatClockSeconds,
  formatShortDateTime,
  FULL_DAY,
  isFullDay,
  isPlayableStart,
  JUMPS,
  jumpLabel,
  keyMove,
  LENGTH_CHOICES,
  panView,
  parseClockSeconds,
  parseDay,
  shiftTime,
  spanAt,
  startIsoAt,
  type View,
} from '@/lib/streams/timeline'
import { DayCalendar } from './DayCalendar'
import { DayTimeline } from './DayTimeline'
import { FastStreamPlayer } from './FastStreamPlayer'
import { PlaybackPlayer } from './PlaybackPlayer'

/**
 * Fast playback 2x-16x (decision D-L1: part of cctv.playback, which everybody on this screen holds for the camera): offered when the server
 * can do it ('available'), or not set up here ('not-set-up': only 1x, and the screen says why).
 */
export type FastPlayback = 'available' | 'not-set-up'

export type PlaybackCamera = { id: string; name: string; storeCode: string }

type Segments = { start: string; end: string }[]
type DaysLoaded = { key: string; days: number[]; error: string | null }
type DayLoaded = { key: string; segments: Segments; truncated: boolean; skipped: number; error: string | null }
type Oldest = { key: string; iso: string | null; error: string | null }
type Session = { id: number; minutes: number; label: string; startIso: string } & ({ kind: 'live'; token: string } | { kind: 'fast'; token: string; speed: Speed })

const COULD_NOT_REACH = 'Could not reach the server.'
const MSG_TIME_FORMAT = 'Type the time as 24-hour HH:MM or HH:MM:SS, for example 14:30.'
const MSG_OUT_OF_RANGE = 'That time cannot be played: recordings can be played from the last year, up to now.'

/** The real clock, read only from event handlers (a jump), never while rendering. */
const realNow = () => Date.now()
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const dayOfMs = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const secOfMs = (ms: number) => Math.floor((ms - dayStartMs(dayOfMs(ms))) / 1000)

/** "Thursday 3 September 2026, 08:14" for a shown-time ISO string. */
function shownLabel(iso: string): string {
  const d = new Date(iso)
  return `${dayLabel(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())}, ${formatClockSeconds(secOfMs(d.getTime())).slice(0, 5)}`
}

/**
 * Playback for one camera: a month to pick the day from (with the oldest recording), the day's recordings on a bar that zooms and pans,
 * a start time (click or drag on the bar, the arrow keys, the jump buttons, or type it), a length, a speed, and the picture. Times are the
 * clock people see (India time, 24 hour). P4-L2: LG-9..LG-17.
 */
export function PlaybackView({ camera, today, initialDay, fastPlayback = 'not-set-up' }: { camera: PlaybackCamera; today: string; initialDay: string; fastPlayback?: FastPlayback }) {
  const startDay = clampDay(parseDay(initialDay) ? initialDay : today, today)
  const first = parseDay(startDay)!
  const [day, setDay] = useState(startDay)
  const [month, setMonth] = useState({ year: first.y, month: first.m })
  const [pick, setPick] = useState<{ day: string; sec: number } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [clockError, setClockError] = useState<string | null>(null)
  const [length, setLength] = useState<number>(DEFAULT_LENGTH)
  const [speed, setSpeed] = useState<Speed>(1)
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [playError, setPlayError] = useState<string | null>(null)
  const [daysLoaded, setDaysLoaded] = useState<DaysLoaded | null>(null)
  const [dayLoaded, setDayLoaded] = useState<DayLoaded | null>(null)
  const [oldest, setOldest] = useState<Oldest | null>(null)
  const [zoom, setZoom] = useState<View>(FULL_DAY)
  const [progress, setProgress] = useState<{ id: number; sec: number } | null>(null)
  const fastSpeedNow = useRef<Speed>(1)
  const playerBox = useRef<HTMLDivElement>(null)
  const playButton = useRef<HTMLButtonElement>(null)
  const nextId = useRef(1)
  const ids = useId()

  // The calendar of the month on the screen, in shown days (the recorder's clock offset applied on the server).
  const monthKey = `${month.year}-${month.month}`
  useEffect(() => {
    let off = false
    listRecordedDaysAction(camera.id, month.year, month.month)
      .then((r) => { if (!off) setDaysLoaded({ key: monthKey, days: r.ok ? r.days : [], error: r.ok ? null : r.error }) })
      .catch(() => { if (!off) setDaysLoaded({ key: monthKey, days: [], error: COULD_NOT_REACH }) })
    return () => { off = true }
  }, [camera.id, month.year, month.month, monthKey])
  const marks = daysLoaded?.key === monthKey ? daysLoaded : null

  // LG-9: when the oldest recording of this camera starts.
  useEffect(() => {
    let off = false
    oldestRecordingAction(camera.id)
      .then((r) => { if (!off) setOldest({ key: camera.id, iso: r.ok ? r.oldest : null, error: r.ok ? null : r.error }) })
      .catch(() => { if (!off) setOldest({ key: camera.id, iso: null, error: COULD_NOT_REACH }) })
    return () => { off = true }
  }, [camera.id])
  const oldestNow = oldest?.key === camera.id ? oldest : null
  const oldestDay = oldestNow?.iso ? oldestNow.iso.slice(0, 10) : null

  // The recordings of the chosen day.
  useEffect(() => {
    let off = false
    listDaySegmentsAction(camera.id, day)
      .then((r) => { if (!off) setDayLoaded(r.ok ? { key: day, segments: r.segments, truncated: r.truncated, skipped: r.skipped, error: null } : { key: day, segments: [], truncated: false, skipped: 0, error: r.error }) })
      .catch(() => { if (!off) setDayLoaded({ key: day, segments: [], truncated: false, skipped: 0, error: COULD_NOT_REACH }) })
    return () => { off = true }
  }, [camera.id, day])
  const loaded = dayLoaded?.key === day ? dayLoaded : null
  const unknown = !!loaded?.error

  const spans = useMemo(() => daySpans(day, loaded?.segments ?? []), [day, loaded])
  const parsed = parseDay(day)
  const label = parsed ? dayLabel(parsed.y, parsed.m, parsed.d) : day
  // Until a time is picked, the first recording of the day is the start.
  const sec = pick?.day === day ? pick.sec : (spans[0]?.startSec ?? null)
  const clock = draft ?? (sec === null ? '' : formatClockSeconds(sec))
  const inRecording = sec !== null && spanAt(spans, sec) !== null
  const later = sec !== null ? (spans.find((s) => s.startSec > sec)?.startSec ?? null) : null

  // Where the picture is now (from the player's own clock), on this day's bar.
  const playingMs = session && progress?.id === session.id ? Date.parse(session.startIso) + progress.sec * 1000 : null
  const position = playingMs !== null && dayOfMs(playingMs) === day ? secOfMs(playingMs) : null

  // The calendar goes back 12 months and never past the current month. Review I-3: the oldest recording is a hint ("Go to it") and
  // NEVER limits navigation (an NVR's answer may not be the true oldest).
  const before = shiftMonth(month.year, month.month, -1)
  const after = shiftMonth(month.year, month.month, 1)
  const canPrev = monthInBounds(before.year, before.month, today)
  const canNext = monthInBounds(after.year, after.month, today)
  const previousDay = shiftTime(day, 0, -DAY_SECONDS).day
  const { canPreviousDay, canNextDay } = dayNavigation(day, today)

  const choose = (s: number, d = day) => {
    setPick({ day: d, sec: s })
    setDraft(null)
    setClockError(null)
  }
  const commitClock = () => {
    if (draft === null) return
    const s = parseClockSeconds(draft)
    if (s === null) {
      setClockError(MSG_TIME_FORMAT)
      return
    }
    choose(s)
  }
  const changeMonth = (delta: number) => setMonth((v) => {
    const to = shiftMonth(v.year, v.month, delta)
    return monthInBounds(to.year, to.month, today) ? to : v
  })
  const selectDay = (d: string, o: { keepZoom?: boolean } = {}) => {
    setDay(d)
    setPlayError(null)
    // A time that was typed for another day is not carried over.
    setDraft(null)
    setClockError(null)
    if (!o.keepZoom) setZoom(FULL_DAY)
    const p = parseDay(d)
    if (p) setMonth((m) => (m.year === p.y && m.month === p.m ? m : { year: p.y, month: p.m }))
    // Keep the address in step so the page can be shared or reloaded (the server page reads ?day=).
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('day', d)
      window.history.replaceState(null, '', url)
    } catch {
      // the address bar is not essential
    }
  }
  // LG-12: the edge of the bar opened the day before or after; a zoomed-in window keeps its width, at the matching end of the new day.
  const edgeDay = (direction: 'previous' | 'next') => {
    if (direction === 'previous' ? !canPreviousDay : !canNextDay) return
    const to = shiftTime(day, 0, direction === 'next' ? DAY_SECONDS : -DAY_SECONDS).day
    const width = zoom.end - zoom.start
    selectDay(to, { keepZoom: true })
    if (!isFullDay(zoom)) setZoom(direction === 'next' ? { start: 0, end: width } : { start: DAY_SECONDS - width, end: DAY_SECONDS })
  }

  // Fast playback is offered when the server can do it (D-L1: every viewer here holds cctv.playback for the camera).
  const fast = fastPlayback === 'available'
  const playSpeed: Speed = fast ? speed : 1

  const start = async (iso: string, minutes: number, text: string, at: Speed = playSpeed) => {
    setPlayError(null)
    const what = `${camera.storeCode}, ${camera.name}, ${text}`
    setBusy(true)
    try {
      if (at !== 1) {
        const clip = fastMinutes(minutes)
        const res = await openFastPlaybackAction(camera.id, iso, clip, at)
        if (!res.ok) {
          setPlayError(res.error)
          toast.error(res.error)
          return
        }
        fastSpeedNow.current = at
        setSession({ id: nextId.current++, kind: 'fast', token: res.token, speed: at, minutes: res.minutes, label: what, startIso: iso })
      } else {
        const res = await openPlaybackAction(camera.id, iso, minutes)
        if (!res.ok) {
          setPlayError(res.error)
          toast.error(res.error)
          return
        }
        setSession({ id: nextId.current++, kind: 'live', token: res.token, minutes, label: what, startIso: iso })
      }
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
    const s = draft !== null ? parseClockSeconds(draft) : sec
    if (s === null) {
      setClockError(MSG_TIME_FORMAT)
      return
    }
    if (draft !== null) choose(s)
    void start(startIsoAt(day, s), length, `${label}, ${formatClockSeconds(s)}`)
  }
  const stop = () => {
    setSession(null)
    setProgress(null)
    setTimeout(() => playButton.current?.focus(), 0)
  }
  const carryOn = (seconds: number) => {
    if (!session) return
    const from = new Date(Date.parse(session.startIso) + seconds * 1000)
    const remaining = Math.max(1, Math.ceil((session.minutes * 60 - seconds) / 60))
    void start(from.toISOString().replace(/\.\d{3}Z$/, 'Z'), remaining, `from ${formatShortDateTime(from.toISOString())}`, session.kind === 'fast' ? fastSpeedNow.current : 1)
  }

  // LG-13: jump from where the picture is (or from the chosen time when nothing plays), across midnight when needed.
  const jump = (delta: number) => {
    const baseMs = playingMs ?? (sec !== null ? dayStartMs(day) + sec * 1000 : null)
    if (baseMs === null) return
    const to = shiftTime(dayOfMs(baseMs), secOfMs(baseMs), delta)
    const iso = startIsoAt(to.day, to.sec)
    if (!isPlayableStart(Date.parse(iso), realNow())) {
      setPlayError(MSG_OUT_OF_RANGE)
      return
    }
    if (to.day !== day) selectDay(to.day, { keepZoom: true })
    choose(to.sec, to.day)
    setZoom((v) => (to.sec >= v.start && to.sec < v.end ? v : panView(v, to.sec - (v.start + v.end) / 2)))
    if (session) {
      const toLabel = to.day === day ? label : (() => { const p = parseDay(to.day)!; return dayLabel(p.y, p.m, p.d) })()
      void start(iso, length, `${toLabel}, ${formatClockSeconds(to.sec)}`, session.kind === 'fast' ? fastSpeedNow.current : 1)
    }
  }
  const playerKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('button, input, select, textarea, [role="slider"]')) return
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? keyMove(e.key, e.shiftKey) : null
    if (delta === null) return
    e.preventDefault()
    jump(delta)
  }

  const playLabel = playSpeed === 1 ? `Play ${length} minutes` : `Play ${fastMinutes(length)} minutes at ${speedLabel(playSpeed)}`
  // Under the speed: why only 1x is offered, or that fast playback is shorter than the longest normal playback.
  const fastHelp = !fast ? 'Fast playback is not set up on this server.' : playSpeed !== 1 && length > MAX_FAST_MINUTES ? `Fast playback shows at most ${MAX_FAST_MINUTES} minutes.` : null

  const summary = !loaded
    ? 'Loading the recordings…'
    : loaded.error
      ? ''
      : spans.length === 0
        ? 'No recordings on this day.'
        : `${spans.length} ${spans.length === 1 ? 'recording' : 'recordings'} on this day, from ${formatClockSeconds(spans[0].startSec).slice(0, 5)} to ${formatClockSeconds(spans[spans.length - 1].endSec).slice(0, 5)}.`

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-[auto_1fr]">
        <div className="min-w-0 md:max-w-sm">
          <DayCalendar year={month.year} month={month.month} selected={day} today={today} marked={marks?.days ?? []} onSelect={(d) => selectDay(d)} onMonth={changeMonth} canPrev={canPrev} canNext={canNext} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => selectDay(today)}>
              Today
            </Button>
            {marks?.error && <p role="status" className="text-xs text-muted-foreground">Could not mark the days with recordings: {marks.error}</p>}
          </div>
          <p role="status" className="mt-2 max-w-sm text-xs text-muted-foreground">
            {!oldestNow
              ? 'Looking for the oldest recording…'
              : oldestNow.error
                ? `Could not find the oldest recording: ${oldestNow.error}`
                : oldestNow.iso
                  ? <>Oldest recording in the last year: {shownLabel(oldestNow.iso)}.{' '}
                      {oldestDay && oldestDay !== day && (
                        <button type="button" className="underline" onClick={() => { selectDay(oldestDay); choose(secOfMs(Date.parse(oldestNow.iso!)), oldestDay) }}>Go to it</button>
                      )}
                    </>
                  : 'No recordings were found in the last year.'}
          </p>
        </div>

        <section aria-labelledby={`${ids}-day`} className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id={`${ids}-day`} className="text-sm font-semibold">{label}</h2>
              <p className="text-xs text-muted-foreground">Times are India time (IST), 24-hour.</p>
            </div>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="outline" aria-disabled={!canPreviousDay} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => canPreviousDay && selectDay(previousDay, { keepZoom: true })}>
                Previous day
              </Button>
              <Button type="button" size="sm" variant="outline" aria-disabled={!canNextDay} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => canNextDay && selectDay(shiftTime(day, 0, DAY_SECONDS).day, { keepZoom: true })}>
                Next day
              </Button>
            </div>
          </div>

          {loaded?.error && (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              The list of recordings could not be read: {loaded.error} You can still choose a time and try to play it.
            </p>
          )}
          <div aria-live="polite" className="text-sm">
            {!loaded?.error && <p className="text-muted-foreground">{summary}</p>}
            {loaded && !loaded.error && loaded.truncated && (
              <p className="text-amber-800 dark:text-amber-300">There are too many recordings on this day to show them all. The first part is shown.</p>
            )}
            {loaded && !loaded.error && loaded.skipped > 0 && <p className="text-amber-800 dark:text-amber-300">Some recordings could not be read.</p>}
          </div>

          <DayTimeline
            label={label}
            spans={spans}
            second={sec}
            position={position}
            view={zoom}
            onView={setZoom}
            onPick={(s) => choose(s)}
            onEdgeDay={edgeDay}
            canPreviousDay={canPreviousDay}
            canNextDay={canNextDay}
            disabled={!loaded}
            unknown={unknown}
          />

          <div role="group" aria-label="Jump" className="flex flex-wrap gap-1">
            {JUMPS.map((d) => (
              <Button key={d} type="button" size="sm" variant="outline" aria-label={jumpLabel(d)} disabled={sec === null && playingMs === null} onClick={() => jump(d)} className="font-mono">
                {d < 0 ? '−' : '+'}{Math.abs(d) / 60} min
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-time`}>Start time</Label>
              <Input
                id={`${ids}-time`}
                value={clock}
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                placeholder="HH:MM:SS"
                aria-describedby={`${ids}-time-help`}
                aria-invalid={clockError !== null}
                className="w-28 font-mono"
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
              <Select id={`${ids}-length`} value={length} onChange={(e) => setLength(Number(e.target.value))} wrapperClassName="w-auto">
                {LENGTH_CHOICES.map((n) => <option key={n} value={n}>{n} minutes</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-speed`}>Speed</Label>
              <Select
                id={`${ids}-speed`}
                value={playSpeed}
                onChange={(e) => { const n = Number(e.target.value); if (isSpeed(n)) setSpeed(n) }}
                aria-describedby={fastHelp === null ? undefined : `${ids}-speed-help`}
                wrapperClassName="w-auto"
              >
                {(fast ? SPEEDS : SPEEDS.filter((s) => s === 1)).map((s) => <option key={s} value={s}>{speedLabel(s)}</option>)}
              </Select>
            </div>
            <Button ref={playButton} type="button" onClick={play} disabled={busy || (sec === null && draft === null)}>
              <Play aria-hidden="true" /> {busy ? 'Opening…' : playLabel}
            </Button>
          </div>
          {fastHelp !== null && <p id={`${ids}-speed-help`} className="text-xs text-muted-foreground">{fastHelp}</p>}
          <p id={`${ids}-time-help`} className={clockError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {clockError ??
              'Click or drag on the bar (a click goes to the nearest recording), or type the time. On the bar the left and right arrow keys move 30 seconds (with Shift 5 minutes), + and − zoom, 0 shows the whole day; the mouse wheel zooms too.'}
          </p>
          {sec !== null && loaded && !loaded.error && !inRecording && spans.length > 0 && (
            <p className="text-xs text-muted-foreground" role="status">
              There is no recording at {formatClockSeconds(sec)}.{later !== null && (
                <> The next one starts at {formatClockSeconds(later)}. <button type="button" className="underline" onClick={() => choose(later)}>Use {formatClockSeconds(later)}</button></>
              )}
            </p>
          )}
          {playError && <p role="alert" className="text-sm text-destructive">{playError}</p>}
        </section>
      </div>

      {session && (
        <div ref={playerBox} tabIndex={-1} className="space-y-2 outline-none" aria-label="Playback" onKeyDown={playerKeys}>
          <h2 className="text-sm font-semibold">Playing {session.label}</h2>
          {session.kind === 'fast' ? (
            <FastStreamPlayer
              key={session.id}
              token={session.token}
              minutes={session.minutes}
              speed={session.speed}
              label={session.label}
              onStop={stop}
              onContinue={carryOn}
              onProgress={(s) => setProgress({ id: session.id, sec: s })}
              onSpeedChange={(s) => (fastSpeedNow.current = s)}
            />
          ) : (
            <PlaybackPlayer key={session.id} token={session.token} minutes={session.minutes} label={session.label} onStop={stop} onContinue={carryOn} onProgress={(s) => setProgress({ id: session.id, sec: s })} />
          )}
          <p className="text-xs text-muted-foreground">Use the jump buttons, or the left and right arrow keys here: 30 seconds, with Shift 5 minutes.</p>
        </div>
      )}
    </div>
  )
}
