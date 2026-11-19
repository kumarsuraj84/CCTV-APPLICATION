import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MSG_FAILED_OPEN, openStreams, releaseStreams, renewStreams } from '@/lib/streams/open'
import { verifyStreamToken } from '@/lib/streams/token'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { acceptingRtspProof } from '../helpers/fake-servers'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P4-L1 brief item 2 (bounded concurrency) and item 4 (stream opens recorded); review round 1, I-1.
// The per-person cap counts, in the database and under one lock per person, every live stream the person holds: a socket the gateway
// opened (and still checks) AND a token handed out that can still connect (its 90 s window). New streams are admitted in the wall's
// order up to LIVE_MAX_STREAMS_PER_USER (default 25); the rest are answered as `paused` — no session, no NVR password read, no go2rtc
// call. Streams the person already holds are renewals and count once (two windows on one camera are one stream). The cap applies to the
// one-minute token renewal too, and the gateway's open refuses (`limit`) a socket that would go above the cap, so neither a crafted
// renewal nor a copied token gets past it. A count that cannot be read opens nothing (fail closed). Every live session records who,
// camera, location, NVR, main or sub, opened and ended. Loopback only: a fake go2rtc API; sockets are opened in the registry the way the
// gateway does (media_session_open); no video moves and no NVR is contacted.

const SECRET = 'live-concurrency-secret-0123456789'
const admin = () => adminClient()
type Rpc = Parameters<ReturnType<typeof adminClient>['rpc']>[0]
const rpc = (fn: string, args: object) => admin().rpc(fn as Rpc, args as never) as unknown as PromiseLike<{ data: unknown; error: { message: string } | null }>

describe('live streams per person are bounded, and every opening is recorded (P4-L1)', () => {
  let orgId: string
  let site: Awaited<ReturnType<typeof createSite>>
  let fake: FakeGo2rtc
  const savedSecret = process.env.STREAM_TOKEN_SECRET
  const opened: string[] = []

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgId = await createOrg()
    site = await createSite(orgId, { host: '127.0.0.1', rtspPort: 15561, httpPort: 16561, username: 'wall-viewer', secret: 'nvr-pass-wall', cameras: 8 })
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

  async function viewer(): Promise<TestUser> {
    const u = await createUser(orgId, 'user')
    await grant(orgId, u.id, ['cctv.live'], ORG_SCOPE)
    return u
  }
  const env = (max: string) => ({ LIVE_MAX_STREAMS_PER_USER: max })
  const open = (u: TestUser, ids: string[], o: { kind?: 'sub' | 'main'; max?: string; release?: { cameraIds: string[]; kind: 'sub' | 'main' }[]; adminClient?: ReturnType<typeof admin>; client?: string } = {}) =>
    openStreams({ admin: o.adminClient ?? admin(), rls: u.client, go2rtc: fake.client, env: env(o.max ?? '4'), rtsp: acceptingRtspProof }, { id: u.id, orgId }, ids, o.kind ?? 'sub', { release: o.release, client: o.client })
  const renew = (u: TestUser, ids: string[], max = '4', client?: string) => renewStreams({ admin: admin(), rls: u.client, env: env(max) }, { id: u.id, orgId }, ids, 'sub', { client })
  /** What the gateway does when the browser's socket arrives with the token. */
  async function connect(token: string): Promise<{ ok: boolean; reason: string | null; sid: string }> {
    const c = verifyStreamToken(token, Date.now(), SECRET)!
    const { data, error } = await rpc('media_session_open', { p_sid: c.sid, p_user: c.u, p_camera: c.c, p_kind: 'live', p_stream: `cam_${c.c}_${c.k}` })
    expect(error).toBeNull()
    const row = (data as { ok: boolean; reason: string | null }[])[0]
    if (row.ok) opened.push(c.sid)
    return { ...row, sid: c.sid }
  }
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error((r as unknown as { error: string }).error)
    return r as Extract<T, { ok: true }>
  }

  it('fills up to the limit; the cameras beyond it are paused, nothing is registered or signed for them', async () => {
    const u = await viewer()
    const [c1, c2, c3, c4, c5, c6] = site.cameraIds
    const first = ok(await open(u, [c1, c2, c3]))
    expect(first.streams.map((s) => s.cameraId)).toEqual([c1, c2, c3])
    for (const s of first.streams) expect((await connect(s.token)).ok).toBe(true)
    fake.seen.length = 0
    const second = ok(await open(u, [c4, c5, c6]))
    expect(second.streams.map((s) => s.cameraId)).toEqual([c4])
    expect(second.paused).toEqual([c5, c6])
    expect(fake.seen.map((s) => s.name)).toEqual([`cam_${c4}_sub`]) // go2rtc is told about the one that fits only
  })

  it('I-1: tokens handed out but not used yet count too: two windows opening at the same moment get at most the limit together', async () => {
    const u = await viewer()
    const ids = site.cameraIds
    const [a, b, c] = await Promise.all([open(u, ids.slice(0, 3)), open(u, ids.slice(3, 6)), open(u, ids.slice(6, 8))])
    const tokens = [a, b, c].flatMap((r) => ok(r).streams)
    expect(tokens.length).toBe(4)
    expect(new Set(tokens.map((t) => t.cameraId)).size).toBe(4)
    // A later window without connecting anything in between: still nothing beyond the limit.
    const d = ok(await open(u, ids.slice(0, 8)))
    expect(d.streams.map((s) => s.cameraId).sort()).toEqual(tokens.map((t) => t.cameraId).sort()) // only the ones already held
  })

  it('I-1: a reconnect storm (the same cameras asked for many times at once) counts each camera once', async () => {
    const u = await viewer()
    const ids = site.cameraIds.slice(0, 3)
    const all = await Promise.all(Array.from({ length: 10 }, () => open(u, ids)))
    for (const r of all) expect(ok(r).streams.map((s) => s.cameraId)).toEqual(ids)
    const { data } = await rpc('media_sessions_live_open', { p_org: orgId, p_user: u.id })
    expect((data as { stream: string }[]).length).toBe(3)
  })

  it('I-1: the one-minute token renewal is capped too: renewing held streams works, a crafted renewal for others gets nothing', async () => {
    const u = await viewer()
    const ids = site.cameraIds
    ok(await open(u, ids.slice(0, 4)))
    const held = ok(await renew(u, ids.slice(0, 4)))
    expect(held.tokens.map((t) => t.cameraId)).toEqual(ids.slice(0, 4))
    const crafted = ok(await renew(u, ids.slice(4, 8)))
    expect(crafted.tokens).toEqual([])
    expect(crafted.paused).toEqual(ids.slice(4, 8))
  })

  it('I-1: the gateway refuses a socket above the limit even when the token got past it (a false "release"): the database decides', async () => {
    const u = await viewer()
    const [c1, c2] = site.cameraIds
    const first = ok(await open(u, [c1], { max: '1' }))
    expect((await connect(first.streams[0].token)).ok).toBe(true)
    // A client that says it let go of c1 (it did not: the socket is open) gets a token for c2 ...
    const lie = ok(await open(u, [c2], { max: '1', release: [{ cameraIds: [c1], kind: 'sub' }] }))
    expect(lie.streams).toHaveLength(1)
    // ... but the gateway's open counts the sockets really open: refused, and the token is not used up (it may try again later).
    const refused = await connect(lie.streams[0].token)
    expect(refused).toMatchObject({ ok: false, reason: 'limit' })
    const row = await admin().from('media_sessions').select('opened_at, revoked_at').eq('id', refused.sid).single()
    expect(row.data).toEqual({ opened_at: null, revoked_at: null })
    // Sessions made by the older call without a limit are held to the default (25): one more socket is fine here.
    const made = await rpc('media_session_create', { p_org: orgId, p_user: u.id, p_kind: 'live', p_cameras: [c2], p_streams: [`cam_${c2}_sub`] })
    const plain = (made.data as { camera_id: string; sid: string }[])[0]
    const r = await rpc('media_session_open', { p_sid: plain.sid, p_user: u.id, p_camera: c2, p_kind: 'live', p_stream: `cam_${c2}_sub` })
    expect((r.data as { ok: boolean }[])[0].ok).toBe(true)
    opened.push(plain.sid)
  })

  it('a page change releases the old page: its unused tokens stop counting and can no longer connect', async () => {
    const u = await viewer()
    const ids = site.cameraIds
    const page1 = ok(await open(u, ids.slice(0, 4)))
    const page2 = ok(await open(u, ids.slice(4, 8), { release: [{ cameraIds: ids.slice(0, 4), kind: 'sub' }] }))
    expect(page2.streams.map((s) => s.cameraId)).toEqual(ids.slice(4, 8))
    expect(page2.paused ?? []).toEqual([])
    const late = await connect(page1.streams[0].token)
    expect(late).toMatchObject({ ok: false, reason: 'released' })
  })

  it('a stream that ends frees its place at once', async () => {
    const u = await viewer()
    const [c1, c2] = site.cameraIds
    const r = ok(await open(u, [c1], { max: '1' }))
    const s = await connect(r.streams[0].token)
    expect(ok(await open(u, [c2], { max: '1' })).streams).toEqual([])
    expect((await rpc('media_session_close', { p_sid: s.sid })).error).toBeNull()
    const next = ok(await open(u, [c2], { max: '1' }))
    expect(next.streams.map((x) => x.cameraId)).toEqual([c2])
  })

  it('counts only sockets the gateway still checks and tokens that can still connect', async () => {
    const u = await viewer()
    const [c1] = site.cameraIds
    const r = ok(await open(u, [c1]))
    await connect(r.streams[0].token)
    const { data } = await rpc('media_sessions_live_open', { p_org: orgId, p_user: u.id })
    expect((data as { stream: string }[]).map((x) => x.stream)).toEqual([`cam_${c1}_sub`])
    await new Promise((x) => setTimeout(x, 1500))
    const fresh = await rpc('media_sessions_live_open', { p_org: orgId, p_user: u.id, p_fresh_sec: 1 })
    // The open socket is no longer "fresh" after 1 s without a check; its token's connect window (90 s) has not passed, but it was used.
    expect(fresh.data).toEqual([])
  })

  // Re-review N-1: a wall watched for more than a minute leaves the renewal tokens of its last minute unused. Leaving it releases them
  // (the page's leave, or the next wall's first request), so the next wall with other cameras opens whole and the person's count never
  // goes above the cap.
  describe('leaving a wall and opening another (re-review N-1)', () => {
    let big: Awaited<ReturnType<typeof createSite>>
    beforeAll(async () => {
      big = await createSite(orgId, { host: '127.0.0.1', rtspPort: 15562, httpPort: 16562, username: 'wall-viewer-2', secret: 'nvr-pass-wall-2', cameras: 32 })
    })
    const W = '7d6f9a1e-4b1c-4a5e-9c2d-111111111111'
    const held = async (u: TestUser) => ((await rpc('media_sessions_live_open', { p_org: orgId, p_user: u.id })).data as { stream: string }[]).length

    it('wall A (4×4) for over a minute, leave (released), wall B with other cameras: all of B opens, never above the cap', async () => {
      const u = await viewer()
      const a = big.cameraIds.slice(0, 16)
      const b = big.cameraIds.slice(16, 32)
      const first = ok(await open(u, a, { max: '25', client: W }))
      for (const s of first.streams) await connect(s.token)
      const renewal = ok(await renew(u, a, '25', W)) // the one-minute renewal: 16 more tokens, unused
      expect(await held(u)).toBe(16)
      // Leaving the page: the wall's sockets close and it hands back the tokens it holds (pagehide / unmount).
      const { data } = await admin().from('media_sessions').select('id').eq('user_id', u.id).not('opened_at', 'is', null).is('closed_at', null)
      for (const s of data ?? []) await rpc('media_session_close', { p_sid: s.id })
      const released = ok(await releaseStreams({ admin: admin() }, { id: u.id, orgId }, renewal.tokens.map((t) => t.token)))
      expect(released.released).toBe(16)
      expect(await held(u)).toBe(0)
      const next = ok(await open(u, b, { max: '25', client: W }))
      expect(next.streams).toHaveLength(16)
      expect(next.paused ?? []).toEqual([])
      expect(await held(u)).toBeLessThanOrEqual(25)
    })

    it('the same without the leave release: the next wall\'s first request releases the previous wall (kept per page), all of B opens', async () => {
      const u = await viewer()
      const a = big.cameraIds.slice(0, 16)
      const b = big.cameraIds.slice(16, 32)
      ok(await open(u, a, { max: '25', client: W }))
      ok(await renew(u, a, '25', W))
      const next = ok(await open(u, b, { max: '25', client: W, release: [{ cameraIds: a, kind: 'sub' }] }))
      expect(next.streams).toHaveLength(16)
      expect(await held(u)).toBe(16)
    })

    it('without any release the old tokens would hold places (why the wall releases)', async () => {
      const u = await viewer()
      ok(await open(u, big.cameraIds.slice(0, 16), { max: '25', client: W }))
      const next = ok(await open(u, big.cameraIds.slice(16, 32), { max: '25', client: W }))
      expect(next.streams).toHaveLength(9)
      expect(next.paused).toHaveLength(7)
    })

    it('re-review N-5: what a tour step costs — a first visit is a full opening, a revisit within 8 minutes only new tokens (measured)', async () => {
      const u = await viewer()
      const page = big.cameraIds.slice(0, 16)
      const calls: string[] = []
      const real = admin()
      const spy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'rpc') return (fn: string, args: object) => { calls.push(fn); return (target.rpc as (f: string, a: object) => unknown)(fn, args) }
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      }) as ReturnType<typeof admin>
      const time = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return performance.now() - t }
      fake.seen.length = 0
      const fullMs = await time(() => openStreams({ admin: spy, rls: u.client, go2rtc: fake.client, env: env('25'), rtsp: acceptingRtspProof }, { id: u.id, orgId }, page, 'sub', { client: W }))
      const fullCalls = [...calls]
      const go2rtcFull = fake.seen.length
      calls.length = 0
      fake.seen.length = 0
      const renewMs = await time(() => renewStreams({ admin: spy, rls: u.client, env: env('25') }, { id: u.id, orgId }, page, 'sub', { client: W }))
      // One NVR: one login state question (final fix X, NB-2; asked first since round 2, NB-9), one login read, and the outcome of the
      // one RTSP proof when one was due.
      expect(fullCalls.filter((c) => c !== 'nvr_login_report')).toEqual(['nvr_login_gate', 'media_session_create_live', 'recorder_credential_read'])
      expect(fullCalls.filter((c) => c === 'nvr_login_report').length).toBeLessThanOrEqual(1)
      expect(go2rtcFull).toBeGreaterThanOrEqual(16)
      expect(calls).toEqual(['media_session_create_live'])
      expect(fake.seen).toEqual([])
      // The action adds one audit row (cctv_live_opened) to a full opening only (lib/actions/streams.ts).
      console.log(JSON.stringify({ tour_step_cost: { cameras: 16, full_open_ms: Math.round(fullMs), full_open_db_calls: fullCalls.length, full_open_go2rtc_calls: go2rtcFull, audit_rows: 1, token_renewal_ms: Math.round(renewMs), token_renewal_db_calls: calls.length } }))
    })

    it('re-review N-6: a release from one window never revokes another window\'s unused token for the same camera', async () => {
      const u = await viewer()
      const [c1] = big.cameraIds
      const W2 = '7d6f9a1e-4b1c-4a5e-9c2d-222222222222'
      const one = ok(await open(u, [c1], { max: '25', client: W }))
      const two = ok(await open(u, [c1], { max: '25', client: W2 }))
      ok(await releaseStreams({ admin: admin() }, { id: u.id, orgId }, [one.streams[0].token]))
      expect(await connect(one.streams[0].token)).toMatchObject({ ok: false, reason: 'released' })
      expect((await connect(two.streams[0].token)).ok).toBe(true)
    })

    it('re-review N-6: the next request\'s release (p_release) of one window leaves another window\'s token for that camera alone', async () => {
      const u = await viewer()
      const [c1, c2] = big.cameraIds
      const W2 = '7d6f9a1e-4b1c-4a5e-9c2d-333333333333'
      const one = ok(await open(u, [c1], { max: '25', client: W }))
      const two = ok(await open(u, [c1], { max: '25', client: W2 }))
      ok(await open(u, [c2], { max: '25', client: W, release: [{ cameraIds: [c1], kind: 'sub' }] }))
      expect(await connect(one.streams[0].token)).toMatchObject({ ok: false, reason: 'released' })
      expect((await connect(two.streams[0].token)).ok).toBe(true)
    })

    it('a leave release ignores tokens of other people, forged ones and junk (it names sessions only through the person\'s own signed tokens)', async () => {
      const u = await viewer()
      const other = await viewer()
      const [c1] = big.cameraIds
      const theirs = ok(await open(other, [c1], { max: '25', client: W }))
      const mine = ok(await open(u, [c1], { max: '25', client: W }))
      const forged = `${mine.streams[0].token.split('.')[0]}.AAAA`
      const r = ok(await releaseStreams({ admin: admin() }, { id: u.id, orgId }, [theirs.streams[0].token, forged, 'junk', 42]))
      expect(r.released).toBe(0)
      expect((await connect(theirs.streams[0].token)).ok).toBe(true)
      expect((await connect(mine.streams[0].token)).ok).toBe(true)
    })
  })

  it('fails closed: when the count cannot be read nothing is opened, with a plain message', async () => {
    const u = await viewer()
    const real = admin()
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') return (fn: string, args: object) => (fn === 'media_session_create_live' ? Promise.resolve({ data: null, error: { message: 'down', code: '57P01' } }) : (target.rpc as (f: string, a: object) => unknown)(fn, args))
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as ReturnType<typeof admin>
    fake.seen.length = 0
    expect(await open(u, site.cameraIds.slice(0, 2), { adminClient: failing })).toEqual({ ok: false, error: MSG_FAILED_OPEN })
    expect(fake.seen).toEqual([])
  })

  it('without a setting the limit is 25, and a bad setting falls back to 25 (never unbounded, never zero)', async () => {
    const ids = site.cameraIds
    for (const max of ['', 'lots', '0', '-3']) {
      const u = await viewer()
      const res = ok(await open(u, ids, { max }))
      expect(res.streams).toHaveLength(ids.length)
      expect(res.paused ?? []).toEqual([])
    }
  })

  it('each live session records who, the camera, its location and NVR, main or sub, opened and ended (stream opens are audited)', async () => {
    const u = await viewer()
    const c6 = site.cameraIds[5]
    const res = ok(await open(u, [c6], { kind: 'main', max: '25' }))
    const { sid } = await connect(res.streams[0].token)
    await rpc('media_session_close', { p_sid: sid })
    const { data, error } = await admin().from('media_sessions')
      .select('user_id, kind, capability, camera_id, location_id, recorder_id, stream, opened_at, closed_at, stream_cap').eq('id', sid).single()
    expect(error).toBeNull()
    expect(data).toMatchObject({ user_id: u.id, kind: 'live', capability: 'cctv.live', camera_id: c6, location_id: site.locationId, recorder_id: site.recorderId, stream: `cam_${c6}_main`, stream_cap: 25 })
    expect(data!.opened_at).not.toBeNull()
    expect(data!.closed_at).not.toBeNull()
    expect(Date.parse(data!.closed_at!)).toBeGreaterThanOrEqual(Date.parse(data!.opened_at!))
    // What goes to the browser holds no NVR address, login or password (AC-10).
    const text = JSON.stringify(res)
    for (const secret of ['127.0.0.1', '15561', 'wall-viewer', 'nvr-pass-wall', 'rtsp']) expect(text).not.toContain(secret)
  })
})
