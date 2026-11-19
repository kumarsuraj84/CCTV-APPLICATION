import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { testRecorderConnection } from '@/lib/inventory/recorder-admin'
import { checkCameras, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { discoverRecorderCameras } from '@/lib/monitor/discovery'
import { MSG_LOGIN_BACKOFF } from '@/lib/monitor/login-backoff'
import { realProbes } from '@/lib/monitor/probes'
import { clearPasswordCache, SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { MSG_CAMERA_NOT_AVAILABLE, MSG_NVR_LOGIN_CHECKING, MSG_NVR_LOGIN_REFUSED } from '@/lib/nvr/login-guard'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { openStreams } from '@/lib/streams/open'
import { openPlayback } from '@/lib/streams/playback'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { startFakeNvr, startFakeRtsp, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'
import { adminClient, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createSite, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'
import { testFence } from '../setup/lease'

// Final fix X (release 1 review C I-1, I-2, I-3; rulings NB-1, NB-2): every path that logs in to an NVR shares ONE back-off in the
// database. A fake NVR (ISAPI on one port, RTSP on another, both on loopback) counts every login answer it receives; with a wrong saved
// password each of them is a failed login, which is what locks a Hikvision account. Nothing real is contacted.

const admin = () => adminClient()
const SECRET = 'integration-test-stream-secret-0123456789'
const RIGHT = 'right-pass-1'

describe('the shared NVR login back-off across every path', () => {
  let orgId: string
  let it_admin: TestUser
  let viewer: TestUser
  let actor: Actor
  let fake: FakeGo2rtc
  const servers: (FakeNvr | FakeRtsp)[] = []
  const saved = process.env.STREAM_TOKEN_SECRET

  /** One NVR on loopback with 16 cameras, its real password RIGHT, the saved one `saved`. */
  async function nvrSite(saved: string, o: { mode?: 'ok' | 'forbidden' } = {}) {
    const nvr = await startFakeNvr({ username: 'viewer', password: RIGHT, mode: o.mode, statuses: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, false])) })
    const rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: RIGHT })
    servers.push(nvr, rtsp)
    const s = await createSite(orgId, { host: '127.0.0.1', httpPort: nvr.port, rtspPort: rtsp.port, username: 'viewer', secret: saved, cameras: 16 })
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(s.locationId))
    /** Login answers the NVR received (each Authorization header is one login; with a wrong password each is a refused one). */
    const logins = () => nvr.authorizations.length + rtsp.authorizations.length
    return { ...s, nvr, rtsp, logins }
  }
  const wall = (u: TestUser, ids: string[]) => openStreams({ admin: admin(), rls: u.client, go2rtc: fake.client, env: {} }, { id: u.id, orgId }, ids, 'sub')
  const worker = async (): Promise<Deps> => ({ db: new SupabaseMonitorDb(admin(), { orgId, fence: await testFence() }), probes: realProbes, cfg: loadMonitorConfig({}), clock: () => new Date() })

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgId = await createOrg()
    it_admin = await createUser(orgId, 'admin')
    await grant(orgId, it_admin.id, [...READ_EVERYTHING, 'admin.inventory'])
    viewer = await createUser(orgId, 'user')
    actor = { id: it_admin.id, orgId, role: 'admin' }
    fake = await startFakeGo2rtc()
  })
  beforeEach(() => clearPasswordCache())
  afterAll(async () => {
    if (saved === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = saved
    await fake.close()
    for (const s of servers) await s.close()
    await cleanupOrg(orgId)
  })

  it('a wall of 16 tiles, opened by two people at once, costs ONE refused login and registers no go2rtc source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = await nvrSite('wrong-pass')
    fake.seen.length = 0
    const [a, b] = await Promise.all([wall(viewer, s.cameraIds), wall(it_admin, s.cameraIds)])
    vi.restoreAllMocks()
    expect(s.logins()).toBe(1)
    expect(fake.seen.filter((x) => x.method === 'PUT')).toEqual([])
    // Plain words on every tile: the NVR detail for the IT view, camera terms for the CCTV-only viewer (the one whose request lost
    // the race may still be waiting for the answer: then it gets no token either, and the wall asks again in 30 s).
    for (const [res, words] of [[a, MSG_CAMERA_NOT_AVAILABLE], [b, MSG_NVR_LOGIN_REFUSED]] as const) {
      expect(res.ok && res.streams).toEqual([])
      if (res.ok && res.unavailable) expect(new Set(res.unavailable.map((u) => u.message))).toEqual(new Set([words]))
    }
    // The wall asks again (every 30 s): still nothing is sent to the NVR, and now both get their words at once.
    const again = await wall(viewer, s.cameraIds)
    expect(again.ok && again.unavailable?.map((u) => u.cameraId).sort()).toEqual([...s.cameraIds].sort())
    expect(again.ok && again.unavailable?.[0].message).toBe(MSG_CAMERA_NOT_AVAILABLE)
    // Every other path leaves it alone too: the worker (also a restarted one), "Find cameras", the connection test.
    await checkCameras(await worker(), undefined, [s.recorderId])
    await checkCameras(await worker(), undefined, [s.recorderId])
    expect(await discoverRecorderCameras({ admin: admin(), rls: it_admin.client }, actor, s.recorderId)).toEqual({ ok: false, error: MSG_LOGIN_BACKOFF })
    expect(await testRecorderConnection({ admin: admin(), rls: it_admin.client }, actor, s.recorderId)).toEqual({ ok: false, error: MSG_LOGIN_BACKOFF })
    expect(s.logins()).toBe(1)
  })

  it('the worker, "Find cameras" and a wall racing for a login never proven: at most ONE refused login between them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = await nvrSite('wrong-pass')
    await Promise.all([
      checkCameras(await worker(), undefined, [s.recorderId]),
      discoverRecorderCameras({ admin: admin(), rls: it_admin.client }, actor, s.recorderId),
      testRecorderConnection({ admin: admin(), rls: it_admin.client }, actor, s.recorderId),
      wall(it_admin, s.cameraIds),
      wall(viewer, s.cameraIds),
    ])
    vi.restoreAllMocks()
    // Round 2 (review M-9): exactly one: the claim lets one path try, and its refusal keeps every other path away.
    expect(s.logins()).toBe(1)
    const st = await admin().from('nvr_login_state' as never).select('outcome').eq('recorder_id', s.recorderId).single()
    expect(st.data).toEqual({ outcome: 'refused' })
  })

  // Round 2 (review I-1; ruling NB-7): a proof that gets no answer (a slow or hung NVR) does not open the wall: at most ONE go2rtc
  // source (the one claimed attempt) until a login is proven; the other tiles say "Camera not available." and are asked for again later.
  it('a slow NVR with a wrong password: 16 tiles from two people at once register at most one source and cost at most one login', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rtsp = await startFakeRtsp('silent')
    servers.push(rtsp)
    const s = await createSite(orgId, { host: '127.0.0.1', httpPort: 1, rtspPort: rtsp.port, username: 'viewer', secret: 'wrong-pass', cameras: 16 })
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(s.locationId))
    const other = await createUser(orgId, 'user')
    await grant(orgId, other.id, CCTV_VIEW, atLocation(s.locationId))
    fake.seen.length = 0
    const [a, b] = await Promise.all([wall(viewer, s.cameraIds), wall(other, s.cameraIds)])
    vi.restoreAllMocks()
    const puts = fake.seen.filter((x) => x.method === 'PUT' && s.cameraIds.some((c) => x.name?.includes(c)))
    expect(puts.length).toBeLessThanOrEqual(1)
    expect(rtsp.authorizations.length).toBeLessThanOrEqual(1)
    const opened = [a, b].flatMap((r) => (r.ok ? r.streams : []))
    expect(opened.length).toBeLessThanOrEqual(1)
    for (const r of [a, b]) {
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.streams.length + (r.unavailable?.length ?? 0)).toBe(16) // every tile is told something
      expect(new Set(r.unavailable?.map((u) => u.message))).toEqual(new Set([MSG_CAMERA_NOT_AVAILABLE]))
    }
  }, 30_000)

  // Round 2 (review M-1): cameras that are not opened (their NVR's login stands refused) never take a place under the stream cap.
  it('refused cameras do not crowd out good ones under the stream cap, however often the wall asks again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bad = await nvrSite('wrong-pass')
    const good = await nvrSite(RIGHT)
    const watcher = await createUser(orgId, 'user')
    await grant(orgId, watcher.id, CCTV_VIEW, [atLocation(bad.locationId), atLocation(good.locationId)])
    const capped = (ids: string[]) => openStreams({ admin: admin(), rls: watcher.client, go2rtc: fake.client, env: { LIVE_MAX_STREAMS_PER_USER: '16' } }, { id: watcher.id, orgId }, ids, 'sub')
    const ids = [...bad.cameraIds.slice(0, 10), ...good.cameraIds.slice(0, 10)]
    await capped(bad.cameraIds.slice(0, 10)) // the wall's first opening finds the bad NVR's login refused
    for (let round = 0; round < 3; round++) {
      const res = await capped(ids)
      vi.restoreAllMocks()
      expect(res.ok).toBe(true)
      if (!res.ok) continue
      expect(res.streams.map((x) => x.cameraId).sort()).toEqual(good.cameraIds.slice(0, 10).sort())
      expect(res.paused ?? []).toEqual([])
      expect(res.unavailable?.map((u) => u.cameraId).sort()).toEqual(bad.cameraIds.slice(0, 10).sort())
    }
    expect(bad.logins()).toBe(1)
  })

  // Round 2 (review M-6): while another path holds the attempt, or the state cannot be read, the tiles say so plainly.
  it('while another path is checking the login, the wall lists the cameras as "being checked" (IT view) or not available', async () => {
    const s = await nvrSite('wrong-pass')
    const held = await admin().rpc('nvr_login_gate' as never, { p_recorders: [s.recorderId], p_path: 'monitoring' } as never)
    expect(((held.data as unknown as { claimed: boolean }[])[0]).claimed).toBe(true)
    const [it, cctv] = await Promise.all([wall(it_admin, s.cameraIds), wall(viewer, s.cameraIds)])
    expect(it.ok && new Set(it.unavailable?.map((u) => u.message))).toEqual(new Set([MSG_NVR_LOGIN_CHECKING]))
    expect(cctv.ok && new Set(cctv.unavailable?.map((u) => u.message))).toEqual(new Set([MSG_CAMERA_NOT_AVAILABLE]))
    expect(s.logins()).toBe(0)
  }, 30_000)

  // Round 2 (review M-5): an attempt claimed by a path that then sent nothing (go2rtc not answering) is given back at once.
  it('1x playback that could not register its stream gives the claimed attempt back (no minute of "being checked")', async () => {
    const rtsp = await startFakeRtsp('silent')
    servers.push(rtsp)
    const s = await createSite(orgId, { host: '127.0.0.1', httpPort: 1, rtspPort: rtsp.port, username: 'viewer', secret: 'any-pass', cameras: 1 })
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(s.locationId))
    const res = await openPlayback({ admin: admin(), rls: viewer.client, go2rtc: new Go2rtcClient('http://127.0.0.1:1'), env: {} }, { id: viewer.id, orgId }, s.cameraIds[0], new Date(Date.now() - 3_600_000), 5, 0)
    expect(res).toEqual({ ok: false, error: 'The video server is not available.' })
    const g = (await admin().rpc('nvr_login_gate' as never, { p_recorders: [s.recorderId], p_path: 'monitoring', p_claim: false } as never)).data as unknown as { decision: string }[]
    expect(g[0].decision).toBe('probe') // not 'wait': nothing holds the attempt
    expect(rtsp.authorizations).toHaveLength(0)
  }, 30_000)

  it('a corrected password ends the back-off at once: the wall opens all 16 with no further refused login', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = await nvrSite('wrong-pass')
    // A person of their own: the media sessions of the walls above still count against the stream cap for 90 s.
    const watcher = await createUser(orgId, 'user')
    await grant(orgId, watcher.id, CCTV_VIEW, atLocation(s.locationId))
    await wall(watcher, s.cameraIds)
    expect(s.logins()).toBe(1)
    expect((await admin().rpc('recorder_store_credential', { p_recorder: s.recorderId, p_secret: RIGHT })).error).toBeNull()
    fake.seen.length = 0
    const res = await wall(watcher, s.cameraIds)
    vi.restoreAllMocks()
    expect(res.ok && res.streams).toHaveLength(16)
    expect(res.ok && res.unavailable).toBeUndefined()
    expect(fake.seen.filter((x) => x.method === 'PUT')).toHaveLength(16)
    // The proof was one RTSP login with the right password (a challenge answered once); nothing refused since.
    const st = await admin().from('nvr_login_state' as never).select('outcome, level').eq('recorder_id', s.recorderId).single()
    expect(st.data).toEqual({ outcome: 'ok', level: 0 })
  })

  it('"forbidden" (a viewer account) is not a refused login: the worker checks by RTSP, writes results, no back-off (I-3)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = await nvrSite(RIGHT, { mode: 'forbidden' })
    await checkCameras(await worker(), undefined, [s.recorderId])
    await checkCameras(await worker(), undefined, [s.recorderId])
    vi.restoreAllMocks()
    const st = await admin().from('nvr_login_state' as never).select('outcome, level').eq('recorder_id', s.recorderId).single()
    expect(st.data).toEqual({ outcome: 'ok', level: 0 })
    const states = await admin().from('check_state').select('status').in('target_id', s.cameraIds)
    expect(states.data).toHaveLength(16)
    expect(states.data?.every((x) => x.status === 'up')).toBe(true)
  })

  it('a wrong password ("unauthorized") on the same kind of NVR: one refused login, no results, the back-off', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = await nvrSite('wrong-pass', { mode: 'forbidden' })
    for (let i = 0; i < 3; i++) await checkCameras(await worker(), undefined, [s.recorderId])
    vi.restoreAllMocks()
    expect(s.logins()).toBe(1)
    expect(s.rtsp.authorizations).toHaveLength(0)
    expect((await admin().from('check_state').select('status').in('target_id', s.cameraIds)).data).toEqual([])
  })
})
