import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCameras, type Deps } from '@/lib/monitor/checks'
import { realProbes } from '@/lib/monitor/probes'
import { NvrError } from '@/lib/nvr/client'
import type { Probes } from '@/lib/monitor/types'
import { startFakeNvr, startFakeRtsp } from '../helpers/fake-servers'
import { MemoryDb } from '../helpers/memory-db'
import { cfg, deps, NOW, store } from '../helpers/monitor-fixtures'

afterEach(() => vi.restoreAllMocks())

describe('a wrong or missing NVR password never makes cameras look down', () => {
  const refused = (kind: 'auth' | 'forbidden' = 'auth'): Partial<Probes> => ({
    nvr: () => ({ channelStatus: async () => { throw new NvrError(kind, 'x') }, channels: async () => { throw new NvrError(kind, 'x') } }),
  })
  const quietLog = () => vi.spyOn(console, 'log').mockImplementation(() => {})
  const loginLines = (spy: ReturnType<typeof quietLog>) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('NVR login problem'))

  it('sends nothing for a camera whose only answer is a refused login, for ISAPI auth and for forbidden', async () => {
    for (const kind of ['auth', 'forbidden'] as const) {
      const db = new MemoryDb()
      db.stores = [store()]
      const spy = quietLog()
      await checkCameras(deps(db, { ...refused(kind), rtsp: async () => ({ code: 401 }) }))
      expect(db.results()).toHaveLength(0)
      expect(db.applied).toHaveLength(0)
      expect(loginLines(spy)).toHaveLength(1)
      expect(loginLines(spy)[0]).toContain('NVR login problem for store S1')
      expect(loginLines(spy)[0]).not.toContain('"pw"')
      spy.mockRestore()
    }
  })

  it('still lets the other answers count: 200 is Live, no answer and an odd answer are failures', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    quietLog()
    await checkCameras(deps(db, { ...refused(), rtsp: async (t) => ({ code: [200, 0, 404][t.channel - 1] }) }))
    expect(db.results().map((r) => [r.id, r.ok])).toEqual([['c1', true], ['c2', false], ['c3', false]])
    expect(db.results()[1].error).toBe('The NVR refused the user name or password.')
    expect(db.results()[2].error).toBe('The camera gave an answer this app does not expect.')
  })

  it('sends nothing, and does not try to log in to the NVR, when the store has no saved password', async () => {
    const db = new MemoryDb()
    db.stores = [store({ password: '' })]
    const spy = quietLog()
    let asked = 0
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => { asked++; return new Map() }, channels: async () => { asked++; return [] } }),
      rtsp: async () => ({ code: 401 }),
    }))
    expect(asked).toBe(0)
    expect(db.results()).toHaveLength(0)
    expect(loginLines(spy)).toHaveLength(1)
  })

  it('with a good login a 401 from RTSP is a normal failure, and nothing is logged about the login', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    const spy = quietLog()
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, false], [2, false], [3, false]]), channels: async () => [] }),
      rtsp: async () => ({ code: 401 }),
    }))
    expect(db.results()).toHaveLength(3)
    expect(db.results().every((r) => !r.ok && r.error === 'The recorder refused the login.')).toBe(true)
    expect(loginLines(spy)).toHaveLength(0)
  })

  it('an NVR that is up but times out is not a login problem: the RTSP fallback works as before', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    const spy = quietLog()
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => { throw new NvrError('timeout', 'x') }, channels: async () => { throw new NvrError('timeout', 'x') } }),
      rtsp: async (t) => ({ code: [200, 401, 0][t.channel - 1] }),
    }))
    expect(db.results().map((r) => [r.id, r.ok])).toEqual([['c1', true], ['c2', false], ['c3', false]])
    expect(db.results()[1].error).toBe('The recorder refused the login.')
    expect(db.results()[2].error).toBe('The NVR took too long to answer.')
    expect(loginLines(spy)).toHaveLength(0)
  })

  describe('against fake servers (real probes)', () => {
    const run = async (nvrPassword: string, storePassword: string, statuses: Record<number, boolean>, rounds: number) => {
      const nvr = await startFakeNvr({ statuses, password: nvrPassword })
      const rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: nvrPassword })
      try {
        const db = new MemoryDb()
        db.stores = [store({
          http_port: nvr.port, rtsp_port: rtsp.port, password: storePassword,
          cameras: Object.keys(statuses).map((n) => ({ id: `c${n}`, channel: Number(n), camera_ip: null })),
        })]
        const d: Deps = { db, probes: realProbes, cfg, clock: () => NOW }
        for (let i = 0; i < rounds; i++) await checkCameras(d)
        return { db, nvr, rtsp }
      } finally {
        await nvr.close()
        await rtsp.close()
      }
    }

    it('a wrong password sends no camera results over three rounds', async () => {
      const spy = quietLog()
      const { db, nvr, rtsp } = await run('secret-pass', 'wrong-pass', { 1: false, 2: true }, 3)
      expect(db.results()).toHaveLength(0)
      expect(nvr.requests.length).toBeGreaterThan(0) // the NVR really was asked, and refused
      expect(rtsp.requests.length).toBeGreaterThan(0)
      expect(loginLines(spy)).toHaveLength(1) // one line when the back-off starts, not one per round
    })

    it('a missing password sends no camera results over three rounds', async () => {
      quietLog()
      const { db } = await run('secret-pass', '', { 1: false, 2: true }, 3)
      expect(db.results()).toHaveLength(0)
    })

    it('the right password behaves as before: the NVR is trusted, the rest is checked with RTSP', async () => {
      const { db } = await run('secret-pass', 'secret-pass', { 1: true, 2: false }, 1)
      expect(db.results().map((r) => [r.id, r.ok, r.method])).toEqual([['c1', true, 'isapi+rtsp'], ['c2', true, 'isapi+rtsp']])
    })
  })
})

describe('an NVR state that is out of date is not trusted', () => {
  const run = (db: MemoryDb, clock: () => Date = () => NOW) => {
    const counts = { nvr: 0 }
    const d = deps(db, { nvr: () => { counts.nvr++; return { channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] } } }, clock)
    return { counts, d }
  }
  const secondsBefore = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString()

  it('a recent "down" marks the cameras down at once', async () => {
    const db = new MemoryDb()
    db.stores = [store({ nvr_status: 'down', nvr_checked_at: secondsBefore(60) })]
    const { d, counts } = run(db)
    await checkCameras(d)
    expect(counts.nvr).toBe(0)
    expect(db.results()).toHaveLength(3)
    expect(db.results().every((r) => r.cause === 'nvr_down')).toBe(true)
  })

  it('exactly three device intervals old still counts', async () => {
    const db = new MemoryDb()
    db.stores = [store({ nvr_status: 'down', nvr_checked_at: secondsBefore(3 * cfg.deviceCheckSec) })]
    await checkCameras(run(db).d)
    expect(db.results()).toHaveLength(3)
    expect(db.results().every((r) => r.cause === 'nvr_down')).toBe(true)
  })

  it('older than three device intervals, or with no time at all, the cameras are probed normally', async () => {
    for (const checked of [secondsBefore(3 * cfg.deviceCheckSec + 1), secondsBefore(3600), null]) {
      const db = new MemoryDb()
      db.stores = [store({ nvr_status: 'down', nvr_checked_at: checked })]
      const { d, counts } = run(db)
      await checkCameras(d)
      expect(counts.nvr).toBe(1)
      expect(db.results()).toHaveLength(3)
      expect(db.results().every((r) => r.ok && r.cause === undefined && r.method === 'isapi')).toBe(true)
      expect(db.applied[0].threshold).toBe(cfg.failThreshold)
    }
  })

  it('follows the injected clock', async () => {
    const db = new MemoryDb()
    db.stores = [store({ nvr_status: 'down', nvr_checked_at: NOW.toISOString() })]
    await checkCameras(run(db, () => new Date(NOW.getTime() + 10 * 60_000)).d)
    expect(db.results()).toHaveLength(3)
    expect(db.results().every((r) => r.ok)).toBe(true)
  })

  it('tells the data layer how old a state may be', async () => {
    const db = new MemoryDb()
    let given: Date | undefined
    db.loadStoreJobs = async (_ids, staleBefore) => {
      given = staleBefore
      return []
    }
    await checkCameras(deps(db))
    expect(given).toEqual(new Date(NOW.getTime() - 3 * cfg.deviceCheckSec * 1000))
  })
})

describe('the NVR timeout from the configuration is used', () => {
  it('is handed to the NVR client', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    const seen: unknown[] = []
    await checkCameras(deps(db, {
      nvr: (_ep, opts) => {
        seen.push(opts)
        return { channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] }
      },
    }))
    expect(seen).toEqual([{ timeoutMs: cfg.nvrTimeoutMs }])
  })

  it('makes the real client give up when the NVR does not answer in time', async () => {
    const nvr = await startFakeNvr({ mode: 'slow', statuses: { 1: true } })
    try {
      const started = Date.now()
      const client = realProbes.nvr({ host: '127.0.0.1', port: nvr.port, username: 'viewer', password: 'secret-pass' }, { timeoutMs: 300 })
      await expect(client.channelStatus()).rejects.toMatchObject({ kind: 'timeout' })
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await nvr.close()
    }
  })
})
