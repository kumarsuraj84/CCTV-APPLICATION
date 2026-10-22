// Playback speeds and the rules of fast playback that the browser needs too. No server code here, so the Playback screen can use it.
//
// Decision D-L1 (owner, 2026-10-22; supersedes D-6a and P2-2 fix M-3 for fast playback): 2x-16x is part of cctv.playback, delivered ONLY
// as a browser stream — a short-lived token bound to the person and the camera, fetched by the Playback screen from FAST_STREAM_PATH and
// played through Media Source Extensions — never as a file that can be saved. Saveable files (the old /api/vod MP4) need cctv.export,
// which only administrators may hold (ruling E-1).

/** What fast playback (2x-16x on the Playback screen) needs for the camera. */
export const FAST_PLAYBACK_CAPABILITY = 'cctv.playback' as const
/** What a saveable recording file (/api/vod and, later, clip exports) needs for the camera, together with cctv.playback. */
export const EXPORT_CAPABILITY = 'cctv.export' as const
export const MSG_FAST_NOT_FOR_YOU = 'Playback is not available for your account.'
export const MSG_EXPORT_NOT_FOR_YOU = 'Downloading recordings is not available for your account.'

/** The stream path the Playback screen fetches; the token goes in this request header, never in the address. */
export const FAST_STREAM_PATH = '/api/playback/stream'
export const FAST_TOKEN_HEADER = 'x-playback-token'
/** The answer's type: on purpose not a video/* type a plain <video src> or a "save as" would take as a recording file. */
export const FAST_STREAM_CONTENT_TYPE = 'application/vnd.ckdrishti.stream'

/** 1x uses the video gateway (go2rtc); 2x-16x the fast stream path. */
export const SPEEDS = [1, 2, 4, 8, 16] as const
export type Speed = (typeof SPEEDS)[number]
export const FAST_SPEEDS = [2, 4, 8, 16] as const
export type FastSpeed = (typeof FAST_SPEEDS)[number]
/** One fast playback plays at most this many minutes. */
export const MAX_FAST_MINUTES = 30

export const isSpeed = (n: unknown): n is Speed => SPEEDS.some((s) => s === n)
export const isFastSpeed = (n: unknown): n is FastSpeed => FAST_SPEEDS.some((s) => s === n)
export const speedLabel = (s: Speed) => `${s}x`

/** The number of minutes fast playback plays for a chosen length. */
export function fastMinutes(length: number): number {
  return Math.min(MAX_FAST_MINUTES, Math.max(1, Math.round(Number.isFinite(length) ? length : 1)))
}

export const MSG_BROWSER_CANNOT_PLAY = "This browser cannot play this camera's recording format."
export const MSG_H265 =
  'This camera records in H.265, which this browser cannot play at a faster speed. Play it at 1x, or use a browser that plays H.265 (for example Microsoft Edge on a computer with H.265 support). Converting H.265 for every browser is planned for a later release.'
export const MSG_FAST_STOPPED = 'Fast playback stopped. Try again, or play at 1x.'
export const MSG_DOWNSHIFTED = (from: Speed, to: Speed) => `The recording is arriving too slowly for ${speedLabel(from)}, so it now plays at ${speedLabel(to)}.`

// ── LG-15: buffer gating and stall auto-downshift ─────────────────────────────────────────────────────────────────────────────────────

/** One speed lower (16x → 8x → 4x → 2x → 1x); 1x stays 1x. */
export function downshift(speed: Speed): Speed {
  const i = SPEEDS.indexOf(speed)
  return i <= 0 ? 1 : SPEEDS[i - 1]
}

export const STALLS_TO_DOWNSHIFT = 3
export const STALL_WINDOW_MS = 40_000

/** Counts stalls (the picture waiting for data): `stall(now)` is true on the third within 40 s, and the count then starts again. */
export function createStallWatch(o: { limit?: number; windowMs?: number } = {}) {
  const limit = o.limit ?? STALLS_TO_DOWNSHIFT
  const windowMs = o.windowMs ?? STALL_WINDOW_MS
  let times: number[] = []
  return {
    stall(nowMs: number): boolean {
      times = [...times.filter((t) => nowMs - t < windowMs), nowMs]
      if (times.length < limit) return false
      times = []
      return true
    },
  }
}

/** Seconds of recording to have before the picture starts: about two seconds of watching at that speed (2 s to 30 s of recording). */
export const bufferTargetSec = (speed: number): number => Math.min(30, Math.max(2, 2 * speed))

/** Start when that much is buffered ahead, or when the whole clip has arrived. */
export const readyToStart = (aheadSec: number, speed: number, complete: boolean): boolean => complete || aheadSec >= bufferTargetSec(speed)
