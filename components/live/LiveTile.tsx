'use client'

import { useEffect, useRef, useState } from 'react'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import type { Status } from '@/lib/queries/status'
import { gatewayBase, gatewaySocketUrl, QUICK_RETRY_MS, RETRY_EVERY_MS } from '@/lib/streams/wall'
import { cn } from '@/lib/utils'
import { loadPlayer, startPlayer } from './player'

/** `canPlayback`: the person may play back this camera's recordings (P2-2); the large picture offers Playback only then. */
export type TileCamera = { id: string; name: string; storeCode: string; channel: number; status: Status | null; stale: boolean; canPlayback?: boolean }

// Read here so the build inlines it for the browser (only NEXT_PUBLIC_ names reach client code).
const GATEWAY = gatewayBase(process.env.NEXT_PUBLIC_STREAM_GATEWAY_URL)

/** Give up on a connection that has shown no picture after this long, and try again later. */
const CONNECT_TIMEOUT_MS = 25_000
/** A picture that played at least this long and then ended is a normal end of session, not a failure. */
const NORMAL_RUN_MS = 5_000

type PlayerState = 'connecting' | 'playing' | 'reconnecting' | 'unavailable'

const MESSAGES = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  paused: 'Paused',
  unavailable: 'Video is not available right now.',
} as const

/**
 * One camera picture. The picture runs while it has a token and is not paused; every socket it opens is closed when it is paused,
 * replaced or removed. If the video cannot be had it says so and tries again every 30 seconds (a picture that simply reached the end of
 * its session comes back after two). The token can change while the picture runs without any reconnect: it is only used to connect.
 */
export function LiveTile({
  camera,
  token,
  failed = false,
  paused = false,
  size = 'tile',
  onOpen,
}: {
  camera: TileCamera
  /** The signed token for this camera, or null while there is none yet. */
  token: string | null
  /** The server could not open this camera (the wall asks again by itself). */
  failed?: boolean
  paused?: boolean
  size?: 'tile' | 'large'
  /** Makes the whole picture a button that opens it larger. */
  onOpen?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const tokenRef = useRef(token)
  const playedAt = useRef(0)
  const [player, setPlayer] = useState<PlayerState>('connecting')
  const [attempt, setAttempt] = useState(0)
  const hasToken = token !== null

  useEffect(() => {
    tokenRef.current = token
  }, [token])

  // Connect while there is a token and the tile is not paused.
  useEffect(() => {
    if (!GATEWAY || !hasToken || paused) return
    let cancelled = false
    let stop: (() => void) | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const ended = () => {
      if (cancelled) return
      clearTimeout(watchdog)
      stop?.()
      stop = undefined
      setPlayer(playedAt.current > 0 && Date.now() - playedAt.current >= NORMAL_RUN_MS ? 'reconnecting' : 'unavailable')
      playedAt.current = 0
    }
    loadPlayer(GATEWAY)
      .then(() => {
        const t = tokenRef.current
        if (cancelled || !t || !host.current) return
        stop = startPlayer(host.current, gatewaySocketUrl(GATEWAY, t), {
          onPlaying: () => {
            clearTimeout(watchdog)
            if (playedAt.current === 0) playedAt.current = Date.now()
            setPlayer('playing')
          },
          onEnded: ended,
        })
        watchdog = setTimeout(ended, CONNECT_TIMEOUT_MS)
      })
      .catch(() => {
        if (!cancelled) setPlayer('unavailable')
      })
    return () => {
      cancelled = true
      clearTimeout(watchdog)
      stop?.()
      playedAt.current = 0
      setPlayer('connecting')
    }
  }, [hasToken, paused, attempt])

  // Not working: try again later (soon, if it only reached the end of its session).
  useEffect(() => {
    if ((player !== 'unavailable' && player !== 'reconnecting') || paused || !hasToken || !GATEWAY) return
    const timer = setTimeout(() => setAttempt((n) => n + 1), player === 'reconnecting' ? QUICK_RETRY_MS : RETRY_EVERY_MS)
    return () => clearTimeout(timer)
  }, [player, paused, hasToken])

  const shown: keyof typeof MESSAGES | 'playing' = !GATEWAY || failed ? 'unavailable' : paused ? 'paused' : !hasToken ? 'connecting' : player
  const label = `${camera.storeCode}, ${camera.name}`

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('relative aspect-video w-full min-w-0 overflow-hidden rounded-lg border bg-black text-white', size === 'large' && 'max-h-[calc(100dvh-9rem)] mx-auto')}
    >
      {/* The player puts its picture here (it hides its own overlay: the tile has its own). */}
      <div ref={host} className="absolute inset-0 [&_video]:bg-black" />
      {onOpen && (
        <button type="button" onClick={onOpen} aria-label={`Enlarge ${label}`} className="absolute inset-0 z-10 cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" />
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-2">
        <div className="min-w-0 text-xs leading-tight">
          <span className="font-mono font-semibold">{camera.storeCode}</span>
          <span className="block truncate">{camera.name}</span>
        </div>
        <StatusBadge status={camera.status} stale={camera.stale} className="shrink-0" />
      </div>
      {shown !== 'playing' && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-3 text-center text-xs text-white/90">
          <span className="rounded bg-black/60 px-2 py-1">{MESSAGES[shown]}</span>
        </div>
      )}
    </div>
  )
}
