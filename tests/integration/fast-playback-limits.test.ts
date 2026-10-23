import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NvrClient } from '@/lib/nvr/client'
import { openFastPlayback, serveFastStream, type FastDeps } from '@/lib/streams/fast'
import { verifyFastToken } from '@/lib/streams/fast-token'
import { exportConversionLimiter, fastConversionLimiter, parseVodQuery, serveVod } from '@/lib/streams/vod'
import { adminClient, atLocation, cleanupOrg, createLocation, createOrg, createRecorder, createUser, grant, type TestUser } from '../setup/fixtures'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import { fakeRemux } from '../helpers/fake-remux'
import { fakeSpawn } from '../helpers/fake-spawn'
import { fmp4Fragment, fmp4Init, makeFmp4 } from '../helpers/fmp4'
import { resetProcessSingletons } from '../helpers/reset-singletons'

// P4-L2 review round 1 (owner ruling on I-1: playback-only people must not be able to dump recordings; I-2 slots; m-2 words): the fast
// stream is paced to its SIGNED speed by the stream layer, capped in bytes, charged against a per-person budget of recording minutes kept
// in the database (every tab and app instance), one at a time per person, its token good for one playback; viewers and exports have
// separate conversion pools and a viewer who stops reading gives the place back. Loopback fakes only; the fake remux adapter (no ffmpeg).

const NVR_USER = 'viewer'
const NVR_PASSWORD = 'secret-pass'
const SECRET = 'fast-limits-test-secret-0123456789'
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0)
const START = '2026-10-22T09:00:00Z'
const admin = () => adminClient()
const nvrClient = (ep: ConstructorParameters<typeof NvrClient>[0]) => new NvrClient(ep, { timeoutMs: 3000 })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (!(await check()) && Date.now() < end) await wait(25)
  expect(await check()).toBe(true)
}
const FRAG = 100_000
const TEN_MB = makeFmp4({ fragments: 100, fragmentSec: 1, payloadBytes: FRAG }) // 100 s of recording, 10 MB, sent at once
const HALF_HOUR = makeFmp4({ fragments: 30, fragmentSec: 60, payloadBytes: 500 }) // 30 minutes of recording, small

describe('fast playback limits (P4-L2 review round 1)', () => {
  let orgId: string, loc: string, camBig: string, camLong: string, camEndless: string
  let nvrBig: FakeNvr, nvrLong: FakeNvr, nvrEndless: FakeNvr
  const saved = process.env.STREAM_TOKEN_SECRET

  async function camera(rec: string, name: string) {
    const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: loc, recorder_id: rec, channel: 1, name }).select('id').single()
    if (error || !data) throw new Error(error?.message)
    return data.id
  }
  async function viewer(): Promise<TestUser> {
    const u = await createUser(orgId, 'user')
    await grant(orgId, u.id, ['cctv.live', 'cctv.playback'], atLocation(loc))
    return u
  }

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    const recordings = [{ start: '2026-10-22T08:00:00', end: '2026-10-22T10:00:00', channel: 1 }]
    nvrBig = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings, downloadBytes: TEN_MB })
    nvrLong = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings, downloadBytes: HALF_HOUR })
    nvrEndless = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings, download: 'endless', downloadBytes: fmp4Init(), endlessChunk: (n) => fmp4Fragment(n, 1000) })
    orgId = await createOrg()
    loc = await createLocation(orgId, { code: `FL${Date.now() % 100000}` })
    const rec = (port: number, rtsp: number, name: string) => createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: port, rtspPort: rtsp, username: NVR_USER, secret: NVR_PASSWORD, name })
    camBig = await camera(await rec(nvrBig.port, 561, 'NVR big'), 'Ten MB at once')
    camLong = await camera(await rec(nvrLong.port, 562, 'NVR long'), 'Half an hour')
    camEndless = await camera(await rec(nvrEndless.port, 563, 'NVR endless'), 'Endless')
  })
  afterAll(async () => {
    if (saved === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = saved
    await Promise.all([nvrBig.close(), nvrLong.close(), nvrEndless.close()])
    await cleanupOrg(orgId)
  })
  beforeEach(() => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    resetProcessSingletons() // fresh conversion pools in this process
  })
  afterEach(async () => {
    await waitFor(() => fastConversionLimiter().running === 0 && exportConversionLimiter().running === 0, 10_000)
  })

  const deps = (u: TestUser, extra: Partial<FastDeps> = {}): FastDeps => ({ rls: u.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), now: () => NOW, offsetMin: 0, ...extra })
  const who = (u: TestUser) => ({ id: u.id, orgId })
  const open = (u: TestUser, cam: string, minutes = 10, speed = 16, extra: Partial<FastDeps> = {}) => openFastPlayback(deps(u, extra), who(u), cam, new Date(START), minutes, speed)
  async function token(u: TestUser, cam: string, minutes = 10, speed = 16, extra: Partial<FastDeps> = {}) {
    const r = await open(u, cam, minutes, speed, extra)
    if (!r.ok) throw new Error(r.error)
    return r.token
  }
  const sessionOf = async (t: string) => (await admin().from('media_sessions').select('revoked_at, revoke_reason, closed_at, fast_media_sec').eq('id', verifyFastToken(t, NOW, SECRET)!.sid).single()).data!
  async function readFor(res: Response, ms: number) {
    const reader = res.body!.getReader()
    let bytes = 0
    const stop = Date.now() + ms
    for (;;) {
      const left = stop - Date.now()
      if (left <= 0) break
      const r = await Promise.race([reader.read(), wait(left).then(() => null)])
      if (r === null || r.done) break
      bytes += r.value.byteLength
    }
    await reader.cancel().catch(() => {})
    return bytes
  }

  describe('pacing to the signed speed (I-1)', () => {
    it('an NVR that sends 10 MB at once: after 2 s at 2x (burst 4 s) the person has at most 9 s of recording, not 10 MB', async () => {
      const u = await viewer()
      const t = await token(u, camBig, 10, 2)
      expect(verifyFastToken(t, NOW, SECRET)!.sp).toBe(2)
      const res = await serveFastStream(deps(u, { timing: { burstSec: 4 } }), who(u), t)
      expect(res.status).toBe(200)
      const bytes = await readFor(res, 2000)
      expect(bytes).toBeLessThanOrEqual(fmp4Init().length + 9 * (FRAG + 200))
      expect(bytes).toBeGreaterThan(3 * FRAG) // and it flows
      console.log(JSON.stringify({ fast_pacing: { speed: 2, burstSec: 4, wallMs: 2000, bytes, unpacedBytes: TEN_MB.length } }))
    })

    it('the byte cap of one stream (recording seconds x the cap rate): past it the stream ends and is charged what was sent', async () => {
      const u = await viewer()
      const t = await token(u, camBig, 1, 16)
      const res = await serveFastStream(deps(u, { timing: { burstSec: 1000, maxBytesPerSec: 3000 } }), who(u), t) // 60 s x 3 kB = 180 kB
      const body = new Uint8Array(await res.arrayBuffer())
      expect(body.length).toBeLessThanOrEqual(180_000)
      await waitFor(async () => (await sessionOf(t)).revoke_reason === 'finished')
    })
  })

  describe('the budget of recording minutes (I-1), kept in the database', () => {
    it('the third 30-minute playback within the hour is refused (60 minutes per hour here); what was played is what is charged', async () => {
      const u = await viewer()
      const budget = { perHourMin: 60, perDayMin: 600 }
      for (let i = 0; i < 2; i++) {
        const t = await token(u, camLong, 30, 16, { budget })
        const res = await serveFastStream(deps(u, { budget, timing: { burstSec: 3600 } }), who(u), t)
        expect(res.status).toBe(200)
        await res.arrayBuffer()
        await waitFor(async () => (await sessionOf(t)).fast_media_sec !== null)
        expect((await sessionOf(t)).fast_media_sec).toBeGreaterThanOrEqual(29 * 60)
      }
      const third = await open(u, camLong, 30, 16, { budget })
      expect(third.ok).toBe(false)
      expect(!third.ok && third.error).toMatch(/fast playback time/i)
      // 1x is untouched by the budget, and the refusal is recorded
      const { data } = await admin().from('admin_audit_log').select('action, detail').eq('actor_id', u.id).eq('action', 'cctv_fast_playback_denied')
      expect((data ?? []).some((r) => (r.detail as { reason?: string }).reason === 'budget_hour')).toBe(true)
    })

    it('the day budget holds too (40 minutes a day here): a second 30-minute playback is refused', async () => {
      const u = await viewer()
      const budget = { perHourMin: 1000, perDayMin: 40 }
      const t = await token(u, camLong, 30, 16, { budget })
      await (await serveFastStream(deps(u, { budget, timing: { burstSec: 3600 } }), who(u), t)).arrayBuffer()
      await waitFor(async () => (await sessionOf(t)).fast_media_sec !== null)
      const again = await open(u, camLong, 30, 16, { budget })
      expect(again.ok).toBe(false)
    })

    it('a token plays once: after its stream ended it cannot be replayed to start again from the beginning', async () => {
      const u = await viewer()
      const t = await token(u, camBig, 1, 16)
      await (await serveFastStream(deps(u, { timing: { burstSec: 1000 } }), who(u), t)).arrayBuffer()
      await waitFor(async () => (await sessionOf(t)).revoke_reason === 'finished')
      const replay = await serveFastStream(deps(u), who(u), t)
      expect(replay.status).toBe(404)
    })

    it('one fast playback per person at a time: a new token ends the running one (it is revoked and stops within the check interval)', async () => {
      const u = await viewer()
      const first = await token(u, camEndless, 10, 2)
      const running = await serveFastStream(deps(u, { timing: { validateMs: 200, failClosedMs: 2000 } }), who(u), first)
      expect(running.status).toBe(200)
      const reader = running.body!.getReader()
      await reader.read()
      const second = await token(u, camBig, 1, 16)
      expect((await sessionOf(first)).revoke_reason).toBe('superseded')
      const ended = (async () => {
        try {
          for (;;) if ((await reader.read()).done) return true
        } catch {
          return true
        }
      })()
      expect(await Promise.race([ended, wait(3000).then(() => false)])).toBe(true)
      await (await serveFastStream(deps(u, { timing: { burstSec: 1000 } }), who(u), second)).arrayBuffer()
    })
  })

  describe('conversion places (I-2)', () => {
    it('8 paused viewers fill the viewers\' pool: a 9th viewer is told the server is busy, an export still runs; then idle viewers give their places back', async () => {
      const users = await Promise.all(Array.from({ length: 9 }, () => viewer()))
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
      for (const u of users.slice(0, 8)) {
        const res = await serveFastStream(deps(u, { timing: { viewerIdleMs: 1500 } }), who(u), await token(u, camEndless, 10, 2))
        expect(res.status).toBe(200)
        const r = res.body!.getReader()
        await r.read() // then never again: a paused / hidden player
        readers.push(r)
      }
      expect(fastConversionLimiter().running).toBe(8)
      const ninth = await serveFastStream(deps(users[8]), who(users[8]), await token(users[8], camBig, 1, 16))
      expect(ninth.status).toBe(429)
      expect(((await ninth.json()) as { error: string }).error).toBe('The server is busy with other fast playbacks. Try again in a moment.')
      // an administrator's export has its own pool
      const exporter = await createUser(orgId, 'admin')
      await grant(orgId, exporter.id, ['cctv.playback', 'cctv.export'], atLocation(loc))
      const q = parseVodQuery(new URLSearchParams(`camera=${camBig}&start=${START}&minutes=1`))
      if (!q.ok) throw new Error(q.error)
      const exp = await serveVod({ rls: exporter.client, admin: admin(), nvr: nvrClient, now: () => NOW, spawn: fakeSpawn('copy'), env: { FFMPEG: 'C:\\fake\\ffmpeg.exe' } }, { id: exporter.id, orgId }, q.query)
      expect(exp.status).toBe(200)
      await exp.arrayBuffer()
      // the paused viewers read nothing for 1.5 s: their streams end and the places come back
      await waitFor(() => fastConversionLimiter().running === 0, 8000)
      const later = await serveFastStream(deps(users[8], { timing: { burstSec: 1000 } }), who(users[8]), await token(users[8], camBig, 1, 16))
      expect(later.status).toBe(200)
      await later.arrayBuffer()
      for (const r of readers) await r.cancel().catch(() => {})
    }, 60_000)

    it('one viewer takes one place: a second stream of the same person ends the first instead of taking another place', async () => {
      const u = await viewer()
      const a = await serveFastStream(deps(u), who(u), await token(u, camEndless, 10, 2))
      const ra = a.body!.getReader()
      await ra.read()
      const b = await serveFastStream(deps(u, { timing: { burstSec: 1000 } }), who(u), await token(u, camBig, 1, 16))
      expect(b.status).toBe(200)
      expect(fastConversionLimiter().running).toBeLessThanOrEqual(1)
      await b.arrayBuffer()
      await ra.cancel().catch(() => {})
    })
  })

  it('review m-2: when the remux stops being available between the token and the stream, the viewer gets the plain words, no ffmpeg text', async () => {
    const u = await viewer()
    const t = await token(u, camBig, 1, 16)
    const res = await serveFastStream(deps(u, { remux: fakeRemux('missing') }), who(u), t)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Fast playback is not set up on this server.' })
  })
})
