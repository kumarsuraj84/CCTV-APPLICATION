import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { MonitorRunner } from '@/lib/monitor/runner'
import type { Probes } from '@/lib/monitor/types'
import { MemoryDb } from '../helpers/memory-db'

const NOW = new Date('2026-05-01T08:00:00Z')
const probes: Probes = {
  tcp: async () => ({ ok: true }),
  icmp: async () => ({ ok: true }),
  rtsp: async () => ({ code: 200 }),
  nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [] }),
}
const runnerFor = (db: MemoryDb) => new MonitorRunner({ db, probes, cfg: loadMonitorConfig({}), clock: () => NOW })

const REQUESTED = new Date('2026-05-01T07:59:00Z')
const pause = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms))

afterEach(() => vi.useRealTimers())

describe('MonitorRunner honest check-now', () => {
  it('waits for a scheduled camera cycle already in progress, then runs a fresh one before it reports finished', async () => {
    const db = new MemoryDb()
    let calls = 0
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    db.loadStoreJobs = async () => {
      calls += 1
      if (calls === 1) await gate
      return []
    }
    const r = runnerFor(db)
    const scheduled = r.runCameras()
    await vi.waitFor(() => expect(calls).toBe(1))
    const full = r.runFull()
    await vi.waitFor(() => expect(db.started).toHaveLength(1))
    await pause()
    expect(db.finished).toHaveLength(0) // not finished while the older cycle is still running
    expect(calls).toBe(1)
    open()
    await full
    await scheduled
    expect(calls).toBe(2) // a fresh cycle ran after the request
    expect(db.finished).toHaveLength(1)
  })

  it('does the same for a scheduled device cycle', async () => {
    const db = new MemoryDb()
    let calls = 0
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    db.loadDevices = async () => {
      calls += 1
      if (calls === 1) await gate
      return []
    }
    const r = runnerFor(db)
    const scheduled = r.runDevices()
    await vi.waitFor(() => expect(calls).toBe(1))
    const full = r.runFull()
    await pause()
    expect(db.finished).toHaveLength(0)
    open()
    await full
    await scheduled
    expect(calls).toBe(2)
    expect(db.finished).toHaveLength(1)
  })

  it('does not report a run finished when the database could not be read; it tries once more on the next poll', async () => {
    const db = new MemoryDb()
    let broken = true
    db.loadDevices = async () => {
      if (broken) throw new Error('database is down')
      return []
    }
    db.request = { requestedAt: REQUESTED, runStartedAt: null }
    const r = runnerFor(db)
    await r.pollOnce()
    expect(db.started).toHaveLength(1)
    expect(db.finished).toHaveLength(0)
    broken = false
    await r.pollOnce()
    expect(db.started).toHaveLength(2)
    expect(db.finished).toHaveLength(1)
    await r.pollOnce()
    expect(db.started).toHaveLength(2) // no third run
  })

  it('retries only once: a second failed run is closed so the page is not left waiting', async () => {
    const db = new MemoryDb()
    db.loadStoreJobs = async () => { throw new Error('database is down') }
    db.request = { requestedAt: REQUESTED, runStartedAt: null }
    const r = runnerFor(db)
    await r.pollOnce()
    expect(db.finished).toHaveLength(0)
    await r.pollOnce()
    expect(db.started).toHaveLength(2)
    expect(db.finished).toHaveLength(1)
    await r.pollOnce()
    expect(db.started).toHaveLength(2)
  })

  it('counts a failure to save results as an unclean run too', async () => {
    const db = new MemoryDb()
    db.devices = [{ id: 'd1', org_id: 'o', ip: '127.0.0.1', tcp_port: 9 }]
    db.applyResults = async () => { throw new Error('save failed') }
    db.request = { requestedAt: REQUESTED, runStartedAt: null }
    await runnerFor(db).pollOnce()
    expect(db.started).toHaveLength(1)
    expect(db.finished).toHaveLength(0)
  })

  it('a clean run is finished at once', async () => {
    const db = new MemoryDb()
    await runnerFor(db).runFull()
    expect(db.finished).toHaveLength(1)
  })
})

describe('MonitorRunner schedule', () => {
  it('starts each cycle a fixed interval after the previous one started, not after it ended', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    const starts: number[] = []
    db.loadDevices = async () => {
      starts.push(Date.now())
      await new Promise<void>((resolve) => setTimeout(resolve, 20_000)) // each cycle takes 20 s
      return []
    }
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(130_000)
    r.stop()
    expect(starts.slice(0, 3).map((t) => t - starts[0])).toEqual([0, 60_000, 120_000])
  })

  it('runs the next cycle at once when one took longer than the interval', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    const starts: number[] = []
    db.loadDevices = async () => {
      starts.push(Date.now())
      await new Promise<void>((resolve) => setTimeout(resolve, 70_000))
      return []
    }
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(145_000)
    r.stop()
    const gaps = starts.slice(0, 3).map((t) => t - starts[0])
    expect(gaps[0]).toBe(0)
    expect(gaps[1]).toBeGreaterThanOrEqual(70_000) // no extra wait, apart from the timer tick
    expect(gaps[1]).toBeLessThan(70_010)
    expect(gaps[2]).toBeLessThan(140_020)
  })

  it('keeps the heartbeat on a fixed beat too', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    const beats: number[] = []
    db.touchHeartbeat = async () => {
      beats.push(Date.now())
      await new Promise<void>((resolve) => setTimeout(resolve, 2000))
    }
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(16_000)
    r.stop()
    expect(beats.slice(0, 3).map((t) => t - beats[0])).toEqual([0, 5000, 10_000])
  })

  it('keeps polling after a cycle that throws out of its loop', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    let reads = 0
    db.readRequest = async () => {
      reads += 1
      return { requestedAt: REQUESTED, runStartedAt: db.started.length > 0 ? NOW : null, runFinishedAt: null }
    }
    let attempts = 0
    const original = db.markRunStarted.bind(db)
    db.markRunStarted = async (at, total) => {
      if (attempts++ === 0) throw new Error('database is down') // makes the first check-now run throw out of the poll loop
      await original(at, total)
    }
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(16_000)
    r.stop()
    expect(attempts).toBeGreaterThanOrEqual(2) // the loop went on and tried again
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(db.started.length).toBeGreaterThanOrEqual(1)
  })
})

describe('MonitorRunner runs left open', () => {
  const stale = (finished: Date | null | undefined) => ({ requestedAt: REQUESTED, runStartedAt: new Date('2026-05-01T07:59:30Z'), runFinishedAt: finished })

  it('start() closes a run that a crash left unfinished', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    db.request = stale(null)
    const r = runnerFor(db)
    await r.start()
    r.stop()
    expect(db.finished).toHaveLength(1)
  })

  it('start() leaves a finished run, and a data layer that does not say, alone', async () => {
    vi.useFakeTimers()
    for (const finished of [new Date('2026-05-01T07:59:50Z'), undefined]) {
      const db = new MemoryDb()
      db.request = stale(finished)
      const r = runnerFor(db)
      await r.start()
      r.stop()
      expect(db.finished).toHaveLength(0)
    }
  })

  it('shutdown() marks a run still going at the time limit as finished', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    db.loadDevices = () => new Promise(() => {}) // the run hangs
    db.request = { requestedAt: REQUESTED, runStartedAt: null }
    const r = runnerFor(db)
    await r.start() // the check-now run is started by the worker's own poll
    await vi.advanceTimersByTimeAsync(100)
    expect(db.started).toHaveLength(1)
    const done = r.shutdown(5000)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(done).resolves.toBe(false)
    expect(db.finished).toHaveLength(1)
  })

  it('shutdown() also closes a run that was kept open for a retry', async () => {
    const db = new MemoryDb()
    db.loadDevices = async () => { throw new Error('database is down') }
    db.request = { requestedAt: REQUESTED, runStartedAt: null }
    const r = runnerFor(db)
    await r.pollOnce()
    expect(db.finished).toHaveLength(0)
    await r.shutdown(1000)
    expect(db.finished).toHaveLength(1)
  })
})

describe('MonitorRunner start-up callbacks', () => {
  it('calls onReady once the gap is recorded, not while it is still being retried', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    let attempts = 0
    db.recordStartupGap = async () => {
      if (++attempts < 2) throw new Error('database is down')
      return false
    }
    const ready = vi.fn()
    const r = runnerFor(db)
    await r.start({ onReady: ready })
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(ready).toHaveBeenCalledTimes(1)
    r.stop()
  })
})
