import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCameras, checkDevices, checkNvrs, checkRecorderCameras } from '@/lib/monitor/checks'
import type { MonitorDb } from '@/lib/monitor/types'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import { MemoryDb } from '../helpers/memory-db'
import { deps, NOW, recorder } from '../helpers/monitor-fixtures'

afterEach(() => vi.restoreAllMocks())

const quietLog = () => vi.spyOn(console, 'log').mockImplementation(() => {})
const lines = (spy: ReturnType<typeof quietLog>, text: string) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(text))
/** Final fix X: the back-off is the data layer's shared login state now (NB-1); how many NVRs stand refused. */
const loginBackoffCount = (db: MonitorDb) => [...(db as MemoryDb).logins.values()].filter((s) => s.outcome === 'refused').length

describe('a wrong password cannot be tried again and again through the video port (minor 1)', () => {
  it('after the first refused video login, when the NVR web port did not answer, the other cameras are not tried and the back-off starts', async () => {
    const spy = quietLog()
    const db = new MemoryDb()
    db.recorders = [recorder()]
    const counts = { nvr: 0, rtsp: 0 }
    const d = deps(db, {
      nvr: () => {
        counts.nvr++
        return { channelStatus: async () => { throw new NvrError('unreachable', 'x') }, channels: async () => { throw new NvrError('unreachable', 'x') } }
      },
      rtsp: async () => { counts.rtsp++; return { code: 401 } },
    })
    await checkCameras(d)
    expect(counts.rtsp).toBe(1) // not one per camera
    expect(db.results()).toHaveLength(0) // a refused login says nothing about the cameras
    expect(loginBackoffCount(d.db)).toBe(1)
    expect(lines(spy, 'NVR login refused at location S1')).toHaveLength(1)

    await checkCameras(d) // still inside the window: the recorder is left alone
    expect(counts.nvr).toBe(1)
    expect(counts.rtsp).toBe(1)
  })

  it('with a working NVR web login a refused video login is just that camera failing, and every camera is still tried', async () => {
    quietLog()
    const db = new MemoryDb()
    db.recorders = [recorder()]
    let rtsp = 0
    const d = deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, false], [2, false], [3, false]]), channels: async () => [] }),
      rtsp: async () => { rtsp++; return { code: 401 } },
    })
    await checkCameras(d)
    expect(rtsp).toBe(3)
    expect(db.results()).toHaveLength(3)
    expect(loginBackoffCount(d.db)).toBe(0)
  })

  describe('the back-off needs a refused login that nothing in the round contradicts', () => {
    const webPortDown = () => ({ channelStatus: async () => { throw new NvrError('unreachable', 'x') }, channels: async () => { throw new NvrError('unreachable', 'x') } })
    const run = async (codes: number[]) => {
      quietLog()
      const db = new MemoryDb()
      db.recorders = [recorder({ cameras: codes.map((_, i) => ({ id: `c${i + 1}`, channel: i + 1, camera_ip: null })) })]
      const asked: number[] = []
      const d = deps(db, { nvr: webPortDown, rtsp: async (t) => { asked.push(t.channel); return { code: codes[t.channel - 1] } } })
      await checkCameras(d)
      return { db, d, asked }
    }

    it('a live camera first: a later refusal is only that camera failing, every camera is tried, no back-off', async () => {
      const { db, d, asked } = await run([200, 401, 200, 0])
      expect(asked.sort()).toEqual([1, 2, 3, 4])
      expect(loginBackoffCount(d.db)).toBe(0)
      expect(db.results().map((r) => [r.id, r.ok])).toEqual([['c1', true], ['c2', false], ['c3', true], ['c4', false]])
      expect(db.results()[1].error).toBe('The recorder refused the login.')
    })

    it('a refusal first, with nothing live before it: the other cameras are not tried, the back-off starts, nothing is recorded', async () => {
      const { db, d, asked } = await run([401, 200, 200, 200])
      expect(asked).toEqual([1])
      expect(loginBackoffCount(d.db)).toBe(1)
      expect(db.results()).toHaveLength(0)
    })

    it('a camera that does not answer first does not prove anything: a refusal after it still starts the back-off', async () => {
      const { d, db, asked } = await run([0, 401, 401, 401])
      expect(loginBackoffCount(d.db)).toBe(1)
      expect(asked).toEqual([1, 2]) // final fix X: one at a time until the login is proven, so ONE refused video login, not three
      expect(db.results()).toHaveLength(0) // a refused login says nothing about any camera of that NVR
    })

    it('final fix X (NB-1): a refusal before any proof stops the round, even if later cameras would have answered', async () => {
      // Replaces "a refusal alongside a live answer does not start the back-off": that sent the later cameras side by side with the same
      // possibly wrong password (one refused login each). Now the cameras go one at a time until one proves the login.
      const { d, asked } = await run([0, 401, 200, 200])
      expect(asked).toEqual([1, 2])
      expect(loginBackoffCount(d.db)).toBe(1)
    })

    it('three silent cameras in a row: the video port is not answering logins at all, so the rest go side by side', async () => {
      const { d, asked } = await run([0, 0, 0, 200, 0])
      expect(asked.sort()).toEqual([1, 2, 3, 4, 5])
      expect(loginBackoffCount(d.db)).toBe(0)
    })
  })

  it('a first camera that answers normally does not stop the others', async () => {
    quietLog()
    const db = new MemoryDb()
    db.recorders = [recorder()]
    const d = deps(db, {
      nvr: () => ({ channelStatus: async () => { throw new NvrError('timeout', 'x') }, channels: async () => { throw new NvrError('timeout', 'x') } }),
      rtsp: async (t) => ({ code: t.channel === 1 ? 200 : 0 }),
    })
    await checkCameras(d)
    expect(db.results().map((r) => [r.id, r.ok])).toEqual([['c1', true], ['c2', false], ['c3', false]])
    expect(loginBackoffCount(d.db)).toBe(0)
  })
})

describe('"NVR known down" is decided once, by the data layer (minor 3)', () => {
  it('a store flagged known down has its cameras marked down at once and does not log a missing password', async () => {
    const spy = quietLog()
    const db = new MemoryDb()
    let asked = 0
    const d = deps(db, { nvr: () => { asked++; return { channelStatus: async () => new Map(), channels: async () => [] } } })
    await checkRecorderCameras(d, recorder({ knownDown: true, password: '', nvr_status: 'down' }))
    expect(asked).toBe(0)
    expect(db.results().every((r) => !r.ok && r.cause === 'nvr_down')).toBe(true)
    expect(lines(spy, 'no saved password')).toHaveLength(0)
  })

  it('the checks do not work it out again from the state and the clock', async () => {
    quietLog()
    const db = new MemoryDb()
    const d = deps(db, { nvr: () => ({ channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] }) })
    // Says "down" a moment ago, but the data layer did not flag it: it is probed like any other store.
    await checkRecorderCameras(d, recorder({ knownDown: false, nvr_status: 'down', nvr_checked_at: NOW.toISOString() }))
    expect(db.results().every((r) => r.ok)).toBe(true)
  })

  it('through the data layer, a stale down is not trusted and a fresh one is', async () => {
    quietLog()
    const probesFor = () => ({ nvr: () => ({ channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] }) })
    const fresh = new MemoryDb()
    fresh.recorders = [recorder({ nvr_status: 'down', nvr_checked_at: NOW.toISOString() })]
    await checkCameras(deps(fresh, probesFor()))
    expect(fresh.results().every((r) => r.cause === 'nvr_down')).toBe(true)
    const old = new MemoryDb()
    old.recorders = [recorder({ nvr_status: 'down', nvr_checked_at: new Date(NOW.getTime() - 3600_000).toISOString() })]
    await checkCameras(deps(old, probesFor()))
    expect(old.results().every((r) => r.ok)).toBe(true)
  })
})

describe('the camera list is asked for only when it can help (minor 4)', () => {
  const run = async (status: () => Promise<Map<number, boolean>>) => {
    quietLog()
    const db = new MemoryDb()
    db.recorders = [recorder()]
    let channels = 0
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: status, channels: async () => { channels++; return [] } }),
      rtsp: async () => ({ code: 0 }),
    }))
    return channels
  }

  it('is not asked after the NVR timed out or could not be reached', async () => {
    expect(await run(async () => { throw new NvrError('timeout', 'x') })).toBe(0)
    expect(await run(async () => { throw new NvrError('unreachable', 'x') })).toBe(0)
  })

  it('is asked after a status answer that could not be read, and after a good one', async () => {
    expect(await run(async () => { throw new NvrError('bad_response', 'x') })).toBe(1)
    expect(await run(async () => new Map([[1, true]]))).toBe(1)
  })
})

describe('a camera the recorder does not list (minor 7)', () => {
  const run = async (listed: Map<number, boolean> | 'failed', code = 0) => {
    quietLog()
    const db = new MemoryDb()
    db.recorders = [recorder()]
    await checkCameras(deps(db, {
      nvr: () => ({
        channelStatus: async () => { if (listed === 'failed') throw new NvrError('timeout', 'x'); return listed },
        channels: async () => [],
      }),
      rtsp: async () => ({ code }),
    }))
    return Object.fromEntries(db.results().map((r) => [r.id, r]))
  }

  it('says so when the recorder listed its channels and this one is not among them', async () => {
    const r = await run(new Map([[1, true], [2, false]]))
    expect(r.c3.ok).toBe(false)
    expect(r.c3.error).toBe('The recorder does not list this camera.')
    // A listed camera that is simply offline keeps the usual wording.
    expect(r.c2.error).toBe('The camera did not answer.')
    expect(r.c1.ok).toBe(true)
  })

  it('also when the recorder answered something odd for it', async () => {
    const r = await run(new Map([[1, true], [2, true]]), 404)
    expect(r.c3.error).toBe('The recorder does not list this camera.')
  })

  it('does not say it when the list is not known', async () => {
    const r = await run('failed')
    expect(r.c3.error).not.toBe('The recorder does not list this camera.')
    const empty = await run(new Map())
    expect(empty.c3.error).not.toBe('The recorder does not list this camera.')
  })
})

describe('the length of each round is logged (minor 4)', () => {
  it('logs how many targets a round covered and how long it took, for all three kinds', async () => {
    const spy = quietLog()
    const db = new MemoryDb()
    db.devices = [{ id: 'd1', org_id: 'o', ip: '127.0.0.1', tcp_port: 1 }]
    db.nvrs = [{ id: 's1', org_id: 'o', location_id: 'l1', ip: '127.0.0.1', rtsp_port: 554 }]
    db.recorders = [recorder()]
    let t = NOW.getTime()
    const clock = () => new Date((t += 250))
    const d = deps(db, {}, clock)
    await checkDevices(d)
    await checkNvrs(d)
    await checkCameras(d)
    const rounds = lines(spy, 'round_finished').map((l) => JSON.parse(l) as { kind: string; count: number; durationMs: number })
    expect(rounds.map((r) => r.kind)).toEqual(['devices', 'nvrs', 'cameras'])
    expect(rounds.map((r) => r.count)).toEqual([1, 1, 1])
    expect(rounds.every((r) => r.durationMs > 0)).toBe(true)
  })
})

describe('the number of NVRs checked at once (minor 4; P2-5b: per recorder)', () => {
  it('comes from RECORDER_CONCURRENCY (the old STORE_CONCURRENCY is still accepted): 10 by default, kept between 1 and 50', () => {
    expect(loadMonitorConfig({}).recorderConcurrency).toBe(10)
    expect(loadMonitorConfig({ STORE_CONCURRENCY: '25' }).recorderConcurrency).toBe(25)
    expect(loadMonitorConfig({ STORE_CONCURRENCY: '0' }).recorderConcurrency).toBe(1)
    expect(loadMonitorConfig({ STORE_CONCURRENCY: '500' }).recorderConcurrency).toBe(50)
    expect(loadMonitorConfig({ STORE_CONCURRENCY: 'many' }).recorderConcurrency).toBe(10)
    expect(loadMonitorConfig({ STORE_CONCURRENCY: '' }).recorderConcurrency).toBe(10)
    expect(loadMonitorConfig({ RECORDER_CONCURRENCY: '7', STORE_CONCURRENCY: '25' }).recorderConcurrency).toBe(7)
    expect(loadMonitorConfig({ RECORDER_CONCURRENCY: '', STORE_CONCURRENCY: '25' }).recorderConcurrency).toBe(25)
  })
})
