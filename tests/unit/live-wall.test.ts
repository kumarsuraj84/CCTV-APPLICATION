import { describe, expect, it } from 'vitest'
import {
  autoLayout, gatewayBase, gatewayConnectOrigins, gatewayScriptUrl, gatewaySocketUrl, LAYOUTS, resolveGatewayBase, serverGatewayBase, layoutLabel, pageCount, pageItems, pageStart, perPage, QUICK_RETRY_MS, REFRESH_AFTER_MS, renewalKind,
  REOPEN_AFTER_MS, RETRY_EVERY_MS, layoutsFor, planRequest,
} from '@/lib/streams/wall'
import { LIVE_WALL_ENABLED, liveWallHref } from '@/lib/groups/live-wall'
import { MAX_STREAMS_PER_REQUEST } from '@/lib/streams/open'
import { TOKEN_LIFETIME_SEC } from '@/lib/streams/token'

describe('wall layouts', () => {
  // P4-L1 (LG-2): the legacy wall's 5×5 (25 pictures) is offered too; it is chosen by hand only, the automatic choice stays at most 4×4.
  it('offers 1, 2x2, 3x3, 4x4 and 5x5, and never more pictures on a page than one request may open', () => {
    expect([...LAYOUTS]).toEqual([1, 2, 3, 4, 5])
    expect(LAYOUTS.map(perPage)).toEqual([1, 4, 9, 16, 25])
    expect(Math.max(...LAYOUTS.map(perPage))).toBeLessThanOrEqual(MAX_STREAMS_PER_REQUEST)
    expect(LAYOUTS.map(layoutLabel)).toEqual(['1', '2×2', '3×3', '4×4', '5×5'])
  })

  it('picks the smallest layout that shows everything, and 4x4 for more (5x5 only when chosen)', () => {
    expect([0, 1, 2, 4, 5, 9, 10, 16, 17, 25, 400].map(autoLayout)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4])
    expect(pageCount(50, 5)).toBe(2)
    expect(pageStart(30, 5)).toBe(25)
  })

  it('pages: 16 to a page on a 4x4 wall', () => {
    expect(pageCount(40, 4)).toBe(3)
    expect(pageCount(16, 4)).toBe(1)
    expect(pageCount(0, 4)).toBe(1)
    expect(pageCount(5, 2)).toBe(2)
    const items = Array.from({ length: 40 }, (_, i) => i)
    expect(pageItems(items, 32, 4)).toEqual(items.slice(32, 40))
    expect(pageItems(items, 0, 4)).toHaveLength(16)
  })

  it('keeps the first picture on screen when the layout changes', () => {
    expect(pageStart(20, 4)).toBe(16)
    expect(pageStart(20, 2)).toBe(20)
    expect(pageStart(20, 3)).toBe(18)
    expect(pageStart(20, 1)).toBe(20)
    expect(pageStart(-5, 4)).toBe(0)
  })
})

describe('wall timing', () => {
  it('renews tokens before they expire, and retries every 30 seconds', () => {
    // P2-4 (D-3, AC-14): the connect window is 90 seconds (it was 10 minutes, renewed after 8), so the wall renews every minute and a
    // tile that reconnects (the gateway ends a socket after 30 minutes) always holds a token that can still connect.
    expect(REFRESH_AFTER_MS).toBe(60_000)
    expect(REFRESH_AFTER_MS).toBeLessThan(TOKEN_LIFETIME_SEC * 1000)
    expect(TOKEN_LIFETIME_SEC * 1000 - REFRESH_AFTER_MS).toBeGreaterThanOrEqual(30_000) // time for the renewal itself to come back
    expect(RETRY_EVERY_MS).toBe(30_000)
    expect(QUICK_RETRY_MS).toBeLessThan(RETRY_EVERY_MS)
  })
})

describe('wall renewal (P2-4 review m-11)', () => {
  it('renews only the tokens every minute and opens everything again every 8 minutes', () => {
    expect(REOPEN_AFTER_MS).toBe(8 * 60_000)
    const t = 1_800_000_000_000
    expect(renewalKind(t + 60_000, t)).toBe('tokens')
    expect(renewalKind(t + REOPEN_AFTER_MS - 1, t)).toBe('tokens')
    expect(renewalKind(t + REOPEN_AFTER_MS, t)).toBe('full')
    expect(renewalKind(t, 0)).toBe('full') // never fully opened
  })
})

describe('gateway addresses', () => {
  it('accepts an http(s) origin and drops a trailing slash', () => {
    expect(gatewayBase('http://localhost:3412')).toBe('http://localhost:3412')
    expect(gatewayBase('https://video.example.com/')).toBe('https://video.example.com')
    expect(gatewayBase('http://10.0.0.5:3412/')).toBe('http://10.0.0.5:3412')
  })

  it('refuses anything else', () => {
    for (const v of [undefined, '', 'localhost:3412', 'ftp://x', 'javascript:alert(1)', 'http://u:p@host', 'http://host?x=1', 'http://host#a', 'not a url']) expect(gatewayBase(v), String(v)).toBeNull()
  })

  it('builds the socket address with the token as the only parameter', () => {
    expect(gatewaySocketUrl('http://localhost:3412', 'abc.def')).toBe('ws://localhost:3412/g/ws?token=abc.def')
    expect(gatewaySocketUrl('https://v.example.com', 'a b')).toBe('wss://v.example.com/g/ws?token=a%20b')
  })

  it('builds the player script address, with a fresh query only on a retry', () => {
    expect(gatewayScriptUrl('http://localhost:3412')).toBe('http://localhost:3412/g/video-stream.js')
    expect(gatewayScriptUrl('http://localhost:3412', 2)).toBe('http://localhost:3412/g/video-stream.js?r=2')
  })
})

// P3-1 brief item 3: when NEXT_PUBLIC_STREAM_GATEWAY_URL is unset, `auto` or a path, the gateway is found from the address the page was
// opened with, so the hub PC (http://10.0.0.47:3212) and the computer it runs on (http://localhost:3212) both reach their own gateway.
describe('gateway address derived from the page (P3-1)', () => {
  const hub = { protocol: 'http:', host: '10.0.0.47:3212', hostname: '10.0.0.47' }
  const local = { protocol: 'http:', host: 'localhost:3212', hostname: 'localhost' }
  const tls = { protocol: 'https:', host: 'drishti.citykart.local', hostname: 'drishti.citykart.local' }

  it('unset or `auto`: the same host as the page on the gateway port (3412 unless configured)', () => {
    for (const v of [undefined, '', '  ', 'auto', 'AUTO', ' Auto ']) {
      expect(resolveGatewayBase(v, hub), String(v)).toBe('http://10.0.0.47:3412')
      expect(resolveGatewayBase(v, local), String(v)).toBe('http://localhost:3412')
    }
    expect(resolveGatewayBase('auto', hub, { port: '4000' })).toBe('http://10.0.0.47:4000')
    expect(resolveGatewayBase('auto', hub, { port: 4001 })).toBe('http://10.0.0.47:4001')
    expect(resolveGatewayBase('auto', tls)).toBe('https://drishti.citykart.local:3412')
    expect(resolveGatewayBase(undefined, { protocol: 'http:', host: '[fd00::5]:3212', hostname: '[fd00::5]' })).toBe('http://[fd00::5]:3412')
  })

  it('a bad gateway port falls back to 3412', () => {
    for (const port of ['0', '65536', 'x', '34 12', '-1', '1.5']) expect(resolveGatewayBase('auto', hub, { port }), port).toBe('http://10.0.0.47:3412')
  })

  it('a path: the gateway sits behind the same address as the app (one reverse proxy, wss on https)', () => {
    expect(resolveGatewayBase('/', tls)).toBe('https://drishti.citykart.local')
    expect(resolveGatewayBase('/video', tls)).toBe('https://drishti.citykart.local/video')
    expect(resolveGatewayBase('/video/', tls)).toBe('https://drishti.citykart.local/video')
    expect(resolveGatewayBase('/video', hub)).toBe('http://10.0.0.47:3212/video')
    expect(gatewaySocketUrl(resolveGatewayBase('/', tls)!, 't')).toBe('wss://drishti.citykart.local/g/ws?token=t')
    expect(gatewayScriptUrl(resolveGatewayBase('/video', tls)!)).toBe('https://drishti.citykart.local/video/g/video-stream.js')
  })

  it('refuses paths that could leave the page origin or carry anything but a path', () => {
    for (const v of ['//evil.example', '/\\evil.example', '/a?b=1', '/a#b', '/a b', '/../x', '/a/../b', '/%2e%2e/x', '/a//b']) expect(resolveGatewayBase(v, tls), v).toBeNull()
  })

  it('an explicit address is kept as it is', () => {
    expect(resolveGatewayBase('http://10.0.0.5:3412', hub)).toBe('http://10.0.0.5:3412')
    expect(resolveGatewayBase('https://video.example.com/', tls)).toBe('https://video.example.com')
    expect(resolveGatewayBase('http://localhost:3412', local)).toBe('http://localhost:3412')
    expect(resolveGatewayBase('http://127.0.0.1:3412', { protocol: 'http:', host: '127.0.0.1:3212', hostname: '127.0.0.1' })).toBe('http://127.0.0.1:3412')
  })

  it('an explicit address on "this computer" opened from another PC uses the page host instead (localhost there is the other PC)', () => {
    expect(resolveGatewayBase('http://localhost:3412', hub)).toBe('http://10.0.0.47:3412')
    expect(resolveGatewayBase('http://127.0.0.1:3412/', hub)).toBe('http://10.0.0.47:3412')
    expect(resolveGatewayBase('http://[::1]:3412', hub)).toBe('http://10.0.0.47:3412')
  })

  it('refuses a bad explicit address, and without a page knows only an explicit one', () => {
    for (const v of ['localhost:3412', 'ftp://x', 'javascript:alert(1)', 'http://u:p@host', 'http://host?x=1', 'not a url']) expect(resolveGatewayBase(v, hub), v).toBeNull()
    expect(resolveGatewayBase('auto', null)).toBeNull()
    expect(resolveGatewayBase('/video', null)).toBeNull()
    expect(resolveGatewayBase('http://10.0.0.5:3412/', null)).toBe('http://10.0.0.5:3412')
  })

  it('the server reaches the gateway itself (health panel): an explicit address, GATEWAY_HEALTH_URL, or this computer on the gateway port', () => {
    expect(serverGatewayBase({ NEXT_PUBLIC_STREAM_GATEWAY_URL: 'http://10.0.0.47:3412' })).toBe('http://10.0.0.47:3412')
    expect(serverGatewayBase({ NEXT_PUBLIC_STREAM_GATEWAY_URL: 'auto', GATEWAY_HEALTH_URL: 'http://127.0.0.1:3999/' })).toBe('http://127.0.0.1:3999')
    expect(serverGatewayBase({})).toBe('http://127.0.0.1:3412')
    expect(serverGatewayBase({ NEXT_PUBLIC_STREAM_GATEWAY_URL: 'auto', GATEWAY_PORT: '3500' })).toBe('http://127.0.0.1:3500')
    expect(serverGatewayBase({ NEXT_PUBLIC_STREAM_GATEWAY_URL: '/', NEXT_PUBLIC_STREAM_GATEWAY_PORT: '3600' })).toBe('http://127.0.0.1:3600')
    expect(serverGatewayBase({ NEXT_PUBLIC_STREAM_GATEWAY_URL: 'ftp://x' })).toBeNull()
  })

  it('names the origins a page must be allowed to connect to (the CSP connect targets): the http(s) and the ws(s) form', () => {
    expect(gatewayConnectOrigins('http://10.0.0.47:3412')).toEqual(['http://10.0.0.47:3412', 'ws://10.0.0.47:3412'])
    expect(gatewayConnectOrigins('http://localhost:3412')).toEqual(['http://localhost:3412', 'ws://localhost:3412'])
    expect(gatewayConnectOrigins('https://drishti.citykart.local/video')).toEqual(['https://drishti.citykart.local', 'wss://drishti.citykart.local'])
    expect(gatewayConnectOrigins(null)).toEqual([])
    expect(gatewayConnectOrigins('not a url')).toEqual([])
  })
})

describe('the groups screens link to the wall', () => {
  it('shows "Open live wall" now that /live exists, pointing at the group', () => {
    expect(LIVE_WALL_ENABLED).toBe(true)
    expect(liveWallHref('a b/c')).toBe('/live?group=a%20b%2Fc')
    expect(liveWallHref('0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0001')).toBe('/live?group=0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0001')
  })
})

// P4-L1 review round 1: the wall's request plan (M-5 tour and returning tab reuse what was opened within 8 minutes, by token renewal;
// M-6 cameras paused for bandwidth do not turn the one-minute renewal into a full opening) and the layouts a phone offers (M-11).
describe('the wall\'s next request (review M-5, M-6)', () => {
  const t = 1_800_000_000_000
  const base = { phase: 'ready' as const, held: ['a', 'b'], paused: [] as string[], issuedAt: t, fullAt: t, triedAt: t, refreshFailed: false }
  const never = () => false

  it('a new list opens in full, unless every camera of it was opened in full within the last 8 minutes: then tokens only', () => {
    expect(planRequest(['a', 'b'], { ...base, phase: 'loading', held: [] }, t, never)).toEqual({ at: t, mode: 'open', which: ['a', 'b'] })
    expect(planRequest(['a', 'b'], { ...base, phase: 'loading', held: [] }, t, (id) => id === 'a')).toEqual({ at: t, mode: 'open', which: ['a', 'b'] })
    expect(planRequest(['a', 'b'], { ...base, phase: 'loading', held: [] }, t, () => true)).toEqual({ at: t, mode: 'tokens', which: ['a', 'b'] })
  })

  it('the one-minute renewal is tokens only even while some cameras are paused; the paused ones are asked for again every 30 s', () => {
    const s = { ...base, held: ['a'], paused: ['b'] }
    expect(planRequest(['a', 'b'], s, t, never)).toEqual({ at: t + RETRY_EVERY_MS, mode: 'full', which: ['b'] })
    expect(planRequest(['a', 'b'], s, t + REFRESH_AFTER_MS, never)).toEqual({ at: t + RETRY_EVERY_MS, mode: 'tokens', which: ['a'] })
  })

  it('a camera that did not come back (missing) is opened again in full; every 8 minutes everything is', () => {
    expect(planRequest(['a', 'b', 'c'], { ...base }, t, never)).toEqual({ at: t + RETRY_EVERY_MS, mode: 'full', which: ['c'] })
    expect(planRequest(['a', 'b'], { ...base, issuedAt: t + REOPEN_AFTER_MS - REFRESH_AFTER_MS }, t + REOPEN_AFTER_MS, never))
      .toEqual({ at: t + REOPEN_AFTER_MS, mode: 'full', which: ['a', 'b'] })
    expect(planRequest([], { ...base }, t, never)).toBeNull()
  })
})

describe('layouts on a phone (review M-11)', () => {
  it('offers one picture or 2×2 below 640 px, everything on a computer', () => {
    expect(layoutsFor(true)).toEqual([1, 2])
    expect(layoutsFor(false)).toEqual([...LAYOUTS])
  })
})
