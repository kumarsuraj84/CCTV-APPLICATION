// Pure helpers for the live wall: layouts, paging and the gateway addresses. No browser or server code here, so they can be tested alone.

/** Tiles per side: 1 (one big picture), 2 by 2, 3 by 3 or 4 by 4. A 6 by 6 wall is not offered: one request opens at most 36 streams. */
export const LAYOUTS = [1, 2, 3, 4] as const
export type Layout = (typeof LAYOUTS)[number]

// P2-4 (D-3): a token can open a socket for 90 seconds only, so new ones are fetched every minute while the wall is shown (a tile that
// reconnects always holds one that still works). Each renewal checks cctv.live again and makes new media sessions; unused ones expire.
export const REFRESH_AFTER_MS = 60_000
// P2-4 review m-11: most renewals only renew the tokens (no NVR login, no go2rtc request); every 8 minutes the wall opens everything
// again (registers the streams, which also brings back a stream go2rtc dropped as idle). Cameras that failed are always opened in full.
export const REOPEN_AFTER_MS = 8 * 60_000
/** Which renewal is due: `full` when the last full opening is REOPEN_AFTER_MS old (or never happened), else `tokens`. */
export const renewalKind = (nowMs: number, lastFullMs: number): 'full' | 'tokens' => (lastFullMs <= 0 || nowMs - lastFullMs >= REOPEN_AFTER_MS ? 'full' : 'tokens')
export const RETRY_EVERY_MS = 30_000 // when video is not available, try again this often
export const QUICK_RETRY_MS = 2_000 // a picture that played and then ended (the gateway ends sessions after 30 minutes) comes back quickly

export const perPage = (layout: Layout): number => layout * layout
export const layoutLabel = (layout: Layout): string => (layout === 1 ? '1' : `${layout}×${layout}`)

/** The layout that shows everything on one page when it can, otherwise the biggest wall. */
export function autoLayout(cameraCount: number): Layout {
  for (const l of LAYOUTS) if (cameraCount <= perPage(l)) return l
  return 4
}

/** The index of the first camera on the page that holds `index`. */
export const pageStart = (index: number, layout: Layout): number => Math.floor(Math.max(0, index) / perPage(layout)) * perPage(layout)

export const pageCount = (cameraCount: number, layout: Layout): number => Math.max(1, Math.ceil(cameraCount / perPage(layout)))

export function pageItems<T>(items: readonly T[], start: number, layout: Layout): T[] {
  return items.slice(start, start + perPage(layout))
}

/** The gateway's web address without a trailing slash, or null when it is missing or not an http(s) address. */
export function gatewayBase(value: string | undefined): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** The video socket address for a token. The token is the only thing in the query. */
export function gatewaySocketUrl(base: string, token: string): string {
  return `${base.replace(/^http/, 'ws')}/g/ws?token=${encodeURIComponent(token)}`
}

export const gatewayScriptUrl = (base: string, attempt = 0): string => `${base}/g/video-stream.js${attempt > 0 ? `?r=${attempt}` : ''}`
