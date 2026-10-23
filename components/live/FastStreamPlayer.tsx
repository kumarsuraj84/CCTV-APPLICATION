'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { startFastStream, type FastState, type FastStreamEnv, type MediaSourceLike, type VideoLike } from '@/lib/streams/fast-client'
import { clipEnd, MSG_BROWSER_CANNOT_PLAY, speedLabel, type Speed } from '@/lib/streams/speed'

/** Give up on a picture that has not started after this long (the server gives up on its side after 30 seconds). */
const START_TIMEOUT_MS = 45_000

/**
 * Fast playback 2x-16x (P4-L2, decision D-L1): the stream of one token, read by the page and played through Media Source Extensions, so the
 * video element holds a blob: picture made in this page and there is no file address to open or save. Muted (recordings have no sound
 * here). The browser's own controls stay for pause and full screen; download, its speed menu and picture-in-picture are left out. When the
 * recording arrives too slowly, the speed steps down by itself and says so (LG-15). The parent gives it a new `key` for every playback.
 */
export function FastStreamPlayer({
  token,
  minutes,
  speed,
  label,
  onStop,
  onContinue,
  onProgress,
  onSpeedChange,
}: {
  /** The fast playback token (openFastPlaybackAction). */
  token: string
  minutes: number
  speed: Speed
  /** What is being played, for example "PA, Front Door, 22 Oct 14:30". */
  label: string
  onStop: () => void
  /** Called with the seconds of the recording that were played, to carry on from there. */
  onContinue: (playedSeconds: number) => void
  /** Seconds of the clip played so far. */
  onProgress?: (seconds: number) => void
  /** The speed was stepped down. */
  onSpeedChange?: (speed: Speed) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<FastState>('preparing')
  const [message, setMessage] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [now, setNow] = useState<Speed>(speed)
  const [playedAtStop, setPlayedAtStop] = useState(0)
  const played = useRef(0)
  // Without Media Source Extensions (an old browser) there is nothing to start.
  const supported = typeof window === 'undefined' || typeof window.MediaSource !== 'undefined'
  const callbacks = useRef({ onProgress, onSpeedChange })
  useEffect(() => {
    callbacks.current = { onProgress, onSpeedChange }
  })

  useEffect(() => {
    const v = video.current
    if (!v || !supported) return
    const env: FastStreamEnv = {
      fetch: window.fetch.bind(window),
      MediaSource: window.MediaSource as unknown as FastStreamEnv['MediaSource'] & { new (): MediaSourceLike },
      createObjectURL: (o) => URL.createObjectURL(o as MediaSource),
      revokeObjectURL: (u) => URL.revokeObjectURL(u),
      now: () => Date.now(),
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined = undefined
    const session = startFastStream({
      token,
      speed,
      video: v as unknown as VideoLike,
      env,
      callbacks: {
        onState: (s) => {
          if (s !== 'preparing') clearTimeout(watchdog)
          if (s === 'failed' || s === 'finished') setPlayedAtStop(played.current)
          setState(s)
        },
        onError: (m) => setMessage(m),
        onSpeed: (s, why) => {
          setNow(s)
          setNote(why)
          callbacks.current.onSpeedChange?.(s)
        },
        onProgress: (sec) => {
          played.current = sec
          callbacks.current.onProgress?.(sec)
        },
      },
    })
    watchdog = setTimeout(() => {
      session.stop()
      setPlayedAtStop(played.current)
      setState('failed')
      setMessage('The recording did not start. Try again, or play at 1x.')
    }, START_TIMEOUT_MS)
    return () => {
      clearTimeout(watchdog)
      session.stop() // the request ends, so the server ends the NVR transfer and the remux
    }
  }, [token, speed, supported])

  const shown: FastState = supported ? state : 'failed'
  const words = supported ? message : MSG_BROWSER_CANNOT_PLAY
  // Review m-3: a clip that ends before the chosen time (an NVR keeps recordings in parts, or the viewer was paused too long) says so
  // and offers to carry on.
  const end = clipEnd(playedAtStop, minutes)
  const status = shown === 'preparing' ? 'Getting the recording…' : shown === 'finished' ? end.message : null
  const canContinue = (shown === 'failed' && playedAtStop > 0) || (shown === 'finished' && end.canContinue && playedAtStop > 0)

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black text-white">
        <video
          ref={video}
          muted
          playsInline
          controls
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
          onContextMenu={(e) => e.preventDefault()}
          className="absolute inset-0 h-full w-full bg-black"
          aria-label={`${label}, ${speedLabel(now)}`}
        />
        {status !== null && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-3 text-center text-sm text-white/90">
            <span role="status" className="rounded bg-black/60 px-2 py-1">{status}</span>
          </div>
        )}
      </div>
      {shown === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {words ?? 'Playback stopped.'}
        </p>
      )}
      {note && shown !== 'failed' && (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">
          {note}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onStop}>Stop</Button>
        {canContinue && <Button type="button" onClick={() => onContinue(playedAtStop)}>Continue from here</Button>}
        <p className="text-xs text-muted-foreground">
          No sound. Plays {minutes} {minutes === 1 ? 'minute' : 'minutes'} of recording at {speedLabel(now)}.
        </p>
      </div>
    </div>
  )
}
