'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { gatewaySocketUrl } from '@/lib/streams/wall'
import { loadPlayer, startPlayer } from './player'
import { useGatewayBase } from './useGatewayBase'

/** Give up on a connection that has shown no picture after this long. */
const CONNECT_TIMEOUT_MS = 25_000
/** Playback stops this long after the length that was asked for (the NVR ends the recording itself; this is only the safety net). */
const END_GRACE_MS = 3_000
/** An ending this close to the asked length counts as the normal end. */
const NEAR_END_MS = 5_000

type State = 'connecting' | 'playing' | 'finished' | 'stopped-early' | 'unavailable'

const MESSAGES: Record<Exclude<State, 'playing'>, string> = {
  connecting: 'Connecting…',
  finished: 'End of the chosen time.',
  'stopped-early': 'Playback stopped before the end.',
  unavailable: 'Video is not available right now.',
}

/**
 * One playback picture. It connects once with its token and plays for the length that was asked for; it never starts again by itself
 * (a recording that has ended must not loop). When the connection ends early (the gateway ends a session after 30 minutes) it offers to
 * continue from where it got to. The parent gives it a new `key` for every playback, so a new token always means a new player.
 */
export function PlaybackPlayer({
  token,
  minutes,
  label,
  onStop,
  onContinue,
}: {
  token: string
  /** The length that was asked for. */
  minutes: number
  /** What is being played, for example "PA, Front Door, 22 Oct 14:30". */
  label: string
  onStop: () => void
  /** Called with the seconds of the recording that were played, to carry on from there. */
  onContinue: (playedSeconds: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const playedAt = useRef(0)
  const video = useRef<HTMLVideoElement | null>(null)
  // P3-1: derived from the page's own address when NEXT_PUBLIC_STREAM_GATEWAY_URL is unset, `auto` or a path (undefined until hydrated).
  const GATEWAY = useGatewayBase()
  const [playerState, setState] = useState<State>('connecting')
  const state: State = GATEWAY === null ? 'unavailable' : playerState
  const [played, setPlayed] = useState(0)

  useEffect(() => {
    if (!GATEWAY) return
    const gateway = GATEWAY
    let cancelled = false
    let stop: (() => void) | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let endTimer: ReturnType<typeof setTimeout> | undefined
    const halt = () => {
      clearTimeout(watchdog)
      clearTimeout(endTimer)
      stop?.()
      stop = undefined
    }
    const done = (reason: 'ended' | 'timer') => {
      if (cancelled) return
      // How far the picture got: the video element knows; the clock is the fallback when it does not say.
      const wall = playedAt.current > 0 ? Math.floor((Date.now() - playedAt.current) / 1000) : 0
      const shown = video.current?.currentTime
      const seconds = Math.min(minutes * 60, typeof shown === 'number' && Number.isFinite(shown) && shown > 0 ? Math.floor(shown) : wall)
      halt()
      setPlayed(seconds)
      if (playedAt.current === 0) setState('unavailable')
      else if (reason === 'timer' || Date.now() - playedAt.current >= minutes * 60_000 - NEAR_END_MS) setState('finished')
      else setState('stopped-early')
    }
    loadPlayer(gateway)
      .then(() => {
        if (cancelled || !host.current) return
        stop = startPlayer(host.current, gatewaySocketUrl(gateway, token), {
          onPlaying: () => {
            clearTimeout(watchdog)
            if (playedAt.current === 0) {
              playedAt.current = Date.now()
              endTimer = setTimeout(() => done('timer'), minutes * 60_000 + END_GRACE_MS)
            }
            setState('playing')
          },
          onEnded: () => done('ended'),
          onVideo: (v) => {
            video.current = v
          },
        })
        watchdog = setTimeout(() => done('ended'), CONNECT_TIMEOUT_MS)
      })
      .catch(() => {
        if (!cancelled) setState('unavailable')
      })
    return () => {
      cancelled = true
      halt()
    }
  }, [GATEWAY, token, minutes])

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black text-white">
        <div ref={host} className="absolute inset-0 [&_video]:bg-black" />
        {state !== 'playing' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-3 text-center text-sm text-white/90">
            <span role="status" className="rounded bg-black/60 px-2 py-1">{MESSAGES[state]}</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onStop}>Stop</Button>
        {state === 'stopped-early' && played > 0 && (
          <Button type="button" onClick={() => onContinue(played)}>Continue from here</Button>
        )}
        <p className="text-xs text-muted-foreground">No sound. Plays for {minutes} {minutes === 1 ? 'minute' : 'minutes'} and stops.</p>
      </div>
    </div>
  )
}
