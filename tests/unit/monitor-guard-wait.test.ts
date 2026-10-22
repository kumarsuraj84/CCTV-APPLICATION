import { describe, expect, it } from 'vitest'
import { waitForSoleWorker } from '@/lib/monitor/guard'

const NOW = new Date('2026-05-01T08:00:00Z')
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000)

describe('waiting for the single worker guard', () => {
  const sleeps: number[] = []
  const base = (read: () => Promise<Date | null>) => ({
    readHeartbeat: read,
    now: () => NOW,
    sleep: async (ms: number) => { sleeps.push(ms) },
    pollSec: 5,
  })
  const never = new AbortController().signal

  it('retries while the database cannot be read, then decides', async () => {
    sleeps.length = 0
    let calls = 0
    const deps = base(async () => {
      if (++calls <= 2) throw new Error('database is down')
      return null
    })
    const seen: unknown[] = []
    expect(await waitForSoleWorker(deps, { retryMs: 5000, signal: never, onError: (e) => seen.push(e) })).toBe('free')
    expect(calls).toBe(3)
    expect(sleeps).toEqual([5000, 5000])
    expect(seen).toHaveLength(1) // the same failure twice is reported once
  })

  it('reports each different kind of failure once', async () => {
    const errors = ['down', 'down', 'timeout', 'timeout', 'down']
    let calls = 0
    const deps = base(async () => {
      if (calls < errors.length) throw new Error(errors[calls++])
      return null
    })
    const seen: string[] = []
    await waitForSoleWorker(deps, { retryMs: 1, signal: never, onError: (e) => seen.push((e as Error).message) })
    expect(seen).toEqual(['down', 'timeout', 'down'])
  })

  it('says another worker is running when the heartbeat keeps moving', async () => {
    let n = 0
    const deps = base(async () => ago(n++ === 0 ? 2 : 0))
    expect(await waitForSoleWorker(deps, { retryMs: 5000, signal: never, onError: () => {} })).toBe('taken')
  })

  it('stops waiting when asked to', async () => {
    const ac = new AbortController()
    const deps = base(async () => { throw new Error('database is down') })
    deps.sleep = async () => { ac.abort(); throw new Error('The operation was aborted') }
    expect(await waitForSoleWorker(deps, { retryMs: 5000, signal: ac.signal, onError: () => {} })).toBe('aborted')
  })

  it('does not even look when already asked to stop', async () => {
    const ac = new AbortController()
    ac.abort()
    let reads = 0
    const deps = base(async () => { reads++; return null })
    expect(await waitForSoleWorker(deps, { retryMs: 5000, signal: ac.signal, onError: () => {} })).toBe('aborted')
    expect(reads).toBe(0)
  })
})
