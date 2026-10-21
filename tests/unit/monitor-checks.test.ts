import { describe, expect, it } from 'vitest'
import { checkCameras, checkDevices, checkNvrs, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import type { CheckResult, Probes, StoreJob } from '@/lib/monitor/types'
import { MemoryDb } from '../helpers/memory-db'

const NOW = new Date('2026-05-01T08:00:00Z')
const cfg = loadMonitorConfig({})

function deps(db: MemoryDb, probes: Partial<Probes> = {}, clock: () => Date = () => NOW): Deps {
  const base: Probes = {
    tcp: async () => ({ ok: true }),
    icmp: async () => ({ ok: true }),
    rtsp: async () => ({ code: 0 }),
    nvr: () => ({ channelStatus: async () => new Map(), channels: async () => [] }),
  }
  return { db, probes: { ...base, ...probes }, cfg, clock }
}

/** What an RTSP check answers: 200 when the camera is live, 0 when nothing answered. */
const rsp = (ok: boolean) => ({ code: ok ? 200 : 0 })

const store = (over: Partial<StoreJob> = {}): StoreJob => ({
  id: 's1', org_id: 'o1', code: 'S1', ip: '127.0.0.1', rtsp_port: 554, http_port: 80, username: 'viewer', password: 'pw', nvr_status: 'up',
  cameras: [{ id: 'c1', channel: 1, camera_ip: null }, { id: 'c2', channel: 2, camera_ip: null }, { id: 'c3', channel: 3, camera_ip: null }],
  ...over,
})

describe('checkDevices', () => {
  it('uses TCP when a port is set and ping when it is not, and records why a device failed', async () => {
    const db = new MemoryDb()
    db.devices = [
      { id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 443 },
      { id: 'd2', org_id: 'o1', ip: '127.0.0.2', tcp_port: null },
      { id: 'd3', org_id: 'o2', ip: '127.0.0.3', tcp_port: 80 },
    ]
    const calls: string[] = []
    await checkDevices(deps(db, {
      tcp: async (h, p) => { calls.push(`tcp ${h}:${p}`); return h === '127.0.0.3' ? { ok: false, error: 'The port refused the connection.' } : { ok: true } },
      icmp: async (h) => { calls.push(`icmp ${h}`); return { ok: true } },
    }))
    expect(calls.sort()).toEqual(['icmp 127.0.0.2', 'tcp 127.0.0.1:443', 'tcp 127.0.0.3:80'])
    const byOrg = Object.fromEntries(db.applied.map((a) => [a.orgId, a.results]))
    expect(byOrg.o1).toEqual([
      { type: 'device', id: 'd1', ok: true, at: NOW.toISOString(), method: 'tcp', error: undefined },
      { type: 'device', id: 'd2', ok: true, at: NOW.toISOString(), method: 'icmp', error: undefined },
    ])
    expect(byOrg.o2[0]).toMatchObject({ id: 'd3', ok: false, error: 'The port refused the connection.' })
    expect(db.applied.every((a) => a.threshold === 2)).toBe(true)
  })

  it('records an address or port that cannot be used as a failed check with a plain message, without probing', async () => {
    const db = new MemoryDb()
    db.devices = [
      { id: 'd1', org_id: 'o1', ip: 'http://evil.example/x', tcp_port: 80 },
      { id: 'd2', org_id: 'o1', ip: '127.0.0.1', tcp_port: 70000 },
      { id: 'd3', org_id: 'o1', ip: '-c', tcp_port: null },
      { id: 'd4', org_id: 'o1', ip: '127.0.0.4', tcp_port: 80 },
    ]
    let probed = 0
    await checkDevices(deps(db, { tcp: async () => { probed++; return { ok: true } }, icmp: async () => { probed++; return { ok: true } } }))
    expect(probed).toBe(1)
    const r = Object.fromEntries(db.results().map((x) => [x.id, x]))
    for (const id of ['d1', 'd2', 'd3']) expect(r[id]).toMatchObject({ ok: false, error: 'The address or port saved for this device is not valid.' })
    expect(r.d4.ok).toBe(true)
  })

  it('sends all four of type, id, ok and at for every result, and never two results for one target', async () => {
    const db = new MemoryDb()
    db.devices = [
      { id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 80 },
      { id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 80 },
      { id: 'd2', org_id: 'o1', ip: '127.0.0.2', tcp_port: 80 },
    ]
    await checkDevices(deps(db))
    const all = db.results()
    expect(all.map((r) => r.id)).toEqual(['d1', 'd2'])
    for (const r of all) {
      expect(typeof r.type).toBe('string')
      expect(typeof r.id).toBe('string')
      expect(typeof r.ok).toBe('boolean')
      expect(Number.isNaN(Date.parse(r.at))).toBe(false)
    }
  })

  it('a probe that throws for one device does not stop the others, and records nothing false about it', async () => {
    const db = new MemoryDb()
    db.devices = [
      { id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 80 },
      { id: 'd2', org_id: 'o1', ip: '127.0.0.2', tcp_port: 80 },
    ]
    await checkDevices(deps(db, { tcp: async (h) => { if (h === '127.0.0.1') throw new Error('boom'); return { ok: true } } }))
    expect(db.results().map((r) => r.id)).toEqual(['d2'])
  })

  it('a database error for one organisation does not stop the others, and the call does not throw', async () => {
    const db = new MemoryDb()
    db.devices = [
      { id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 80 },
      { id: 'd2', org_id: 'o2', ip: '127.0.0.2', tcp_port: 80 },
    ]
    const original = db.applyResults.bind(db)
    db.applyResults = async (org, results, threshold) => {
      if (org === 'o1') throw new Error('database is unhappy')
      return original(org, results, threshold)
    }
    await expect(checkDevices(deps(db))).resolves.toBe(2)
    expect(db.results().map((r) => r.id)).toEqual(['d2'])
  })

  it('does not throw when the devices cannot be loaded', async () => {
    const db = new MemoryDb()
    db.loadDevices = async () => { throw new Error('database is down') }
    await expect(checkDevices(deps(db))).resolves.toBe(0)
  })

  it('sends at most 200 results per call', async () => {
    const db = new MemoryDb()
    db.devices = Array.from({ length: 450 }, (_, i) => ({ id: `d${i}`, org_id: 'o1', ip: '127.0.0.1', tcp_port: 80 }))
    await checkDevices(deps(db))
    expect(db.applied.map((a) => a.results.length)).toEqual([200, 200, 50])
  })

  it('two runs at the same time never overlap, so a late result cannot reach the database', async () => {
    const db = new MemoryDb()
    db.devices = [{ id: 'd1', org_id: 'o1', ip: '127.0.0.1', tcp_port: 80 }]
    let inFlight = 0
    let peak = 0
    db.applyResults = async (orgId, results, threshold) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      db.applied.push({ orgId, results, threshold })
      inFlight--
    }
    let tick = 0
    const clock = () => new Date(NOW.getTime() + tick++ * 1000)
    const d = deps(db, {}, clock)
    await Promise.all([checkDevices(d), checkDevices(d)])
    expect(peak).toBe(1)
    const times = db.results().map((r) => Date.parse(r.at))
    expect(times).toHaveLength(2)
    expect(times[0]).toBeLessThan(times[1])
  })
})

describe('checkNvrs', () => {
  it('checks the NVR video port of every store', async () => {
    const db = new MemoryDb()
    db.nvrs = [{ id: 's1', org_id: 'o1', ip: '127.0.0.1', rtsp_port: 8554 }, { id: 's2', org_id: 'o1', ip: '127.0.0.2', rtsp_port: 554 }]
    await checkNvrs(deps(db, { tcp: async (h) => ({ ok: h === '127.0.0.1' }) }))
    expect(db.results().map((r) => [r.type, r.id, r.ok])).toEqual([['nvr', 's1', true], ['nvr', 's2', false]])
  })

  it('records an NVR address that cannot be used as a failure without probing it', async () => {
    const db = new MemoryDb()
    db.nvrs = [{ id: 's1', org_id: 'o1', ip: 'a b', rtsp_port: 554 }, { id: 's2', org_id: 'o1', ip: '127.0.0.2', rtsp_port: 0 }]
    let probed = 0
    await checkNvrs(deps(db, { tcp: async () => { probed++; return { ok: true } } }))
    expect(probed).toBe(0)
    expect(db.results().map((r) => [r.id, r.ok, r.error])).toEqual([
      ['s1', false, 'The NVR address saved for this store is not valid.'],
      ['s2', false, 'The NVR address saved for this store is not valid.'],
    ])
  })
})

describe('checkCameras', () => {
  it('trusts the NVR for cameras it says are online and re-checks the others with RTSP', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    const rtspCalls: number[] = []
    await checkCameras(deps(db, {
      nvr: () => ({
        channelStatus: async () => new Map([[1, true], [2, false], [3, false]]),
        channels: async () => [{ channel: 1, name: 'A', ip: '192.0.2.1' }, { channel: 2, name: 'B', ip: '192.0.2.2' }, { channel: 3, name: 'C', ip: null }],
      }),
      rtsp: async (t) => { rtspCalls.push(t.channel); return rsp(t.channel === 2) },
    }))
    expect(rtspCalls.sort()).toEqual([2, 3])
    expect(db.results().map((r) => [r.id, r.ok, r.method])).toEqual([['c1', true, 'isapi+rtsp'], ['c2', true, 'isapi+rtsp'], ['c3', false, 'isapi+rtsp']])
    expect(db.results()[2].error).toBe('The camera did not answer.')
    expect(db.ipsSaved[0].rows).toEqual([{ cameraId: 'c1', ip: '192.0.2.1' }, { cameraId: 'c2', ip: '192.0.2.2' }])
  })

  it('does not use RTSP when the NVR says every camera is online', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    let rtsp = 0
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] }),
      rtsp: async () => { rtsp++; return rsp(false) },
    }))
    expect(rtsp).toBe(0)
    expect(db.results().every((r) => r.ok && r.method === 'isapi')).toBe(true)
  })

  it('falls back to RTSP for every camera when the NVR cannot be asked, and says why', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => { throw new NvrError('auth', 'x') }, channels: async () => { throw new NvrError('auth', 'x') } }),
      rtsp: async (t) => rsp(t.channel === 1),
    }))
    expect(db.results().map((r) => [r.id, r.ok, r.method])).toEqual([['c1', true, 'rtsp'], ['c2', false, 'rtsp'], ['c3', false, 'rtsp']])
    expect(db.results()[1].error).toBe('The NVR refused the user name or password.')
  })

  it('aims the RTSP check at the NVR itself, on the camera channel, with the store login', async () => {
    const db = new MemoryDb()
    db.stores = [store({ cameras: [{ id: 'c1', channel: 7, camera_ip: null }] })]
    const targets: unknown[] = []
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[7, false]]), channels: async () => [{ channel: 7, name: 'A', ip: '203.0.113.9' }] }),
      rtsp: async (t) => { targets.push(t); return rsp(true) },
    }))
    expect(targets).toEqual([{ host: '127.0.0.1', port: 554, username: 'viewer', password: 'pw', channel: 7 }])
  })

  it('tells a camera that refuses the login from one that does not answer, and from an odd answer', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, false], [2, false], [3, false]]), channels: async () => [] }),
      rtsp: async (t) => ({ code: [200, 401, 404][t.channel - 1] }),
    }))
    const r = db.results()
    expect(r.map((x) => [x.id, x.ok])).toEqual([['c1', true], ['c2', false], ['c3', false]])
    expect(r[1].error).toBe('The camera answered but refused the login.')
    expect(r[2].error).toBe('The camera gave an answer this app does not expect.')
  })

  it('marks every camera down at once, with the NVR as the cause, when the NVR is down, and asks nothing', async () => {
    const db = new MemoryDb()
    db.stores = [store({ nvr_status: 'down' })]
    let asked = 0
    await checkCameras(deps(db, {
      nvr: () => { asked++; return { channelStatus: async () => new Map(), channels: async () => [] } },
      rtsp: async () => { asked++; return rsp(true) },
    }))
    expect(asked).toBe(0)
    expect(db.applied).toHaveLength(1)
    expect(db.applied[0].threshold).toBe(1)
    expect(db.results().every((r) => !r.ok && r.cause === 'nvr_down' && r.method === 'nvr_down')).toBe(true)
  })

  it('skips camera addresses that did not change and reports progress per store', async () => {
    const db = new MemoryDb()
    db.stores = [
      store({ id: 's1', cameras: [{ id: 'c1', channel: 1, camera_ip: '192.0.2.1' }] }),
      store({ id: 's2', cameras: [{ id: 'c9', channel: 1, camera_ip: null }] }),
    ]
    const progress: [number, number][] = []
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [{ channel: 1, name: 'A', ip: '192.0.2.1' }] }),
    }), (d, t) => progress.push([d, t]))
    expect(db.ipsSaved.flatMap((i) => i.rows)).toEqual([{ cameraId: 'c9', ip: '192.0.2.1' }])
    expect(progress).toEqual([[1, 2], [2, 2]])
  })

  it('never saves a camera address that is not a plain IP address', async () => {
    const db = new MemoryDb()
    db.stores = [store({ cameras: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, channel: n, camera_ip: null })) })]
    await checkCameras(deps(db, {
      nvr: () => ({
        channelStatus: async () => new Map([[1, true], [2, true], [3, true], [4, true]]),
        channels: async () => [
          { channel: 1, name: 'A', ip: 'http://evil.example/' },
          { channel: 2, name: 'B', ip: '192.0.2.5:554' },
          { channel: 3, name: 'C', ip: 'fe80::1%eth0' },
          { channel: 4, name: 'D', ip: '2001:db8::5' },
        ],
      }),
    }))
    expect(db.ipsSaved.flatMap((i) => i.rows)).toEqual([{ cameraId: 'c4', ip: '2001:db8::5' }])
  })

  it('an NVR address that cannot be used fails its cameras without probing anything', async () => {
    const db = new MemoryDb()
    db.stores = [store({ ip: 'bad host' })]
    let asked = 0
    await checkCameras(deps(db, {
      nvr: () => { asked++; return { channelStatus: async () => new Map(), channels: async () => [] } },
      rtsp: async () => { asked++; return rsp(true) },
    }))
    expect(asked).toBe(0)
    expect(db.results().every((r) => !r.ok && r.error === 'The NVR address saved for this store is not valid.')).toBe(true)
    expect(db.results()).toHaveLength(3)
  })

  it('one failing store does not stop the others', async () => {
    const db = new MemoryDb()
    db.stores = [store({ id: 's1', cameras: [{ id: 'c1', channel: 1, camera_ip: null }] }), store({ id: 's2', cameras: [{ id: 'c2', channel: 1, camera_ip: null }] })]
    let n = 0
    await checkCameras(deps(db, {
      nvr: () => {
        if (n++ === 0) throw new Error('boom')
        return { channelStatus: async () => new Map([[1, true]]), channels: async () => [] }
      },
    }))
    expect(db.results().map((r) => r.id)).toEqual(['c2'])
  })

  it('a camera whose RTSP check throws is left out; its neighbours are still recorded', async () => {
    const db = new MemoryDb()
    db.stores = [store()]
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => new Map([[1, true], [2, false], [3, false]]), channels: async () => [] }),
      rtsp: async (t) => { if (t.channel === 2) throw new Error('boom'); return rsp(true) },
    }))
    expect(db.results().map((r) => [r.id, r.ok])).toEqual([['c1', true], ['c3', true]])
  })

  it('a failing progress callback does not stop the run', async () => {
    const db = new MemoryDb()
    db.stores = [store({ id: 's1' }), store({ id: 's2' })]
    await checkCameras(deps(db, { nvr: () => ({ channelStatus: async () => new Map([[1, true], [2, true], [3, true]]), channels: async () => [] }) }), () => {
      throw new Error('callback broke')
    })
    expect(db.results()).toHaveLength(6)
  })

  it('limits the run to the stores asked for', async () => {
    const db = new MemoryDb()
    db.stores = [store({ id: 's1' }), store({ id: 's2', cameras: [{ id: 'c9', channel: 1, camera_ip: null }] })]
    await expect(checkCameras(deps(db, { nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [] }) }), undefined, ['s2'])).resolves.toBe(1)
    expect(db.results().map((r) => r.id)).toEqual(['c9'])
  })

  it('two runs over the same store never overlap, so the older result is always applied first', async () => {
    const db = new MemoryDb()
    db.stores = [store({ cameras: [{ id: 'c1', channel: 1, camera_ip: null }] })]
    let inFlight = 0
    let peak = 0
    db.applyResults = async (orgId, results, threshold) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      db.applied.push({ orgId, results, threshold })
      inFlight--
    }
    let tick = 0
    const d = deps(db, { nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [] }) }, () => new Date(NOW.getTime() + tick++ * 1000))
    await Promise.all([checkCameras(d), checkCameras(d, undefined, ['s1'])])
    expect(peak).toBe(1)
    const times = db.results().map((r: CheckResult) => Date.parse(r.at))
    expect(times[0]).toBeLessThan(times[1])
  })

  it('never puts the NVR password into a result or a saved address', async () => {
    const db = new MemoryDb()
    db.stores = [store({ password: 'S3cret-Pass' })]
    await checkCameras(deps(db, {
      nvr: () => ({ channelStatus: async () => { throw new NvrError('auth', 'login refused with S3cret-Pass') }, channels: async () => [] }),
      rtsp: async () => rsp(false),
    }))
    expect(JSON.stringify([db.applied, db.ipsSaved])).not.toContain('S3cret-Pass')
  })
})
