import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NvrClient } from '@/lib/nvr/client'
import { Go2rtcClient } from '@/lib/streams/go2rtc'
import { createWindowLimiter } from '@/lib/streams/limiter'
import { listDaySegments, listRecordedDays, openPlayback } from '@/lib/streams/playback'
import { verifyStreamToken } from '@/lib/streams/token'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

const SECRET = 'integration-test-stream-secret-0123456789'
const NVR_USER = 'viewer'
const NVR_PASSWORD = 'secret-pass'
const admin = () => adminClient()
const nvrClient = (ep: ConstructorParameters<typeof NvrClient>[0]) => new NvrClient(ep, { timeoutMs: 3000 })

// ── a fake go2rtc (like the real one with a read-only config: it answers 400 to a change it has applied) ──
type Seen = { method: string; name: string | null; src: string | null }
type FakeGo2rtc = { client: Go2rtcClient; seen: Seen[]; streams: Map<string, string>; watched: Set<string>; failAll: boolean; close: () => Promise<void> }
async function startFakeGo2rtc(): Promise<FakeGo2rtc> {
  const seen: Seen[] = []
  const streams = new Map<string, string>()
  const watched = new Set<string>()
  const fake = { failAll: false }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const consumers = (k: string) => (watched.has(k) ? [{ id: 1 }] : null)
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      const one = u.searchParams.get('src')
      if (one === null) return void res.end(JSON.stringify(Object.fromEntries([...streams].map(([k, v]) => [k, { producers: [{ url: v }], consumers: consumers(k) }]))))
      if (!streams.has(one)) {
        res.statusCode = 404
        return void res.end('not found')
      }
      return void res.end(JSON.stringify({ producers: [{ url: streams.get(one) }], consumers: consumers(one) }))
    }
    const name = u.searchParams.get('name')
    seen.push({ method: req.method ?? '', name, src: u.searchParams.get('src') })
    if (fake.failAll) {
      res.statusCode = 500
      return void res.end('boom')
    }
    if (req.method === 'PUT' && name) streams.set(name, u.searchParams.get('src') ?? '')
    if (req.method === 'DELETE') streams.delete(u.searchParams.get('src') ?? '')
    res.statusCode = 400
    res.end('read-only')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return Object.assign(fake, {
    client: new Go2rtcClient(`http://127.0.0.1:${port}`),
    seen,
    streams,
    watched,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  })
}

// Recordings on the fake NVR, in the NVR's own clock. Camera 1 only; camera 2 has none.
const RECORDINGS = [
  { start: '2026-10-20T01:00:00', end: '2026-10-20T02:00:00', channel: 1 },
  { start: '2026-10-20T10:00:00', end: '2026-10-20T10:30:00', channel: 1 },
  { start: '2026-10-20T23:30:00', end: '2026-10-21T00:30:00', channel: 1 },
  { start: '2026-10-22T09:00:00', end: '2026-10-22T10:00:00', channel: 1 },
]

describe('playback streams', () => {
  let orgId: string, otherOrg: string
  let sA: string, sB: string, sNoPass: string, sDown: string, sWrong: string
  let a1: string, a2: string, aOff: string, b1: string, n1: string, d1: string, w1: string, foreign: string
  let viewer: TestUser, nobody: TestUser, manager: TestUser
  let nvr: FakeNvr
  let fake: FakeGo2rtc
  const savedSecret = process.env.STREAM_TOKEN_SECRET

  async function addStore(org: string, code: string, o: { port?: number } = {}) {
    const { data, error } = await admin().from('stores').insert({ org_id: org, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', http_port: o.port ?? nvr.port, rtsp_port: 554, nvr_username: NVR_USER }).select('id').single()
    if (error || !data) throw new Error(`addStore: ${error?.message}`)
    return data.id
  }
  async function addCamera(org: string, store: string, channel: number, name: string, active = true) {
    const { data, error } = await admin().from('cameras').insert({ org_id: org, store_id: store, channel, name, is_active: active }).select('id').single()
    if (error || !data) throw new Error(`addCamera: ${error?.message}`)
    return data.id
  }
  const savePassword = (store: string, secret: string) => admin().rpc('nvr_store_credential', { p_store: store, p_secret: secret })

  beforeAll(async () => {
    nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS })
    orgId = await createOrg()
    otherOrg = await createOrg()
    sA = await addStore(orgId, 'PA')
    sB = await addStore(orgId, 'PB')
    sNoPass = await addStore(orgId, 'PN')
    sDown = await addStore(orgId, 'PD', { port: await closedPort() })
    sWrong = await addStore(orgId, 'PW')
    for (const s of [sA, sB, sDown]) await savePassword(s, NVR_PASSWORD)
    await savePassword(sWrong, 'not-the-password')
    a1 = await addCamera(orgId, sA, 1, 'Front Door')
    a2 = await addCamera(orgId, sA, 2, 'Back Door')
    aOff = await addCamera(orgId, sA, 3, 'Switched off', false)
    b1 = await addCamera(orgId, sB, 1, 'Store B door')
    n1 = await addCamera(orgId, sNoPass, 1, 'No password yet')
    d1 = await addCamera(orgId, sDown, 1, 'Down NVR')
    w1 = await addCamera(orgId, sWrong, 1, 'Wrong password')
    foreign = await addCamera(otherOrg, await addStore(otherOrg, 'PX'), 1, 'Other org')
    await savePassword(await addStore(otherOrg, 'PY'), NVR_PASSWORD)
    viewer = await createUser(orgId, 'user')
    nobody = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    const { error } = await admin().rpc('replace_user_access', { p_user: viewer.id, p_stores: [sA, sNoPass, sDown, sWrong], p_zones: [], p_cameras: [] })
    if (error) throw new Error(error.message)
  })
  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await nvr.close()
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })
  beforeEach(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    fake = await startFakeGo2rtc()
    nvr.requests.length = 0
    nvr.posts.length = 0
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fake.close()
  })

  const lookupDeps = (user: TestUser, extra: { limiter?: { allow(key: string): boolean }; nvr?: (ep: ConstructorParameters<typeof NvrClient>[0]) => NvrClient } = {}) => ({ rls: user.client, admin: admin(), nvr: extra.nvr ?? nvrClient, limiter: extra.limiter })
  const actorOf = (user: TestUser) => ({ id: user.id, orgId })
  const days = (user: TestUser, camera: string, year = 2026, month = 10, offset = 0) => listRecordedDays(lookupDeps(user), actorOf(user), camera, year, month, offset)
  const segments = (user: TestUser, camera: string, day: string, offset = 0) => listDaySegments(lookupDeps(user), actorOf(user), camera, day, offset)

  // "now" in these tests is 22 Oct 2026 10:00 real time = 15:30 on the shown (India) clock.
  const NOW = Date.UTC(2026, 9, 22, 10, 0, 0)
  const SHOWN_NOW = NOW + 330 * 60_000
  const play = (
    user: TestUser,
    camera: string,
    start: Date,
    minutes = 10,
    offset = 0,
    extra: { env?: Record<string, string | undefined>; limiter?: { allow(key: string): boolean }; now?: () => number; adminClient?: ReturnType<typeof admin> } = {},
  ) => openPlayback({ rls: user.client, admin: extra.adminClient ?? admin(), go2rtc: fake.client, now: extra.now ?? (() => NOW), env: extra.env ?? {}, limiter: extra.limiter }, actorOf(user), camera, start, minutes, offset)

  describe('visibility', () => {
    it('a camera the person may not see is refused with one plain message, the same as for one that does not exist, and the NVR is never asked', async () => {
      const hidden = [b1, foreign, aOff, '11111111-1111-4111-8111-111111111111', 'not-an-id']
      for (const id of hidden) {
        expect(await days(viewer, id), id).toEqual({ ok: false, error: 'Camera not found.' })
        expect(await segments(viewer, id, '2026-10-20'), id).toEqual({ ok: false, error: 'Camera not found.' })
        expect(await play(viewer, id, new Date(SHOWN_NOW - 3_600_000)), id).toEqual({ ok: false, error: 'Camera not found.' })
      }
      expect(await days(nobody, a1)).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await segments(nobody, a1, '2026-10-20')).toEqual({ ok: false, error: 'Camera not found.' })
      expect(nvr.requests).toHaveLength(0)
      expect(fake.seen).toHaveLength(0)
    })

    it('a manager, who sees every store, can look at a camera in any store of the organisation', async () => {
      expect((await days(manager, b1)).ok).toBe(true)
    })

    it('reads the NVR password through the service-role RPC only, once, and only for a camera that is visible', async () => {
      const calls: string[] = []
      const real = admin()
      const spy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'rpc') return (name: string, args: unknown) => { calls.push(name); return target.rpc(name as never, args as never) }
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      await listDaySegments({ rls: viewer.client, admin: spy, nvr: nvrClient }, actorOf(viewer), a1, '2026-10-20', 0)
      expect(calls).toEqual(['nvr_read_credential'])
      calls.length = 0
      await listDaySegments({ rls: viewer.client, admin: spy, nvr: nvrClient }, actorOf(viewer), b1, '2026-10-20', 0)
      expect(calls).toEqual([])
    })
  })

  describe('days and recordings', () => {
    it('lists the days the NVR calendar marks, for the camera asked about', async () => {
      expect(await days(viewer, a1)).toEqual({ ok: true, days: [20, 21, 22] })
      expect(await days(viewer, a2)).toEqual({ ok: true, days: [] })
      expect(await days(viewer, a1, 2026, 9)).toEqual({ ok: true, days: [] })
      expect(nvr.posts.every((p) => p.path.endsWith('/dailyDistribution'))).toBe(true)
      expect(nvr.posts.map((p) => p.path)).toContain('/ISAPI/ContentMgmt/record/tracks/101/dailyDistribution')
      expect(nvr.posts.map((p) => p.path)).toContain('/ISAPI/ContentMgmt/record/tracks/201/dailyDistribution')
    })

    it('the calendar marks are NVR days: the offset does not move them (they are only a hint)', async () => {
      expect(await days(viewer, a1, 2026, 10, 330)).toEqual({ ok: true, days: [20, 21, 22] })
    })

    it('lists the recordings of a day as shown times, whole and not cut at midnight', async () => {
      const res = await segments(viewer, a1, '2026-10-20')
      expect(res).toEqual({
        ok: true,
        truncated: false,
        skipped: 0,
        segments: [
          { start: '2026-10-20T01:00:00.000Z', end: '2026-10-20T02:00:00.000Z' },
          { start: '2026-10-20T10:00:00.000Z', end: '2026-10-20T10:30:00.000Z' },
          { start: '2026-10-20T23:30:00.000Z', end: '2026-10-21T00:30:00.000Z' },
        ],
      })
    })

    it('with an offset of 330 minutes the shown times are 5 hours 30 minutes later than the NVR times, and the NVR is asked for the day shifted back', async () => {
      const res = await segments(viewer, a1, '2026-10-20', 330)
      expect(res).toEqual({
        ok: true,
        truncated: false,
        skipped: 0,
        segments: [
          { start: '2026-10-20T06:30:00.000Z', end: '2026-10-20T07:30:00.000Z' },
          { start: '2026-10-20T15:30:00.000Z', end: '2026-10-20T16:00:00.000Z' },
        ],
      })
      expect(nvr.posts[0].body).toContain('<startTime>2026-10-19T18:30:00Z</startTime>')
      expect(nvr.posts[0].body).toContain('<endTime>2026-10-20T18:30:00Z</endTime>')
    })

    it('a day without recordings is an empty list, not an error', async () => {
      expect(await segments(viewer, a1, '2026-10-25')).toEqual({ ok: true, segments: [], truncated: false, skipped: 0 })
      expect(await segments(viewer, a2, '2026-10-20')).toEqual({ ok: true, segments: [], truncated: false, skipped: 0 })
    })

    it('what comes back holds no playback address, no password and no NVR address', async () => {
      const text = JSON.stringify([await segments(viewer, a1, '2026-10-20'), await days(viewer, a1)])
      for (const needle of ['rtsp://', 'playbackURI', 'uri', NVR_PASSWORD, '127.0.0.1', 'Streaming/tracks']) expect(text, needle).not.toContain(needle)
      const res = await segments(viewer, a1, '2026-10-20')
      if (!res.ok) throw new Error(res.error)
      for (const s of res.segments) expect(Object.keys(s).sort()).toEqual(['end', 'start'])
      expect(Object.keys(res).sort()).toEqual(['ok', 'segments', 'skipped', 'truncated'])
    })

    async function withOddNvr(searchAnswer: (o: { position: number }) => string, run: (camera: string) => Promise<void>) {
      const odd = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, searchAnswer })
      const store = await addStore(orgId, `PO${Math.floor(Math.random() * 1e6)}`, { port: odd.port })
      try {
        await savePassword(store, NVR_PASSWORD)
        await run(await addCamera(orgId, store, 1, 'Odd'))
      } finally {
        await odd.close()
      }
    }
    const item = (s: string, e: string) => `<searchMatchItem><timeSpan><startTime>${s}</startTime><endTime>${e}</endTime></timeSpan></searchMatchItem>`
    const page = (items: string[], status: string) => `<CMSearchResult><responseStatusStrg>${status}</responseStatusStrg><matchList>${items.join('')}</matchList></CMSearchResult>`
    const good = item('2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z')
    const goodSegment = { start: '2026-10-20T01:00:00.000Z', end: '2026-10-20T02:00:00.000Z' }

    it('says so when the list may be incomplete (the NVR still had more)', async () => {
      await withOddNvr(() => page([good], 'MORE'), async (cam) => {
        expect(await segments(manager, cam, '2026-10-20')).toEqual({ ok: true, segments: [goodSegment], truncated: true, skipped: 0 })
      })
    })

    it('says so when some recordings could not be read', async () => {
      await withOddNvr(({ position }) => (position === 0 ? page([good, item('garbage', 'garbage')], 'MORE') : page([], 'OK')), async (cam) => {
        expect(await segments(manager, cam, '2026-10-20')).toEqual({ ok: true, segments: [goodSegment], truncated: false, skipped: 1 })
      })
    })
  })

  describe('NVR trouble', () => {
    it('a store with no saved NVR login gives a plain message and no request is sent', async () => {
      expect(await days(viewer, n1)).toEqual({ ok: false, error: 'This store has no saved NVR login.' })
      expect(await segments(viewer, n1, '2026-10-20')).toEqual({ ok: false, error: 'This store has no saved NVR login.' })
      expect(await play(viewer, n1, new Date(SHOWN_NOW - 3_600_000))).toEqual({ ok: false, error: 'This store has no saved NVR login.' })
      expect(nvr.requests).toHaveLength(0)
      expect(fake.seen).toHaveLength(0)
    })

    it('an NVR that does not answer gives the plain NVR message', async () => {
      expect(await days(viewer, d1)).toEqual({ ok: false, error: 'The NVR did not answer.' })
      expect(await segments(viewer, d1, '2026-10-20')).toEqual({ ok: false, error: 'The NVR did not answer.' })
    })

    it('a refused login gives the plain NVR message', async () => {
      expect(await segments(viewer, w1, '2026-10-20')).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
    })

    it('an NVR that answers with nonsense gives the plain NVR message', async () => {
      const bad = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, mode: 'garbage' })
      const store = await addStore(orgId, `PG${Math.floor(Math.random() * 1e6)}`, { port: bad.port })
      try {
        await savePassword(store, NVR_PASSWORD)
        const cam = await addCamera(orgId, store, 1, 'Garbage')
        expect(await segments(manager, cam, '2026-10-20')).toEqual({ ok: false, error: 'The NVR gave an answer this app does not understand.' })
        expect(await days(manager, cam)).toEqual({ ok: false, error: 'The NVR gave an answer this app does not understand.' })
      } finally {
        await bad.close()
      }
    })

    it('an unexpected failure becomes a plain message, and the log holds only the kind of error', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const boom = () => ({ post: async () => { throw Object.assign(new TypeError(`connect ECONNREFUSED rtsp://viewer:planted-secret@10.0.0.5`), { cause: new Error('planted-secret') }) }, deadline: () => AbortSignal.timeout(1000) }) as unknown as NvrClient
      const res = await listDaySegments(lookupDeps(viewer, { nvr: boom }), actorOf(viewer), a1, '2026-10-20', 0)
      expect(res.ok).toBe(false)
      expect(JSON.stringify(res)).not.toMatch(/planted-secret|ECONNREFUSED|10\.0\.0\.5/)
      const res2 = await listRecordedDays(lookupDeps(viewer, { nvr: boom }), actorOf(viewer), a1, 2026, 10, 0)
      expect(res2.ok).toBe(false)
      const output = logged.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(output).toContain('TypeError')
      for (const needle of ['planted-secret', 'rtsp://', 'viewer:', '10.0.0.5', 'ECONNREFUSED']) expect(output, needle).not.toContain(needle)
    })

    it('rejects input that is not a month or a day, without asking the NVR', async () => {
      for (const [y, m] of [[1999, 10], [2101, 1], [2026, 0], [2026, 13], [2026.5, 3], [Number.NaN, 3]]) expect((await days(viewer, a1, y, m)).ok, `${y}-${m}`).toBe(false)
      for (const d of ['2026-02-30', '26-10-20', '2026-10-20T00:00', '', 'x']) expect((await segments(viewer, a1, d)).ok, d).toBe(false)
      expect((await segments(viewer, a1, '2026-10-20', 99999)).ok).toBe(false)
      expect((await segments(viewer, a1, '2026-10-20', 1.5)).ok).toBe(false)
      expect(nvr.requests).toHaveLength(0)
    })
  })

  describe('rate limit', () => {
    it('refuses beyond the limit before any NVR or video request, and each person has their own count', async () => {
      const limiter = createWindowLimiter(2, 60_000)
      expect((await listRecordedDays(lookupDeps(viewer, { limiter }), actorOf(viewer), a1, 2026, 10, 0)).ok).toBe(true)
      expect((await listDaySegments(lookupDeps(viewer, { limiter }), actorOf(viewer), a1, '2026-10-20', 0)).ok).toBe(true)
      const before = nvr.requests.length
      const refused = { ok: false, error: 'Too many video requests. Please wait a minute and try again.' }
      expect(await listRecordedDays(lookupDeps(viewer, { limiter }), actorOf(viewer), a1, 2026, 10, 0)).toEqual(refused)
      expect(await listDaySegments(lookupDeps(viewer, { limiter }), actorOf(viewer), a1, '2026-10-20', 0)).toEqual(refused)
      expect(await play(viewer, a1, new Date(SHOWN_NOW - 3_600_000), 10, 0, { limiter })).toEqual(refused)
      expect(nvr.requests).toHaveLength(before)
      expect(fake.seen).toHaveLength(0)
      expect((await listRecordedDays(lookupDeps(manager, { limiter }), actorOf(manager), a1, 2026, 10, 0)).ok).toBe(true)
    })

    it('a request that is wrong from the start does not use up the allowance', async () => {
      const limiter = createWindowLimiter(1, 60_000)
      expect((await listDaySegments(lookupDeps(viewer, { limiter }), actorOf(viewer), a1, 'nope', 0)).ok).toBe(false)
      expect((await listDaySegments(lookupDeps(viewer, { limiter }), actorOf(viewer), a1, '2026-10-20', 0)).ok).toBe(true)
    })
  })

  describe('openPlayback', () => {
    const START = new Date(Date.UTC(2026, 9, 22, 14, 30, 0)) // 14:30 on the shown clock
    const rtsp = (s: Seen) => new URL(s.src ?? '')
    const okOf = (r: Awaited<ReturnType<typeof play>>) => {
      if (!r.ok) throw new Error(r.error)
      return r
    }

    it('registers pb_<camera>_<start> with the NVR playback address, the offset taken off (shown minus offset), and returns a pb token', async () => {
      const res = okOf(await play(viewer, a1, START, 10, 330))
      const s = START.getTime() / 1000
      expect(res.name).toBe(`pb_${a1}_${s}`)
      expect(fake.seen.map((x) => [x.method, x.name])).toEqual([['PUT', `pb_${a1}_${s}`]])
      const src = fake.seen[0].src!
      expect(src).toBe(`rtsp://${NVR_USER}:${NVR_PASSWORD}@127.0.0.1:554/Streaming/tracks/101?starttime=20261022T090000Z&endtime=20261022T091000Z`)
      expect(rtsp(fake.seen[0]).pathname).toBe('/Streaming/tracks/101')
      const claims = verifyStreamToken(res.token, NOW, SECRET)
      expect(claims).toEqual({ u: viewer.id, c: a1, k: 'pb', exp: NOW / 1000 + 600, s, e: s + 600 })
    })

    it('with no offset the NVR is asked for the time as shown, and a later camera channel uses its own track', async () => {
      okOf(await play(manager, a2, START, 5, 0))
      expect(fake.seen[0].src).toBe(`rtsp://${NVR_USER}:${NVR_PASSWORD}@127.0.0.1:554/Streaming/tracks/201?starttime=20261022T143000Z&endtime=20261022T143500Z`)
    })

    it('a negative offset moves the request the other way', async () => {
      okOf(await play(viewer, a1, START, 10, -60))
      expect(fake.seen[0].src).toContain('starttime=20261022T153000Z&endtime=20261022T154000Z')
    })

    it('keeps the length between 1 and 60 minutes', async () => {
      const lengths = async (minutes: number) => {
        const res = okOf(await play(viewer, a1, START, minutes))
        const c = verifyStreamToken(res.token, NOW, SECRET)!
        return c.e! - c.s!
      }
      expect(await lengths(500)).toBe(3600)
      expect(await lengths(61)).toBe(3600)
      expect(await lengths(60)).toBe(3600)
      expect(await lengths(0)).toBe(60)
      expect(await lengths(-5)).toBe(60)
      expect(await lengths(1)).toBe(60)
      expect(await lengths(30)).toBe(1800)
      expect((await play(viewer, a1, START, Number.NaN)).ok).toBe(false)
      expect((await play(viewer, a1, START, '10' as never)).ok).toBe(false)
    })

    it('drops the fraction of a second from the start', async () => {
      const res = okOf(await play(viewer, a1, new Date(START.getTime() + 999), 10))
      expect(verifyStreamToken(res.token, NOW, SECRET)!.s).toBe(START.getTime() / 1000)
    })

    it('asking again for the same moment registers nothing new (no second connection to the NVR) but signs a fresh token', async () => {
      const first = okOf(await play(viewer, a1, START, 10))
      const again = okOf(await play(viewer, a1, START, 10, 0, { now: () => NOW + 5000 }))
      expect(fake.seen.filter((x) => x.method === 'PUT')).toHaveLength(1)
      expect(again.name).toBe(first.name)
      expect(again.token).not.toBe(first.token)
    })

    it('another person asking for the same moment shares the stream but gets their own token', async () => {
      const a = okOf(await play(viewer, a1, START, 10))
      const b = okOf(await play(manager, a1, START, 10))
      expect(fake.seen.filter((x) => x.method === 'PUT')).toHaveLength(1)
      expect(verifyStreamToken(a.token, NOW, SECRET)!.u).toBe(viewer.id)
      expect(verifyStreamToken(b.token, NOW, SECRET)!.u).toBe(manager.id)
    })

    it('a different length for the same start is registered again with the new end (the source changed)', async () => {
      okOf(await play(viewer, a1, START, 10))
      okOf(await play(viewer, a1, START, 30))
      expect(fake.seen.filter((x) => x.method === 'PUT')).toHaveLength(2)
      expect(fake.seen[1].src).toContain('endtime=20261022T150000Z')
    })

    it('refuses a start in the future, or older than a year, or not a date, and registers nothing', async () => {
      const one = 60_000
      expect((await play(viewer, a1, new Date(SHOWN_NOW + 30_000))).ok).toBe(true) // within a minute of now: allowed
      fake.seen.length = 0
      for (const bad of [new Date(SHOWN_NOW + 2 * one), new Date(SHOWN_NOW + 2 * 86_400_000), new Date(SHOWN_NOW - 366 * 86_400_000), new Date(0), new Date(Number.NaN), new Date(Number.POSITIVE_INFINITY), 'yesterday' as never, null as never]) {
        expect((await play(viewer, a1, bad)).ok, String(bad)).toBe(false)
      }
      expect(fake.seen).toHaveLength(0)
      expect((await play(viewer, a1, new Date(SHOWN_NOW - 364 * 86_400_000))).ok).toBe(true)
    })

    it('"now" is the shown clock: a time that is earlier today on the Indian clock is allowed even though it is later than the real UTC time', async () => {
      // Real time 10:00Z is 15:30 shown. 14:30 shown is after 10:00Z but in the past on the shown clock.
      expect(START.getTime()).toBeGreaterThan(NOW)
      expect((await play(viewer, a1, START)).ok).toBe(true)
    })

    it('a switched-off camera cannot be played', async () => {
      expect(await play(manager, aOff, START)).toEqual({ ok: false, error: 'Camera not found.' })
    })

    it('refuses with a plain message when no stream secret is set, and registers nothing', async () => {
      for (const value of [undefined, '', 'short']) {
        if (value === undefined) delete process.env.STREAM_TOKEN_SECRET
        else process.env.STREAM_TOKEN_SECRET = value
        expect(await play(viewer, a1, START)).toEqual({ ok: false, error: 'Live video is not set up yet.' })
      }
      expect(fake.seen).toHaveLength(0)
    })

    it('when go2rtc does not take the stream the answer is the plain error, without addresses', async () => {
      fake.failAll = true
      const res = await play(viewer, a1, START)
      expect(res).toEqual({ ok: false, error: 'The video server is not available.' })
      expect(JSON.stringify(res)).not.toMatch(/127\.0\.0\.1|rtsp:/)
      await fake.close()
      fake = await startFakeGo2rtc() // so afterEach has something to close
    })

    it('when go2rtc is not running the answer is the plain error', async () => {
      await fake.close()
      expect(await play(viewer, a1, START)).toEqual({ ok: false, error: 'The video server is not available.' })
      fake = await startFakeGo2rtc()
    })

    it('the answer holds no password, no address, no playback address', async () => {
      const text = JSON.stringify(await play(viewer, a1, START, 10, 330))
      for (const needle of [NVR_PASSWORD, 'rtsp://', '127.0.0.1', 'Streaming', 'starttime', 'nvr_ip', 'password', SECRET]) expect(text, needle).not.toContain(needle)
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(['name', 'ok', 'token'])
    })

    it('reads the NVR password through the service-role RPC only', async () => {
      const calls: { name: string; args: unknown }[] = []
      const real = admin()
      const spy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'rpc') return (name: string, args: unknown) => { calls.push({ name, args }); return target.rpc(name as never, args as never) }
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      okOf(await play(viewer, a1, START, 10, 0, { adminClient: spy }))
      expect(calls).toEqual([{ name: 'nvr_read_credential', args: { p_store: sA } }])
    })

    it('with DEMO_VIDEO=1 and a loopback store the source is the generated test picture, and no password is read', async () => {
      const calls: string[] = []
      const real = admin()
      const spy = new Proxy(real, {
        get(target, prop) {
          if (prop === 'rpc') return (name: string, args: unknown) => { calls.push(name); return target.rpc(name as never, args as never) }
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      const res = okOf(await play(viewer, n1, START, 10, 0, { env: { DEMO_VIDEO: '1', NODE_ENV: 'development' }, adminClient: spy }))
      expect(calls).toEqual([])
      expect(fake.seen[0].name).toBe(res.name)
      expect(fake.seen[0].src).toMatch(/^ffmpeg:virtual\?video=\w+&size=640x360&duration=86400\.\d+#video=h264$/)
      expect(fake.seen[0].src).not.toMatch(/exec:|rtsp:\/\//)
      expect(JSON.stringify(res)).not.toContain('ffmpeg')
    })

    it('DEMO_VIDEO is ignored in production', async () => {
      okOf(await play(viewer, a1, START, 10, 0, { env: { DEMO_VIDEO: '1', NODE_ENV: 'production' } }))
      expect(fake.seen[0].src).toMatch(/^rtsp:\/\/viewer:/)
    })

    it('a playback stream is removed after being idle, but never while somebody is watching it', async () => {
      const res = okOf(await play(viewer, a1, START))
      const idle = 31 * 60_000
      fake.watched.add(res.name)
      expect(await fake.client.prune({ now: Date.now() + idle, everyMs: 0 })).toBe(0)
      expect(fake.streams.has(res.name)).toBe(true)
      fake.watched.clear() // the viewer leaves: idle time counts from the last time it was seen watched
      expect(await fake.client.prune({ now: Date.now() + idle + 31 * 60_000, everyMs: 0 })).toBe(1)
      expect(fake.streams.has(res.name)).toBe(false)
    })
  })
})
