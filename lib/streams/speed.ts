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

export const MSG_FAST_NOT_SET_UP = 'Fast playback is not set up on this server.'
export const MSG_BROWSER_CANNOT_PLAY ="This browser cannot play this camera's recording format."
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

// ── Review round 1 (owner ruling on I-1): fast playback is watching, not dumping ─────────────────────────────────────────────────────

/** The stream is released at most this far ahead of speed x real time (enough for the player's start and its look-ahead). */
export const FAST_BURST_SEC = 60
/** Bytes per second of recording that one stream may carry at most (16 Mbit/s: above any camera main stream here). */
export const FAST_MAX_BYTES_PER_REC_SEC = 2_000_000
/** A stream that nobody reads for this long (a paused or hidden player) ends and gives its place back (review I-2). */
export const VIEWER_IDLE_MS = 60_000
/** The response header that says the body is framed (obfuscated: XOR with a key the page derives from its token). */
export const FAST_FRAMING_HEADER = 'x-stream-framing'
export const FAST_FRAMING = 'x32'

/** Wall-clock seconds that `recordingSec` of recording takes at `speed` (the pace the server holds). */
export const secondsToPlay = (recordingSec: number, speed: number): number => recordingSec / speed

const whole = (raw: string | undefined, fallback: number, max: number): number => {
  const n = /^\s*\d{1,6}\s*$/.test(raw ?? '') ? Number(raw) : Number.NaN
  return Number.isInteger(n) && n >= 1 ? Math.min(max, n) : fallback
}
/**
 * The per-person budget of fast playback, in minutes of RECORDING: FAST_PLAYBACK_MINUTES_PER_HOUR (default 120) in any rolling hour and
 * FAST_PLAYBACK_MINUTES_PER_DAY (default 480 = 8 hours) in any rolling 24 hours. Anything that is not a whole number from 1 is the default.
 */
export function fastBudget(env: Record<string, string | undefined>): { perHourMin: number; perDayMin: number } {
  return { perHourMin: whole(env.FAST_PLAYBACK_MINUTES_PER_HOUR, 120, 1440), perDayMin: whole(env.FAST_PLAYBACK_MINUTES_PER_DAY, 480, 1440) }
}
export const MSG_FAST_BUDGET = (b: { perHourMin: number; perDayMin: number }) =>
  `You have used your fast playback time for now (${b.perHourMin} minutes of recording per hour, ${Math.round((b.perDayMin / 60) * 10) / 10} hours per day). Play at 1x, or try fast playback again later.`

export const MSG_RECORDING_PART_ENDED = 'The recording stopped before the end of the chosen time (the NVR may keep it in parts). Use "Continue from here" to play on.'

/** What to say when a fast clip ends: the chosen time, or an earlier end (a recording in parts) with the offer to carry on (review m-3). */
export function clipEnd(playedSec: number, minutes: number): { message: string; canContinue: boolean } {
  return playedSec >= minutes * 60 - 5 ? { message: 'End of the chosen time.', canContinue: false } : { message: MSG_RECORDING_PART_ENDED, canContinue: true }
}
