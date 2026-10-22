import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_STREAMS_PER_REQUEST, openStreams, type OpenedStream } from '@/lib/streams/open'
import { verifyStreamToken } from '@/lib/streams/token'
import { startFakeGo2rtc, type FakeGo2rtc, type Seen } from '../helpers/fake-go2rtc'
import { adminClient, atCamera, atLocation, CCTV_VIEW, cleanupOrg, createLocation, createOrg, createRecorder, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const SECRET = 'integration-test-stream-secret-0123456789'
const PASSWORD = 'p@ss:w/rd#1!'
const ENCODED_PASSWORD = 'p%40ss%3Aw%2Frd%231%21'
const admin = () => adminClient()

describe('openStreams', () => {
  let orgId: string, otherOrg: string
  let sA: string, sB: string, sNoPass: string
  let rA: string, rB: string
  let a1: string, a2: string, aOff: string, b1: string, n1: string, foreign: string
  let viewer: TestUser, nobody: TestUser, manager: TestUser
  let fake: FakeGo2rtc
  const savedSecret = process.env.STREAM_TOKEN_SECRET
  const recorderOf = new Map<string, string>()

  // P2-5b: a store is a location with ONE recorder (its NVR, on 127.0.0.1) of its own; its cameras are mapped to it.
  async function addStore(org: string, code: string, o: { active?: boolean; port?: number } = {}) {
    const loc = await createLocation(org, { code, name: `Store ${code}`, isActive: o.active ?? true })
    recorderOf.set(loc, await createRecorder(org, loc, { host: '127.0.0.1', rtspPort: o.port ?? 554 }))
    return loc
  }
  async function addCamera(org: string, store: string, channel: number, name: string, active = true) {
    const { data, error } = await admin().from('cameras').insert({ org_id: org, location_id: store, recorder_id: recorderOf.get(store)!, channel, name, is_active: active }).select('id').single()
    if (error || !data) throw new Error(`addCamera: ${error?.message}`)
    return data.id
  }

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    sA = await addStore(orgId, 'OA')
    sB = await addStore(orgId, 'OB')
    sNoPass = await addStore(orgId, 'ON', { port: 8554 })
    rA = recorderOf.get(sA)!
    rB = recorderOf.get(sB)!
    for (const r of [rA, rB]) await admin().rpc('recorder_store_credential', { p_recorder: r, p_secret: PASSWORD })
    a1 = await addCamera(orgId, sA, 1, 'Front Door')
    a2 = await addCamera(orgId, sA, 2, 'Back Door')
    aOff = await addCamera(orgId, sA, 3, 'Switched off', false)
    b1 = await addCamera(orgId, sB, 1, 'Store B door')
    n1 = await addCamera(orgId, sNoPass, 1, 'No password yet')
    foreign = await addCamera(otherOrg, await addStore(otherOrg, 'XX'), 1, 'Other org')
    viewer = await createUser(orgId, 'user')
    nobody = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees every store only through explicit grants
    await grant(orgId, viewer.id, CCTV_VIEW, [atLocation(sA), atLocation(sNoPass)]) // store grants as live + playback (P2-1)
  })
  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })
  beforeEach(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    fake = await startFakeGo2rtc()
  })
  afterEach(async () => {
    await fake.close()
  })

  const open = (user: TestUser, ids: string[], kind: 'sub' | 'main' = 'sub', extra: { env?: Record<string, string | undefined>; now?: () => number; adminClient?: ReturnType<typeof admin> } = {}) =>
    openStreams({ admin: extra.adminClient ?? admin(), rls: user.client, go2rtc: fake.client, env: extra.env ?? {}, now: extra.now }, { id: user.id, orgId }, ids, kind)
  const streamsOf = (r: Awaited<ReturnType<typeof open>>): OpenedStream[] => {
    if (!r.ok) throw new Error(r.error)
    return r.streams
  }
  const rtsp = (s: Seen) => new URL(s.src ?? '')

  it('a viewer asking for cameras of two stores gets only the visible ones, and go2rtc is told exactly those', async () => {
    const res = await open(viewer, [a1, b1, a2, foreign, aOff, '11111111-1111-4111-8111-111111111111', 'not-an-id'])
    expect(streamsOf(res).map((s) => s.cameraId)).toEqual([a1, a2])
    expect(streamsOf(res).map((s) => [s.name, s.storeCode, s.channel, s.kind])).toEqual([['Front Door', 'OA', 1, 'sub'], ['Back Door', 'OA', 2, 'sub']])
    expect(fake.seen.map((s) => s.method)).toEqual(['PUT', 'PUT'])
    expect(fake.seen.map((s) => s.name).sort()).toEqual([`cam_${a1}_sub`, `cam_${a2}_sub`].sort())
    const first = fake.seen.find((s) => s.name === `cam_${a1}_sub`)!
    // Checked on the server side only: path, credentials (still encoded in the raw text), port and host.
    expect(first.src).toBe(`rtsp://viewer:${ENCODED_PASSWORD}@127.0.0.1:554/Streaming/Channels/102`)
    expect(rtsp(first).pathname).toBe('/Streaming/Channels/102')
    expect(decodeURIComponent(rtsp(first).password)).toBe(PASSWORD)
    expect(rtsp(fake.seen.find((s) => s.name === `cam_${a2}_sub`)!).pathname).toBe('/Streaming/Channels/202')
  })

  it('asking again for cameras that are already open registers nothing new, but still signs fresh tokens', async () => {
    const first = streamsOf(await open(viewer, [a1, a2]))
    expect(fake.seen).toHaveLength(2)
    const again = streamsOf(await open(viewer, [a1, a2], 'sub', { now: () => Date.now() + 5000 }))
    expect(fake.seen).toHaveLength(2) // no second PUT: go2rtc would start a second connection to the camera
    expect(again.map((s) => s.cameraId)).toEqual([a1, a2])
    expect(again[0].token).not.toBe(first[0].token)
  })

  it('never reads the whole go2rtc list to open a stream (it holds every camera password)', async () => {
    streamsOf(await open(viewer, [a1, a2]))
    streamsOf(await open(viewer, [a1, a2]))
    // Only the pruner reads the list, and not more than once a minute.
    expect(fake.wholeListReads).toBeLessThanOrEqual(1)
  })

  it('a changed NVR password is registered again with the new password, and fails if go2rtc does not take it', async () => {
    streamsOf(await open(viewer, [a1]))
    expect(fake.streams.get(`cam_${a1}_sub`)).toContain(ENCODED_PASSWORD)
    const { error } = await admin().rpc('recorder_store_credential', { p_recorder: rA, p_secret: 'N3w:pass/word' })
    expect(error).toBeNull()
    try {
      fake.applies = false // go2rtc answers 400 and does not apply it
      expect(await open(viewer, [a1])).toEqual({ ok: false, error: 'The video server is not available.' })
      expect(fake.streams.get(`cam_${a1}_sub`)).toContain(ENCODED_PASSWORD) // still the old one: nothing was pretended
      fake.applies = true
      expect(streamsOf(await open(viewer, [a1])).map((s) => s.cameraId)).toEqual([a1])
      expect(fake.streams.get(`cam_${a1}_sub`)).toBe('rtsp://viewer:N3w%3Apass%2Fword@127.0.0.1:554/Streaming/Channels/102')
      expect(fake.seen.filter((s) => s.method === 'PUT').map((s) => s.name)).toEqual([`cam_${a1}_sub`, `cam_${a1}_sub`, `cam_${a1}_sub`])
    } finally {
      await admin().rpc('recorder_store_credential', { p_recorder: rA, p_secret: PASSWORD })
    }
  })

  it('a viewer with a camera grant only (no store grant) gets only that camera, even from a store they are not granted', async () => {
    const cameraOnly = await createUser(orgId, 'user')
    await grant(orgId, cameraOnly.id, CCTV_VIEW, atCamera(b1))
    const res = await open(cameraOnly, [a1, a2, b1])
    expect(streamsOf(res).map((s) => s.cameraId)).toEqual([b1])
    expect(fake.seen.map((s) => s.name)).toEqual([`cam_${b1}_sub`])
    expect(verifyStreamToken(streamsOf(res)[0].token, Date.now(), SECRET)).toMatchObject({ u: cameraOnly.id, c: b1 })
    // A single camera grant in a store gives that camera only.
    const mixed = await createUser(orgId, 'user')
    await grant(orgId, mixed.id, CCTV_VIEW, atCamera(a2))
    expect(streamsOf(await open(mixed, [a1, a2])).map((s) => s.cameraId)).toEqual([a2])
  })

  // AC-2 (P2-1): live video needs cctv.live; playback or export rights for the camera do not open live video.
  it('a person with playback and export but not live gets no live stream', async () => {
    const noLive = await createUser(orgId, 'user')
    await grant(orgId, noLive.id, ['cctv.playback', 'cctv.export'], atLocation(sA))
    expect(await open(noLive, [a1, a2])).toEqual({ ok: true, streams: [] })
    expect(fake.seen).toHaveLength(0)
  })

  it('the answer holds no password and no RTSP address', async () => {
    const text = JSON.stringify(await open(viewer, [a1, a2]))
    for (const needle of [PASSWORD, ENCODED_PASSWORD, 'rtsp://', 'viewer:', '127.0.0.1', 'Streaming/Channels', '"host"', 'recorder', 'password', SECRET]) expect(text, needle).not.toContain(needle)
    expect(Object.keys(JSON.parse(text).streams[0]).sort()).toEqual(['cameraId', 'channel', 'kind', 'name', 'storeCode', 'token'])
  })

  it('tokens verify and name this person, this camera and this kind, for ten minutes', async () => {
    const t = Date.now()
    const streams = streamsOf(await open(viewer, [a1, a2]))
    for (const s of streams) {
      const claims = verifyStreamToken(s.token, Date.now(), SECRET)
      expect(claims).toMatchObject({ u: viewer.id, c: s.cameraId, k: 'sub' })
      expect(Math.abs(claims!.exp - (Math.floor(t / 1000) + 600))).toBeLessThanOrEqual(3)
      expect(verifyStreamToken(s.token, Date.now() + 601_000, SECRET)).toBeNull() // gone after ten minutes
    }
    expect(streams[0].token).not.toBe(streams[1].token)
  })

  it('uses the injected clock for the expiry', async () => {
    const at = Date.UTC(2026, 9, 22, 6, 0, 0)
    const streams = streamsOf(await open(viewer, [a1], 'sub', { now: () => at }))
    expect(verifyStreamToken(streams[0].token, at, SECRET)).toMatchObject({ exp: at / 1000 + 600 })
  })

  it('main uses the 01 stream and a main stream name', async () => {
    const streams = streamsOf(await open(viewer, [a1], 'main'))
    expect(streams[0].kind).toBe('main')
    expect(verifyStreamToken(streams[0].token, Date.now(), SECRET)).toMatchObject({ k: 'main', c: a1 })
    expect(fake.seen[0].name).toBe(`cam_${a1}_main`)
    expect(rtsp(fake.seen[0]).pathname).toBe('/Streaming/Channels/101')
  })

  it('cameras that cannot be seen are left out silently: the answer is the same as for ids that do not exist', async () => {
    const hidden = await open(viewer, [b1, foreign])
    const missing = await open(viewer, ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'])
    expect(hidden).toEqual({ ok: true, streams: [] })
    expect(missing).toEqual(hidden)
    expect(await open(nobody, [a1, a2, b1])).toEqual({ ok: true, streams: [] })
    expect(fake.seen).toHaveLength(0)
  })

  it('a manager with organisation-wide live grants gets cameras of both stores (AC-8: the grants, not the role)', async () => {
    expect(streamsOf(await open(manager, [a1, b1])).map((s) => s.cameraId)).toEqual([a1, b1])
  })

  it('asks for the same camera twice, or in capitals, and gets it once', async () => {
    const streams = streamsOf(await open(viewer, [a1, a1.toUpperCase(), a1]))
    expect(streams).toHaveLength(1)
    expect(fake.seen).toHaveLength(1)
    expect(verifyStreamToken(streams[0].token, Date.now(), SECRET)?.c).toBe(a1)
  })

  it('more than 36 ids are refused, and so is an empty list', async () => {
    const many = Array.from({ length: MAX_STREAMS_PER_REQUEST + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const tooMany = await open(viewer, many)
    expect(tooMany.ok).toBe(false)
    const exactly = await open(viewer, many.slice(0, MAX_STREAMS_PER_REQUEST))
    expect(exactly).toEqual({ ok: true, streams: [] }) // 36 is allowed; none of these exist
    expect((await open(viewer, [])).ok).toBe(false)
    expect((await open(viewer, ['nope'])).ok).toBe(false)
    expect(fake.seen).toHaveLength(0)
  })

  it('refuses with a plain message when no stream secret is set, and registers nothing', async () => {
    for (const value of [undefined, '', 'short']) {
      if (value === undefined) delete process.env.STREAM_TOKEN_SECRET
      else process.env.STREAM_TOKEN_SECRET = value
      expect(await open(viewer, [a1])).toEqual({ ok: false, error: 'Live video is not set up yet.' })
    }
    expect(fake.seen).toHaveLength(0)
  })

  it('refuses a kind that is neither sub nor main', async () => {
    expect((await open(viewer, [a1], 'pb' as never)).ok).toBe(false)
    expect(fake.seen).toHaveLength(0)
  })

  it('one registration failing leaves that camera out and opens the others', async () => {
    fake.failNames.add(`cam_${a1}_sub`)
    const res = await open(manager, [a1, a2, b1])
    expect(streamsOf(res).map((s) => s.cameraId)).toEqual([a2, b1])
  })

  it('when none can be opened the answer is the plain error, without addresses', async () => {
    fake.failAll = true
    const res = await open(viewer, [a1, a2])
    expect(res).toEqual({ ok: false, error: 'The video server is not available.' })
    expect(JSON.stringify(res)).not.toContain('127.0.0.1')
  })

  it('when go2rtc is not running the answer is the plain error', async () => {
    await fake.close()
    const res = await open(viewer, [a1])
    expect(res).toEqual({ ok: false, error: 'The video server is not available.' })
    fake = await startFakeGo2rtc() // so afterEach has something to close
  })

  it('an NVR with no saved password leaves its cameras out; the rest still open', async () => {
    const res = await open(viewer, [n1, a1])
    expect(streamsOf(res).map((s) => s.cameraId)).toEqual([a1])
    expect(fake.seen.map((s) => s.name)).toEqual([`cam_${a1}_sub`])
    // Only a store with no password: nothing opens, but that is not a video server failure.
    expect(await open(viewer, [n1])).toEqual({ ok: true, streams: [] })
  })

  it('reads the NVR password once per recorder, through the recorder credential RPC only (P2-5b)', async () => {
    const calls: { name: string; args: unknown }[] = []
    const real = admin()
    const spy = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') return (name: string, args: unknown) => { calls.push({ name, args }); return target.rpc(name as never, args as never) }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    streamsOf(await open(manager, [a1, a2, b1], 'sub', { adminClient: spy }))
    expect(calls.map((c) => c.name)).toEqual(['recorder_read_credential', 'recorder_read_credential'])
    expect(calls.map((c) => (c.args as { p_recorder: string }).p_recorder).sort()).toEqual([rA, rB].sort())
  })

  it('with DEMO_VIDEO=1 and a loopback store the source is the generated test picture and no password is read', async () => {
    const calls: string[] = []
    const real = admin()
    const spy = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') return (name: string, args: unknown) => { calls.push(name); return target.rpc(name as never, args as never) }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const streams = streamsOf(await open(viewer, [a1, n1], 'sub', { env: { DEMO_VIDEO: '1', NODE_ENV: 'development' }, adminClient: spy }))
    expect(streams.map((s) => s.cameraId)).toEqual([a1, n1]) // the store without a password works too: there is no real camera
    expect(calls).toEqual([])
    const src = fake.seen.find((s) => s.name === `cam_${a1}_sub`)!.src!
    expect(src).toMatch(/^ffmpeg:virtual\?video=\w+&size=640x360&duration=86400\.\d+#video=h264$/)
    const other = fake.seen.find((s) => s.name === `cam_${n1}_sub`)!.src!
    expect(other).not.toBe(src) // two cameras never share one source (go2rtc would publish both to one path)
    expect(src).not.toMatch(/exec:|rtsp:\/\//)
    expect(JSON.stringify(streams)).not.toContain('ffmpeg')
  })

  it('DEMO_VIDEO is ignored in production', async () => {
    const res = await open(viewer, [a1], 'sub', { env: { DEMO_VIDEO: '1', NODE_ENV: 'production' } })
    expect(streamsOf(res)).toHaveLength(1)
    expect(fake.seen[0].src).toMatch(/^rtsp:\/\/viewer:/)
  })

  it('owner addition: a camera on an NVR with monitoring switched off is refused with a plain message; nothing is registered or read', async () => {
    const sOff = await addStore(orgId, 'OOFF')
    const rec = recorderOf.get(sOff)!
    await admin().rpc('recorder_store_credential', { p_recorder: rec, p_secret: PASSWORD })
    const off1 = await addCamera(orgId, sOff, 1, 'Real NVR camera')
    const watcher = await createUser(orgId, 'user')
    await grant(orgId, watcher.id, CCTV_VIEW, [atLocation(sOff), atLocation(sA)])
    expect((await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR: not to be contacted' })).error).toBeNull()
    // Count every credential read the service makes.
    const reads: string[] = []
    const real = admin()
    const counting = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rpc') return (fn: string, args: object) => { if (/credential/.test(fn)) reads.push(fn); return (target.rpc as (f: string, a: object) => unknown)(fn, args) }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as ReturnType<typeof admin>
    expect(await open(watcher, [off1], 'sub', { adminClient: counting })).toEqual({ ok: false, error: 'Monitoring is switched off for this NVR.' })
    expect(fake.seen).toEqual([])
    expect(reads).toEqual([])
    // Mixed with a camera of a switched-on NVR: only that one opens.
    expect(streamsOf(await open(watcher, [off1, a1])).map((s) => s.cameraId)).toEqual([a1])
    expect(fake.seen.map((s) => s.name)).toEqual([`cam_${a1}_sub`])
    // Switched on again, it opens.
    await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab NVR' })
    expect(streamsOf(await open(watcher, [off1])).map((s) => s.cameraId)).toEqual([off1])
  })
})
