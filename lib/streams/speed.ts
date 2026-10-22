import { isAdminRole, type Role } from '@/lib/admin/roles'

// Fast playback in the browser: the speeds offered and the address of the video route. No server code here, so the Playback screen can use it.

/**
 * INTERIM rule: until the capability model exists, only administrators and platform owners may use fast playback (the route /api/vod, its
 * probe, and the 2x/4x/8x choice on the Playback screen). This is the one place that decides it; the capability rewiring replaces it here.
 */
export const canUseFastPlaybackInterim = (role: Role): boolean => isAdminRole(role)
export const MSG_FAST_NOT_FOR_YOU = 'Fast playback is not available for your account yet.'

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

/** What a video element's error code 4 (the address did not give a video it can play) most likely means when the server had no complaint. */
export const MSG_BROWSER_CANNOT_PLAY = "This browser cannot play this camera's recording format."

export type VodProbe = { error: string | null; codec: 'h264' | 'h265' | null }

/**
 * A video element cannot say why it failed, so after a failure the same request is made once more with `probe=1`: the server does every
 * check but sends no video, and answers in JSON. `error` is the server's plain message, or null when the check passes or cannot be read;
 * `codec` is the video format the server read from the recording list, when it did.
 */
export async function probeVod(url: string, fetchImpl: typeof fetch = fetch): Promise<VodProbe> {
  try {
    const probe = url + (url.includes('?') ? '&' : '?') + 'probe=1'
    const res = await fetchImpl(probe, { credentials: 'same-origin', cache: 'no-store' })
    const body: unknown = await res.json()
    const fields = typeof body === 'object' && body !== null ? (body as { error?: unknown; codec?: unknown }) : {}
    const codec = fields.codec === 'h264' || fields.codec === 'h265' ? fields.codec : null
    if (res.ok) return { error: null, codec }
    const error = fields.error
    return { error: typeof error === 'string' && error.length > 0 && error.length <= 300 ? error : null, codec }
  } catch {
    return { error: null, codec: null }
  }
}

/** Just the server's message (see probeVod), or null. */
export async function explainVodFailure(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  return (await probeVod(url, fetchImpl)).error
}
