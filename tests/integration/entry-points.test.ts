import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, atLocation, cleanupOrg, createOrg, createSite, createUser, grant, type TestUser } from '../setup/fixtures'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import { makeFmp4 } from '../helpers/fmp4'
import { resetProcessSingletons } from '../helpers/reset-singletons'

// P2-2 fix round 1 (review: "one integration test per entry point with a real JWT"). The real Server Actions and the real route handler
// run with the signed-in person's own JWT: only the Next request plumbing is replaced (headers without a forwarded id, so the session
// is checked with GoTrue; the cookie client is the test user's own client). No other part is mocked.

const m = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.client as SupabaseClient<Database> }))

const admin = () => adminClient()
const SECRET = 'entry-points-test-stream-secret-0123456789'
const NVR_USER = 'viewer'
const NVR_PASSWORD = 'entry-pass-1'

type Seen = { method: string; name: string | null }
async function startFakeGo2rtc() {
  const seen: Seen[] = []
  const streams = new Map<string, string>()
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const name = u.searchParams.get('name') ?? u.searchParams.get('src')
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      const one = u.searchParams.get('src')
      if (one === null) return void res.end(JSON.stringify(Object.fromEntries([...streams].map(([k, v]) => [k, { producers: [{ url: v }], consumers: null }]))))
      if (!streams.has(one)) {
        res.statusCode = 404
        return void res.end('not found')
      }
      return void res.end(JSON.stringify({ producers: [{ url: streams.get(one) }], consumers: null }))
    }
    seen.push({ method: req.method ?? '', name })
    if (req.method === 'PUT' && u.searchParams.get('name')) streams.set(u.searchParams.get('name')!, u.searchParams.get('src') ?? '')
    res.statusCode = 400
    res.end('read-only')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

describe('entry points with a real JWT (P2-2 fix round 1)', () => {
  let orgId: string
  let sGood: string, sWrong: string, sNoLogin: string, cGood: string, cWrong: string, cNoLogin: string
  let live: TestUser, playback: TestUser, exportPlayback: TestUser, exportOnly: TestUser, itPerson: TestUser, operate: TestUser
  let nvr: FakeNvr
  let go2rtc: Awaited<ReturnType<typeof startFakeGo2rtc>>
  let savedWorker: unknown
  const saved = { secret: process.env.STREAM_TOKEN_SECRET, go2rtc: process.env.GO2RTC_URL, ffmpeg: process.env.FFMPEG }
  const as = (u: TestUser) => (m.client = u.client)

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    process.env.FFMPEG = 'C:\\definitely\\not\\ffmpeg.exe'
    savedWorker = (await admin().from('worker_state').select('*').eq('id', 1).single()).data
    // P4-L2 review I-1: a fragmented MP4 (the fast playback stream is paced by its own timestamps).
    nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: [{ start: '2026-10-20T09:00:00', end: '2026-10-20T10:00:00' }], downloadBytes: makeFmp4({ fragments: 3 }) })
    go2rtc = await startFakeGo2rtc()
    process.env.GO2RTC_URL = go2rtc.url
    orgId = await createOrg()
    // P2-5b: each store is a location with its own NVR (a recorder; its login in the vault, keyed by recorder).
    const store = async (code: string, secret?: string) =>
      (await createSite(orgId, { code, name: code, host: '127.0.0.1', httpPort: nvr.port, rtspPort: 554, username: NVR_USER, secret })).locationId
    sGood = await store('EG', NVR_PASSWORD)
    sWrong = await store('EW', 'not-the-password')
    sNoLogin = await store('EN')
    const cam = async (s: string) => (await admin().from('cameras').insert({ org_id: orgId, location_id: s, channel: 1, name: 'cam' }).select('id').single()).data!.id
    cGood = await cam(sGood)
    cWrong = await cam(sWrong)
    cNoLogin = await cam(sNoLogin)
    const all = [sGood, sWrong, sNoLogin].map(atLocation)
    live = await createUser(orgId, 'user')
    playback = await createUser(orgId, 'user')
    exportPlayback = await createUser(orgId, 'user')
    exportOnly = await createUser(orgId, 'user')
    itPerson = await createUser(orgId, 'user')
    operate = await createUser(orgId, 'operator')
    await grant(orgId, live.id, 'cctv.live', all)
    await grant(orgId, playback.id, 'cctv.playback', all)
    await grant(orgId, exportPlayback.id, ['cctv.playback', 'cctv.export'], all)
    await grant(orgId, exportOnly.id, 'cctv.export', all)
    await grant(orgId, itPerson.id, ['cctv.playback', 'cctv.export', 'it.inventory.view'], all)
    await grant(orgId, operate.id, 'it.monitoring.operate', atLocation(sGood))
  })
  afterAll(async () => {
    for (const [k, v] of [['STREAM_TOKEN_SECRET', saved.secret], ['GO2RTC_URL', saved.go2rtc], ['FFMPEG', saved.ffmpeg]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await admin().from('worker_state').update(savedWorker as never).eq('id', 1)
    await go2rtc.close()
    await nvr.close()
    await cleanupOrg(orgId)
  })
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    go2rtc.seen.length = 0
    nvr.requests.length = 0
  })

  it('openStreamsAction: cctv.live opens; playback only gets nothing and go2rtc is not asked', async () => {
    resetProcessSingletons()
    const { openStreamsAction } = await import('@/lib/actions/streams')
    as(playback)
    expect(await openStreamsAction([cGood], 'sub')).toEqual({ ok: true, streams: [] })
    expect(go2rtc.seen).toEqual([])
    as(live)
    const r = await openStreamsAction([cGood], 'sub')
    expect(r.ok && r.streams.map((s) => s.cameraId)).toEqual([cGood])
  })

  it('openPlaybackAction: cctv.playback opens; live only is "Camera not found." and go2rtc is not asked', async () => {
    const { openPlaybackAction } = await import('@/lib/actions/playback')
    const start = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 19) + 'Z'
    as(live)
    expect(await openPlaybackAction(cGood, start, 5)).toEqual({ ok: false, error: 'Camera not found.' })
    expect(go2rtc.seen).toEqual([])
    as(playback)
    expect((await openPlaybackAction(cGood, start, 5)).ok).toBe(true)
  })

  it('listDaySegmentsAction: NVR and login trouble in camera terms without the IT view, the specific words with it (fix I-2)', async () => {
    const { listDaySegmentsAction, listRecordedDaysAction } = await import('@/lib/actions/playback')
    const neutral = { ok: false, error: 'The recordings of this camera cannot be reached right now.' }
    as(playback)
    expect(await listDaySegmentsAction(cWrong, '2026-10-20')).toEqual(neutral)
    expect(await listRecordedDaysAction(cNoLogin, 2026, 10)).toEqual(neutral)
    as(itPerson)
    expect(await listDaySegmentsAction(cWrong, '2026-10-20')).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
    expect(await listRecordedDaysAction(cNoLogin, 2026, 10)).toEqual({ ok: false, error: 'This NVR has no saved login.' })
  })

  it('requestCheckNowAction: it.monitoring.operate on a location asks; others are refused and nothing is written', async () => {
    await admin().from('worker_state').update({ last_heartbeat: null, run_started_at: null, run_finished_at: null, check_requested_at: null }).eq('id', 1)
    const { requestCheckNowAction } = await import('@/lib/actions/monitor')
    as(itPerson)
    expect(await requestCheckNowAction()).toEqual({ error: 'You are not allowed to start a check.' })
    expect((await admin().from('worker_state').select('check_requested_at').eq('id', 1).single()).data!.check_requested_at).toBeNull()
    as(operate)
    expect((await requestCheckNowAction()).ok).toBe(true)
    expect((await admin().from('worker_state').select('check_requested_at').eq('id', 1).single()).data!.check_requested_at).not.toBeNull()
  })

  it('GET /api/vod: export and playback pass the camera check; export only or playback only are refused; NVR trouble in camera terms (fixes M-3, I-2)', async () => {
    const { GET } = await import('@/app/api/vod/route')
    const url = (camera: string, probe = true) => new Request(`http://localhost:3212/api/vod?camera=${camera}&start=2026-10-20T09:10:00Z&minutes=5${probe ? '&probe=1' : ''}`)
    for (const u of [exportOnly, playback]) {
      as(u)
      const res = await GET(url(cGood))
      expect(res.status).toBe(403)
      // D-L1 (P4-L2): /api/vod is the saveable-file (export) path only; same rule, the refusal now says so.
      expect(await res.json()).toEqual({ error: 'Downloading recordings is not available for your account.' })
    }
    expect(nvr.requests).toEqual([])
    as(exportPlayback)
    const ok = await GET(url(cGood))
    expect((await ok.json() as { error?: string }).error).not.toBe('Camera not found.') // past the camera check (no ffmpeg here)
    const noLogin = await GET(url(cNoLogin))
    expect([noLogin.status, await noLogin.json()]).toEqual([502, { error: 'The recordings of this camera cannot be reached right now.' }])
    const wrong = await GET(url(cWrong, false))
    expect([wrong.status, await wrong.json()]).toEqual([502, { error: 'The recordings of this camera cannot be reached right now.' }])
    as(itPerson)
    const itNoLogin = await GET(url(cNoLogin))
    expect([itNoLogin.status, await itNoLogin.json()]).toEqual([409, { error: 'This NVR has no saved login.' }])
  })

  // P4-L2 (decision D-L1): the real action and the real stream route with the person's own JWT. The development pass-through stands in for
  // ffmpeg (not installed here); the fake NVR is on loopback.
  it('openFastPlaybackAction + GET /api/playback/stream: playback without export streams 16x with no file headers; live only and export only get nothing; the token is the person\'s', async () => {
    const before = process.env.FAST_PLAYBACK_REMUX
    process.env.FAST_PLAYBACK_REMUX = 'passthrough'
    try {
      const { openFastPlaybackAction } = await import('@/lib/actions/playback')
      const { GET } = await import('@/app/api/playback/stream/route')
      const start = '2026-10-20T09:10:00Z'
      for (const u of [live, exportOnly]) {
        as(u)
        expect(await openFastPlaybackAction(cGood, start, 5, 4)).toEqual({ ok: false, error: 'Camera not found.' })
      }
      expect(nvr.requests).toEqual([])
      as(playback)
      const t = await openFastPlaybackAction(cGood, start, 5, 16)
      expect(t.ok).toBe(true)
      if (!t.ok) return
      const req = (token: string) => new Request('http://localhost:3212/api/playback/stream', { headers: { 'x-playback-token': token, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })
      as(live) // no playback anywhere: refused by the route before any camera is looked up
      expect((await GET(req(t.token))).status).toBe(403)
      as(exportPlayback) // has playback for the camera, but the token is not theirs
      expect((await GET(req(t.token))).status).toBe(404)
      expect(nvr.requests).toEqual([])
      as(playback)
      const res = await GET(req(t.token))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBeNull()
      expect(res.headers.get('content-type')).toBe('application/vnd.ckdrishti.stream')
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
    } finally {
      if (before === undefined) delete process.env.FAST_PLAYBACK_REMUX
      else process.env.FAST_PLAYBACK_REMUX = before
    }
  })

  it('the live, playback and export counts are separate: using up live leaves playback and fast playback working', async () => {
    resetProcessSingletons()
    vi.resetModules()
    const { openStreamsAction } = await import('@/lib/actions/streams')
    const { openPlaybackAction } = await import('@/lib/actions/playback')
    const { GET } = await import('@/app/api/vod/route')
    await grant(orgId, itPerson.id, 'cctv.live', atLocation(sGood))
    as(itPerson)
    for (let i = 0; i < 30; i++) await openStreamsAction([cGood], 'sub')
    expect(await openStreamsAction([cGood], 'sub')).toEqual({ ok: false, error: 'Too many video requests. Please wait a minute and try again.' })
    const start = new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 19) + 'Z'
    expect((await openPlaybackAction(cGood, start, 5)).ok).toBe(true)
    const res = await GET(new Request(`http://localhost:3212/api/vod?camera=${cGood}&start=2026-10-20T09:10:00Z&minutes=5&probe=1`))
    expect(res.status).not.toBe(429)
  })
})
