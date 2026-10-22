'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import type { CameraState } from '@/lib/live/rollups'
import type { Status } from '@/lib/queries/status'
import { MSG_PAUSED_FOR_BANDWIDTH } from '@/lib/streams/concurrency'
import { createTileConnection, type TileConnection, type TileView } from '@/lib/streams/tile-connection'
import { gatewaySocketUrl } from '@/lib/streams/wall'
import { cn } from '@/lib/utils'
import { loadPlayer, startPlayer } from './player'
import { CameraStateBadge } from './StateDot'
import { useGatewayBase } from './useGatewayBase'

/**
 * `canPlayback`: the person may play back this camera's recordings (P2-2); the large picture offers Playback only then.
 * `state` (P4-L1): the honest state ("Recorder not reachable" is not "Offline"); without it the plain status badge is shown.
 */
export type TileCamera = { id: string; name: string; storeCode: string; channel: number; status: Status | null; stale: boolean; state?: CameraState; canPlayback?: boolean }

/**
 * Why a picture is not playing: the tab is hidden (`hidden`), the person's live streams are at their limit (`bandwidth`), or the tile is
 * out of sight — scrolled away or behind the large picture (`idle`). `true` is a plain pause.
 */
export type PauseReason = false | true | 'hidden' | 'bandwidth' | 'idle'

const MESSAGES = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  paused: 'Paused',
  bandwidth: MSG_PAUSED_FOR_BANDWIDTH,
  unavailable: 'Video is not available right now.',
} as const

/**
 * One camera picture. Its socket is run by lib/streams/tile-connection.ts (P4-L1): it connects while there is a token and the picture is
 * not paused, closes at once when it is paused or removed, and reconnects with a back-off when the video cannot be had. The token can
 * change while the picture runs without any reconnect: it is only used to connect. A double-click (or Enter) opens it larger.
 */
export function LiveTile({
  camera,
  token,
  failed = false,
  paused = false,
  size = 'tile',
  onOpen,
  actions,
}: {
  camera: TileCamera
  /** The signed token for this camera, or null while there is none yet. */
  token: string | null
  /** The server could not open this camera (the wall asks again by itself). */
  failed?: boolean
  paused?: PauseReason
  size?: 'tile' | 'large'
  /** Double-click or Enter opens the picture larger. */
  onOpen?: () => void
  /** Buttons shown on the picture when it is hovered or has the keyboard focus (always on a phone). */
  actions?: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  // P3-1: derived from the page's own address when NEXT_PUBLIC_STREAM_GATEWAY_URL is unset, `auto` or a path (undefined until hydrated).
  const GATEWAY = useGatewayBase()
  const conn = useRef<TileConnection | null>(null)
  const [view, setView] = useState<TileView>('connecting')
  const isPaused = paused !== false
  const url = GATEWAY && token ? gatewaySocketUrl(GATEWAY, token) : null

  // One connection per picture and gateway; removing the picture (another page, another wall, leaving the page) closes everything.
  useEffect(() => {
    if (!GATEWAY) return
    const gateway = GATEWAY
    const c = createTileConnection({
      connect: (socketUrl, ev) => {
        let stop: (() => void) | undefined
        let cancelled = false
        loadPlayer(gateway)
          .then(() => {
            if (cancelled || !host.current) return
            stop = startPlayer(host.current, socketUrl, { onPlaying: ev.onPlaying, onEnded: ev.onEnded })
          })
          .catch(() => {
            if (!cancelled) ev.onEnded()
          })
        return () => {
          cancelled = true
          stop?.()
        }
      },
      onView: setView,
    })
    conn.current = c
    return () => {
      c.dispose()
      conn.current = null
    }
  }, [GATEWAY])

  useEffect(() => {
    conn.current?.update({ url, paused: isPaused })
  }, [GATEWAY, url, isPaused])

  const shown: keyof typeof MESSAGES | 'playing' =
    GATEWAY === null || failed ? 'unavailable' : paused === 'bandwidth' ? 'bandwidth' : isPaused ? 'paused' : !token || GATEWAY === undefined ? 'connecting' : view === 'paused' ? 'connecting' : view
  const label = `${camera.storeCode}, ${camera.name}`

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('group/tile relative aspect-video w-full min-w-0 overflow-hidden rounded-lg border bg-black text-white', size === 'large' && 'max-h-[calc(100dvh-9rem)] mx-auto')}
    >
      {/* The player puts its picture here (it hides its own overlay: the tile has its own). */}
      <div ref={host} className="absolute inset-0 [&_video]:bg-black" />
      {onOpen && (
        // The whole picture is the double-click area for the mouse (review M-8: not a second "Enlarge" control for the keyboard or a
        // screen reader — the tile's own Enlarge button is that, and the large view opens with it).
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onDoubleClick={onOpen}
          title="Double-click to enlarge"
          className="absolute inset-0 z-10 cursor-zoom-in"
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/70 to-transparent p-2 text-xs leading-tight">
        <div className="flex items-start justify-between gap-2">
          <span translate="no" className="font-mono font-semibold">{camera.storeCode}</span>
          {camera.state ? <CameraStateBadge state={camera.state} className="min-w-0 shrink" /> : <StatusBadge status={camera.status} stale={camera.stale} className="shrink-0" />}
        </div>
        <span className="mt-0.5 block truncate">{camera.name}</span>
      </div>
      {shown !== 'playing' && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-3 text-center text-xs text-white/90">
          <span className="rounded bg-black/60 px-2 py-1">{MESSAGES[shown]}</span>
        </div>
      )}
      {actions && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex flex-wrap justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/tile:opacity-100 sm:group-focus-within/tile:opacity-100">
          {actions}
        </div>
      )}
    </div>
  )
}
