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

afterEach(() => vi.useRealTimers())

describe('MonitorRunner', () => {
  it('writes a heartbeat on every poll and does not run anything without a request', async () => {
    const db = new MemoryDb()
    const r = runnerFor(db)
    await r.pollOnce()
    await r.pollOnce()
    expect(db.heartbeats).toHaveLength(2)
    expect(db.started).toHaveLength(0)
  })

  it('runs everything once for a new check request and not again until there is a newer one', async () => {
    const db = new MemoryDb()
    db.request = { requestedAt: new Date('2026-05-01T07:59:00Z'), runStartedAt: null }
    const r = runnerFor(db)
    await r.pollOnce()
    expect(db.started).toHaveLength(1)
    expect(db.finished).toHaveLength(1)
    await r.pollOnce()
    expect(db.started).toHaveLength(1)
    db.request = { requestedAt: new Date('2026-05-01T08:00:30Z'), runStartedAt: NOW }
    await r.pollOnce()
    expect(db.started).toHaveLength(2)
  })

  it('ignores a request that is older than the last run', async () => {
    const db = new MemoryDb()
    db.request = { requestedAt: new Date('2026-05-01T07:00:00Z'), runStartedAt: new Date('2026-05-01T07:30:00Z') }
    await runnerFor(db).pollOnce()
    expect(db.started).toHaveLength(0)
  })

  it('reports progress per store, and a run that cannot read or start is not reported finished', async () => {
    const db = new MemoryDb()
    db.stores = [{ id: 's1', org_id: 'o', code: 'S1', ip: '127.0.0.1', rtsp_port: 554, http_port: 80, username: 'u', password: 'p', nvr_status: 'up', nvr_checked_at: null, knownDown: false, cameras: [{ id: 'c1', channel: 1, camera_ip: null }] }]
    await runnerFor(db).runFull()
    expect(db.progress).toEqual([[1, 1]])
    expect(db.finished).toHaveLength(1)

    // The checks log and swallow their own database errors, but a run that could not read is not reported finished (see monitor-runner-checknow.test.ts).
    const unreadable = new MemoryDb()
    unreadable.loadDevices = async () => { throw new Error('database is down') }
    await runnerFor(unreadable).runFull()
    expect(unreadable.finished).toHaveLength(0)

    // A run that cannot even be started fails out loud and is not reported finished; the next poll tries again as the request is still unanswered.
    const broken = new MemoryDb()
    broken.markRunStarted = async () => { throw new Error('database is down') }
    await expect(runnerFor(broken).runFull()).rejects.toThrow('database is down')
    expect(broken.finished).toHaveLength(0)
  })

  it('does not start a second run while one is in progress', async () => {
    const db = new MemoryDb()
    let release: () => void = () => {}
    let waiting = false
    db.loadDevices = () => new Promise((resolve) => { waiting = true; release = () => resolve([]) })
    const r = runnerFor(db)
    const first = r.runFull()
    await vi.waitFor(() => expect(waiting).toBe(true))
    await r.runFull() // returns at once
    release()
    await first
    expect(db.started).toHaveLength(1)
  })

  it('start() records a possible gap, then polls and checks on its own timers until stopped', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(db.heartbeats.length).toBeGreaterThanOrEqual(3)
    r.stop()
    const seen = db.heartbeats.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(db.heartbeats.length).toBe(seen)
  })
})

/** Everything below is about a worker that must survive a flaky database and stop cleanly. */
describe('MonitorRunner resilience', () => {
  it('can run again after the run could not even be marked finished', async () => {
    const db = new MemoryDb()
    let fail = true
    db.markRunFinished = async (at) => {
      if (fail) throw new Error('write failed')
      db.finished.push(at)
    }
    const r = runnerFor(db)
    await expect(r.runFull()).rejects.toThrow('write failed')
    fail = false
    await r.runFull()
    expect(db.started).toHaveLength(2)
    expect(db.finished).toHaveLength(1)
  })

  it('a failed heartbeat write does not stop the check-now request from being answered', async () => {
    const db = new MemoryDb()
    db.touchHeartbeat = async () => { throw new Error('heartbeat failed') }
    db.request = { requestedAt: new Date('2026-05-01T07:59:00Z'), runStartedAt: null }
    await runnerFor(db).pollOnce()
    expect(db.started).toHaveLength(1)
  })

  it('a failed request read does not throw out of the poll', async () => {
    const db = new MemoryDb()
    db.readRequest = async () => { throw new Error('read failed') }
    await expect(runnerFor(db).pollOnce()).resolves.toBeUndefined()
    expect(db.heartbeats).toHaveLength(1)
  })

  it('keeps the heartbeat going while a long full run is in progress', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    let release: () => void = () => {}
    db.markRunStarted = () => new Promise((resolve) => { release = resolve }) // only a full run calls this
    db.request = { requestedAt: new Date('2026-05-01T07:59:00Z'), runStartedAt: null }
    const r = runnerFor(db)
    await r.start()
    await vi.advanceTimersByTimeAsync(1000) // the full run starts and hangs
    const before = db.heartbeats.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(db.heartbeats.length).toBeGreaterThanOrEqual(before + 3)
    release()
    await r.shutdown(1000)
  })

  describe('start-up gap', () => {
    it('a failed gap record does not kill the worker, leaves the heartbeat alone and is retried until it works', async () => {
      vi.useFakeTimers()
      const db = new MemoryDb()
      let attempts = 0
      db.recordStartupGap = async () => {
        attempts += 1
        if (attempts < 3) throw new Error('recording the gap failed')
        return true
      }
      const r = runnerFor(db)
      await expect(r.start()).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(4000)
      expect(attempts).toBe(1)
      expect(db.heartbeats).toHaveLength(0) // not moved, so a restart would still see the old silence
      await vi.advanceTimersByTimeAsync(7000)
      expect(attempts).toBe(3)
      await vi.advanceTimersByTimeAsync(6000)
      expect(db.heartbeats.length).toBeGreaterThanOrEqual(1) // polling begins once the gap is recorded
      r.stop()
    })

    it('does not begin polling after being stopped while the gap could not be recorded', async () => {
      vi.useFakeTimers()
      const db = new MemoryDb()
      db.recordStartupGap = async () => { throw new Error('still down') }
      const r = runnerFor(db)
      await r.start()
      r.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(db.heartbeats).toHaveLength(0)
    })
  })

  describe('shutdown', () => {
    it('stops the timers and waits for the cycle in progress', async () => {
      vi.useFakeTimers()
      const db = new MemoryDb()
      let release: () => void = () => {}
      let finishedAt = 0
      db.loadDevices = () => new Promise((resolve) => { release = () => { finishedAt = Date.now(); resolve([]) } })
      const r = runnerFor(db)
      await r.start()
      await vi.advanceTimersByTimeAsync(100) // a device cycle is now hanging
      const done = r.shutdown(10_000)
      await vi.advanceTimersByTimeAsync(2000)
      release()
      await expect(done).resolves.toBe(true)
      expect(finishedAt).toBeGreaterThan(0)
      const seen = db.heartbeats.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(db.heartbeats.length).toBe(seen)
    })

    it('gives up waiting after the bound and says so', async () => {
      vi.useFakeTimers()
      const db = new MemoryDb()
      db.loadDevices = () => new Promise(() => {}) // never finishes
      const r = runnerFor(db)
      await r.start()
      await vi.advanceTimersByTimeAsync(100)
      const done = r.shutdown(5000)
      await vi.advanceTimersByTimeAsync(5000)
      await expect(done).resolves.toBe(false)
    })

    it('returns at once when nothing is running', async () => {
      const r = runnerFor(new MemoryDb())
      await expect(r.shutdown(1000)).resolves.toBe(true)
    })
  })
})
