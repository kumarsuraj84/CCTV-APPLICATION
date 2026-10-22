import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openStreams } from '@/lib/streams/open'
import { verifyStreamToken } from '@/lib/streams/token'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P4-L1 brief item 2 (bounded concurrency) and item 4 (stream opens recorded). The person's own open live streams are counted in the
// session registry (P2-4): a socket the gateway opened, not closed or revoked, and checked by the gateway within the last minute. A
// new opening may bring the person's DIFFERENT open streams up to LIVE_MAX_STREAMS_PER_USER (default 25); the cameras beyond that are
// answered as `paused` ("paused to save bandwidth" on the wall) and nothing is registered or signed for them. Streams the person
// already has open are renewals and never count twice. Every live session row records who, which camera, its location and recorder
// (NVR) at the time, main or sub (the stream name), when it was opened and when it ended. Loopback only: a fake go2rtc API; the
// "sockets" are opened in the registry the way the gateway does (media_session_open), no video is moved.

const SECRET = 'live-concurrency-secret-0123456789'
const admin = () => adminClient()
type Rpc = Parameters<ReturnType<typeof adminClient>['rpc']>[0]
const rpc = (fn: string, args: object) => admin().rpc(fn as Rpc, args as never) as unknown as PromiseLike<{ data: unknown; error: { message: string } | null }>

describe('live streams per person are bounded, and every opening is recorded (P4-L1)', () => {
  let orgId: string
  let site: Awaited<ReturnType<typeof createSite>>
  let viewer: TestUser
  let fake: FakeGo2rtc
  const savedSecret = process.env.STREAM_TOKEN_SECRET
  const opened: string[] = []

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgId = await createOrg()
    site = await createSite(orgId, { host: '127.0.0.1', rtspPort: 15561, httpPort: 16561, username: 'wall-viewer', secret: 'nvr-pass-wall', cameras: 6 })
    viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live'], ORG_SCOPE)
  })
  afterAll(async () => {
    for (const sid of opened) await rpc('media_session_close', { p_sid: sid })
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await cleanupOrg(orgId)
  })
  beforeEach(async () => {
    fake = await startFakeGo2rtc()
  })
  afterEach(async () => {
    await fake.close()
  })

  const open = (ids: string[], kind: 'sub' | 'main' = 'sub', max = '4') =>
    openStreams({ admin: admin(), rls: viewer.client, go2rtc: fake.client, env: { LIVE_MAX_STREAMS_PER_USER: max } }, { id: viewer.id, orgId }, ids, kind)
  /** What the gateway does when the browser's socket arrives with the token. */
  async function connect(token: string) {
    const c = verifyStreamToken(token, Date.now(), SECRET)!
    const stream = `cam_${c.c}_${c.k}`
    const { data, error } = await rpc('media_session_open', { p_sid: c.sid, p_user: c.u, p_camera: c.c, p_kind: 'live', p_stream: stream })
    expect(error).toBeNull()
    expect((data as { ok: boolean }[])[0].ok).toBe(true)
    opened.push(c.sid)
    return c.sid
  }
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error((r as unknown as { error: string }).error)
    return r as Extract<T, { ok: true }>
  }

  it('fills up to the limit; the cameras beyond it are paused, nothing is registered or signed for them', async () => {
    const [c1, c2, c3, c4, c5, c6] = site.cameraIds
    const first = ok(await open([c1, c2, c3]))
    expect(first.streams.map((s) => s.cameraId)).toEqual([c1, c2, c3])
    expect(first.paused ?? []).toEqual([])
    for (const s of first.streams) await connect(s.token)
    fake.seen.length = 0
    const second = ok(await open([c4, c5, c6]))
    expect(second.streams.map((s) => s.cameraId)).toEqual([c4])
    expect(second.paused).toEqual([c5, c6])
    expect(fake.seen.map((s) => s.name)).toEqual([`cam_${c4}_sub`]) // go2rtc is told about the one that fits only
  })

  it('the person\'s own open streams asked for again (the wall\'s renewal) never count twice', async () => {
    const [c1, c2, c3] = site.cameraIds
    const again = ok(await open([c1, c2, c3]))
    expect(again.streams.map((s) => s.cameraId)).toEqual([c1, c2, c3])
    expect(again.paused ?? []).toEqual([])
  })

  it('a stream that ends frees its place at once', async () => {
    const [c1, , , , c5] = site.cameraIds
    const { data } = await admin().from('media_sessions').select('id').eq('user_id', viewer.id).eq('camera_id', c1).not('opened_at', 'is', null).is('closed_at', null)
    for (const s of data ?? []) expect((await rpc('media_session_close', { p_sid: s.id })).error).toBeNull()
    const res = ok(await open([c5]))
    expect(res.streams.map((s) => s.cameraId)).toEqual([c5])
  })

  it('counts only sockets the gateway still checks: a session not seen within the window does not hold a place', async () => {
    const { data, error } = await rpc('media_sessions_live_open', { p_org: orgId, p_user: viewer.id })
    expect(error).toBeNull()
    expect((data as { stream: string }[]).map((r) => r.stream).sort()).toEqual([`cam_${site.cameraIds[1]}_sub`, `cam_${site.cameraIds[2]}_sub`].sort())
    await new Promise((r) => setTimeout(r, 1500))
    const fresh = await rpc('media_sessions_live_open', { p_org: orgId, p_user: viewer.id, p_fresh_sec: 1 })
    expect(fresh.error).toBeNull()
    expect(fresh.data).toEqual([])
  })

  it('without a setting the limit is 25, and a bad setting falls back to 25 (never unbounded, never zero)', async () => {
    const ids = site.cameraIds
    for (const max of ['', 'lots', '0', '-3']) {
      const res = ok(await open(ids, 'sub', max))
      expect(res.streams).toHaveLength(ids.length)
      expect(res.paused ?? []).toEqual([])
    }
  })

  it('each live session records who, the camera, its location and NVR, main or sub, opened and ended (stream opens are audited)', async () => {
    const c6 = site.cameraIds[5]
    const res = ok(await open([c6], 'main', '25'))
    const sid = await connect(res.streams[0].token)
    await rpc('media_session_close', { p_sid: sid })
    const { data, error } = await admin().from('media_sessions')
      .select('user_id, kind, capability, camera_id, location_id, recorder_id, stream, opened_at, closed_at').eq('id', sid).single()
    expect(error).toBeNull()
    expect(data).toMatchObject({ user_id: viewer.id, kind: 'live', capability: 'cctv.live', camera_id: c6, location_id: site.locationId, recorder_id: site.recorderId, stream: `cam_${c6}_main` })
    expect(data!.opened_at).not.toBeNull()
    expect(data!.closed_at).not.toBeNull()
    expect(Date.parse(data!.closed_at!)).toBeGreaterThanOrEqual(Date.parse(data!.opened_at!))
    // What goes to the browser holds no NVR address, login or password (AC-10).
    const text = JSON.stringify(res)
    for (const secret of ['127.0.0.1', '15561', 'wall-viewer', 'nvr-pass-wall', 'rtsp']) expect(text).not.toContain(secret)
  })
})
