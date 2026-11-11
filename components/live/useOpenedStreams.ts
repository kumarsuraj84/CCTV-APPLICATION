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
  /** Final fix X (review C I-2): cameras of an NVR whose login stands refused, with the server's words (asked again every 30 s; no NVR contact). */
  unavailable: Record<string, string>
}

const fresh = (key: string): State => ({ key, phase: 'loading', streams: {}, error: null, issuedAt: 0, fullAt: 0, triedAt: 0, refreshFailed: false, paused: [], unavailable: {} })

// P4-L1 review M-5: when each camera's stream was last opened in full (registered in go2rtc) in this page, per kind. A list made only of
// cameras opened in full within 8 minutes (a tour going round, a tab coming back) starts with new tokens alone: no NVR login, no go2rtc
// request, no second audit row; the 8-minute full opening still comes on time.
const openedAt = new Map<string, number>()
const recently = (kind: 'sub' | 'main', now: number) => (id: string) => now - (openedAt.get(`${kind}:${id}`) ?? 0) < REOPEN_AFTER_MS
const oldestOpen = (kind: 'sub' | 'main', ids: string[]) => Math.min(...ids.map((id) => openedAt.get(`${kind}:${id}`) ?? 0))

// Fix round 2 (re-review N-1): what the page last asked for, per kind, kept at MODULE level (one per page, not per component), so the
// first request of the next wall — another component after a route change — releases the cameras of the wall that was left.
const lastAsked = new Map<'sub' | 'main', string[]>()

// Fix round 2 (re-review N-6): this window's id (one per page load), sent with every request; the database stamps the window's media
// sessions with it and a release on a request only reaches that window's own tokens. Made with getRandomValues (randomUUID needs https).
let windowIdValue: string | null = null
export function windowId(): string {
  if (windowIdValue) return windowIdValue
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  windowIdValue = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  return windowIdValue
}

// Fix round 2 (N-1): leaving (route change = unmount, pagehide, the tab hidden, the idle prompt, the large picture over the grid) hands
// the tokens the wall holds back to the server (POST /api/live/release, keepalive, best effort): the unused ones — the one-minute
// renewal's — stop counting against the person's cap at once instead of for up to 90 s. Each token is handed back once.
const handedBack = new Set<string>()
export function releaseHeld(tokens: string[]): void {
  const fresh = tokens.filter((t) => !handedBack.has(t))
  if (fresh.length === 0 || typeof fetch !== 'function') return
  if (handedBack.size > 2_000) handedBack.clear()
  for (const t of fresh) handedBack.add(t)
  try {
    void fetch('/api/live/release', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokens: fresh }) }).catch(() => {})
  } catch {
    // best effort: the tokens run out on their own (90 s), and the next wall's first request releases these cameras anyway
  }
}

/**
 * Opens the streams for `ids` while `active`, and keeps their tokens fresh (P2-4: a token connects within 90 s): every minute the
 * tokens alone are renewed (renewStreamTokensAction: cctv.live and the person's stream cap checked again, new media sessions, no NVR or
 * go2rtc work), every 8 minutes everything is opened again in full, and the cameras that could not be opened (or the whole list, when
 * nothing opened) are asked for again in full every 30 seconds (lib/streams/wall.ts planRequest). When `active` turns false (the tab is
 * hidden, the large picture is open, nobody is at the screen) everything is dropped, so tiles close their sockets; becoming active again
 * asks for new tokens. Only cameras on `ids` are ever asked for. P4-L1 review I-1: when the list changes, the cameras that left it are
 * released with the next request (their unused tokens stop counting against the cap at once), and `release` adds what another part of
 * the wall let go of (the grid behind the large picture). Fix round 2 (N-1): what was last asked is kept per page (so the next wall
 * releases it too), and leaving hands the held tokens back (releaseHeld); N-6: every request names this window (windowId).
 */
export function useOpenedStreams(ids: string[], kind: 'sub' | 'main', active: boolean, opts: { release?: StreamRelease[] } = {}) {
  const key = `${active ? 'on' : 'off'}|${kind}|${ids.join(',')}`
  const [state, setState] = useState<State>(() => fresh(key))
  // A different list, kind or activity starts again from nothing (nothing from the old list is kept).
  if (state.key !== key) setState(fresh(key))
  const current = state.key === key ? state : fresh(key)
  // The tokens this hook holds as of the last commit, for the leave release (read in the cleanups below, before they are replaced).
  const heldTokens = useRef<string[]>([])
  useEffect(() => {
    heldTokens.current = active ? Object.values(current.streams).map((s) => s.token) : []
  })
  useEffect(() => {
    if (!active) return
    const onPageHide = () => releaseHeld(heldTokens.current)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      releaseHeld(heldTokens.current) // unmount (a route change) or no longer active (hidden tab, idle prompt, large picture)
    }
  }, [active])

  const failed = (error: string) =>
    setState((prev) => (prev.key !== key ? prev : { ...prev, phase: Object.keys(prev.streams).length > 0 ? 'ready' : 'error', error, triedAt: Date.now(), refreshFailed: true }))

  const run = (which: string[], mode: 'open' | 'full' | 'tokens', first: boolean) => {
    const own = first ? releaseFor(lastAsked.get(kind) ?? [], ids) : []
    const release = [...(own.length > 0 ? [{ cameraIds: own, kind }] : []), ...(first ? (opts.release ?? []) : [])].filter((r) => r.cameraIds.length > 0)
    const options = release.length > 0 ? { release, client: windowId() } : { client: windowId() }
    lastAsked.set(kind, ids)
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
          const unavailable: Record<string, string> = everyone ? {} : Object.fromEntries(Object.entries(prev.unavailable).filter(([id]) => !which.includes(id)))
          for (const u of res.unavailable ?? []) unavailable[u.cameraId] = u.message
          return { ...prev, phase: 'ready', streams, error: null, triedAt: now, refreshFailed: false, issuedAt: everyone ? now : prev.issuedAt, fullAt: everyone ? now : prev.fullAt, paused, unavailable }
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

  /** The gateway refused a camera's socket because its NVR login stands refused: its token is dropped, so the next request asks the server. */
  const forget = (cameraId: string) =>
    setState((prev) => {
      if (prev.key !== key || !prev.streams[cameraId]) return prev
      const streams = { ...prev.streams }
      delete streams[cameraId]
      return { ...prev, streams }
    })

  return {
    phase: current.phase, streams: active ? current.streams : ({} as Record<string, HeldStream>), error: current.error, paused: active ? current.paused : [],
    unavailable: active ? current.unavailable : ({} as Record<string, string>), forget,
  }
}
