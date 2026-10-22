'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ExternalLink, History, Maximize2, Pause, Play, Plus, Square, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { removeCameraAction } from '@/lib/actions/groups'
import type { CameraState } from '@/lib/live/rollups'
import { allocateTiles, DEFAULT_MAX_STREAMS_PER_USER } from '@/lib/streams/concurrency'
import { INITIAL_TOUR, TOUR_SECONDS, tourReducer, tourRunning, tourStops } from '@/lib/streams/tour'
import { autoLayout, LAYOUTS, layoutLabel, pageCount, pageItems, pageStart, perPage, type Layout } from '@/lib/streams/wall'
import { cn } from '@/lib/utils'
import { LiveTile, type PauseReason, type TileCamera } from './LiveTile'
import { TileGroupDialog, type EditableGroup } from './TileGroupDialog'
import { useOpenedStreams, useTabVisible } from './useOpenedStreams'

const NARROW = '(max-width: 639px)'
const subscribeNarrow = (cb: () => void) => {
  const m = window.matchMedia(NARROW)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}
/** True on a phone-sized screen. The first render (on the server) assumes a wide one and is corrected straight away. */
function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false)
}

/** Which tiles are out of view (P4-L1: a tile scrolled out of view stops its stream; on the server every tile counts as on screen). */
function useOnScreen(): { observe: (id: string) => (el: HTMLElement | null) => void; offScreen: Set<string> } {
  // Only tiles the browser has reported out of view are off screen; a tile not reported yet counts as on screen (no flicker).
  const [offScreen, setOffScreen] = useState<Set<string>>(() => new Set())
  const observer = useRef<IntersectionObserver | null>(null)
  const ids = useRef(new Map<Element, string>())
  const seen = useRef(new Map<string, boolean>())
  // One stable ref callback per camera, so React calls it only when that tile appears or goes (never on every render).
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const o = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = ids.current.get(e.target)
        if (id) seen.current.set(id, e.isIntersecting)
      }
      const next = [...seen.current].filter(([, v]) => !v).map(([k]) => k).sort()
      setOffScreen((prev) => (prev && prev.size === next.length && next.every((k) => prev.has(k)) ? prev : new Set(next)))
    })
    observer.current = o
    for (const el of ids.current.keys()) o.observe(el)
    return () => {
      o.disconnect()
      observer.current = null
    }
  }, [])
  const observe = useCallback((id: string) => {
    let f = refs.current.get(id)
    if (!f) {
      let current: Element | null = null
      f = (el: HTMLElement | null) => {
        if (current) {
          observer.current?.unobserve(current)
          ids.current.delete(current)
          seen.current.delete(id)
        }
        current = el
        if (el) {
          ids.current.set(el, id)
          observer.current?.observe(el)
        } else refs.current.delete(id)
      }
      refs.current.set(id, f)
    }
    return f
  }, [])
  return { observe, offScreen }
}

const GRID: Record<Layout, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  5: 'grid-cols-5',
}

export type WallCamera = TileCamera & { locationId: string; state: CameraState; canPlayback: boolean }
/** `editable`: groups the person may add cameras to (only for people who may change groups); `current`: this wall's own group. */
export type GroupTools = { editable: EditableGroup[]; current?: { id: string; removable: string[] } }

const tileButton = 'inline-flex h-7 items-center gap-1 rounded-md bg-black/60 px-2 text-xs font-medium text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white'

/**
 * The wall (P4-L1): the cameras of one region, cluster, location, NVR, group or camera, a page at a time (1, 2 by 2, 3 by 3, 4 by 4
 * or 5 by 5). Tiles show sub-streams; a double-click (or Enter) opens one large with its main stream. At most `maxStreams` pictures play
 * at once (LIVE_MAX_STREAMS_PER_USER; the server counts the person's open streams too), the rest say "Paused to save bandwidth"; tiles
 * stop while the tab is hidden, while they are scrolled out of view and while the large picture is open, and every socket is closed when
 * a tile goes (another page, another wall, leaving the page). Tour mode moves through the pages — location by location on a wall of
 * several — every 5 to 60 seconds, skips locations whose recorder is not reachable, waits while the pointer is on the wall and stops
 * on any key.
 */
export function LiveWall({ cameras, maxStreams = DEFAULT_MAX_STREAMS_PER_USER, multiLocation = false, groupTools }: {
  cameras: WallCamera[]
  maxStreams?: number
  multiLocation?: boolean
  groupTools?: GroupTools
}) {
  const router = useRouter()
  const narrow = useNarrow()
  const visible = useTabVisible()
  const [chosen, setChosen] = useState<Layout | null>(null)
  const [start, setStart] = useState(0)
  const [enlarged, setEnlarged] = useState<string | null>(null)
  const [grouping, setGrouping] = useState<string | null>(null)
  const [tour, dispatch] = useReducer(tourReducer, INITIAL_TOUR)
  const [removing, startRemoving] = useTransition()
  const trigger = useRef<HTMLElement | null>(null)
  const { observe, offScreen } = useOnScreen()

  // A phone starts with one big picture; a computer with the smallest wall that shows everything (at most 4 by 4; 5 by 5 when chosen).
  const layout: Layout = chosen ?? (narrow ? 1 : autoLayout(cameras.length))
  const byId = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras])
  const stops = useMemo(
    () => tourStops(cameras.map((c) => ({ id: c.id, locationId: c.locationId, unreachable: c.state === 'unreachable' })), perPage(layout), multiLocation),
    [cameras, layout, multiLocation],
  )
  const touring = tour.running && stops.length > 0
  const stop = touring ? stops[tour.index % stops.length] : null
  const first = Math.min(pageStart(start, layout), pageStart(Math.max(0, cameras.length - 1), layout))
  const page = stop ? stop.ids.map((id) => byId.get(id)).filter((c): c is WallCamera => !!c) : pageItems(cameras, first, layout)
  const pages = pageCount(cameras.length, layout)
  const pageNo = Math.floor(first / perPage(layout)) + 1

  const grid = useOpenedStreams(page.map((c) => c.id), 'sub', visible)
  const big = enlarged ? byId.get(enlarged) : undefined
  const large = useOpenedStreams(big ? [big.id] : [], 'main', visible && !!big)
  const alloc = allocateTiles(page.map((c) => c.id), new Set(page.map((c) => c.id).filter((id) => !offScreen.has(id))), maxStreams, !!big)
  const overLimit = new Set([...alloc.bandwidth, ...grid.paused])
  const idle = new Set(alloc.idle)

  const chooseLayout = (l: Layout) => {
    setChosen(l)
    setStart(pageStart(first, l)) // the first picture on the screen stays on the screen
  }
  const open = useCallback((id: string) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEnlarged(id)
  }, [])
  const closeLarge = useCallback(() => setEnlarged(null), [])
  const closeGrouping = useCallback(() => setGrouping(null), [])

  // Tour: the next stop after the chosen interval, only while it runs, the pointer is off the wall and the tab is visible.
  const running = touring && tourRunning(tour, visible)
  useEffect(() => {
    if (!running) return
    const t = setTimeout(() => dispatch({ type: 'tick', stops: stops.length }), tour.seconds * 1000)
    return () => clearTimeout(t)
  }, [running, tour.index, tour.seconds, stops.length])
  // Any key stops the tour (modifier keys alone do not).
  useEffect(() => {
    if (!tour.running) return
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      dispatch({ type: 'key' })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tour.running])

  // While the large view is open: the dialog takes the focus, Escape closes it, the page behind does not scroll (and is inert, below).
  // When it closes the focus goes back to the picture that opened it (after the wall is no longer inert).
  const dialog = useRef<HTMLDivElement>(null)
  const isOpen = !!big
  useEffect(() => {
    if (!isOpen) {
      trigger.current?.focus()
      trigger.current = null
      return
    }
    dialog.current?.focus()
    const scrollLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLarge()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = scrollLock
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, closeLarge])

  const loading = grid.phase === 'loading' && page.length > 0
  const to = Math.min(first + perPage(layout), cameras.length)
  const removable = new Set(groupTools?.current?.removable ?? [])
  const removeFromGroup = (c: WallCamera) =>
    startRemoving(async () => {
      const res = await removeCameraAction(groupTools!.current!.id, c.id)
      if (res.error) toast.error(res.error)
      else {
        toast.success(res.message ?? 'Camera removed from the group.')
        router.refresh()
      }
    })
  const pauseOf = (id: string): PauseReason => (!visible ? 'hidden' : idle.has(id) ? 'idle' : overLimit.has(id) ? 'bandwidth' : false)
  const groupingCamera = grouping ? byId.get(grouping) : undefined

  return (
    <div className="min-w-0">
      {/* inert while a dialog is open: nothing behind it can be reached with the keyboard or a screen reader */}
      <div inert={isOpen || !!groupingCamera} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {cameras.length === 0
              ? 'No cameras'
              : stop
                ? `Tour: ${tour.index % stops.length + 1} of ${stops.length} · ${page[0]?.storeCode ?? ''} · every ${tour.seconds} s${tour.hovering ? ' · waiting while the pointer is on the wall' : ''} · press any key to stop`
                : `Showing ${first + 1}–${to} of ${cameras.length} ${cameras.length === 1 ? 'camera' : 'cameras'}`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Pictures per page" className="flex items-center gap-1">
              {LAYOUTS.map((l) => (
                <Button
                  key={l}
                  type="button"
                  size="sm"
                  variant={l === layout ? 'default' : 'outline'}
                  aria-pressed={l === layout}
                  aria-label={l === 1 ? 'One picture at a time' : `${l} by ${l}`}
                  onClick={() => chooseLayout(l)}
                >
                  {layoutLabel(l)}
                </Button>
              ))}
            </div>
            {pages > 1 && !stop && (
              <div className="flex items-center gap-1">
                <Button type="button" size="sm" variant="outline" aria-label="Previous page" disabled={pageNo <= 1} onClick={() => setStart(first - perPage(layout))}>
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <span className="min-w-20 text-center text-sm" aria-live="polite">Page {pageNo} of {pages}</span>
                <Button type="button" size="sm" variant="outline" aria-label="Next page" disabled={pageNo >= pages} onClick={() => setStart(first + perPage(layout))}>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            )}
            <div role="group" aria-label="Tour" className="flex items-center gap-1">
              <Select
                aria-label="Tour interval"
                value={tour.seconds}
                onChange={(e) => dispatch({ type: 'interval', seconds: Number(e.target.value) })}
                wrapperClassName="w-24"
                className="h-8"
              >
                {TOUR_SECONDS.map((s) => <option key={s} value={s}>{s} s</option>)}
              </Select>
              {tour.running ? (
                <Button type="button" size="sm" variant="outline" onClick={() => dispatch({ type: 'stop' })}>
                  <Square aria-hidden="true" /> Stop tour
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={stops.length < 2}
                  title={stops.length < 2 ? 'There is only one page to show.' : undefined}
                  onClick={() => {
                    setEnlarged(null)
                    dispatch({ type: 'start', stops: stops.length })
                  }}
                >
                  <Play aria-hidden="true" /> Start tour
                </Button>
              )}
              {stop && tour.hovering && <Pause aria-hidden="true" className="size-4 text-muted-foreground" />}
            </div>
          </div>
        </div>

        {grid.error && (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {grid.error} Trying again in a moment.
          </p>
        )}
        {overLimit.size > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            You are watching as many cameras as you may at once ({maxStreams}). The others are paused to save bandwidth.
          </p>
        )}

        {page.length > 0 && (
          <ul
            className={cn('grid gap-2', GRID[layout])}
            onMouseEnter={() => tour.running && dispatch({ type: 'hover', on: true })}
            onMouseLeave={() => tour.hovering && dispatch({ type: 'hover', on: false })}
          >
            {page.map((c) => {
              const s = grid.streams[c.id]
              const reason = pauseOf(c.id)
              const label = `${c.storeCode}, ${c.name}`
              return (
                <li key={c.id} ref={observe(c.id)} className="min-w-0">
                  <LiveTile
                    camera={c}
                    token={s?.token ?? null}
                    failed={!s && !loading && reason !== 'bandwidth'}
                    paused={reason}
                    onOpen={() => open(c.id)}
                    actions={
                      <>
                        <button type="button" className={tileButton} onClick={() => open(c.id)} aria-label={`Enlarge ${label}`}>
                          <Maximize2 aria-hidden="true" className="size-3.5" />
                        </button>
                        <a href={`/live?camera=${encodeURIComponent(c.id)}`} target="_blank" rel="noopener" className={tileButton} aria-label={`Open ${label} in a new window`}>
                          <ExternalLink aria-hidden="true" className="size-3.5" />
                        </a>
                        {c.canPlayback && (
                          <Link href={`/playback?camera=${encodeURIComponent(c.id)}`} className={tileButton} aria-label={`Play back ${label}`}>
                            <History aria-hidden="true" className="size-3.5" />
                          </Link>
                        )}
                        {groupTools && (
                          <button type="button" className={tileButton} onClick={() => setGrouping(c.id)}>
                            <Plus aria-hidden="true" className="size-3.5" /> <span className="sr-only">{label}: </span>Add to group
                          </button>
                        )}
                        {groupTools?.current && removable.has(c.id) && (
                          <button type="button" className={tileButton} disabled={removing} onClick={() => removeFromGroup(c)}>
                            <X aria-hidden="true" className="size-3.5" /> <span className="sr-only">{label}: </span>Remove from this group
                          </button>
                        )}
                      </>
                    }
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {big && (
        <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${big.storeCode}, ${big.name}`} className="fixed inset-0 z-50 flex flex-col gap-2 bg-black/90 p-3 outline-none sm:p-6">
          <div className="flex items-center justify-between gap-2 text-white">
            <p className="min-w-0 truncate text-sm">
              <span translate="no" className="font-mono font-semibold">{big.storeCode}</span> · {big.name}
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <a href={`/live?camera=${encodeURIComponent(big.id)}`} target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline' })}>
                <ExternalLink aria-hidden="true" /> New window
              </a>
              {big.canPlayback && (
                <Link href={`/playback?camera=${encodeURIComponent(big.id)}`} className={buttonVariants({ variant: 'outline' })}>
                  <History aria-hidden="true" /> Playback
                </Link>
              )}
              <Button type="button" variant="secondary" onClick={closeLarge}>
                <X aria-hidden="true" /> Close
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="w-full">
              <LiveTile camera={big} size="large" token={large.streams[big.id]?.token ?? null} failed={!large.streams[big.id] && large.phase !== 'loading' && !large.paused.includes(big.id)} paused={!visible ? 'hidden' : large.paused.includes(big.id) ? 'bandwidth' : false} />
            </div>
          </div>
          {large.error && <p role="status" className="text-center text-sm text-white/80">{large.error}</p>}
        </div>
      )}

      {groupingCamera && groupTools && (
        <TileGroupDialog camera={{ id: groupingCamera.id, label: `${groupingCamera.storeCode}, ${groupingCamera.name}` }} groups={groupTools.editable} onClose={closeGrouping} />
      )}
    </div>
  )
}
