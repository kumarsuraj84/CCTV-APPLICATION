import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NvrClient } from '@/lib/nvr/client'
import { openFastPlayback, serveFastStream, type FastDeps } from '@/lib/streams/fast'
import { signFastToken, verifyFastToken } from '@/lib/streams/fast-token'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { listDaySegments, listOldestRecording, listRecordedDays, openPlayback } from '@/lib/streams/playback'
import { createConversionLimiter, parseVodQuery, serveVod, type ConversionLimiter } from '@/lib/streams/vod'
import { adminClient, atCamera, atLocation, cleanupOrg, createLocation, createOrg, createRecorder, createUser, grant, type TestUser } from '../setup/fixtures'
import { framingKey, xorFrame } from '@/lib/streams/framing'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import { fmp4Fragment, makeFmp4 } from '../helpers/fmp4'
import { fakeRemux } from '../helpers/fake-remux'
import { fakeSpawn } from '../helpers/fake-spawn'

// P4-L2 (decision D-L1, brief items 2, 3, 6, 7): fast playback 2x-16x is a cctv.playback right delivered ONLY as a browser stream —
// a short-lived token bound to the person, the camera and a media session of kind playback (revoked like every other video), answered by
// /api/playback/stream with no file headers. Saveable files stay behind cctv.export (/api/vod, administrators only, E-1). Every time the NVR
// is asked for is the shown time minus THAT recorder's own clock offset. Loopback fakes only: fake NVRs and a fake remux adapter (ffmpeg is
// not installed on this PC; the real-ffmpeg test below is skipped with that reason).

const NVR_USER = 'viewer'
const NVR_PASSWORD = 'secret-pass'
const SECRET = 'fast-playback-test-secret-0123456789'
const admin = () => adminClient()
const nvrClient = (ep: ConstructorParameters<typeof NvrClient>[0]) => new NvrClient(ep, { timeoutMs: 3000 })
// "now" is 22 Oct 2026 10:00 real time = 15:30 on the shown (India) clock.
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0)

// NVR clocks. A: no offset of its own (the default, 0 here). B: +3600 s (its clock is an hour behind the shown clock). C: -97 s (it runs
// 97 seconds fast). Each has a recording across ITS midnight and one in the morning of the 22nd.
const RECORDINGS = [
  { start: '2026-09-03T08:14:00', end: '2026-09-03T09:00:00', channel: 1 },
  { start: '2026-10-21T23:10:00', end: '2026-10-22T00:50:00', channel: 1 },
  { start: '2026-10-22T09:00:00', end: '2026-10-22T10:00:00', channel: 1 },
]
const ffmpegWorks = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0
  } catch {
    return false
  }
})()

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  expect(await check()).toBe(true)
}
const CLIP = makeFmp4({ fragments: 5, fragmentSec: 1, payloadBytes: 2000 })
const nvrStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

describe('fast playback through the stream path (D-L1)', () => {
  let orgId: string, loc: string
  let recA: string, recB: string, recC: string
  let a1: string, b1: string, c1: string, a2: string
  let viewer: TestUser, liveOnly: TestUser, exportOnly: TestUser, cameraOnly: TestUser, other: TestUser
  let nvrA: FakeNvr, nvrB: FakeNvr, nvrC: FakeNvr, nvrEnd: FakeNvr
  let limits: ConversionLimiter
  const saved = process.env.STREAM_TOKEN_SECRET

  async function camera(rec: string, channel: number, name: string) {
    const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: loc, recorder_id: rec, channel, name }).select('id').single()
    if (error || !data) throw new Error(`camera: ${error?.message}`)
    return data.id
  }

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    // Review I-1: the stream layer paces a fragmented MP4 by its own timestamps, so the fake NVRs send one (5 s of recording).
    nvrA = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, downloadBytes: CLIP })
    nvrB = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, downloadBytes: CLIP })
    nvrC = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, downloadBytes: CLIP })
    nvrEnd = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, download: 'endless', downloadBytes: makeFmp4({ fragments: 1 }), endlessChunk: (n) => fmp4Fragment(n + 1, 1000) })
    orgId = await createOrg()
    loc = await createLocation(orgId, { code: `FP${Date.now() % 100000}` })
    recA = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvrA.port, rtspPort: 554, username: NVR_USER, secret: NVR_PASSWORD, name: 'NVR A' })
    recB = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvrB.port, rtspPort: 555, username: NVR_USER, secret: NVR_PASSWORD, name: 'NVR B', clockOffsetSec: 3600 })
    recC = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvrC.port, rtspPort: 556, username: NVR_USER, secret: NVR_PASSWORD, name: 'NVR C', clockOffsetSec: -97 })
    const recEnd = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvrEnd.port, rtspPort: 557, username: NVR_USER, secret: NVR_PASSWORD, name: 'NVR endless' })
    a1 = await camera(recA, 1, 'Entrance')
    b1 = await camera(recB, 1, 'Cash office')
    c1 = await camera(recC, 1, 'Stockroom')
    a2 = await camera(recEnd, 1, 'Endless')
    viewer = await createUser(orgId, 'user')
    liveOnly = await createUser(orgId, 'user')
    exportOnly = await createUser(orgId, 'admin')
    cameraOnly = await createUser(orgId, 'user')
    other = await createUser(orgId, 'user')
    // D-L1: live and playback, NO export (a plain viewer may never hold export: E-1).
    await grant(orgId, viewer.id, ['cctv.live', 'cctv.playback'], atLocation(loc))
    await grant(orgId, liveOnly.id, 'cctv.live', atLocation(loc))
    await grant(orgId, exportOnly.id, ['cctv.live', 'cctv.export'], atLocation(loc))
    await grant(orgId, cameraOnly.id, ['cctv.live', 'cctv.playback'], atCamera(b1))
    await grant(orgId, other.id, ['cctv.live', 'cctv.playback'], atLocation(loc))
  })
  afterAll(async () => {
    if (saved === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = saved
    await Promise.all([nvrA.close(), nvrB.close(), nvrC.close(), nvrEnd.close()])
    await cleanupOrg(orgId)
  })
  beforeEach(() => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    limits = createConversionLimiter()
    for (const n of [nvrA, nvrB, nvrC, nvrEnd]) {
      n.requests.length = 0
      n.posts.length = 0
      n.downloadBodies.length = 0
      n.downloadsEnded.count = 0
    }
  })
  afterEach(async () => {
    await waitFor(() => limits.running === 0)
  })

  const deps = (u: TestUser, extra: Partial<FastDeps> = {}): FastDeps => ({
    rls: u.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), conversions: limits, now: () => NOW, offsetMin: 0,
    timing: { killGraceMs: 300 }, ...extra,
  })
  const who = (u: TestUser) => ({ id: u.id, orgId })
  const shown = (iso: string) => new Date(iso)
  async function tokenFor(u: TestUser, cam: string, start = '2026-10-22T09:20:00Z', minutes = 10, extra: Partial<FastDeps> = {}) {
    const r = await openFastPlayback(deps(u, extra), who(u), cam, shown(start), minutes, 16)
    if (!r.ok) throw new Error(`open: ${r.error}`)
    return r.token
  }
  const sessionsOf = async (u: TestUser) =>
    (await admin().from('media_sessions').select('kind, capability, camera_id, stream, location_id, recorder_id, opened_at, closed_at, revoked_at, revoke_reason').eq('user_id', u.id).order('created_at')).data ?? []
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

  describe('who may (permission scenarios)', () => {
    it('D-L1: a viewer with cctv.playback and no export gets 16x as a stream: no file headers, not a video/* answer, the remuxed bytes', async () => {
      const token = await tokenFor(viewer, a1)
      const res = await serveFastStream(deps(viewer), who(viewer), token)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBeNull()
      expect(res.headers.get('content-type')).toBe('application/vnd.ckdrishti.stream')
      expect(res.headers.get('cache-control')).toContain('no-store')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-video-codec')).toBe('h264')
      // review I-1: framed (obfuscation): the saved body is not the MP4; the page undoes it with the key from the token
      expect(res.headers.get('x-stream-framing')).toBe('x32')
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.subarray(4, 8).toString('latin1')).not.toBe('ftyp')
      expect(Buffer.from(xorFrame(body, framingKey(token), 0))).toEqual(CLIP)
    })

    it('the same viewer can never download a file: /api/vod (export) is "Camera not found." and the NVR is not asked', async () => {
      const q = parseVodQuery(new URLSearchParams(`camera=${a1}&start=2026-10-22T09:20:00Z&minutes=10`))
      if (!q.ok) throw new Error(q.error)
      for (const probe of [false, true]) {
        const res = await serveVod({ rls: viewer.client, admin: admin(), nvr: nvrClient, conversions: limits, now: () => NOW, spawn: fakeSpawn('copy'), env: { FFMPEG: 'C:\\fake\\ffmpeg.exe' } }, who(viewer), { ...q.query, probe })
        expect(res.status).toBe(404)
        expect(await errorOf(res)).toBe('Camera not found.')
      }
      expect(nvrA.requests).toHaveLength(0)
    })

    it('playback is denied despite live: no token, no session, no NVR request', async () => {
      expect(await openFastPlayback(deps(liveOnly), who(liveOnly), a1, shown('2026-10-22T09:20:00Z'), 10, 4)).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await sessionsOf(liveOnly)).toEqual([])
      expect(nvrA.requests).toHaveLength(0)
    })

    it('export without playback is not enough for fast playback either', async () => {
      expect(await openFastPlayback(deps(exportOnly), who(exportOnly), a1, shown('2026-10-22T09:20:00Z'), 10, 4)).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await sessionsOf(exportOnly)).toEqual([])
    })

    it('a camera-only grant fast-plays that camera and no other of the location', async () => {
      expect((await openFastPlayback(deps(cameraOnly), who(cameraOnly), b1, shown('2026-10-22T09:20:00Z'), 10, 2)).ok).toBe(true)
      expect(await openFastPlayback(deps(cameraOnly), who(cameraOnly), a1, shown('2026-10-22T09:20:00Z'), 10, 2)).toEqual({ ok: false, error: 'Camera not found.' })
    })

    it('a speed that is not 2x to 16x, a length outside 1 to 30 minutes and a start outside the year are refused before anything', async () => {
      for (const [start, minutes, speed] of [['2026-10-22T09:20:00Z', 10, 1], ['2026-10-22T09:20:00Z', 10, 32], ['2026-10-22T09:20:00Z', 0, 4], ['2026-10-22T09:20:00Z', 31, 4], ['2026-10-23T09:20:00Z', 10, 4], ['2025-09-01T09:20:00Z', 10, 4]] as const) {
        expect((await openFastPlayback(deps(viewer), who(viewer), a1, shown(start), minutes, speed as never)).ok, `${start} ${minutes} ${speed}`).toBe(false)
      }
      expect(nvrA.requests).toHaveLength(0)
    })

    it('when fast playback is not set up on this server (no remux program) nothing is made and the words say so', async () => {
      expect(await openFastPlayback(deps(viewer, { remux: fakeRemux('missing') }), who(viewer), a1, shown('2026-10-22T09:20:00Z'), 10, 4)).toEqual({ ok: false, error: 'Fast playback is not set up on this server.' })
      expect((await sessionsOf(viewer)).filter((s) => s.camera_id === a1 && s.opened_at === null && s.closed_at === null)).toEqual([])
    })
  })

  describe('the token is bound to the person and the camera (brief item 3)', () => {
    it('somebody else presenting the token gets "Camera not found." and the owner\'s session is left untouched (still usable by its owner)', async () => {
      const token = await tokenFor(viewer, a1)
      const res = await serveFastStream(deps(other), who(other), token)
      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe('Camera not found.')
      const claims = verifyFastToken(token, NOW, SECRET)!
      const row = (await admin().from('media_sessions').select('opened_at, revoked_at').eq('id', claims.sid).single()).data!
      expect(row).toEqual({ opened_at: null, revoked_at: null })
      const own = await serveFastStream(deps(viewer), who(viewer), token)
      expect(own.status).toBe(200)
      await own.arrayBuffer()
    })

    it('a forged token (other secret), a token past its 90 seconds and rubbish are refused before the NVR is asked', async () => {
      const token = await tokenFor(viewer, a1)
      const claims = verifyFastToken(token, NOW, SECRET)!
      for (const t of [signFastToken(claims, 'another-secret-value-9876543210'), 'rubbish', '']) {
        expect((await serveFastStream(deps(viewer), who(viewer), t)).status).toBe(404)
      }
      expect((await serveFastStream(deps(viewer, { now: () => NOW + 91_000 }), who(viewer), token)).status).toBe(404)
      expect(nvrA.requests).toHaveLength(0)
    })

    it('a token opens one stream at a time: a copy used while it plays is refused, and the playing one is not disturbed', async () => {
      const token = await tokenFor(viewer, a2)
      const first = await serveFastStream(deps(viewer), who(viewer), token)
      expect(first.status).toBe(200)
      const reader = first.body!.getReader()
      await reader.read()
      const copy = await serveFastStream(deps(viewer, { conversions: createConversionLimiter() }), who(viewer), token)
      expect(copy.status).toBe(404)
      expect((await reader.read()).done).toBe(false) // still flowing
      await reader.cancel()
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
    })

    it('the stream is a media session of kind playback (cctv.playback), named for the camera and span, with its location and NVR, closed at the end', async () => {
      // B's clock is an hour behind the shown clock: 10:20 shown is inside its 09:00-10:00 (NVR) recording.
      const token = await tokenFor(viewer, b1, '2026-10-22T10:20:00Z')
      const claims = verifyFastToken(token, NOW, SECRET)!
      const res = await serveFastStream(deps(viewer), who(viewer), token)
      expect(res.status).toBe(200)
      await res.arrayBuffer()
      await waitFor(async () => (await admin().from('media_sessions').select('closed_at').eq('id', claims.sid).single()).data?.closed_at != null)
      await waitFor(async () => (await admin().from('media_sessions').select('fast_media_sec').eq('id', claims.sid).single()).data?.fast_media_sec != null)
      const row = (await admin().from('media_sessions').select('kind, capability, camera_id, stream, location_id, recorder_id, opened_at, revoke_reason, fast_media_sec').eq('id', claims.sid).single()).data!
      // Review I-1: at its end the session is finished for good (its token plays once) with the recording seconds it released (5 s here).
      expect(row).toMatchObject({ kind: 'playback', capability: 'cctv.playback', camera_id: b1, stream: `fpb_${b1}_${claims.s}_${claims.e}`, location_id: loc, recorder_id: recB, revoke_reason: 'finished', fast_media_sec: 5 })
      expect(row.opened_at).not.toBeNull()
    })

    it('no NVR login is read when the token is issued; when the stream runs it is read only after the session opened', async () => {
      const calls: string[] = []
      const counting = new Proxy(admin(), {
        get(target, prop) {
          if (prop === 'rpc') return (fn: string, args: object) => (calls.push(fn), (target.rpc as unknown as (f: string, a: object) => unknown).call(target, fn, args))
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      }) as ReturnType<typeof admin>
      const token = await tokenFor(viewer, a1, undefined, undefined, { admin: counting })
      expect(calls).toContain('media_session_create_fast') // review I-1: budget, one at a time and the session in one call
      expect(calls.filter((f) => /credential/.test(f))).toEqual([])
      expect(nvrA.requests).toHaveLength(0)
      calls.length = 0
      const res = await serveFastStream(deps(viewer, { admin: counting }), who(viewer), token)
      expect(res.status).toBe(200)
      await res.arrayBuffer()
      expect(calls.indexOf('recorder_credential_read')).toBeGreaterThan(calls.indexOf('media_session_open'))
    })
  })

  describe('revocation (brief item 6)', () => {
    it('removing the playback grant mid-stream aborts the NVR transfer within the check interval', async () => {
      const u = await createUser(orgId, 'user')
      const ids = await grant(orgId, u.id, ['cctv.live', 'cctv.playback'], atLocation(loc))
      const token = await tokenFor(u, a2)
      const res = await serveFastStream(deps(u, { timing: { killGraceMs: 300, validateMs: 250, failClosedMs: 1000 } }), who(u), token)
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      await reader.read()
      const t0 = Date.now()
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [ids[1]], p_reason: 'test: no more playback' })).error).toBeNull()
      const drained = (async () => {
        try {
          for (;;) if ((await reader.read()).done) return
        } catch {
          // the cut
        }
      })()
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      await drained
      const ms = Date.now() - t0
      expect(ms).toBeLessThan(3000)
      expect((await sessionsOf(u))[0]).toMatchObject({ kind: 'playback', revoke_reason: 'access_changed' })
      console.log(JSON.stringify({ fast_playback_revocation_ms: { grant_removed: ms, validateMs: 250 } }))
    })

    it('a token issued before the grant was removed can no longer open anything', async () => {
      const u = await createUser(orgId, 'user')
      const ids = await grant(orgId, u.id, ['cctv.live', 'cctv.playback'], atLocation(loc))
      const token = await tokenFor(u, a1)
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [ids[1]], p_reason: 'test' })).error).toBeNull()
      const res = await serveFastStream(deps(u), who(u), token)
      expect(res.status).toBe(404)
      expect(nvrA.requests).toHaveLength(0)
    })
  })

  describe('times: IST shown clock and each recorder\'s own offset (brief item 2)', () => {
    const downloaded = (n: FakeNvr) => n.downloadBodies.at(-1) ?? ''
    async function play(cam: string, start: string, minutes = 10) {
      const res = await serveFastStream(deps(viewer), who(viewer), await tokenFor(viewer, cam, start, minutes))
      const body = await res.arrayBuffer()
      return { status: res.status, body }
    }

    it('fast playback asks each NVR for the shown time minus ITS offset (A: 0, B: +3600 s, C: -97 s)', async () => {
      const start = '2026-10-22T09:20:00Z'
      expect((await play(a1, start)).status).toBe(200)
      expect(downloaded(nvrA)).toContain(`starttime=${nvrStamp(Date.parse(start))}`)
      // B's clock is an hour behind: 09:20 shown is 08:20 on B, outside B's 09:00-10:00 recording, so 10:20 shown is used for B.
      expect((await play(b1, '2026-10-22T10:20:00Z')).status).toBe(200)
      expect(downloaded(nvrB)).toContain(`starttime=${nvrStamp(Date.parse('2026-10-22T09:20:00Z'))}`)
      expect(downloaded(nvrB)).toContain(`endtime=${nvrStamp(Date.parse('2026-10-22T09:30:00Z'))}`)
      // C runs 97 s fast: the NVR is asked for 97 s later than shown.
      expect((await play(c1, start)).status).toBe(200)
      expect(downloaded(nvrC)).toContain(`starttime=${nvrStamp(Date.parse(start) + 97_000)}`)
    })

    it('a recording that spans midnight: on B it began 23:10 on the 21st (NVR), which is 00:10 on the 22nd shown; fast playback from 00:20 shown finds it', async () => {
      const r = await play(b1, '2026-10-22T00:20:00Z')
      expect(r.status).toBe(200)
      expect(downloaded(nvrB)).toContain(`starttime=${nvrStamp(Date.parse('2026-10-21T23:20:00Z'))}`)
      // A clip that starts before midnight and runs past it on A (no offset) is one clip, cut where the recording ends (00:50).
      expect((await play(a1, '2026-10-21T23:55:00Z', 30)).status).toBe(200)
      expect(downloaded(nvrA)).toContain(`starttime=${nvrStamp(Date.parse('2026-10-21T23:55:00Z'))}`)
      expect(downloaded(nvrA)).toContain(`endtime=${nvrStamp(Date.parse('2026-10-22T00:25:00Z'))}`)
    })

    it('the day\'s recordings are shown in shown time per recorder, whole across midnight', async () => {
      const segs = async (cam: string) => {
        const r = await listDaySegments({ rls: viewer.client, admin: admin(), nvr: nvrClient }, who(viewer), cam, '2026-10-22', 0)
        if (!r.ok) throw new Error(r.error)
        return r.segments
      }
      expect(await segs(a1)).toEqual([
        { start: '2026-10-21T23:10:00.000Z', end: '2026-10-22T00:50:00.000Z' },
        { start: '2026-10-22T09:00:00.000Z', end: '2026-10-22T10:00:00.000Z' },
      ])
      expect(await segs(b1)).toEqual([
        { start: '2026-10-22T00:10:00.000Z', end: '2026-10-22T01:50:00.000Z' },
        { start: '2026-10-22T10:00:00.000Z', end: '2026-10-22T11:00:00.000Z' },
      ])
      expect((await segs(c1))[1]).toEqual({ start: '2026-10-22T08:58:23.000Z', end: '2026-10-22T09:58:23.000Z' })
    })

    // Review m-4 replaces "B's NVR days 21 and 22 reach into the shown 23rd; C's reach back into the 20th": a skew under 10 minutes (C)
    // marks no extra day, and no day after today is marked (on the 22nd, B's spill into the 23rd is the future).
    it('the calendar marks shown days with the recorder\'s offset, never a day after today, and ignores a skew under 10 minutes', async () => {
      const days = async (cam: string, now = NOW) => {
        const r = await listRecordedDays({ rls: viewer.client, admin: admin(), nvr: nvrClient, now: () => now }, who(viewer), cam, 2026, 10, 0)
        if (!r.ok) throw new Error(r.error)
        return r.days
      }
      expect(await days(a1)).toEqual([21, 22])
      expect(await days(b1)).toEqual([21, 22])
      expect(await days(c1)).toEqual([21, 22])
      expect(await days(b1, NOW + 86_400_000)).toEqual([21, 22, 23]) // once the 23rd has come, B's spill into it is shown
    })

    it('the oldest recording is found and given in shown time per recorder (LG-9)', async () => {
      const oldest = async (cam: string) => {
        const r = await listOldestRecording({ rls: viewer.client, admin: admin(), nvr: nvrClient, now: () => NOW }, who(viewer), cam, 0)
        if (!r.ok) throw new Error(r.error)
        return r.oldest
      }
      expect(await oldest(a1)).toBe('2026-09-03T08:14:00.000Z')
      expect(await oldest(b1)).toBe('2026-09-03T09:14:00.000Z')
      expect(await oldest(c1)).toBe('2026-09-03T08:12:23.000Z')
    })

    // Review I-3: never assume the NVR's order; the earliest is found by the calendar and the day's own sorted list.
    it('review I-3: an NVR that lists its matches newest first still gives the true oldest recording', async () => {
      const desc = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, searchOrder: 'desc', searchPageSize: 1, recordings: [
        { start: '2026-10-21T10:00:00', end: '2026-10-21T11:00:00', channel: 1 },
        { start: '2026-08-14T06:30:00', end: '2026-08-14T07:00:00', channel: 1 },
        { start: '2026-08-14T05:10:00', end: '2026-08-14T05:20:00', channel: 1 },
        { start: '2026-09-30T23:00:00', end: '2026-10-01T01:00:00', channel: 1 },
      ] })
      try {
        const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: desc.port, rtspPort: 559, username: NVR_USER, secret: NVR_PASSWORD, name: 'NVR newest first' })
        const cam = await camera(rec, 1, 'Newest first')
        const r = await listOldestRecording({ rls: viewer.client, admin: admin(), nvr: nvrClient, now: () => NOW }, who(viewer), cam, 0)
        expect(r).toEqual({ ok: true, oldest: '2026-08-14T05:10:00.000Z' })
      } finally {
        await desc.close()
      }
    })

    it('1x playback applies the skewed offset too (C: -97 s)', async () => {
      const seen: { name: string; src: string }[] = []
      const go2rtc = { inspect: async () => ({ busy: false }), register: async (name: string, src: string) => void seen.push({ name, src }), prune: async () => {} } as unknown as Go2rtcClient
      const start = new Date('2026-10-22T09:20:00Z')
      const r = await openPlayback({ rls: viewer.client, admin: admin(), go2rtc, now: () => NOW, env: {} }, who(viewer), c1, start, 10, 0)
      expect(r.ok).toBe(true)
      expect(seen[0].src).toContain(`starttime=${nvrStamp(start.getTime() + 97_000)}`)
    })
  })

  // Brief item 3: the real program. ffmpeg is NOT installed on this PC, so real transcoding is unvalidated; see docs/drishti/runbooks/ffmpeg.md.
  it.skipIf(!ffmpegWorks)('real ffmpeg (skipped when ffmpeg is not installed on this computer, which is the case on the development PC): the stream path turns an NVR download into a fragmented MP4', async () => {
    const make = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-c:v', 'libx264', '-f', 'mpegts', 'pipe:1'], { timeout: 30_000 })
    expect(make.status).toBe(0)
    const real = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, downloadBytes: make.stdout })
    try {
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: real.port, rtspPort: 558, username: NVR_USER, secret: NVR_PASSWORD, name: 'NVR real' })
      const cam = await camera(rec, 1, 'Real ffmpeg')
      const token = await tokenFor(viewer, cam, '2026-10-22T09:20:00Z', 10, { remux: undefined, env: { PATH: process.env.PATH } })
      const res = await serveFastStream(deps(viewer, { remux: undefined, env: { PATH: process.env.PATH } }), who(viewer), token)
      expect(res.status).toBe(200)
      const bytes = Buffer.from(xorFrame(new Uint8Array(await res.arrayBuffer()), framingKey(token), 0))
      expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp')
      expect(bytes.includes(Buffer.from('moof', 'latin1'))).toBe(true)
    } finally {
      await real.close()
    }
  })
})
