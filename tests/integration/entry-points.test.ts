import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, atLocation, cleanupOrg, createOrg, createUser, grant, type TestUser } from '../setup/fixtures'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
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
    nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: [{ start: '2026-10-20T09:00:00', end: '2026-10-20T10:00:00' }] })
    go2rtc = await startFakeGo2rtc()
    process.env.GO2RTC_URL = go2rtc.url
    orgId = await createOrg()
    const store = async (code: string) => (await admin().from('stores').insert({ org_id: orgId, code, name: code, nvr_ip: '127.0.0.1', http_port: nvr.port, rtsp_port: 554, nvr_username: NVR_USER }).select('id').single()).data!.id
    sGood = await store('EG')
    sWrong = await store('EW')
    sNoLogin = await store('EN')
    await admin().rpc('nvr_store_credential', { p_store: sGood, p_secret: NVR_PASSWORD })
    await admin().rpc('nvr_store_credential', { p_store: sWrong, p_secret: 'not-the-password' })
    const cam = async (s: string) => (await admin().from('cameras').insert({ org_id: orgId, store_id: s, channel: 1, name: 'cam' }).select('id').single()).data!.id
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
    expect(await listRecordedDaysAction(cNoLogin, 2026, 10)).toEqual({ ok: false, error: 'This store has no saved NVR login.' })
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
      expect(await res.json()).toEqual({ error: 'Fast playback is not available for your account.' })
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
    expect([itNoLogin.status, await itNoLogin.json()]).toEqual([409, { error: 'This store has no saved NVR login.' }])
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
