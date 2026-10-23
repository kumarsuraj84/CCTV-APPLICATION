import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { click, fire, installMiniDom, type MiniDocument, type MiniElement } from '../helpers/mini-dom'

// P4-L1 review M-3 ("component tests for the wall cleanup", brief item 5): the REACT side of the wall — LiveWall, its tiles' effects,
// useOpenedStreams' resets, the tour's page switch — mounted with react-dom/client in a tiny DOM (tests/helpers/mini-dom.ts; the
// repository has no DOM library and nothing may be installed). The player is a fake that counts open sockets; the server actions are
// fakes that hand out tokens. What must hold: the open sockets are exactly the tiles that play, after a wall change, a hidden tab, the
// large picture, a tour step, the idle prompt, and none at all after leaving the page.

const sockets = new Set<string>()
const asked: { fn: string; ids: string[]; release?: unknown; client?: unknown }[] = []
// Fix round 2 (N-1): the server's side of the cap, as the database counts it — the distinct cameras of open sockets and of tokens
// handed out but not used yet (not released, still able to connect). New cameras beyond `cap.max` come back paused; `cap.peak` is the
// most the person ever held.
const cap = { max: 25, unused: new Map<string, { camera: string; client: unknown }>(), peak: 0 }
const tokenOf = (url: string) => decodeURIComponent(url.split('token=')[1] ?? '')
const heldNow = () => new Set([...[...sockets].map((u) => tokenOf(u).replace(/^t-/, '').replace(/-\d+$/, '')), ...[...cap.unused.values()].map((v) => v.camera)])
const note = () => { cap.peak = Math.max(cap.peak, heldNow().size) }
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }))
vi.mock('@/components/live/useGatewayBase', () => ({ useGatewayBase: () => 'http://gw.test:3412' }))
vi.mock('@/components/live/player', () => ({
  loadPlayer: () => Promise.resolve(),
  startPlayer: (_host: unknown, url: string, ev: { onPlaying: () => void }) => {
    sockets.add(url)
    cap.unused.delete(tokenOf(url))
    note()
    queueMicrotask(() => ev.onPlaying())
    return () => { sockets.delete(url) }
  },
}))
const token = (id: string, n: number) => `t-${id}-${n}`
let issued = 0
/** One request as the database answers it: the window's released cameras first (its own unused tokens), then the cap. */
function hand(ids: string[], o?: { release?: { cameraIds: string[] }[]; client?: unknown }) {
  const rel = new Set((o?.release ?? []).flatMap((r) => r.cameraIds).filter((id) => !ids.includes(id)))
  for (const [t, v] of cap.unused) if (rel.has(v.camera) && v.client === o?.client) cap.unused.delete(t)
  const held = heldNow()
  const out: { id: string; token: string }[] = []
  const paused: string[] = []
  for (const id of ids) {
    if (held.has(id) || held.size < cap.max) {
      held.add(id)
      const t = token(id, ++issued)
      cap.unused.set(t, { camera: id, client: o?.client })
      out.push({ id, token: t })
    } else paused.push(id)
  }
  note()
  return { out, paused }
}
vi.mock('@/lib/actions/streams', () => ({
  openStreamsAction: async (ids: string[], kind: string, o?: { release?: { cameraIds: string[] }[]; client?: unknown }) => {
    asked.push({ fn: 'open', ids, release: o?.release, client: o?.client })
    const { out, paused } = hand(ids, o)
    return { ok: true, streams: out.map(({ id, token: t }) => ({ cameraId: id, name: id, storeCode: 'L', channel: 1, kind, token: t })), ...(paused.length ? { paused } : {}) }
  },
  refreshStreamTokensAction: async (ids: string[], kind: string, o?: { release?: { cameraIds: string[] }[]; client?: unknown }) => {
    asked.push({ fn: 'full', ids, release: o?.release, client: o?.client })
    const { out, paused } = hand(ids, o)
    return { ok: true, streams: out.map(({ id, token: t }) => ({ cameraId: id, name: id, storeCode: 'L', channel: 1, kind, token: t })), ...(paused.length ? { paused } : {}) }
  },
  renewStreamTokensAction: async (ids: string[], _kind: string, o?: { release?: { cameraIds: string[] }[]; client?: unknown }) => {
    asked.push({ fn: 'tokens', ids, release: o?.release, client: o?.client })
    const { out, paused } = hand(ids, o)
    return { ok: true, tokens: out.map(({ id, token: t }) => ({ cameraId: id, token: t })), ...(paused.length ? { paused } : {}) }
  },
}))
// The page's leave release (POST /api/live/release with keepalive): the tokens it names stop counting, if they were not used.
const leaves: { tokens: string[]; keepalive: boolean }[] = []
let leaveWorks = true
const fakeFetch = vi.fn(async (url: string, init: { body: string; keepalive?: boolean }) => {
  if (url !== '/api/live/release') throw new Error(`unexpected fetch ${url}`)
  const { tokens } = JSON.parse(init.body) as { tokens: string[] }
  leaves.push({ tokens, keepalive: init.keepalive === true })
  if (!leaveWorks) throw new Error('offline')
  for (const t of tokens) cap.unused.delete(t)
  return new Response(null, { status: 204 })
})
vi.mock('@/lib/actions/groups', () => ({ addCamerasAction: vi.fn(), removeCameraAction: vi.fn(), createGroupAction: vi.fn() }))

let dom: { document: MiniDocument; restore: () => void }
const roots: { unmount: () => void }[] = []
/** The camera a socket was opened for (its token is t-<camera>-<n>). */
const cameraOf = (url: string) => decodeURIComponent(url.split('token=')[1] ?? '').replace(/^t-/, '').replace(/-\d+$/, '')
beforeAll(() => { dom = installMiniDom(); vi.stubGlobal('fetch', fakeFetch) })
afterAll(() => { dom.restore(); vi.unstubAllGlobals() })
beforeEach(() => {
  sockets.clear(); asked.length = 0; dom.document.visibilityState = 'visible'
  cap.unused.clear(); cap.peak = 0; cap.max = 25; leaves.length = 0; leaveWorks = true
})
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

// Fix round 2, re-review N-1: leaving a wall must not leave its unused renewal tokens holding places for up to 90 s. The wall keeps the
// cameras it last asked for at module level (one per page, not per component), so the next wall's first request releases them; and
// leaving (unmount = route change, pagehide, a hidden tab) sends the tokens it holds to /api/live/release (keepalive; best effort).
describe('leaving a wall frees its places at once (fix round 2, N-1)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  async function mountFake(node: React.ReactNode) {
    const { createRoot } = await import('react-dom/client')
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    const root = createRoot(container as unknown as Element)
    let gone = false
    roots.push({ unmount: () => { if (!gone) root.unmount() } })
    const real = root.unmount.bind(root)
    root.unmount = () => { gone = true; real() }
    await act(async () => root.render(node))
    await advance(50)
    return { root, container }
  }
  const wallA = Array.from({ length: 16 }, (_, i) => cam(i + 201, 'LA'))
  const wallB = Array.from({ length: 16 }, (_, i) => cam(i + 301, 'LB'))
  const ids = (cs: { id: string }[]) => cs.map((c) => c.id).sort()

  async function watchAThenLeave() {
    const { LiveWall } = await import('@/components/live/LiveWall')
    const a = await mountFake(<LiveWall cameras={wallA} maxStreams={25} />)
    expect(sockets.size).toBe(16)
    await advance(61_000) // over a minute: the one-minute renewal hands out 16 new tokens the tiles do not use
    expect(asked.at(-1)?.fn).toBe('tokens')
    expect(cap.unused.size).toBe(16)
    await act(async () => a.root.unmount()) // leave (a route change)
    await advance(10)
    expect(sockets.size).toBe(0)
  }

  it('wall A (4×4) for over a minute, leave, wall B with other cameras: every tile of B opens and the count never goes above the cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    await watchAThenLeave()
    // The leave sent the tokens the wall held (the unused renewal ones among them), with keepalive.
    expect(leaves).toHaveLength(1)
    expect(leaves[0].keepalive).toBe(true)
    expect(leaves[0].tokens).toHaveLength(16)
    expect(cap.unused.size).toBe(0)
    const { LiveWall } = await import('@/components/live/LiveWall')
    await mountFake(<LiveWall cameras={wallB} maxStreams={25} />)
    expect([...sockets].map(cameraOf).sort()).toEqual(ids(wallB))
    expect(asked.filter((x) => x.ids.includes(wallB[0].id)).every((x) => !('paused' in x))).toBe(true)
    expect(cap.peak).toBeLessThanOrEqual(25)
  })

  it('when the leave release is lost, the next wall\'s first request releases the old wall (kept per page), so B still opens whole', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    leaveWorks = false
    await watchAThenLeave()
    expect(cap.unused.size).toBe(16) // the 16 unused renewal tokens still count
    const { LiveWall } = await import('@/components/live/LiveWall')
    await mountFake(<LiveWall cameras={wallB} maxStreams={25} />)
    const firstOfB = asked.find((x) => x.ids.includes(wallB[0].id))!
    expect(firstOfB.release).toEqual([{ cameraIds: wallA.map((c) => c.id), kind: 'sub' }])
    // One window id for the whole page: the release only reaches this window's own tokens (N-6).
    expect(typeof firstOfB.client === 'string' && UUID.test(firstOfB.client)).toBe(true)
    expect(new Set(asked.map((x) => x.client))).toEqual(new Set([firstOfB.client]))
    expect([...sockets].map(cameraOf).sort()).toEqual(ids(wallB))
    expect(cap.peak).toBeLessThanOrEqual(25)
  })

  it('pagehide and a hidden tab send the held tokens too (best effort, keepalive)', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    await mount(<LiveWall cameras={[1, 2, 3].map((i) => cam(i))} maxStreams={25} />)
    expect(sockets.size).toBe(3)
    const held = [...sockets].map(tokenOf).sort()
    ;(globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => void } }).window.dispatchEvent({ type: 'pagehide' })
    expect(leaves).toHaveLength(1)
    expect({ ...leaves[0], tokens: [...leaves[0].tokens].sort() }).toEqual({ tokens: held, keepalive: true })
    dom.document.visibilityState = 'hidden'
    await act(async () => { dom.document.dispatchEvent({ type: 'visibilitychange' }) })
    await settle()
    expect(sockets.size).toBe(0)
    // Hidden after a pagehide sends nothing twice (the same tokens were already sent).
    expect(leaves).toHaveLength(1)
  })

  it('a hidden tab alone sends the held tokens', async () => {
    const { LiveWall } = await import('@/components/live/LiveWall')
    await mount(<LiveWall cameras={[1, 2].map((i) => cam(i))} maxStreams={25} />)
    const held = [...sockets].map(tokenOf).sort()
    dom.document.visibilityState = 'hidden'
    await act(async () => { dom.document.dispatchEvent({ type: 'visibilitychange' }) })
    await settle()
    expect(leaves.map((l) => ({ ...l, tokens: [...l.tokens].sort() }))).toEqual([{ tokens: held, keepalive: true }])
  })
})
