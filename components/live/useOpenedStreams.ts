'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { openStreamsAction, refreshStreamTokensAction } from '@/lib/actions/streams'
import type { OpenedStream } from '@/lib/streams/open'
import { REFRESH_AFTER_MS, RETRY_EVERY_MS } from '@/lib/streams/wall'

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb)
  return () => document.removeEventListener('visibilitychange', cb)
}

/** False while the browser tab is hidden or the window is minimised. */
export function useTabVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible', () => true)
}

type Phase = 'loading' | 'ready' | 'error'
type State = {
  key: string
  phase: Phase
  streams: Record<string, OpenedStream>
  error: string | null
  /** When the tokens were last renewed for the whole list (ms). */
  issuedAt: number
  /** When the last request finished (ms), for the 30 second retry. */
  triedAt: number
  /** A request after the first one failed (the tokens in hand are still good for a while). */
  refreshFailed: boolean
}

const fresh = (key: string): State => ({ key, phase: 'loading', streams: {}, error: null, issuedAt: 0, triedAt: 0, refreshFailed: false })

/**
 * Opens the streams for `ids` while `active`, and keeps their tokens fresh: renewed after 8 minutes, and the cameras that could not be
 * opened (or the whole list, when nothing opened) are asked for again every 30 seconds. When `active` turns false (the tab is hidden)
 * everything is dropped, so tiles close their sockets; becoming active again asks for new tokens. Only cameras on `ids` are ever asked
 * for, so nothing is renewed for a page nobody is looking at.
 */
export function useOpenedStreams(ids: string[], kind: 'sub' | 'main', active: boolean) {
  const key = `${active ? 'on' : 'off'}|${kind}|${ids.join(',')}`
  const [state, setState] = useState<State>(() => fresh(key))
  // A different list, kind or activity starts again from nothing (nothing from the old list is kept).
  if (state.key !== key) setState(fresh(key))
  const current = state.key === key ? state : fresh(key)

  const run = (which: string[], first: boolean) => {
    const call = first ? openStreamsAction : refreshStreamTokensAction
    call(which, kind)
      .then((res) => {
        setState((prev) => {
          if (prev.key !== key) return prev // the list changed while asking
          const now = Date.now()
          if (!res.ok) return { ...prev, phase: Object.keys(prev.streams).length > 0 ? 'ready' : 'error', error: res.error, triedAt: now, refreshFailed: true }
          const streams = { ...prev.streams }
          for (const s of res.streams) streams[s.cameraId] = s
          const everyone = which.length === ids.length
          return { ...prev, phase: 'ready', streams, error: null, triedAt: now, refreshFailed: false, issuedAt: everyone ? now : prev.issuedAt }
        })
      })
      .catch(() => {
        setState((prev) => (prev.key !== key ? prev : { ...prev, phase: Object.keys(prev.streams).length > 0 ? 'ready' : 'error', error: 'Could not reach the server.', triedAt: Date.now(), refreshFailed: true }))
      })
  }

  const idsText = ids.join(',')
  const loaded = Object.keys(current.streams).join(',')
  useEffect(() => {
    if (!active || ids.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    if (current.phase === 'loading') {
      timer = setTimeout(() => run(ids, true), 0)
    } else {
      const missing = ids.filter((id) => !current.streams[id])
      const retryAt = current.phase === 'error' || current.refreshFailed || missing.length > 0 ? current.triedAt + RETRY_EVERY_MS : Infinity
      const renewAt = current.issuedAt > 0 ? current.issuedAt + REFRESH_AFTER_MS : Infinity
      const at = Math.min(retryAt, renewAt)
      if (!Number.isFinite(at)) return
      timer = setTimeout(() => {
        const renewing = Date.now() >= renewAt - 50
        const everythingFailed = current.phase === 'error'
        run(renewing || everythingFailed ? ids : missing.length > 0 ? missing : ids, false)
      }, Math.max(0, at - Date.now()))
    }
    return () => clearTimeout(timer)
    // `run` and `current` are rebuilt every render; what matters is which request is due, which these values say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, idsText, current.phase, current.issuedAt, current.triedAt, current.refreshFailed, loaded])

  return { phase: current.phase, streams: active ? current.streams : ({} as Record<string, OpenedStream>), error: current.error }
}
