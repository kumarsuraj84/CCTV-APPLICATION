import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCameras, checkNvrs, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import type { Probes, RecorderJob } from '@/lib/monitor/types'
import { MemoryDb } from '../helpers/memory-db'
import { NOW, recorder } from '../helpers/monitor-fixtures'

// Final fix X (release 1 review C I-4 and the estate-scale estimate; rulings NB-4, NB-5): the first production start must not contact all
// 218 NVRs at once. The worker contacts at most MONITOR_NEW_RECORDERS_PER_ROUND (10) NVRs whose login was never proven per camera round,
// doubling while they succeed; NVRs proven before are checked every round as usual; 10 NVRs at a time, one lane per NVR, at most 4
// video checks per NVR. The scheduling is shown at 218 fake NVRs with every request counted (fake probes, no network).

afterEach(() => vi.restoreAllMocks())
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {})

const N = 218
const CAMS = 20

/** 218 fake NVRs (20 cameras each). `refuse`: those whose saved password is wrong. Counts every request and the logins in flight. */
function estate(o: { refuse?: (i: number) => boolean; onlineEvery?: number } = {}) {
  const db = new MemoryDb()
  db.recorders = Array.from({ length: N }, (_, i): RecorderJob => recorder({
    id: `r${String(i).padStart(3, '0')}`, location_id: `l${i}`, code: `L${i}`, ip: `127.0.${Math.floor(i / 200)}.${(i % 200) + 1}`,
    username: o.refuse?.(i) ? 'wrong' : 'viewer',
    cameras: Array.from({ length: CAMS }, (_, c) => ({ id: `c${i}-${c + 1}`, channel: c + 1, camera_ip: null })),
  }))
  const counts = { isapi: 0, channelLists: 0, rtsp: 0, tcp: 0 }
  const live = { logins: 0, max: 0, perNvr: new Map<string, number>(), maxPerNvr: 0, rtspPerNvr: new Map<string, number>(), maxRtspPerNvr: 0 }
  const enter = (host: string) => {
    live.logins++
    live.max = Math.max(live.max, live.logins)
    const n = (live.perNvr.get(host) ?? 0) + 1
    live.perNvr.set(host, n)
    live.maxPerNvr = Math.max(live.maxPerNvr, n)
  }
  const leave = (host: string) => {
    live.logins--
    live.perNvr.set(host, (live.perNvr.get(host) ?? 1) - 1)
  }
  const probes: Probes = {
    tcp: async () => { counts.tcp++; return { ok: true } },
    icmp: async () => ({ ok: true }),
    rtsp: async (t) => {
      counts.rtsp++
      const n = (live.rtspPerNvr.get(t.host) ?? 0) + 1
      live.rtspPerNvr.set(t.host, n)
      live.maxRtspPerNvr = Math.max(live.maxRtspPerNvr, n)
      await sleep(1)
      live.rtspPerNvr.set(t.host, (live.rtspPerNvr.get(t.host) ?? 1) - 1)
      return { code: 200 }
    },
    nvr: (ep) => ({
      channelStatus: async () => {
        counts.isapi++
        enter(ep.host)
        await sleep(2)
        leave(ep.host)
        if (ep.username === 'wrong') throw new NvrError('auth', 'refused')
        // Every `onlineEvery`-th camera is reported offline, so it gets an RTSP check.
        return new Map(Array.from({ length: CAMS }, (_, c) => [c + 1, (c + 1) % (o.onlineEvery ?? 5) !== 0]))
      },
      channels: async () => { counts.channelLists++; return [] },
    }),
  }
  const time = { now: NOW.getTime() }
  const cfg = loadMonitorConfig({})
  const d: Deps = { db, probes, cfg, clock: () => new Date(time.now), rollout: { allowance: cfg.newRecordersPerRound } }
  /** One camera round: what it asked, by kind, and which NVRs it reached. */
  const round = async () => {
    const before = { ...counts }
    const reportsBefore = db.loginReports.length
    await checkCameras(d)
    time.now += cfg.cameraCheckSec * 1000
    return {
      nvrsAsked: counts.isapi - before.isapi, channelLists: counts.channelLists - before.channelLists, rtsp: counts.rtsp - before.rtsp,
      refused: db.loginReports.slice(reportsBefore).filter((r) => r.outcome === 'refused').length,
    }
  }
  return { db, d, counts, live, round, time }
}

describe('the first start against 218 NVRs: staggered, polite, counted', () => {
  it('contacts 10 never-proven NVRs, then 20, 40, 80, then the rest; never more than 10 logins at once, one per NVR', async () => {
    quiet()
    const e = estate()
    const rounds = []
    for (let i = 0; i < 6; i++) rounds.push(await e.round())
    // Round k contacts the NVRs proven before (checked every round) plus the new ones allowed.
    expect(rounds.map((r) => r.nvrsAsked)).toEqual([10, 30, 70, 150, 218, 218])
    // Per NVR and round: one ISAPI status read, one channel list read, one RTSP check for each camera it reports offline (4 of 20).
    expect(rounds[5]).toEqual({ nvrsAsked: 218, channelLists: 218, rtsp: 218 * 4, refused: 0 })
    expect(e.live.max).toBeLessThanOrEqual(10)
    expect(e.live.maxPerNvr).toBe(1)
    expect(e.live.maxRtspPerNvr).toBeLessThanOrEqual(4)
    // Nothing of a not-yet-contacted NVR was recorded.
    const first = new Set(e.db.applied.slice(0, 10).flatMap((a) => a.results.map((r) => r.recorder)))
    expect(first.size).toBeLessThanOrEqual(10)
  })

  it('a wrong password does not speed the rollout up: refused NVRs do not double the allowance, and each is tried once', async () => {
    quiet()
    const e = estate({ refuse: (i) => i % 2 === 0 })
    const rounds = []
    for (let i = 0; i < 3; i++) rounds.push(await e.round())
    // Round 1: 10 new (5 refused, 5 fine); round 2: the 5 proven + 10 new (allowance stays at 10: only 5 succeeded); and so on.
    expect(rounds.map((r) => r.nvrsAsked)).toEqual([10, 15, 20])
    expect(rounds.map((r) => r.refused)).toEqual([5, 5, 5])
    // No refused NVR was asked twice: the rounds are 5 minutes apart, the first window 15 minutes.
    const refusedReports = e.db.loginReports.filter((r) => r.outcome === 'refused').map((r) => r.recorderId)
    expect(new Set(refusedReports).size).toBe(refusedReports.length)
  })

  it('the NVR reachability check (one TCP connect, no login) is not staggered and calls an NVR down after 3 failures (M-6)', async () => {
    quiet()
    const e = estate()
    e.db.nvrs = e.db.recorders.map((r) => ({ id: r.id, org_id: r.org_id, location_id: r.location_id, ip: r.ip, rtsp_port: r.rtsp_port }))
    await checkNvrs(e.d)
    expect(e.counts.tcp).toBe(N)
    expect(e.db.applied.every((a) => a.threshold === 3)).toBe(true)
  })

  it('an estate already proven (a restart of a running worker) is checked whole at once', async () => {
    quiet()
    const e = estate()
    e.db.provenAll(NOW.getTime())
    expect((await e.round()).nvrsAsked).toBe(218)
  })
})
