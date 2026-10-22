// Pure helpers for the live wall: layouts, paging and the gateway addresses. No browser or server code here, so they can be tested alone.

/**
 * Tiles per side: 1 (one big picture), 2 by 2, 3 by 3, 4 by 4 or 5 by 5 (P4-L1, LG-2: the legacy wall's 25). A 6 by 6 wall is not
 * offered: one request opens at most 36 streams, and 25 is the default number of live streams per person (LIVE_MAX_STREAMS_PER_USER).
 */
export const LAYOUTS = [1, 2, 3, 4, 5] as const
export type Layout = (typeof LAYOUTS)[number]
/** The biggest wall picked by itself; 5 by 5 only when somebody chooses it. */
const AUTO_LAYOUTS = [1, 2, 3, 4] as const

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

/** The layout that shows everything on one page when it can, otherwise 4 by 4. */
export function autoLayout(cameraCount: number): Layout {
  for (const l of AUTO_LAYOUTS) if (cameraCount <= perPage(l)) return l
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

/** The gateway port when the address is derived from the page (NEXT_PUBLIC_STREAM_GATEWAY_PORT, else 3412: ruling PORTS-1). */
export const DEFAULT_GATEWAY_PORT = 3412

/** Where a page was opened: `location` in a browser; the request's scheme and Host header on the server (the CSP). */
export type PageAddress = { protocol: string; host: string; hostname: string }

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i
const isLoopback = (hostname: string) => LOOPBACK.test(hostname)
/** A plain path: segments of unreserved characters, no `..`, no empty segment, no query, fragment, backslash or percent sign. */
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/

function portOf(port: string | number | undefined): number {
  const n = typeof port === 'number' ? port : /^\d{1,5}$/.test(String(port ?? '').trim()) ? Number(String(port).trim()) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_GATEWAY_PORT
}

/**
 * The gateway's address for a page (P3-1 brief item 3), without a trailing slash, or null when it cannot be known.
 *   - unset, empty or `auto`: the page's own host on the gateway port (`opts.port`, default 3412): http://10.0.0.47:3212 → http://10.0.0.47:3412
 *   - a path such as `/` or `/video`: the gateway sits behind the same address as the app (one reverse proxy; wss when the page is https)
 *   - an http(s) address: used as it is, except that an address on "this computer" (localhost, 127.x, ::1) seen from a page opened on
 *     another computer means that other computer, so the page's host is used instead (keeping the configured port and path)
 * Without a page (server code), only an explicit address is known.
 */
export function resolveGatewayBase(configured: string | undefined, page: PageAddress | null, opts: { port?: string | number } = {}): string | null {
  const value = (configured ?? '').trim()
  if (value === '' || value.toLowerCase() === 'auto') {
    if (!page || !page.hostname) return null
    return `${page.protocol}//${page.hostname}:${portOf(opts.port)}`
  }
  if (value.startsWith('/')) {
    if (!page || !SAFE_PATH.test(value) || value.split('/').some((s) => s === '..' || s === '.')) return null
    return `${page.protocol}//${page.host}${value.replace(/\/+$/, '')}`
  }
  const base = gatewayBase(value)
  if (!base || !page || !page.hostname || isLoopback(page.hostname)) return base
  const u = new URL(base)
  if (!isLoopback(u.hostname)) return base
  return `${u.protocol}//${page.hostname}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * The address the web server itself uses for the gateway (the health panel): GATEWAY_HEALTH_URL, else an explicit
 * NEXT_PUBLIC_STREAM_GATEWAY_URL, else (unset, `auto` or a path: the gateway runs next to the app) this computer on the gateway port.
 */
export function serverGatewayBase(env: Record<string, string | undefined> = process.env): string | null {
  if (env.GATEWAY_HEALTH_URL?.trim()) return gatewayBase(env.GATEWAY_HEALTH_URL.trim())
  const configured = (env.NEXT_PUBLIC_STREAM_GATEWAY_URL ?? '').trim()
  if (configured !== '' && configured.toLowerCase() !== 'auto' && !configured.startsWith('/')) return gatewayBase(configured)
  return `http://127.0.0.1:${portOf(env.GATEWAY_PORT || env.NEXT_PUBLIC_STREAM_GATEWAY_PORT)}`
}

/** The origins a page must be allowed to reach for this gateway (CSP connect-src): its http(s) origin and the matching ws(s) one. */
export function gatewayConnectOrigins(base: string | null): string[] {
  if (!base) return []
  try {
    const u = new URL(base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return []
    return [u.origin, u.origin.replace(/^http/, 'ws')]
  } catch {
    return []
  }
}

/** The video socket address for a token. The token is the only thing in the query. */
export function gatewaySocketUrl(base: string, token: string): string {
  return `${base.replace(/^http/, 'ws')}/g/ws?token=${encodeURIComponent(token)}`
}

export const gatewayScriptUrl = (base: string, attempt = 0): string => `${base}/g/video-stream.js${attempt > 0 ? `?r=${attempt}` : ''}`
