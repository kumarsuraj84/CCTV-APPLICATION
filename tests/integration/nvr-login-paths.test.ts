import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { testRecorderConnection } from '@/lib/inventory/recorder-admin'
import { checkCameras, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { discoverRecorderCameras } from '@/lib/monitor/discovery'
import { MSG_LOGIN_BACKOFF } from '@/lib/monitor/login-backoff'
import { realProbes } from '@/lib/monitor/probes'
import { clearPasswordCache, SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { MSG_CAMERA_NOT_AVAILABLE, MSG_NVR_LOGIN_REFUSED } from '@/lib/nvr/login-guard'
import { openStreams } from '@/lib/streams/open'
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
    expect(s.logins()).toBeLessThanOrEqual(1)
    const st = await admin().from('nvr_login_state' as never).select('outcome').eq('recorder_id', s.recorderId).single()
    expect(st.data).toEqual({ outcome: s.logins() === 1 ? 'refused' : null })
  })

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
