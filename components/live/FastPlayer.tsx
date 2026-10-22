'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MSG_BROWSER_CANNOT_PLAY, probeVod, speedLabel, type Speed } from '@/lib/streams/speed'

/** Give up on a video that has shown no picture after this long (the server itself gives up on its side after 30 seconds). */
const START_TIMEOUT_MS = 45_000

type State = 'preparing' | 'playing' | 'finished' | 'failed'

const FALLBACK_FAILURE = 'Fast playback stopped. Try again, or play at 1x.'

/**
 * Fast playback: the picture of /api/vod in a plain video element, played at 2x, 4x or 8x. The server sends the recording much faster than
 * it plays, so the picture starts after a moment and then runs ahead. There is no sound. The video element cannot say why it failed, so
 * after a failure the same address is asked once more with probe=1 and the server's plain message is shown. The parent gives it a new `key`
 * for every playback.
 */
export function FastPlayer({
  src,
  minutes,
  speed,
  label,
  onStop,
  onContinue,
}: {
  /** The address from vodUrl(). */
  src: string
  /** The length of the clip, in minutes. */
  minutes: number
  speed: Speed
  /** What is being played, for example "PA, Front Door, 22 Oct 14:30". */
  label: string
  onStop: () => void
  /** Called with the seconds of the recording that were played, to carry on from there. */
  onContinue: (playedSeconds: number) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<State>('preparing')
  const [played, setPlayed] = useState(0)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const v = video.current
    if (!v) return
    let cancelled = false
    let ended = false
    const rate = () => {
      // The speed is set before the address (loading a new address starts again from the default speed) and again once the video is known.
      v.defaultPlaybackRate = speed
      v.playbackRate = speed
    }
    const seconds = () => (Number.isFinite(v.currentTime) && v.currentTime > 0 ? Math.floor(v.currentTime) : 0)
    const fail = () => {
      if (cancelled || ended) return
      ended = true
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4): the address did not give a video this browser can play. It is also what a JSON error looks like, so
      // the server is asked first; only when it has no complaint is it the browser's format support.
      const unsupported = v.error?.code === 4
      clearTimeout(watchdog)
      setPlayed(seconds())
      setState('failed')
      v.pause()
      v.removeAttribute('src')
      v.load() // lets go of the connection to the server
      void probeVod(src).then(({ error }) => {
        if (!cancelled) setMessage(error ?? (unsupported ? MSG_BROWSER_CANNOT_PLAY : FALLBACK_FAILURE))
      })
    }
    const onPlaying = () => {
      clearTimeout(watchdog)
      rate()
      setState('playing')
    }
    const onEnded = () => {
      if (cancelled || ended) return
      ended = true
      setPlayed(seconds())
      setState('finished')
    }
    v.addEventListener('loadedmetadata', rate)
    v.addEventListener('playing', onPlaying)
    v.addEventListener('ended', onEnded)
    v.addEventListener('error', fail)

    v.muted = true
    rate()
    v.src = src
    v.play().catch(() => {
      // Refused or interrupted: an error event or the watchdog says what happened.
    })
    const watchdog = setTimeout(fail, START_TIMEOUT_MS)
    return () => {
      cancelled = true
      clearTimeout(watchdog)
      v.removeEventListener('loadedmetadata', rate)
      v.removeEventListener('playing', onPlaying)
      v.removeEventListener('ended', onEnded)
      v.removeEventListener('error', fail)
      // Closing the picture must close the connection: the server stops the conversion when it does.
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  }, [src, speed])

  const status =
    state === 'preparing' ? 'Getting the recording…' : state === 'finished' ? 'End of the chosen time.' : state === 'failed' ? (message ?? 'Playback stopped.') : null

  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black text-white">
        {/* Controls are the browser's own (keyboard and screen reader friendly); download and its own speed menu are left out. The recording has no sound and cannot be skipped through. */}
        <video ref={video} muted playsInline controls controlsList="nodownload noplaybackrate" disablePictureInPicture preload="auto" className="absolute inset-0 h-full w-full bg-black" aria-label={`${label}, ${speedLabel(speed)}`} />
        {status !== null && state !== 'failed' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-3 text-center text-sm text-white/90">
            <span role="status" className="rounded bg-black/60 px-2 py-1">{status}</span>
          </div>
        )}
      </div>
      {state === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {message ?? 'Playback stopped.'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={onStop}>Stop</Button>
        {state === 'failed' && played > 0 && <Button type="button" onClick={() => onContinue(played)}>Continue from here</Button>}
        <p className="text-xs text-muted-foreground">
          No sound. Plays {minutes} {minutes === 1 ? 'minute' : 'minutes'} of recording at {speedLabel(speed)}.
        </p>
      </div>
    </div>
  )
}
