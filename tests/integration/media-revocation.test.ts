import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { applyChange, previewChange } from '@/lib/admin/access'
import type { Actor } from '@/lib/admin/types'
import { resetUserPassword, updateUser } from '@/lib/admin/users'
import { createGateway, type GatewayServer } from '@/lib/streams/gateway'
import { openStreams } from '@/lib/streams/open'
import { createRestRegistry, type RegistryClient } from '@/lib/streams/registry'
import { signStreamToken, verifyStreamToken } from '@/lib/streams/token'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { openSocket, startFakeGo2rtcWs, waitFor, type FakeGo2rtcWs, type Outcome } from '../helpers/fake-go2rtc-ws'
import {
  ADMINISTRATOR_SET, adminClient, atCamera, atCluster, atLocation, atRecorder, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder,
  createRegion, createUser, grant, mapCamera, ORG_SCOPE, type GrantScope, type TestUser,
} from '../setup/fixtures'

// P2-4 acceptance (brief item 6, directive AC-14, CC-10): the real local database (the registry), the real gateway with its REST
// registry client and the service key of the local stack, a fake go2rtc (registration API + video socket) and ws clients. Real time,
// with a 2 second check interval (production: 15 s, asserted in gateway-sessions.test.ts). Every case measures the time from the
// access change to the socket's close and prints it (media_revocation_ms). Loopback only: no NVR or camera is ever contacted.

const SECRET = 'media-revocation-secret-0123456789'
const APP = 'http://app.test:3212'
const CHECK_MS = 2000
const BOUND_MS = 25_000
const admin = () => adminClient()
// Final fix X round 2 (NB-7): nothing listens on these NVRs' RTSP port, and an NVR whose one RTSP proof gets no answer gets one source
// only; these tests are about access, so the proof is a fake NVR that accepts the login after the Digest exchange.
const acceptingNvr = async () => ({ code: 200, authSent: true })

describe('open video stops when access goes (P2-4 acceptance)', () => {
  let orgId: string
  let region: string, c1: string, c2: string, L1: string, L2: string, R1: string, R2: string, R3: string
  let cam1: string, cam2: string, cam3: string, cam4: string
  let owner: TestUser, actor: Actor
  let api: FakeGo2rtc, video: FakeGo2rtcWs
  let gateway: GatewayServer, port: number
  const savedSecret = process.env.STREAM_TOKEN_SECRET
  const latencies: Record<string, number> = {}
  const sockets: WebSocket[] = []

  function restRegistry(): RegistryClient {
    return createRestRegistry({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY! })
  }
  async function startGateway(registry: RegistryClient, o: { autoValidate?: boolean } = {}) {
    const g = createGateway({ go2rtcUrl: video.url, secret: SECRET, allowedOrigins: [APP], registry, validateEveryMs: CHECK_MS, autoValidate: o.autoValidate ?? true, maxSockets: 400, maxSocketsPerIp: 400, maxUpgradesPerMinute: 2000 })
    const p = await new Promise<number>((resolve) => g.listen(0, '127.0.0.1', () => resolve((g.address() as AddressInfo).port)))
    return { g, p }
  }
  /** The person opens live video of these cameras the application's way, and connects a socket for each through the gateway. */
  async function watch(u: TestUser, cameras: string[], at = port) {
    const res = await openStreams({ admin: admin(), rls: u.client, go2rtc: api.client, env: {}, rtsp: acceptingNvr }, { id: u.id, orgId }, cameras, 'sub')
    if (!res.ok) throw new Error(res.error)
    expect(res.streams.map((s) => s.cameraId).sort()).toEqual([...cameras].sort())
    const opened = res.streams.map((s) => {
      const c = openSocket(`ws://127.0.0.1:${at}/g/ws?token=${encodeURIComponent(s.token)}`, APP)
      sockets.push(c.ws)
      return { camera: s.cameraId, token: s.token, ...c }
    })
    expect(await Promise.all(opened.map((x) => x.opened))).toEqual(opened.map(() => true))
    await waitFor(() => opened.every((x) => x.ws.readyState === WebSocket.OPEN), 3000, 'sockets to open')
    await new Promise((r) => setTimeout(r, 150)) // the registry has answered and go2rtc is connected
    for (const x of opened) expect(x.ws.readyState, 'still open after the registry answered').toBe(WebSocket.OPEN)
    return opened
  }
  /** Closes within the bound with 4403; records the time from `since`. */
  async function closesFor(name: string, s: { closed: Promise<Outcome> }, since: number) {
    const r = await Promise.race([s.closed, new Promise<Outcome>((resolve) => setTimeout(() => resolve({ error: 'still open after 25 s' }), BOUND_MS))])
    const ms = Date.now() - since
    expect(r, name).toEqual({ code: 4403, reason: 'Access changed' })
    expect(ms, name).toBeLessThan(BOUND_MS)
    latencies[name] = ms
  }
  const stillOpen = (s: { ws: WebSocket }) => expect(s.ws.readyState).toBe(WebSocket.OPEN)
  const viewer = async (role: 'user' | 'admin', caps: string | readonly string[], scopes: GrantScope | GrantScope[], o: { validUntil?: string } = {}) => {
    const u = await createUser(orgId, role)
    const ids = await grant(orgId, u.id, caps, scopes, o)
    return { u, ids }
  }

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgId = await createOrg()
    region = await createRegion(orgId)
    c1 = await createCluster(orgId, region)
    c2 = await createCluster(orgId, region)
    L1 = await createLocation(orgId, { clusterId: c1 })
    L2 = await createLocation(orgId)
    // Loopback NVR addresses with DEMO_VIDEO off: openStreams builds RTSP addresses for the fake go2rtc API, which never dials them.
    R1 = await createRecorder(orgId, L1, { host: '127.0.0.1', httpPort: 16541, rtspPort: 15541, secret: 'nvr-pass-1' })
    R2 = await createRecorder(orgId, L1, { host: '127.0.0.1', httpPort: 16542, rtspPort: 15542, secret: 'nvr-pass-2' })
    R3 = await createRecorder(orgId, L2, { host: '127.0.0.1', httpPort: 16543, rtspPort: 15543, secret: 'nvr-pass-3' })
    cam1 = await createCamera(orgId, { locationId: L1, recorderId: R1, channel: 1 })
    cam2 = await createCamera(orgId, { locationId: L1, recorderId: R1, channel: 2 })
    cam3 = await createCamera(orgId, { locationId: L1, recorderId: R2, channel: 1 })
    cam4 = await createCamera(orgId, { locationId: L2, recorderId: R3, channel: 1 })
    owner = await createUser(orgId, 'platform_owner')
    await grant(orgId, owner.id, ADMINISTRATOR_SET)
    actor = { id: owner.id, orgId, role: 'platform_owner' }
    api = await startFakeGo2rtc()
    video = await startFakeGo2rtcWs()
    ;({ g: gateway, p: port } = await startGateway(restRegistry()))
  })
  afterAll(async () => {
    sockets.forEach((s) => s.terminate())
    await gateway?.shutdown(1000)
    await api?.close()
    await video?.close()
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await cleanupOrg(orgId)
    console.log(JSON.stringify({ media_revocation_ms: latencies, checkEveryMs: CHECK_MS }))
  })
  let bystander: TestUser
  let theirs: Awaited<ReturnType<typeof watch>>
  beforeEach(async () => {
    // (d) Another person watching the same cameras the whole time: never affected.
    bystander = (await viewer('user', 'cctv.live', ORG_SCOPE)).u
    theirs = await watch(bystander, [cam1, cam3, cam4])
  })
  afterEach(() => {
    for (const s of theirs) stillOpen(s)
  })

  it('(a) removing a grant closes the socket with 4403 within 25 s; (b) a token issued before cannot open a new socket (1008)', async () => {
    const { u, ids } = await viewer('user', 'cctv.live', [atCamera(cam1), atCamera(cam4)])
    const [s1, s4] = await watch(u, [cam1, cam4])
    const spare = await openStreams({ admin: admin(), rls: u.client, go2rtc: api.client, env: {}, rtsp: acceptingNvr }, { id: u.id, orgId }, [cam1], 'sub')
    if (!spare.ok) throw new Error(spare.error)
    const t0 = Date.now()
    expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [ids[0]], p_reason: 'test: camera taken away' })).error).toBeNull()
    await closesFor('grant_removed', s1, t0)
    stillOpen(s4) // the other camera's grant still holds
    // (b) The token made before the revocation is still within its 90 s window, and is refused.
    expect(verifyStreamToken(spare.streams[0].token, Date.now(), SECRET)).not.toBeNull()
    const late = openSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(spare.streams[0].token)}`, APP)
    sockets.push(late.ws)
    expect(await late.closed).toEqual({ code: 1008, reason: 'Not allowed' })
    // (g) And a token re-used for a second socket is refused too.
    const again = openSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(s4.token)}`, APP)
    sockets.push(again.ws)
    expect(await again.closed).toEqual({ code: 1008, reason: 'Not allowed' })
    stillOpen(s4)
  })

  it('review m-1: a tile whose socket dropped reconnects with the same token within its window; a copy beside an open socket is refused', async () => {
    const { u } = await viewer('user', 'cctv.live', atCamera(cam4))
    const [s] = await watch(u, [cam4])
    s.ws.close() // the picture dropped (camera hiccup, watchdog)
    await s.closed
    // The gateway closes the session in the registry when the socket ends.
    const sid = verifyStreamToken(s.token, Date.now(), SECRET)!.sid
    for (let i = 0; i < 50; i++) {
      const { data } = await admin().from('media_sessions').select('closed_at').eq('id', sid).single()
      if (data?.closed_at) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const again = openSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(s.token)}`, APP)
    sockets.push(again.ws)
    expect(await again.opened).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(again.ws.readyState).toBe(WebSocket.OPEN)
    const copy = openSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(s.token)}`, APP)
    sockets.push(copy.ws)
    expect(await copy.closed).toEqual({ code: 1008, reason: 'Not allowed' })
    stillOpen(again)
  })

  it('(a) deactivating the person (people screen service) closes every socket of theirs; the app also revokes the sessions itself', async () => {
    const { u } = await viewer('user', 'cctv.live', atLocation(L1))
    const mine = await watch(u, [cam1, cam3])
    const calls: { fn: string; args: Record<string, unknown> }[] = []
    const spy = new Proxy(admin(), {
      get(target, prop) {
        if (prop === 'rpc') return (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return (target.rpc as (f: string, a: object) => unknown)(fn, args) }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as ReturnType<typeof admin>
    const t0 = Date.now()
    expect(await updateUser(spy, actor, u.id, { is_active: false })).toMatchObject({ ok: true })
    for (const [i, s] of mine.entries()) await closesFor(`deactivated_${i}`, s, t0)
    expect(calls.find((c) => c.fn === 'media_sessions_revoke_user')?.args).toEqual({ p_org: orgId, p_user: u.id, p_reason: 'deactivated' })
  })

  it('(a) a grant whose end (valid_until) passes closes the socket within 25 s of the end, without anybody doing anything', async () => {
    const until = Date.now() + 5000
    const { u } = await viewer('user', 'cctv.live', atCamera(cam2), { validUntil: new Date(until).toISOString() })
    const [s] = await watch(u, [cam2])
    await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())))
    await closesFor('grant_expired', s, until)
  })

  it('a password reset and a role change close the person’s sockets (D-3)', async () => {
    const a = await viewer('user', 'cctv.live', ORG_SCOPE)
    const b = await viewer('user', 'cctv.live', ORG_SCOPE)
    const [sa] = await watch(a.u, [cam4])
    const [sb] = await watch(b.u, [cam4])
    const t0 = Date.now()
    expect(await resetUserPassword(admin(), actor, a.u.id)).toMatchObject({ ok: true })
    expect(await updateUser(admin(), actor, b.u.id, { role: 'operator' })).toMatchObject({ ok: true })
    await closesFor('password_reset', sa, t0)
    await closesFor('role_changed', sb, t0)
  })

  it('removing a grant in the access editor (P2-3 service) closes the socket it covered', async () => {
    const { u, ids } = await viewer('user', 'cctv.live', [atCamera(cam3), atCamera(cam4)])
    const [s3, s4] = await watch(u, [cam3, cam4])
    const changes = [{ op: 'revoke' as const, grant_id: ids[0], reason: 'test: removed in the editor' }]
    const version = Number((await admin().from('profiles').select('access_version').eq('id', u.id).single()).data!.access_version)
    const p = await previewChange(admin(), actor, u.id, { changes, expectedVersion: version })
    if (!p.ok) throw new Error(p.error)
    const t0 = Date.now()
    expect(await applyChange(admin(), actor, u.id, { changes, expectedVersion: p.version, token: p.token })).toMatchObject({ ok: true, revoked: 1 })
    await closesFor('editor_grant_removed', s3, t0)
    stillOpen(s4)
  })

  it('addendum: moving a location to another cluster, moving a camera to another NVR, removing a recorder grant, archiving a camera and a location', async () => {
    // The location of these cases is made here so the moves do not change the other tests' cameras.
    const loc = await createLocation(orgId, { clusterId: c1 })
    const ra = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 16544, rtspPort: 15544, secret: 'nvr-pass-4' })
    const rb = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 16545, rtspPort: 15545, secret: 'nvr-pass-5' })
    const k1 = await createCamera(orgId, { locationId: loc, recorderId: ra, channel: 1 })
    const k2 = await createCamera(orgId, { locationId: loc, recorderId: ra, channel: 2 })
    const k3 = await createCamera(orgId, { locationId: loc, recorderId: rb, channel: 1 })
    const clusterHolder = await viewer('user', 'cctv.live', atCluster(c1))
    const locationHolder = await viewer('user', 'cctv.live', atLocation(loc))
    const nvrHolder = await viewer('user', 'cctv.live', atRecorder(ra))
    const nvrGrantHolder = await viewer('user', 'cctv.live', [atRecorder(rb), atCamera(cam4)])
    const [sc] = await watch(clusterHolder.u, [k3])
    const sl = await watch(locationHolder.u, [k1, k2, k3])
    const [sn] = await watch(nvrHolder.u, [k2])
    const [sg, sg4] = await watch(nvrGrantHolder.u, [k3, cam4])

    let t0 = Date.now()
    expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: loc, p_cluster: c2, p_actor: owner.id })).error).toBeNull()
    await closesFor('location_moved_cluster', sc, t0)

    t0 = Date.now()
    await mapCamera(orgId, k2, rb, 2)
    await closesFor('camera_moved_nvr', sn, t0)

    t0 = Date.now()
    expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: nvrGrantHolder.u.id, p_grant_ids: [nvrGrantHolder.ids[0]], p_reason: 'test: NVR grant removed' })).error).toBeNull()
    await closesFor('recorder_grant_removed', sg, t0)
    stillOpen(sg4)

    t0 = Date.now()
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: k1, p_actor: owner.id })).error).toBeNull()
    await closesFor('camera_archived', sl[0], t0)
    stillOpen(sl[1])
    stillOpen(sl[2])

    t0 = Date.now()
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: loc, p_actor: owner.id })).error).toBeNull()
    await closesFor('location_archived_1', sl[1], t0)
    await closesFor('location_archived_2', sl[2], t0)
  }, 120_000)

  it('with the production interval (15 s) a removed grant closes the socket within 20 s (D-3: 15 s check + 5 s call)', async () => {
    const prod = createGateway({ go2rtcUrl: video.url, secret: SECRET, allowedOrigins: [APP], registry: restRegistry() })
    const p = await new Promise<number>((resolve) => prod.listen(0, '127.0.0.1', () => resolve((prod.address() as AddressInfo).port)))
    try {
      expect(prod.health().validateEverySec).toBe(15)
      const { u, ids } = await viewer('user', 'cctv.live', atCamera(cam4))
      const [s] = await watch(u, [cam4], p)
      const t0 = Date.now()
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: ids, p_reason: 'test: production interval' })).error).toBeNull()
      const r = await Promise.race([s.closed, new Promise<Outcome>((resolve) => setTimeout(() => resolve({ error: 'still open after 20 s' }), 20_000))])
      const ms = Date.now() - t0
      expect(r).toEqual({ code: 4403, reason: 'Access changed' })
      expect(ms).toBeLessThan(20_000)
      latencies.grant_removed_production_interval = ms
    } finally {
      await prod.shutdown(1000)
    }
  }, 60_000)

  it('(c, real database) the gateway closes everything when its registry stops answering, and nothing stays open', async () => {
    let down = false
    const real = restRegistry()
    const flaky: RegistryClient = { ...real, stillValid: (sids) => (down ? Promise.reject(new Error('down')) : real.stillValid(sids)) }
    const second = await startGateway(flaky)
    try {
      const { u } = await viewer('user', 'cctv.live', ORG_SCOPE)
      const mine = await watch(u, [cam1, cam4], second.p)
      const t0 = Date.now()
      down = true
      const results = await Promise.all(mine.map((s) => s.closed))
      for (const r of results) expect(r).toEqual({ code: 1013, reason: 'Cannot verify access' })
      const ms = Date.now() - t0
      // 45 s by default; this gateway checks every 2 s, so it is 45 s from the last good check (at most 2 s before the outage).
      expect(ms).toBeGreaterThanOrEqual(42_000)
      expect(ms).toBeLessThan(60_000)
      latencies.registry_down_fail_closed = ms
      expect(second.g.health()).toMatchObject({ openSessions: 0, registry: 'failing' })
    } finally {
      await second.g.shutdown(1000)
    }
  }, 90_000)

  it('(h) 300 open sockets: one registry call per check, timed on the real database', async () => {
    const timings: number[] = []
    const real = restRegistry()
    let calls = 0
    const timed: RegistryClient = {
      ...real,
      stillValid: async (sids) => {
        calls++
        const t = performance.now()
        try {
          return await real.stillValid(sids)
        } finally {
          timings.push(performance.now() - t)
        }
      },
    }
    const big = await startGateway(timed, { autoValidate: false })
    try {
      const { u } = await viewer('user', 'cctv.live', ORG_SCOPE)
      const extra = await createLocation(orgId)
      const rec = await createRecorder(orgId, extra, { host: '127.0.0.1', httpPort: 16546, rtspPort: 15546, secret: 'nvr-pass-6' })
      const cams: string[] = []
      // P4-L1 review I-1: one person may hold at most 25 DIFFERENT live streams at the gateway (the default cap, enforced by
      // media_session_open), so the 300 sockets are twelve for each of 25 cameras (was ten for each of 30).
      for (let ch = 1; ch <= 25; ch++) cams.push(await createCamera(orgId, { locationId: extra, recorderId: rec, channel: ch }))
      // 300 sessions: twelve for each of the 25 cameras, made by the registry as openStreams would make them.
      const tokens: string[] = []
      for (let round = 0; round < 12; round++) {
        const { data, error } = await admin().rpc('media_session_create', { p_org: orgId, p_user: u.id, p_kind: 'live', p_cameras: cams, p_streams: cams.map((c) => `cam_${c}_sub`) })
        if (error) throw new Error(error.message)
        for (const r of data ?? []) tokens.push(signStreamToken({ sid: r.sid, u: u.id, c: r.camera_id, k: 'sub', exp: Math.floor(Date.now() / 1000) + 90 }, SECRET))
      }
      expect(tokens).toHaveLength(300)
      const open: ReturnType<typeof openSocket>[] = []
      for (let i = 0; i < 300; i += 50) {
        const group = tokens.slice(i, i + 50).map((t) => openSocket(`ws://127.0.0.1:${big.p}/g/ws?token=${encodeURIComponent(t)}`, APP))
        group.forEach((g) => sockets.push(g.ws))
        expect((await Promise.all(group.map((g) => g.opened))).every(Boolean)).toBe(true)
        open.push(...group)
      }
      await waitFor(() => big.g.health().openSessions === 300, 20_000, '300 open sessions')
      for (let i = 0; i < 3; i++) await big.g.validateNow()
      expect(calls).toBe(3)
      expect(open.every((s) => s.ws.readyState === WebSocket.OPEN)).toBe(true)
      const sorted = [...timings].sort((a, b) => a - b)
      console.log(JSON.stringify({ still_valid_300_ms: { each: timings.map((t) => Math.round(t)), median: Math.round(sorted[1]) } }))
      expect(sorted[1]).toBeLessThan(5000) // well inside the 5 s call limit
    } finally {
      await big.g.shutdown(1000)
    }
  }, 120_000)
})
