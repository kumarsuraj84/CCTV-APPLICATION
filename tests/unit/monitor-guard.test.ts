import { describe, expect, it } from 'vitest'
import { anotherWorkerIsRunning } from '@/lib/monitor/guard'

const NOW = new Date('2026-05-01T08:00:00Z')
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000)

/** A heartbeat store whose value changes only when a test says so; sleeping does not take real time. */
function setup(first: Date | null, afterWait: Date | null) {
  const slept: number[] = []
  let current = first
  return {
    slept,
    deps: {
      readHeartbeat: async () => current,
      now: () => NOW,
      sleep: async (ms: number) => { slept.push(ms); current = afterWait },
      pollSec: 5,
    },
  }
}

describe('single worker guard', () => {
  it('lets a worker start when there has never been a heartbeat', async () => {
    const t = setup(null, null)
    expect(await anotherWorkerIsRunning(t.deps)).toBe(false)
    expect(t.slept).toEqual([])
  })

  it('lets a worker start at once when the last heartbeat is old, without waiting', async () => {
    const t = setup(ago(60), ago(60))
    expect(await anotherWorkerIsRunning(t.deps)).toBe(false)
    expect(t.slept).toEqual([])
  })

  it('refuses to start when a recent heartbeat keeps moving: someone else is running', async () => {
    const t = setup(ago(2), ago(0))
    expect(await anotherWorkerIsRunning(t.deps)).toBe(true)
    expect(t.slept).toHaveLength(1)
    expect(t.slept[0]).toBeGreaterThan(5000) // long enough for a running worker to beat at least once
  })

  it('lets a worker start when a recent heartbeat stays put: the earlier worker has just stopped', async () => {
    const t = setup(ago(2), ago(2))
    expect(await anotherWorkerIsRunning(t.deps)).toBe(false)
    expect(t.slept).toHaveLength(1)
  })

  it('treats a heartbeat from the future (clock difference) as recent and still decides by whether it moves', async () => {
    const stays = setup(new Date(NOW.getTime() + 3000), new Date(NOW.getTime() + 3000))
    expect(await anotherWorkerIsRunning(stays.deps)).toBe(false)
    const moves = setup(new Date(NOW.getTime() + 3000), new Date(NOW.getTime() + 8000))
    expect(await anotherWorkerIsRunning(moves.deps)).toBe(true)
  })

  it('does not decide anything when the heartbeat cannot be read twice', async () => {
    const deps = { readHeartbeat: async () => { throw new Error('database is down') }, now: () => NOW, sleep: async () => {}, pollSec: 5 }
    await expect(anotherWorkerIsRunning(deps)).rejects.toThrow('database is down')
  })
})
