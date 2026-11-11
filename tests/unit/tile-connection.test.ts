import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_MAX_MS, CONNECT_TIMEOUT_MS, createTileConnection, reconnectDelayMs, type TileView } from '@/lib/streams/tile-connection'
import { QUICK_RETRY_MS, RETRY_EVERY_MS } from '@/lib/streams/wall'

// P4-L1 brief item 2, the wall's cleanup: every picture's socket is closed when the tile is paused (hidden tab, scrolled away, behind
// the large picture, over the bandwidth limit), replaced or removed (navigation), and a picture that cannot play reconnects with a
// back-off. The browser part (go2rtc's player) is a `connect` function; here a fake one counts the open sockets.

type Sock = { url: string; open: boolean; playing: () => void; end: () => void }
function fakeGateway() {
  const sockets: Sock[] = []
  const connect = (url: string, ev: { onPlaying: () => void; onEnded: (reason?: string) => void }) => {
    const s: Sock = { url, open: true, playing: () => ev.onPlaying(), end: () => ev.onEnded() }
    sockets.push(s)
    return () => { s.open = false }
  }
  return { sockets, connect, open: () => sockets.filter((s) => s.open).length }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('reconnect back-off', () => {
  it('a picture that played a while and ended comes back quickly; a failing one waits 2, 4, 8, 16 then 30 seconds', () => {
    expect(reconnectDelayMs(1, true)).toBe(QUICK_RETRY_MS)
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => reconnectDelayMs(n, false))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(BACKOFF_MAX_MS).toBe(RETRY_EVERY_MS)
  })
})

describe('one tile\'s connection', () => {
  it('connects when it has a token and is not paused; a new token does not reconnect a running picture', () => {
    const gw = fakeGateway()
    const views: TileView[] = []
    const c = createTileConnection({ connect: gw.connect, onView: (v) => views.push(v) })
    c.update({ url: null, paused: false })
    expect(gw.sockets).toHaveLength(0)
    c.update({ url: 'ws://gw/t1', paused: false })
    expect(gw.open()).toBe(1)
    gw.sockets[0].playing()
    c.update({ url: 'ws://gw/t2', paused: false })
    expect(gw.sockets).toHaveLength(1)
    expect(views.at(-1)).toBe('playing')
    c.dispose()
  })

  it('pausing closes the socket at once; resuming opens a new one with the newest token', () => {
    const gw = fakeGateway()
    const c = createTileConnection({ connect: gw.connect, onView: () => {} })
    c.update({ url: 'ws://gw/t1', paused: false })
    c.update({ url: 'ws://gw/t1', paused: true })
    expect(gw.open()).toBe(0)
    c.update({ url: 'ws://gw/t2', paused: true })
    expect(gw.sockets).toHaveLength(1)
    c.update({ url: 'ws://gw/t2', paused: false })
    expect(gw.open()).toBe(1)
    expect(gw.sockets[1].url).toBe('ws://gw/t2')
    c.dispose()
  })

  it('a failing picture reconnects with growing pauses, and a long-playing one that ended comes back quickly', () => {
    const gw = fakeGateway()
    const views: TileView[] = []
    const c = createTileConnection({ connect: gw.connect, onView: (v) => views.push(v) })
    c.update({ url: 'ws://gw/t', paused: false })
    gw.sockets[0].end()
    expect(views.at(-1)).toBe('unavailable')
    expect(gw.open()).toBe(0)
    vi.advanceTimersByTime(1_999)
    expect(gw.sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(gw.sockets).toHaveLength(2)
    gw.sockets[1].end()
    vi.advanceTimersByTime(3_999)
    expect(gw.sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(gw.sockets).toHaveLength(3)
    gw.sockets[2].playing()
    vi.advanceTimersByTime(60_000)
    gw.sockets[2].end()
    expect(views.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(QUICK_RETRY_MS)
    expect(gw.sockets).toHaveLength(4)
    expect(gw.open()).toBe(1)
    c.dispose()
  })

  it('a socket that shows nothing within the connect time is closed and tried again later', () => {
    const gw = fakeGateway()
    const c = createTileConnection({ connect: gw.connect, onView: () => {} })
    c.update({ url: 'ws://gw/t', paused: false })
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    expect(gw.open()).toBe(0)
    vi.advanceTimersByTime(2_000)
    expect(gw.open()).toBe(1)
    c.dispose()
  })

  it('removal (navigation away) closes everything and nothing comes back: no socket, no timer left', () => {
    const gw = fakeGateway()
    const c = createTileConnection({ connect: gw.connect, onView: () => {} })
    c.update({ url: 'ws://gw/t', paused: false })
    gw.sockets[0].end() // a retry is pending
    c.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(gw.sockets).toHaveLength(1)
    expect(gw.open()).toBe(0)
    // Events of a closed socket that arrive late change nothing.
    gw.sockets[0].end()
    gw.sockets[0].playing()
    c.update({ url: 'ws://gw/t', paused: false })
    expect(gw.sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('an NVR whose login stands refused (final fix X, review C I-2)', () => {
  it('the gateway says so: the tile shows it, never reconnects by itself, and tries again only with a new token', () => {
    const sockets: { end: (reason?: string) => void }[] = []
    const views: TileView[] = []
    const refused: number[] = []
    const c = createTileConnection({
      connect: (_url, ev) => {
        sockets.push({ end: (reason) => ev.onEnded(reason) })
        return () => {}
      },
      onView: (v) => views.push(v),
      onRefused: () => refused.push(1),
    })
    c.update({ url: 'ws://gw/t1', paused: false })
    sockets[0].end('nvr_login_refused')
    expect(views.at(-1)).toBe('refused')
    expect(refused).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10 * 60_000)
    expect(sockets).toHaveLength(1) // a wall of 16 such tiles makes no request at all
    c.update({ url: 'ws://gw/t1', paused: false })
    expect(sockets).toHaveLength(1)
    c.update({ url: 'ws://gw/t2', paused: false })
    expect(sockets).toHaveLength(2)
    c.dispose()
  })
})

describe('a whole wall', () => {
  it('a 5×5 page, a page change, a hidden tab and leaving the page: the open sockets are always exactly the tiles that play', () => {
    const gw = fakeGateway()
    const page = (n: number) => Array.from({ length: 25 }, (_, i) => `cam-${n}-${i}`)
    let tiles = new Map(page(1).map((id) => [id, createTileConnection({ connect: gw.connect, onView: () => {} })]))
    for (const [id, t] of tiles) t.update({ url: `ws://gw/${id}`, paused: false })
    expect(gw.open()).toBe(25)
    // Next page: the old tiles go (dispose), the new ones come.
    for (const t of tiles.values()) t.dispose()
    tiles = new Map(page(2).map((id) => [id, createTileConnection({ connect: gw.connect, onView: () => {} })]))
    for (const [id, t] of tiles) t.update({ url: `ws://gw/${id}`, paused: false })
    expect(gw.open()).toBe(25)
    for (const [id, t] of tiles) t.update({ url: `ws://gw/${id}`, paused: true }) // the tab is hidden
    expect(gw.open()).toBe(0)
    for (const [id, t] of tiles) t.update({ url: `ws://gw/${id}`, paused: false })
    expect(gw.open()).toBe(25)
    for (const t of tiles.values()) t.dispose() // navigation away
    expect(gw.open()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
