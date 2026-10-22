import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { click, fire, installMiniDom, type MiniDocument, type MiniElement } from '../helpers/mini-dom'

// P4-L1 review M-3 ("component tests for the wall cleanup", brief item 5): the REACT side of the wall — LiveWall, its tiles' effects,
// useOpenedStreams' resets, the tour's page switch — mounted with react-dom/client in a tiny DOM (tests/helpers/mini-dom.ts; the
// repository has no DOM library and nothing may be installed). The player is a fake that counts open sockets; the server actions are
// fakes that hand out tokens. What must hold: the open sockets are exactly the tiles that play, after a wall change, a hidden tab, the
// large picture, a tour step, the idle prompt, and none at all after leaving the page.

const sockets = new Set<string>()
const asked: { fn: string; ids: string[]; release?: unknown }[] = []
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }))
vi.mock('@/components/live/useGatewayBase', () => ({ useGatewayBase: () => 'http://gw.test:3412' }))
vi.mock('@/components/live/player', () => ({
  loadPlayer: () => Promise.resolve(),
  startPlayer: (_host: unknown, url: string, ev: { onPlaying: () => void }) => {
    sockets.add(url)
    queueMicrotask(() => ev.onPlaying())
    return () => { sockets.delete(url) }
  },
}))
const token = (id: string, n: number) => `t-${id}-${n}`
let issued = 0
vi.mock('@/lib/actions/streams', () => ({
  openStreamsAction: async (ids: string[], kind: string, o?: { release?: unknown }) => {
    asked.push({ fn: 'open', ids, release: o?.release })
    return { ok: true, streams: ids.map((id) => ({ cameraId: id, name: id, storeCode: 'L', channel: 1, kind, token: token(id, ++issued) })) }
  },
  refreshStreamTokensAction: async (ids: string[], kind: string) => {
    asked.push({ fn: 'full', ids })
    return { ok: true, streams: ids.map((id) => ({ cameraId: id, name: id, storeCode: 'L', channel: 1, kind, token: token(id, ++issued) })) }
  },
  renewStreamTokensAction: async (ids: string[]) => {
    asked.push({ fn: 'tokens', ids })
    return { ok: true, tokens: ids.map((id) => ({ cameraId: id, token: token(id, ++issued) })) }
  },
}))
vi.mock('@/lib/actions/groups', () => ({ addCamerasAction: vi.fn(), removeCameraAction: vi.fn(), createGroupAction: vi.fn() }))

let dom: { document: MiniDocument; restore: () => void }
const roots: { unmount: () => void }[] = []
/** The camera a socket was opened for (its token is t-<camera>-<n>). */
const cameraOf = (url: string) => decodeURIComponent(url.split('token=')[1] ?? '').replace(/^t-/, '').replace(/-\d+$/, '')
beforeAll(() => { dom = installMiniDom() })
afterAll(() => dom.restore())
beforeEach(() => { sockets.clear(); asked.length = 0; dom.document.visibilityState = 'visible' })
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount())
  vi.useRealTimers()
})

const cam = (i: number, loc = 'L1') => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Camera ${i}`, storeCode: loc, locationId: loc, channel: i, status: 'up' as const, stale: false, state: 'live' as const, canPlayback: false })
const settle = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }

async function mount(node: React.ReactNode) {
  const { createRoot } = await import('react-dom/client')
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const root = createRoot(container as unknown as Element)
  let gone = false
  roots.push({ unmount: () => { if (!gone) root.unmount() } })
  const real = root.unmount.bind(root)
  root.unmount = () => { gone = true; real() }
  await act(async () => root.render(node))
  await settle()
  return { root, container }
}

describe('the wall cleans up after itself (React side; review M-3)', () => {
  it('opens one socket per playing tile; another wall replaces them; leaving the page closes all, and nothing reconnects', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    const first = [1, 2, 3, 4].map((i) => cam(i))
    const { root } = await mount(<LiveWall cameras={first} maxStreams={25} />)
    expect(sockets.size).toBe(4)
    const second = [5, 6].map((i) => cam(i))
    await act(async () => root.render(<LiveWall cameras={second} maxStreams={25} />))
    await settle()
    expect([...sockets].map(cameraOf).sort()).toEqual(second.map((c) => c.id).sort())
    expect(sockets.size).toBe(2)
    // The next list's first request released the old cameras (review I-1).
    expect(asked.find((a) => a.ids.includes(second[0].id))?.release).toEqual([{ cameraIds: first.map((c) => c.id), kind: 'sub' }])
    await act(async () => root.unmount())
    await settle(50)
    expect(sockets.size).toBe(0)
  })

  it('a hidden tab closes every socket and asks for nothing; coming back opens them again', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    const { root } = await mount(<LiveWall cameras={[1, 2, 3].map((i) => cam(i))} maxStreams={25} />)
    expect(sockets.size).toBe(3)
    dom.document.visibilityState = 'hidden'
    await act(async () => { dom.document.dispatchEvent({ type: 'visibilitychange' }) })
    await settle()
    expect(sockets.size).toBe(0)
    const before = asked.length
    await settle(80)
    expect(asked.length).toBe(before)
    dom.document.visibilityState = 'visible'
    await act(async () => { dom.document.dispatchEvent({ type: 'visibilitychange' }) })
    await settle(700) // the 500 ms debounce of coming back
    await settle(100) // the request it then makes, and the tiles connecting
    expect(sockets.size).toBe(3)
    // Coming back within 8 minutes renews the tokens only (review M-5): no second full opening.
    expect(asked.slice(before).map((a) => a.fn)).toEqual(['tokens'])
    await act(async () => root.unmount())
    expect(sockets.size).toBe(0)
  })

  it('above the limit only the first tiles play; the rest have no socket', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    const { root, container } = await mount(<LiveWall cameras={[1, 2, 3, 4].map((i) => cam(i))} maxStreams={2} />)
    expect(sockets.size).toBe(2)
    expect((container as unknown as MiniElement).textContent).toContain('Paused to save bandwidth')
    await act(async () => root.unmount())
    expect(sockets.size).toBe(0)
  })

  it('a tour step replaces the page\'s sockets (the old page released), and a key stops the tour', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    const cams = Array.from({ length: 20 }, (_, i) => cam(i + 1))
    const { container } = await mount(<LiveWall cameras={cams} maxStreams={25} />)
    expect(sockets.size).toBe(16) // 4×4, page 1
    const root = container as unknown as MiniElement
    const interval = root.findAll((e) => e.tagName === 'SELECT')[0]
    interval.value = '5' // the shortest interval
    await act(async () => fire(interval, 'change'))
    const startTour = root.findAll((e) => e.tagName === 'BUTTON' && e.textContent.includes('Start tour'))[0]
    await act(async () => click(startTour))
    expect(root.textContent).toContain('Stop tour')
    await settle(5_300)
    await settle(100)
    expect([...sockets].map(cameraOf).sort()).toEqual(cams.slice(16).map((c) => c.id).sort())
    const step = asked.find((a) => a.ids.length === 4 && a.ids[0] === cams[16].id)!
    expect(step.release).toEqual([{ cameraIds: cams.slice(0, 16).map((c) => c.id), kind: 'sub' }])
    await act(async () => { dom.document.dispatchEvent({ type: 'keydown', key: 'x', target: dom.document.body } as never) })
    expect((container as unknown as MiniElement).textContent).toContain('Start tour')
  }, 15_000)

  it('the idle prompt stops the wall: no socket, no request, until "Continue watching"', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    const { LivePresence } = await import('@/components/live/LivePresence')
    const { root, container } = await mount(
      <LivePresence idleMs={60} refreshMs={60_000}><LiveWall cameras={[1, 2].map((i) => cam(i))} maxStreams={25} /></LivePresence>,
    )
    await settle(200)
    expect((container as unknown as MiniElement).textContent).toContain('Are you still there?')
    expect(sockets.size).toBe(0)
    const before = asked.length
    await settle(100)
    expect(asked.length).toBe(before)
    await act(async () => root.unmount())
  })
})
