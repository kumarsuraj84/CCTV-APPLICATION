import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// P4-L1 fix round 2, re-review N-2: the input cookie carries the time of the last real input in the SERVER's clock. The signed-in
// layout hands the page the server's time when it is rendered; the tracker keeps the difference to the browser's clock and writes
// browser time + that difference. A browser clock that is hours wrong therefore writes the right time.

type Doc = { cookie: string; addEventListener: (t: string, l: () => void) => void }
let written: string[] = []
let listeners: Map<string, () => void>
const g = globalThis as unknown as { document?: Doc; location?: { protocol: string } }

beforeEach(() => {
  vi.resetModules()
  written = []
  listeners = new Map()
  const doc = { addEventListener: (t: string, l: () => void) => { listeners.set(t, l) } } as unknown as Doc
  Object.defineProperty(doc, 'cookie', { set: (v: string) => written.push(v), get: () => '' })
  g.document = doc
  g.location = { protocol: 'http:' }
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  delete g.document
  delete g.location
  vi.useRealTimers()
})

const valueOf = (cookie: string) => Number(/^drishti-input=(\d+);/.exec(cookie)?.[1])
const SERVER = Date.UTC(2026, 9, 23, 6, 0, 0)

describe('the input cookie is in the server\'s clock (N-2)', () => {
  for (const [label, skew] of [['2 hours behind', -2 * 3600_000], ['5 hours ahead', 5 * 3600_000], ['right', 0]] as const) {
    it(`browser clock ${label}: page load and later input are written as server time`, async () => {
      vi.setSystemTime(SERVER + skew)
      const { installInputTracker } = await import('@/components/layout/input-tracker')
      installInputTracker(SERVER)
      expect(valueOf(written[0])).toBe(Math.floor(SERVER / 1000))
      vi.setSystemTime(SERVER + skew + 20_000)
      listeners.get('keydown')!()
      expect(valueOf(written.at(-1)!)).toBe(Math.floor((SERVER + 20_000) / 1000))
    })
  }

  it('without the server\'s time (an old page) the browser clock is used, as before', async () => {
    vi.setSystemTime(SERVER)
    const { installInputTracker } = await import('@/components/layout/input-tracker')
    installInputTracker()
    expect(valueOf(written[0])).toBe(Math.floor(SERVER / 1000))
  })
})
