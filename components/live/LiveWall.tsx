'use client'

import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { autoLayout, LAYOUTS, layoutLabel, pageCount, pageItems, pageStart, perPage, type Layout } from '@/lib/streams/wall'
import { cn } from '@/lib/utils'
import { LiveTile, type TileCamera } from './LiveTile'
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

const GRID: Record<Layout, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
}

/**
 * The wall: the cameras of one store, group or camera, shown a page at a time (1, 2 by 2, 3 by 3 or 4 by 4). Picking a picture opens it
 * large (the main stream). Pictures stop while the tab is hidden or a large picture is open, and every socket is closed when a tile goes.
 */
export function LiveWall({ cameras }: { cameras: TileCamera[] }) {
  const narrow = useNarrow()
  const visible = useTabVisible()
  const [chosen, setChosen] = useState<Layout | null>(null)
  const [start, setStart] = useState(0)
  const [enlarged, setEnlarged] = useState<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)

  // A phone starts with one big picture; a computer with the smallest wall that shows everything (at most 4 by 4).
  const layout: Layout = chosen ?? (narrow ? 1 : autoLayout(cameras.length))
  const first = Math.min(pageStart(start, layout), pageStart(Math.max(0, cameras.length - 1), layout))
  const page = pageItems(cameras, first, layout)
  const pages = pageCount(cameras.length, layout)
  const pageNo = Math.floor(first / perPage(layout)) + 1

  const grid = useOpenedStreams(page.map((c) => c.id), 'sub', visible)
  const big = enlarged ? cameras.find((c) => c.id === enlarged) : undefined
  const large = useOpenedStreams(big ? [big.id] : [], 'main', visible && !!big)

  const chooseLayout = (l: Layout) => {
    setChosen(l)
    setStart(pageStart(first, l)) // the first picture on the screen stays on the screen
  }
  const open = useCallback((id: string) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setEnlarged(id)
  }, [])
  const closeLarge = useCallback(() => {
    setEnlarged(null)
    trigger.current?.focus()
  }, [])

  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!big) return
    closeButton.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLarge()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [big, closeLarge])

  const loading = grid.phase === 'loading' && page.length > 0
  const to = Math.min(first + perPage(layout), cameras.length)

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {cameras.length === 0 ? 'No cameras' : `Showing ${first + 1}–${to} of ${cameras.length} ${cameras.length === 1 ? 'camera' : 'cameras'}`}
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
          {pages > 1 && (
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
        </div>
      </div>

      {grid.error && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {grid.error} Trying again in a moment.
        </p>
      )}

      {page.length > 0 && (
        <ul className={cn('grid gap-2', GRID[layout])}>
          {page.map((c) => {
            const s = grid.streams[c.id]
            return (
              <li key={c.id} className="min-w-0">
                <LiveTile camera={c} token={s?.token ?? null} failed={!s && !loading} paused={!visible || !!big} onOpen={() => open(c.id)} />
              </li>
            )
          })}
        </ul>
      )}

      {big && (
        <div role="dialog" aria-modal="true" aria-label={`${big.storeCode}, ${big.name}`} className="fixed inset-0 z-50 flex flex-col gap-2 bg-black/90 p-3 sm:p-6">
          <div className="flex items-center justify-between gap-2 text-white">
            <p className="min-w-0 truncate text-sm">
              <span className="font-mono font-semibold">{big.storeCode}</span> · {big.name}
            </p>
            <Button ref={closeButton} type="button" variant="secondary" onClick={closeLarge}>
              <X aria-hidden="true" /> Close
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div className="w-full">
              <LiveTile camera={big} size="large" token={large.streams[big.id]?.token ?? null} failed={!large.streams[big.id] && large.phase !== 'loading'} paused={!visible} />
            </div>
          </div>
          {large.error && <p role="status" className="text-center text-sm text-white/80">{large.error}</p>}
        </div>
      )}
    </div>
  )
}
