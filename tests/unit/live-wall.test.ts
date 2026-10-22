import { describe, expect, it } from 'vitest'
import {
  autoLayout, gatewayBase, gatewayScriptUrl, gatewaySocketUrl, LAYOUTS, layoutLabel, pageCount, pageItems, pageStart, perPage, QUICK_RETRY_MS, REFRESH_AFTER_MS, RETRY_EVERY_MS,
} from '@/lib/streams/wall'
import { LIVE_WALL_ENABLED, liveWallHref } from '@/lib/groups/live-wall'
import { MAX_STREAMS_PER_REQUEST } from '@/lib/streams/open'
import { TOKEN_LIFETIME_SEC } from '@/lib/streams/token'

describe('wall layouts', () => {
  it('offers 1, 2x2, 3x3 and 4x4, and never more pictures on a page than one request may open', () => {
    expect([...LAYOUTS]).toEqual([1, 2, 3, 4])
    expect(LAYOUTS.map(perPage)).toEqual([1, 4, 9, 16])
    expect(Math.max(...LAYOUTS.map(perPage))).toBeLessThanOrEqual(MAX_STREAMS_PER_REQUEST)
    expect(LAYOUTS.map(layoutLabel)).toEqual(['1', '2×2', '3×3', '4×4'])
  })

  it('picks the smallest layout that shows everything, and 4x4 for more', () => {
    expect([0, 1, 2, 4, 5, 9, 10, 16, 17, 400].map(autoLayout)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4, 4])
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
    expect(REFRESH_AFTER_MS).toBe(8 * 60_000)
    expect(REFRESH_AFTER_MS).toBeLessThan(TOKEN_LIFETIME_SEC * 1000)
    expect(RETRY_EVERY_MS).toBe(30_000)
    expect(QUICK_RETRY_MS).toBeLessThan(RETRY_EVERY_MS)
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

describe('the groups screens link to the wall', () => {
  it('shows "Open live wall" now that /live exists, pointing at the group', () => {
    expect(LIVE_WALL_ENABLED).toBe(true)
    expect(liveWallHref('a b/c')).toBe('/live?group=a%20b%2Fc')
    expect(liveWallHref('0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0001')).toBe('/live?group=0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0001')
  })
})
