import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCameras, type Deps } from '@/lib/monitor/checks'
import { realProbes } from '@/lib/monitor/probes'
import { NvrError, type NvrErrorKind } from '@/lib/nvr/client'
import { startFakeNvr, startFakeRtsp } from '../helpers/fake-servers'
import { MemoryDb } from '../helpers/memory-db'
import { cfg, deps, NOW, recorder } from '../helpers/monitor-fixtures'

// Final fix X (release 1 review C I-1 and I-3; ruling NB-1). The worker's NVR login back-off is the SHARED one now (the data layer's
// login state, in the database for the real worker): it escalates (15 minutes doubling to 6 hours), it survives a restart or a new lease
// epoch (the state is not in the runner), no RTSP login follows a refused ISAPI login, an NVR without a saved password is never
// contacted, and "forbidden" is not a refused login. These tests replace the P2 ones that pinned "1 NVR + 1 RTSP login per window" and
// "also backs off after forbidden" (both are what the review found wrong).

afterEach(() => vi.restoreAllMocks())

const START = NOW.getTime()
const min = (n: number) => 60_000 * n
const quietLog = () => vi.spyOn(console, 'log').mockImplementation(() => {})
const lines = (spy: ReturnType<typeof quietLog>, text: string) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(text))
export const refusedCount = (db: MemoryDb) => [...db.logins.values()].filter((s) => s.outcome === 'refused').length

/** A fake clock the test moves by hand, and an NVR whose ISAPI answers with `kind` for the user "viewer" (any other user: fine). */
function setup(kind: NvrErrorKind = 'auth', rtspCode = 401) {
  const db = new MemoryDb()
  db.recorders = [recorder()]
  const time = { now: START }
  const counts = { nvr: 0, rtsp: 0 }
  const d = deps(db, {
    nvr: (ep) => {
      counts.nvr++
      if (ep.username !== 'viewer') return { channelStatus: async () => new Map([[1, true]]), channels: async () => [] }
      return { channelStatus: async () => { throw new NvrError(kind, 'x') }, channels: async () => { throw new NvrError(kind, 'x') } }
    },
    rtsp: async () => { counts.rtsp++; return { code: rtspCode } },
  }, () => new Date(time.now))
  return { db, time, counts, d, round: (ids?: string[], over: Deps = d) => checkCameras(over, undefined, ids) }
}

describe('after a refused NVR login the recorder is left alone (shared, escalating back-off)', () => {
  it('one ISAPI login and NO RTSP login after it; then nothing for the whole window; no results for its cameras', async () => {
    const spy = quietLog()
    const { db, time, counts, round } = setup()
    for (let i = 0; i < 5; i++) {
      await round()
      time.now += min(1)
    }
    expect(counts).toEqual({ nvr: 1, rtsp: 0 })
    expect(db.results()).toHaveLength(0)
    expect(lines(spy, 'nvr_login_refused')).toHaveLength(1)
  })

  it('escalates: one try after 15 minutes, then after 30 more, then 60 more', async () => {
    quietLog()
    const { time, counts, round } = setup()
    const at = async (m: number) => {
      time.now = START + min(m)
      await round()
      return counts.nvr
    }
    expect(await at(0)).toBe(1)
    expect(await at(14)).toBe(1)
    expect(await at(15)).toBe(2)
    expect(await at(44)).toBe(2)
    expect(await at(45)).toBe(3)
    expect(await at(104)).toBe(3)
    expect(await at(105)).toBe(4)
    expect(counts.rtsp).toBe(0)
  })

  it('survives a restart or a new lease epoch: a new runner on the same data layer does not ask again', async () => {
    quietLog()
    const { d, counts } = setup()
    await checkCameras(d)
    const restarted: Deps = { ...d, signal: new AbortController().signal } // a new runner: nothing of the old one is kept
    await checkCameras(restarted)
    await checkCameras({ ...restarted })
    expect(counts.nvr).toBe(1)
  })

  it('"forbidden" is not a refused login: a viewer account is checked by RTSP every round, results written, no back-off (I-3)', async () => {
    const spy = quietLog()
    const { db, time, counts, round } = setup('forbidden', 200)
    for (let i = 0; i < 3; i++) {
      await round()
      time.now += min(5)
    }
    expect(counts.nvr).toBe(3)
    expect(counts.rtsp).toBe(9) // three cameras, three rounds
    expect(db.results().filter((r) => r.ok)).toHaveLength(9)
    expect(refusedCount(db)).toBe(0)
    expect(lines(spy, 'nvr_login_refused')).toHaveLength(0)
    expect(lines(spy, 'nvr_login_problem')).toHaveLength(0)
  })

  it('"forbidden" and then the first video login refused: one RTSP try only, then the back-off, no results', async () => {
    // A 403 says the web login was accepted, not that the video login is: the first camera goes alone, and its refusal counts against
    // the NVR account like any other, so nothing else is tried.
    quietLog()
    const { db, counts, round } = setup('forbidden', 401)
    await round()
    await round()
    expect(counts).toEqual({ nvr: 1, rtsp: 1 })
    expect(refusedCount(db)).toBe(1)
    expect(db.results()).toHaveLength(0)
  })

  it('a "check now" for that NVR does not bypass it', async () => {
    quietLog()
    const { counts, round } = setup()
    await round()
    await round(['s1'])
    expect(counts).toEqual({ nvr: 1, rtsp: 0 })
  })

  it('a timeout or an unreachable NVR, with nothing refused at the video port, is not a login problem: no back-off', async () => {
    quietLog()
    for (const kind of ['timeout', 'unreachable'] as const) {
      const { db, time, counts, round } = setup(kind, 0)
      for (let i = 0; i < 3; i++) {
        await round()
        time.now += min(1)
      }
      expect(counts.nvr).toBe(3)
      expect(refusedCount(db)).toBe(0)
    }
  })

  it('ISAPI not answering and the first video login refused: one RTSP login only, then the back-off', async () => {
    quietLog()
    const { db, counts, round } = setup('timeout', 401)
    await round()
    await round()
    expect(counts).toEqual({ nvr: 1, rtsp: 1 })
    expect(refusedCount(db)).toBe(1)
  })

  it('an NVR with no saved password is never contacted (no ISAPI, no RTSP), however many rounds', async () => {
    quietLog()
    const { db, counts, round } = setup()
    db.recorders = [recorder({ password: '' })]
    for (let i = 0; i < 4; i++) await round()
    expect(counts).toEqual({ nvr: 0, rtsp: 0 })
    expect(db.results()).toHaveLength(0)
    expect(db.passwordReads).toHaveLength(0)
  })

  it('other NVRs are not held back, also a second NVR of the SAME location', async () => {
    quietLog()
    const { db, counts, round } = setup()
    db.recorders = [recorder({ id: 'rA', location_id: 'l1' }), recorder({ id: 'rB', location_id: 'l1', ip: '127.0.0.2', username: 'fine', cameras: [{ id: 'c9', channel: 1, camera_ip: null }] })]
    await round()
    await round()
    await round()
    expect(counts.nvr).toBe(4) // rA and rB, then only rB twice
    expect(db.results().filter((r) => r.id === 'c9')).toHaveLength(3)
    expect(db.results().filter((r) => ['c1', 'c2', 'c3'].includes(r.id))).toHaveLength(0)
  })

  it('ends at once when the saved password or user name changes, but not when something else does', async () => {
    quietLog()
    const { db, counts, round } = setup()
    await round()
    db.recorders = [recorder({ nvr_checked_at: null, cameras: [{ id: 'c1', channel: 1, camera_ip: '192.0.2.1' }] })]
    await round()
    expect(counts.nvr).toBe(1)
    db.recorders = [recorder({ password: 'new-pass' })]
    await round()
    expect(counts.nvr).toBe(2)
    db.recorders = [recorder({ password: 'new-pass', username: 'other' })]
    await round()
    expect(counts.nvr).toBe(3)
  })

  it('reads the password only for an NVR it may ask, never for one in its back-off', async () => {
    quietLog()
    const { db, round } = setup()
    await round()
    await round()
    await round()
    expect(db.passwordReads).toEqual(['s1'])
  })

  it('uses the configured first window', async () => {
    quietLog()
    const { time, counts, d } = setup()
    const short: Deps = { ...d, cfg: { ...d.cfg, nvrLoginBackoffSec: 60, nvrLoginBackoffMaxSec: 600 } }
    await checkCameras(short)
    time.now += 59_000
    await checkCameras(short)
    expect(counts.nvr).toBe(1)
    time.now += 1000
    await checkCameras(short)
    expect(counts.nvr).toBe(2)
  })

  it('the log lines hold no password', async () => {
    const spy = quietLog()
    const { db, round } = setup()
    db.recorders = [recorder({ password: 'Sup3r-Secret' })]
    await round()
    expect(lines(spy, 'Sup3r-Secret')).toHaveLength(0)
  })

  it('against fake servers (real probes): one failed login in five rounds and no RTSP at all, then one more after the window', async () => {
    quietLog()
    const nvr = await startFakeNvr({ statuses: { 1: false, 2: true }, password: 'secret-pass' })
    const rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: 'secret-pass' })
    try {
      const db = new MemoryDb()
      db.recorders = [recorder({ http_port: nvr.port, rtsp_port: rtsp.port, password: 'wrong-pass', cameras: [{ id: 'c1', channel: 1, camera_ip: null }, { id: 'c2', channel: 2, camera_ip: null }] })]
      const time = { now: START }
      const d: Deps = { db, probes: realProbes, cfg, clock: () => new Date(time.now) }
      await checkCameras(d)
      const failedLogins = () => nvr.authorizations.length
      expect(failedLogins()).toBe(1) // one Digest answer, refused
      expect(nvr.requests.every((r) => r.includes('/status'))).toBe(true)
      for (let i = 0; i < 4; i++) {
        time.now += min(1)
        await checkCameras(d)
      }
      expect(failedLogins()).toBe(1)
      expect(rtsp.requests).toHaveLength(0)
      expect(db.results()).toHaveLength(0)
      time.now = START + min(15)
      await checkCameras(d)
      expect(failedLogins()).toBe(2)
      expect(rtsp.requests).toHaveLength(0)
    } finally {
      await nvr.close()
      await rtsp.close()
    }
  })
})
