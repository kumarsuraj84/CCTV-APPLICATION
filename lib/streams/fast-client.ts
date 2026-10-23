import { framingKey, xorFrame } from '@/lib/streams/framing'
import { initSegment, mimeFor, videoCodecOf } from '@/lib/streams/mp4'
import {
  bufferTargetSec,
  createStallWatch,
  downshift,
  FAST_FRAMING,
  FAST_FRAMING_HEADER,
  FAST_STREAM_PATH,
  FAST_TOKEN_HEADER,
  isSpeed,
  MSG_BROWSER_CANNOT_PLAY,
  MSG_DOWNSHIFTED,
  MSG_FAST_STOPPED,
  MSG_H265,
  readyToStart,
  type Speed,
} from '@/lib/streams/speed'

// P4-L2 (decision D-L1): the browser side of fast playback, without React so that it can be tested with fakes. The stream is fetched with
// the token in a request header (never in an address that could be opened, shared or saved), read chunk by chunk and appended to a
// Media Source Extensions buffer; the <video> element plays a blob: address made in this page. Buffer gating (start after about two
// seconds of watching at the speed), back-pressure (reading pauses while far more is buffered than is watched; the server then stops
// reading the NVR), old picture is let go behind the viewer, and three stalls within 40 s step the speed down (LG-15).

export type RangesLike = { length: number; start(i: number): number; end(i: number): number }
export type VideoLike = EventTarget & {
  src: string
  currentTime: number
  playbackRate: number
  defaultPlaybackRate: number
  muted: boolean
  readonly buffered: RangesLike
  error: { code: number } | null
  play(): Promise<void>
  pause(): void
  removeAttribute(name: string): void
  load(): void
}
export type SourceBufferLike = EventTarget & { updating: boolean; readonly buffered: RangesLike; appendBuffer(b: Uint8Array): void; remove(start: number, end: number): void }
export type MediaSourceLike = EventTarget & { readyState: string; addSourceBuffer(mime: string): SourceBufferLike; endOfStream(): void }
export type FastStreamEnv = {
  fetch: typeof fetch
  MediaSource: { new (): MediaSourceLike; isTypeSupported(type: string): boolean }
  createObjectURL(o: unknown): string
  revokeObjectURL(url: string): void
  now(): number
}
export type FastState = 'preparing' | 'playing' | 'finished' | 'failed'
export type FastCallbacks = {
  onState(state: FastState): void
  onError(message: string): void
  /** The speed was stepped down (with the words to show). */
  onSpeed(speed: Speed, why: string): void
  /** Seconds of the clip played so far (from the picture's own clock). */
  onProgress(seconds: number): void
}

/** Reading pauses while this much (seconds of recording) is buffered ahead of what is shown. */
export const DEFAULT_MAX_AHEAD_SEC = 240
/** Picture this far behind what is shown is let go (the buffer has a size limit in every browser). */
export const KEEP_BEHIND_SEC = 30
/** The most that is gathered before the stream must have shown its first part (ftyp + moov). */
const MAX_INIT_BYTES = 4 * 1024 * 1024

const aheadOf = (v: VideoLike): number => {
  const r = v.buffered
  for (let i = 0; i < r.length; i++) if (r.start(i) <= v.currentTime + 0.5 && v.currentTime < r.end(i)) return r.end(i) - v.currentTime
  return r.length > 0 ? Math.max(0, r.end(r.length - 1) - v.currentTime) : 0
}

/** Starts fast playback of one token into `video`; `stop()` ends everything (the request, the picture, the blob address). */
export function startFastStream(o: { token: string; speed: Speed; video: VideoLike; env: FastStreamEnv; callbacks: FastCallbacks; maxAheadSec?: number }) {
  const { video, env, callbacks } = o
  const maxAhead = o.maxAheadSec ?? DEFAULT_MAX_AHEAD_SEC
  const abort = new AbortController()
  const stalls = createStallWatch()
  let speed: Speed = o.speed
  let stopped = false
  let started = false
  let complete = false
  let failed = false
  let wake: (() => void) | null = null
  let origin = 0
  const listeners: [string, () => void][] = []

  const ms = new env.MediaSource()
  const url = env.createObjectURL(ms)
  video.muted = true
  video.defaultPlaybackRate = speed
  video.playbackRate = speed
  video.src = url

  const nudge = () => {
    const w = wake
    wake = null
    w?.()
  }
  const listen = (name: string, fn: () => void) => {
    video.addEventListener(name, fn)
    listeners.push([name, fn])
  }
  const fail = (message: string) => {
    if (stopped || failed) return
    failed = true
    abort.abort()
    nudge()
    callbacks.onError(message)
    callbacks.onState('failed')
  }
  let originSet = false
  const tryStart = () => {
    // The clip's own first time (ffmpeg may keep the recording's timestamps): progress counts from it, and the picture starts there.
    if (!originSet && video.buffered.length > 0) {
      originSet = true
      origin = video.buffered.start(0)
      if (video.currentTime < origin) video.currentTime = origin
    }
    if (started || stopped || failed) return
    if (!readyToStart(aheadOf(video), speed, complete)) return
    started = true
    video.playbackRate = speed
    void video.play().catch(() => {
      // refused or interrupted: the 'playing' event never comes and the screen keeps saying "getting the recording"
    })
  }

  listen('playing', () => {
    if (stopped) return
    video.playbackRate = speed
    callbacks.onState('playing')
  })
  listen('waiting', () => {
    if (stopped || !started) return
    // A stall is the recording running out (less than the start target buffered ahead), not the browser catching up on decoding.
    if (aheadOf(video) >= bufferTargetSec(speed)) return
    if (!stalls.stall(env.now())) return
    const lower = downshift(speed)
    if (lower === speed) return
    const from = speed
    speed = lower
    video.defaultPlaybackRate = lower
    video.playbackRate = lower
    callbacks.onSpeed(lower, MSG_DOWNSHIFTED(from, lower))
  })
  listen('timeupdate', () => {
    if (stopped) return
    callbacks.onProgress(Math.max(0, Math.floor(video.currentTime - origin)))
    nudge()
  })
  listen('ended', () => {
    if (stopped || failed) return
    callbacks.onProgress(Math.max(0, Math.floor(video.currentTime - origin)))
    callbacks.onState('finished')
  })
  listen('error', () => fail(MSG_BROWSER_CANNOT_PLAY))

  const waitFor = (ev: EventTarget, name: string) =>
    new Promise<void>((resolve) => {
      const done = () => {
        ev.removeEventListener(name, done)
        resolve()
      }
      ev.addEventListener(name, done)
    })
  const append = async (sb: SourceBufferLike, bytes: Uint8Array) => {
    while (sb.updating) await waitFor(sb, 'updateend')
    // Let go of what is far behind the viewer before adding more.
    const r = sb.buffered
    if (r.length > 0 && video.currentTime - r.start(0) > KEEP_BEHIND_SEC * 2) {
      sb.remove(r.start(0), video.currentTime - KEEP_BEHIND_SEC)
      await waitFor(sb, 'updateend')
    }
    sb.appendBuffer(bytes)
    await waitFor(sb, 'updateend')
  }
  // Back-pressure: while far more is buffered than will be watched soon, wait for the viewer (a timeupdate) before reading on.
  const roomToRead = async () => {
    while (!stopped && !failed && aheadOf(video) >= maxAhead) await new Promise<void>((r) => (wake = r))
  }

  async function run() {
    let res: Response
    try {
      res = await env.fetch(FAST_STREAM_PATH, { method: 'GET', headers: { [FAST_TOKEN_HEADER]: o.token }, credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
    } catch {
      return fail(MSG_FAST_STOPPED)
    }
    if (stopped) return
    if (!res.ok || !res.body) {
      let message = MSG_FAST_STOPPED
      try {
        const body = (await res.json()) as { error?: unknown }
        if (typeof body.error === 'string' && body.error.length > 0 && body.error.length <= 300) message = body.error
      } catch {
        // not the server's JSON
      }
      return fail(message)
    }
    const reader = res.body.getReader()
    // Review round 1: a framed body (obfuscation, lib/streams/framing.ts) is unframed with the key from this page's own token.
    let key: Uint8Array | null = null
    if (res.headers.get(FAST_FRAMING_HEADER) === FAST_FRAMING) {
      try {
        key = framingKey(o.token)
      } catch {
        return fail(MSG_BROWSER_CANNOT_PLAY)
      }
    }
    let at = 0
    const unframe = (bytes: Uint8Array): Uint8Array => {
      if (!key) return bytes
      const out = xorFrame(bytes, key, at)
      at += bytes.length
      return out
    }
    let head = new Uint8Array(0)
    let sb: SourceBufferLike | null = null
    try {
      for (;;) {
        await roomToRead()
        if (stopped || failed) break
        const { done, value: raw } = await reader.read()
        if (stopped || failed) break
        const value = done ? new Uint8Array(0) : unframe(raw)
        if (done) {
          if (!sb) return fail(MSG_BROWSER_CANNOT_PLAY)
          complete = true
          while (sb.updating) await waitFor(sb, 'updateend')
          if (ms.readyState === 'open') ms.endOfStream()
          tryStart()
          return
        }
        if (!sb) {
          const joined = new Uint8Array(head.length + value.length)
          joined.set(head)
          joined.set(value, head.length)
          head = joined
          const init = initSegment(head)
          if (!init.ok) {
            if (!init.more || head.length > MAX_INIT_BYTES) return fail(MSG_BROWSER_CANNOT_PLAY)
            continue
          }
          const codec = videoCodecOf(head.subarray(0, init.end))
          if (!codec) return fail(MSG_BROWSER_CANNOT_PLAY)
          if (!env.MediaSource.isTypeSupported(mimeFor(codec.codec))) return fail(codec.family === 'h265' ? MSG_H265 : MSG_BROWSER_CANNOT_PLAY)
          sb = ms.addSourceBuffer(mimeFor(codec.codec))
          await append(sb, head)
          head = new Uint8Array(0)
        } else {
          await append(sb, value)
        }
        tryStart()
      }
    } catch {
      if (!stopped) fail(MSG_FAST_STOPPED)
    } finally {
      if (stopped || failed) void reader.cancel().catch(() => {})
    }
  }

  const begin = () => void run()
  if (ms.readyState === 'open') begin()
  else ms.addEventListener('sourceopen', begin, { once: true })
  callbacks.onState('preparing')

  return {
    stop() {
      if (stopped) return
      stopped = true
      abort.abort()
      nudge()
      for (const [name, fn] of listeners) video.removeEventListener(name, fn)
      ms.removeEventListener('sourceopen', begin)
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        // the element is already gone
      }
      env.revokeObjectURL(url)
    },
    /** The speed now (after any downshift). */
    speed: () => speed,
    setSpeed(next: Speed) {
      if (!isSpeed(next) || stopped) return
      speed = next
      video.defaultPlaybackRate = next
      video.playbackRate = next
    },
  }
}
