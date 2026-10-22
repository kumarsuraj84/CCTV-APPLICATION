import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { MonitorRunner } from '@/lib/monitor/runner'
import type { Probes } from '@/lib/monitor/types'
import { MemoryDb } from '../helpers/memory-db'

const T0 = new Date('2026-05-01T08:00:00Z').getTime()
const probes: Probes = {
  tcp: async () => ({ ok: true }),
  icmp: async () => ({ ok: true }),
  rtsp: async () => ({ code: 200 }),
  nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [] }),
}

/** A runner with a clock the test moves by hand. */
function setup(opts: { beatGapMs?: number } = {}) {
  const db = new MemoryDb()
  const time = { now: T0 }
  const runner = new MonitorRunner({ db, probes, cfg: loadMonitorConfig({}), clock: () => new Date(time.now) }, opts)
  return { db, time, runner }
}
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('silence between heartbeats is recorded as a gap (I2)', () => {
  it('a ten minute silence between two beats records exactly one gap, from the last good beat to the next', async () => {
    const { db, time, runner } = setup()
    await runner.beat()
    time.now = T0 + 10 * 60_000
    await runner.beat()
    expect(db.gaps).toEqual([{ from: new Date(T0), to: new Date(T0 + 10 * 60_000) }])
    time.now += 5000
    await runner.beat()
    expect(db.gaps).toHaveLength(1)
  })

  it('normal beats, five seconds apart, record none; thirty seconds exactly is still normal', async () => {
    const { db, time, runner } = setup()
    for (let i = 0; i < 200; i++) {
      await runner.beat()
      time.now += 5000
    }
    await runner.beat()
    time.now += 30_000
    await runner.beat()
    expect(db.gaps).toEqual([])
    time.now += 30_001
    await runner.beat()
    expect(db.gaps).toHaveLength(1)
  })

  it('the limit can be set', async () => {
    const { db, time, runner } = setup({ beatGapMs: 8000 })
    await runner.beat()
    time.now += 9000
    await runner.beat()
    expect(db.gaps).toHaveLength(1)
  })

  it('a gap that could not be saved is tried again at the next beat, once, with the same bounds', async () => {
    quiet()
    const { db, time, runner } = setup()
    const original = db.recordGap.bind(db)
    let fail = true
    db.recordGap = async (from, to) => {
      if (fail) throw new Error('write failed')
      await original(from, to)
    }
    await runner.beat()
    time.now = T0 + 10 * 60_000
    await runner.beat() // the silence is noticed, saving fails
    expect(db.gaps).toEqual([])
    time.now += 5000
    await runner.beat() // still failing: nothing is lost
    expect(db.gaps).toEqual([])
    fail = false
    time.now += 5000
    await runner.beat()
    expect(db.gaps).toEqual([{ from: new Date(T0), to: new Date(T0 + 10 * 60_000) }])
    time.now += 5000
    await runner.beat()
    expect(db.gaps).toHaveLength(1)
  })

  it('a database that was away for ten minutes (heartbeats failing) leaves a gap from the last good beat', async () => {
    quiet()
    const { db, time, runner } = setup()
    await runner.beat()
    const original = db.touchHeartbeat.bind(db)
    db.touchHeartbeat = async () => { throw new Error('database is down') }
    for (let i = 0; i < 120; i++) {
      time.now += 5000
      await runner.beat()
    }
    db.touchHeartbeat = original
    time.now += 5000
    await runner.beat()
    expect(db.gaps).toEqual([{ from: new Date(T0), to: new Date(time.now) }])
  })

  it('the gap recorded at start-up and the gaps found by beats never overlap', async () => {
    vi.useFakeTimers()
    const { db, time, runner } = setup()
    // The previous worker's last heartbeat was an hour ago: the start-up gap runs up to the start.
    db.recordStartupGap = async (now = new Date(T0)) => {
      db.gaps.push({ from: new Date(now.getTime() - 3600_000), to: now })
      return true
    }
    await runner.start()
    runner.stop()
    time.now = T0 + 10 * 60_000
    await runner.beat()
    time.now = T0 + 25 * 60_000
    await runner.beat()
    expect(db.gaps).toHaveLength(3)
    const sorted = [...db.gaps].sort((a, b) => a.from.getTime() - b.from.getTime())
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].from.getTime()).toBeGreaterThanOrEqual(sorted[i - 1].to.getTime())
  })

  it('a clock that steps backwards records nothing', async () => {
    const { db, time, runner } = setup()
    await runner.beat()
    time.now = T0 - 3600_000
    await runner.beat()
    time.now += 5000
    await runner.beat()
    expect(db.gaps).toEqual([])
  })
})

describe('the times of the last scheduled rounds are saved (I4)', () => {
  it('a devices round and a cameras round each save their time when they finish', async () => {
    const { db, time, runner } = setup()
    db.recorders = [{ id: 's1', org_id: 'o', location_id: 'l1', code: 'S1', name: 'NVR', ip: '127.0.0.1', rtsp_port: 554, http_port: 80, username: 'u', password: 'p', nvr_status: 'up', nvr_checked_at: null, knownDown: false, cameras: [{ id: 'c1', channel: 1, camera_ip: null }] }]
    time.now = T0 + 1000
    await runner.runDevices()
    expect(db.rounds).toEqual([{ kind: 'devices', at: new Date(T0 + 1000) }])
    time.now = T0 + 2000
    await runner.runCameras()
    expect(db.rounds.map((r) => r.kind)).toEqual(['devices', 'cameras'])
    expect(db.rounds[1].at).toEqual(new Date(T0 + 2000))
  })

  it('a round whose database work failed is not recorded as done', async () => {
    quiet()
    const { db, runner } = setup()
    db.loadDevices = async () => { throw new Error('database is down') }
    await runner.runDevices()
    expect(db.rounds).toEqual([])
    const cams = setup()
    cams.db.loadRecorderJobs =async () => { throw new Error('database is down') }
    await cams.runner.runCameras()
    expect(cams.db.rounds).toEqual([])
  })

  it('a round that was skipped because the same kind was already running is not recorded by the skipper', async () => {
    const { db, runner } = setup()
    let release: () => void = () => {}
    let waiting = false
    db.loadRecorderJobs =() => new Promise((resolve) => { waiting = true; release = () => resolve([]) })
    const first = runner.runCameras()
    await vi.waitFor(() => expect(waiting).toBe(true))
    await runner.runCameras() // returns at once
    expect(db.rounds).toEqual([])
    release()
    await first
    expect(db.rounds.map((r) => r.kind)).toEqual(['cameras'])
  })

  it('a failure to save the time is logged and does not break the round', async () => {
    const spy = quiet()
    const { db, runner } = setup()
    db.markRound = async () => { throw new Error('write failed') }
    await expect(runner.runDevices()).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
  })
})

describe('a run left open by a crash is run again (minor 6)', () => {
  it('start() does not mark it finished; the next poll repeats it and then closes it', async () => {
    vi.useFakeTimers()
    const db = new MemoryDb()
    db.request = { requestedAt: new Date(T0 - 60_000), runStartedAt: new Date(T0 - 30_000), runFinishedAt: null }
    const runner = new MonitorRunner({ db, probes, cfg: loadMonitorConfig({}), clock: () => new Date(T0) })
    await runner.start()
    expect(db.finished).toHaveLength(0)
    expect(db.started).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(6000)
    runner.stop()
    expect(db.started).toHaveLength(1)
    expect(db.finished).toHaveLength(1)
  })
})
