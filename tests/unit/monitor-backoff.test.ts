import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCameras, loginBackoffCount, type Deps } from '@/lib/monitor/checks'
import { realProbes } from '@/lib/monitor/probes'
import { NvrError, type NvrErrorKind } from '@/lib/nvr/client'
import { startFakeNvr, startFakeRtsp } from '../helpers/fake-servers'
import { MemoryDb } from '../helpers/memory-db'
import { cfg, deps, NOW, store } from '../helpers/monitor-fixtures'

afterEach(() => vi.restoreAllMocks())

const START = NOW.getTime()
const sec = (n: number) => 1000 * n
const quietLog = () => vi.spyOn(console, 'log').mockImplementation(() => {})
const lines = (spy: ReturnType<typeof quietLog>, text: string) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(text))

/** A fake clock the test moves by hand, and a store whose NVR refuses (or fails) the login. */
function setup(kind: NvrErrorKind = 'auth') {
  const db = new MemoryDb()
  db.stores = [store()]
  const time = { now: START }
  const counts = { nvr: 0, rtsp: 0 }
  const d = deps(db, {
    nvr: (ep) => {
      counts.nvr++
      // Only the user "viewer" is refused; any other user gets a normal answer.
      if (ep.username !== 'viewer') return { channelStatus: async () => new Map([[1, true]]), channels: async () => [] }
      return { channelStatus: async () => { throw new NvrError(kind, 'x') }, channels: async () => { throw new NvrError(kind, 'x') } }
    },
    rtsp: async () => { counts.rtsp++; return { code: 401 } },
  }, () => new Date(time.now))
  return { db, time, counts, d, round: (ids?: string[]) => checkCameras(d, undefined, ids) }
}

describe('after a refused NVR login the recorder is left alone for a while (back-off)', () => {
  it('asks the NVR once, then not at all for the whole window, and sends no results for its cameras', async () => {
    const spy = quietLog()
    const { db, time, counts, round } = setup()
    for (let i = 0; i < 5; i++) {
      await round()
      time.now += sec(60)
    }
    expect(counts.nvr).toBe(1)
    expect(counts.rtsp).toBe(3) // the three cameras, in the first round only
    expect(db.results()).toHaveLength(0)
    expect(lines(spy, 'NVR login problem for store S1')).toHaveLength(1)
  })

  it('asks again once the window (15 minutes by default) is over, and starts a new window if it is refused again', async () => {
    const spy = quietLog()
    const { time, counts, round } = setup()
    await round()
    time.now = START + sec(899)
    await round()
    expect(counts.nvr).toBe(1)
    time.now = START + sec(900)
    await round()
    expect(counts.nvr).toBe(2)
    expect(counts.rtsp).toBe(6)
    expect(lines(spy, 'NVR login problem for store S1')).toHaveLength(2)
    time.now += sec(300)
    await round()
    expect(counts.nvr).toBe(2)
  })

  it('also backs off after "forbidden"', async () => {
    quietLog()
    const { time, counts, round } = setup('forbidden')
    await round()
    time.now += sec(60)
    await round()
    expect(counts.nvr).toBe(1)
  })

  it('a "check now" for that store does not bypass it', async () => {
    quietLog()
    const { counts, round } = setup()
    await round()
    await round(['s1'])
    expect(counts.nvr).toBe(1)
    expect(counts.rtsp).toBe(3)
  })

  it('a timeout or an unreachable NVR is not a login problem: no back-off', async () => {
    quietLog()
    for (const kind of ['timeout', 'unreachable'] as const) {
      const { d, time, counts, round } = setup(kind)
      for (let i = 0; i < 3; i++) {
        await round()
        time.now += sec(60)
      }
      expect(counts.nvr).toBe(3)
      expect(loginBackoffCount(d.db)).toBe(0)
    }
  })

  it('other stores are not held back', async () => {
    quietLog()
    const { db, counts, round } = setup()
    db.stores = [store(), store({ id: 's2', code: 'S2', username: 'fine', cameras: [{ id: 'c9', channel: 1, camera_ip: null }] })]
    await round()
    await round()
    expect(counts.nvr).toBe(3) // s1 and s2, then only s2 again
  })

  it('ends early when the saved user name or password changes, but not when something else does', async () => {
    quietLog()
    const { db, counts, round } = setup()
    await round()
    db.stores = [store({ nvr_checked_at: null, cameras: [{ id: 'c1', channel: 1, camera_ip: '192.0.2.1' }] })]
    await round()
    expect(counts.nvr).toBe(1) // unrelated change: still waiting
    db.stores = [store({ password: 'new-pass' })]
    await round()
    expect(counts.nvr).toBe(2)
    db.stores = [store({ password: 'new-pass', username: 'other' })]
    await round()
    expect(counts.nvr).toBe(3)
  })

  it('keeps only live entries: an expired one is removed, also for a store that is never checked again', async () => {
    quietLog()
    const { db, time, round, d } = setup()
    await round()
    expect(loginBackoffCount(d.db)).toBe(1)
    db.stores = [store({ id: 'other', code: 'OT', cameras: [] })]
    time.now = START + sec(901)
    await round()
    expect(loginBackoffCount(d.db)).toBe(0)
  })

  it('uses the configured length of the window', async () => {
    quietLog()
    const { time, counts, d } = setup()
    const short: Deps = { ...d, cfg: { ...d.cfg, nvrLoginBackoffSec: 60 } }
    await checkCameras(short)
    time.now += sec(59)
    await checkCameras(short)
    expect(counts.nvr).toBe(1)
    time.now += sec(1)
    await checkCameras(short)
    expect(counts.nvr).toBe(2)
  })

  it('the log line and the back-off hold no password', async () => {
    const spy = quietLog()
    const { db, round } = setup()
    db.stores = [store({ password: 'Sup3r-Secret' })]
    await round()
    expect(lines(spy, 'Sup3r-Secret')).toHaveLength(0)
  })

  it('against fake servers (real probes): one login attempt in five rounds, then one more after the window', async () => {
    quietLog()
    const nvr = await startFakeNvr({ statuses: { 1: false, 2: true }, password: 'secret-pass' })
    const rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: 'secret-pass' })
    try {
      const db = new MemoryDb()
      db.stores = [store({ http_port: nvr.port, rtsp_port: rtsp.port, password: 'wrong-pass', cameras: [{ id: 'c1', channel: 1, camera_ip: null }, { id: 'c2', channel: 2, camera_ip: null }] })]
      const time = { now: START }
      const d: Deps = { db, probes: realProbes, cfg, clock: () => new Date(time.now) }
      await checkCameras(d)
      const nvrAfterFirst = nvr.requests.length
      const rtspAfterFirst = rtsp.requests.length
      expect(nvrAfterFirst).toBeGreaterThan(0)
      expect(nvr.requests.every((r) => r.includes('/status'))).toBe(true) // only the status call; the channel list is not tried
      expect(rtspAfterFirst).toBeGreaterThan(0)
      for (let i = 0; i < 4; i++) {
        time.now += sec(60)
        await checkCameras(d)
      }
      expect(nvr.requests.length).toBe(nvrAfterFirst)
      expect(rtsp.requests.length).toBe(rtspAfterFirst)
      expect(db.results()).toHaveLength(0)
      time.now = START + sec(900)
      await checkCameras(d)
      expect(nvr.requests.length).toBe(nvrAfterFirst * 2)
      expect(rtsp.requests.length).toBe(rtspAfterFirst * 2)
    } finally {
      await nvr.close()
      await rtsp.close()
    }
  })
})
