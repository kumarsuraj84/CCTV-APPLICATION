'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { openStreamsAction, refreshStreamTokensAction, renewStreamTokensAction } from '@/lib/actions/streams'
import { releaseFor } from '@/lib/streams/concurrency'
import type { StreamRelease } from '@/lib/streams/open'
import { planRequest, REOPEN_AFTER_MS } from '@/lib/streams/wall'

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb)
  return () => document.removeEventListener('visibilitychange', cb)
}

/** Coming back to the tab is acted on only after this long, so quickly switching tabs back and forth does not ask for new streams each time. */
export const VISIBLE_DEBOUNCE_MS = 500

/** False while the browser tab is hidden or the window is minimised (at once); true again 500 ms after it comes back. */
export function useTabVisible(): boolean {
  const now = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible', () => true)
  const [settled, setSettled] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(now), now ? VISIBLE_DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  }, [now])
  return now && settled
}

/** What a tile needs: its token (only used to connect). */
export type HeldStream = { cameraId: string; token: string }

type Phase = 'loading' | 'ready' | 'error'
type State = {
  key: string
  phase: Phase
  streams: Record<string, HeldStream>
  error: string | null
  /** When the tokens were last renewed for the whole list (ms). */
  issuedAt: number
  /** When the whole list was last opened in full (streams registered), for the 8-minute full renewal (P2-4 review m-11). */
  fullAt: number
  /** When the last request finished (ms), for the 30 second retry. */
  triedAt: number
  /** A request after the first one failed (the tokens in hand are still good for a while). */
  refreshFailed: boolean
  /** P4-L1: cameras the server left out because the person's live streams are at their limit (asked for again every 30 s). */
  paused: string[]
}

const fresh = (key: string): State => ({ key, phase: 'loading', streams: {}, error: null, issuedAt: 0, fullAt: 0, triedAt: 0, refreshFailed: false, paused: [] })

// P4-L1 review M-5: when each camera's stream was last opened in full (registered in go2rtc) in this page, per kind. A list made only of
// cameras opened in full within 8 minutes (a tour going round, a tab coming back) starts with new tokens alone: no NVR login, no go2rtc
// request, no second audit row; the 8-minute full opening still comes on time.
const openedAt = new Map<string, number>()
const recently = (kind: 'sub' | 'main', now: number) => (id: string) => now - (openedAt.get(`${kind}:${id}`) ?? 0) < REOPEN_AFTER_MS
const oldestOpen = (kind: 'sub' | 'main', ids: string[]) => Math.min(...ids.map((id) => openedAt.get(`${kind}:${id}`) ?? 0))

/**
 * Opens the streams for `ids` while `active`, and keeps their tokens fresh (P2-4: a token connects within 90 s): every minute the
 * tokens alone are renewed (renewStreamTokensAction: cctv.live and the person's stream cap checked again, new media sessions, no NVR or
 * go2rtc work), every 8 minutes everything is opened again in full, and the cameras that could not be opened (or the whole list, when
 * nothing opened) are asked for again in full every 30 seconds (lib/streams/wall.ts planRequest). When `active` turns false (the tab is
 * hidden, the large picture is open, nobody is at the screen) everything is dropped, so tiles close their sockets; becoming active again
 * asks for new tokens. Only cameras on `ids` are ever asked for. P4-L1 review I-1: when the list changes, the cameras that left it are
 * released with the next request (their unused tokens stop counting against the cap at once), and `release` adds what another part of
 * the wall let go of (the grid behind the large picture).
 */
export function useOpenedStreams(ids: string[], kind: 'sub' | 'main', active: boolean, opts: { release?: StreamRelease[] } = {}) {
  const key = `${active ? 'on' : 'off'}|${kind}|${ids.join(',')}`
  const [state, setState] = useState<State>(() => fresh(key))
  // A different list, kind or activity starts again from nothing (nothing from the old list is kept).
  if (state.key !== key) setState(fresh(key))
  const current = state.key === key ? state : fresh(key)
  // What this hook last asked for, so the cameras that left the list can be released (review I-1).
  const lastAsked = useRef<string[]>([])

  const failed = (error: string) =>
    setState((prev) => (prev.key !== key ? prev : { ...prev, phase: Object.keys(prev.streams).length > 0 ? 'ready' : 'error', error, triedAt: Date.now(), refreshFailed: true }))

  const run = (which: string[], mode: 'open' | 'full' | 'tokens', first: boolean) => {
    const own = first ? releaseFor(lastAsked.current, ids) : []
    const release = [...(own.length > 0 ? [{ cameraIds: own, kind }] : []), ...(first ? (opts.release ?? []) : [])].filter((r) => r.cameraIds.length > 0)
    const options = release.length > 0 ? { release } : undefined
    lastAsked.current = ids
    if (mode === 'tokens') {
      renewStreamTokensAction(which, kind, options)
        .then((res) => {
          if (!res.ok) return failed(res.error)
          setState((prev) => {
            if (prev.key !== key) return prev
            // Only the tokens change; a camera that did not come back (no longer allowed, its NVR switched off, over the cap) is dropped
            // from the held list (and, when paused, waits for the 30 s retry). The first request of a list is a whole one.
            const streams: Record<string, HeldStream> = {}
            for (const t of res.tokens) if (first || prev.streams[t.cameraId]) streams[t.cameraId] = { cameraId: t.cameraId, token: t.token }
            const now = Date.now()
            return {
              ...prev, phase: 'ready', streams, error: null, triedAt: now, refreshFailed: false, issuedAt: now,
              fullAt: first ? oldestOpen(kind, which) : prev.fullAt, paused: res.paused ?? [],
            }
          })
        })
        .catch(() => failed('Could not reach the server.'))
      return
    }
    const call = mode === 'open' ? openStreamsAction : refreshStreamTokensAction
    call(which, kind, options)
      .then((res) => {
        setState((prev) => {
          if (prev.key !== key) return prev // the list changed while asking
          const now = Date.now()
          if (!res.ok) return { ...prev, phase: Object.keys(prev.streams).length > 0 ? 'ready' : 'error', error: res.error, triedAt: now, refreshFailed: true }
          for (const s of res.streams) openedAt.set(`${kind}:${s.cameraId}`, now)
          // A renewal of the whole list replaces what was held: a camera that did not come back (it failed, or the person may no longer
          // see it) loses its old token and is asked for again. Asking only for the missing ones adds to what is held.
          const everyone = which.length === ids.length
          const streams: Record<string, HeldStream> = everyone ? {} : { ...prev.streams }
          for (const s of res.streams) streams[s.cameraId] = { cameraId: s.cameraId, token: s.token }
          const paused = everyone ? (res.paused ?? []) : [...prev.paused.filter((id) => !which.includes(id)), ...(res.paused ?? [])]
          return { ...prev, phase: 'ready', streams, error: null, triedAt: now, refreshFailed: false, issuedAt: everyone ? now : prev.issuedAt, fullAt: everyone ? now : prev.fullAt, paused }
        })
      })
      .catch(() => {
        setState((prev) => (prev.key !== key ? prev : { ...prev, phase: Object.keys(prev.streams).length > 0 ? 'ready' : 'error', error: 'Could not reach the server.', triedAt: Date.now(), refreshFailed: true }))
      })
  }

  const idsText = ids.join(',')
  const loaded = Object.keys(current.streams).join(',')
  const pausedText = current.paused.join(',')
  useEffect(() => {
    if (!active || ids.length === 0) return
    const now = Date.now()
    const plan = planRequest(ids, { ...current, held: Object.keys(current.streams) }, now, recently(kind, now))
    if (!plan) return
    const first = current.phase === 'loading'
    const timer = setTimeout(() => run(plan.which, plan.mode, first), Math.max(0, plan.at - Date.now()))
    return () => clearTimeout(timer)
    // `run` and `current` are rebuilt every render; what matters is which request is due, which these values say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, idsText, current.phase, current.issuedAt, current.triedAt, current.refreshFailed, loaded, pausedText])

  return { phase: current.phase, streams: active ? current.streams : ({} as Record<string, HeldStream>), error: current.error, paused: active ? current.paused : [] }
}
