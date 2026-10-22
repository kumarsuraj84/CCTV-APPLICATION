// Fast playback in the browser: the speeds offered and the address of the video route. No server code here, so the Playback screen can use it.

/** 1x uses the video gateway (go2rtc); the others use /api/vod, which needs ffmpeg on the server. */
export const SPEEDS = [1, 2, 4, 8] as const
export type Speed = (typeof SPEEDS)[number]
/** The video route plays at most this many minutes. */
export const MAX_FAST_MINUTES = 30

export const isSpeed = (n: unknown): n is Speed => SPEEDS.some((s) => s === n)
export const speedLabel = (s: Speed) => `${s}x`

/** The number of minutes the video route can play for a chosen length. */
export function fastMinutes(length: number): number {
  return Math.min(MAX_FAST_MINUTES, Math.max(1, Math.round(Number.isFinite(length) ? length : 1)))
}

/** The address of the fast playback video: `start` is a shown-time ISO string (`yyyy-mm-ddThh:mm:ssZ`). */
export function vodUrl(o: { camera: string; start: string; minutes: number }): string {
  const q = new URLSearchParams({ camera: o.camera, start: o.start, minutes: String(fastMinutes(o.minutes)) })
  return `/api/vod?${q.toString()}`
}

/**
 * A video element cannot say why it failed, so after a failure the same request is made once more with `probe=1`: the server does every
 * check but sends no video, and answers in JSON. Returns the server's plain message, or null when the check passes or cannot be read.
 */
export async function explainVodFailure(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const probe = url + (url.includes('?') ? '&' : '?') + 'probe=1'
    const res = await fetchImpl(probe, { credentials: 'same-origin', cache: 'no-store' })
    if (res.ok) return null
    const body: unknown = await res.json()
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
    return typeof error === 'string' && error.length > 0 && error.length <= 300 ? error : null
  } catch {
    return null
  }
}
