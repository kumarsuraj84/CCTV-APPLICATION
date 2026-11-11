import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NvrClient } from '@/lib/nvr/client'
import { createWindowLimiter } from '@/lib/streams/limiter'
import { buildFfmpegArgs, createConversionLimiter, parseVodQuery, serveVod, type ConversionLimiter, type VodDeps } from '@/lib/streams/vod'
import { adminClient, atCamera, atLocation, CCTV_VIEW, cleanupOrg, createLocation, createOrg, createRecorder, createUser, grant, primaryRecorderOf, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const WITH_EXPORT = [...CCTV_VIEW, 'cctv.export']
import { closedPort, FAKE_DOWNLOAD_BYTES, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import { fakeSpawn, isAlive } from '../helpers/fake-spawn'

const NVR_USER = 'viewer'
const NVR_PASSWORD = 'secret-pass'
const admin = () => adminClient()
const nvrClient = (ep: ConstructorParameters<typeof NvrClient>[0]) => new NvrClient(ep, { timeoutMs: 3000 })

// "now" is 22 Oct 2026 10:00 real time = 15:30 on the shown (India) clock.
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0)
// Recordings on the fake NVR, in the NVR's own clock. Camera 1 only; camera 2 has none.
const RECORDINGS = [
  { start: '2026-10-20T10:00:00', end: '2026-10-20T11:00:00', channel: 1 },
  { start: '2026-10-22T09:00:00', end: '2026-10-22T10:00:00', channel: 1 },
]
const START = '2026-10-22T09:20:00Z' // inside the second recording when the offset is 0
const FFMPEG_PATH = path.resolve('/opt/fake/ffmpeg') // the stand-in is started whatever program is asked for
const ID = '0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111'

const ffmpegWorks = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0
  } catch {
    return false
  }
})()

const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  expect(check()).toBe(true)
}
async function readAll(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer())
}

describe('fast playback (/api/vod)', () => {
  let orgId: string, otherOrg: string
  let sA: string, sNoPass: string, sDown: string, sWrong: string, sXml: string, sEnd: string, sHostile: string, sOff: string
  let a1: string, a2: string, aOff: string, n1: string, d1: string, w1: string, x1: string, e1: string, h1: string, offStoreCamera: string, foreign: string
  let viewer: TestUser, nobody: TestUser, manager: TestUser, u1: TestUser, u2: TestUser, u3: TestUser
  let nvr: FakeNvr, nvrXml: FakeNvr, nvrEnd: FakeNvr, nvrHostile: FakeNvr
  let hostile: (() => string) | null = null
  let hostileCodec: string | null = null

  // P2-5b: a store is a location with ONE recorder (its NVR) of its own; its cameras are mapped to it and the login is the recorder's.
  const recorderOf = new Map<string, string>()
  async function addStore(org: string, code: string, o: { port?: number; active?: boolean } = {}) {
    const id = await createLocation(org, { code, name: `Store ${code}`, isActive: o.active ?? true })
    recorderOf.set(id, await createRecorder(org, id, { host: '127.0.0.1', httpPort: o.port ?? nvr.port, rtspPort: 554, username: NVR_USER }))
    return id
  }
  async function addCamera(org: string, store: string, channel: number, name: string, active = true) {
    const { data, error } = await admin().from('cameras').insert({ org_id: org, location_id: store, recorder_id: recorderOf.get(store)!, channel, name, is_active: active }).select('id').single()
    if (error || !data) throw new Error(`addCamera: ${error?.message}`)
    return data.id
  }
  const savePassword = (store: string, secret: string) => admin().rpc('recorder_store_credential', { p_recorder: recorderOf.get(store)!, p_secret: secret })

  beforeAll(async () => {
    nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS })
    nvrXml = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, download: 'xml' })
    nvrEnd = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, download: 'endless' })
    nvrHostile = await startFakeNvr({
      username: NVR_USER,
      password: NVR_PASSWORD,
      searchAnswer: () =>
        `<?xml version="1.0"?><CMSearchResult><responseStatusStrg>OK</responseStatusStrg><matchList><searchMatchItem><timeSpan><startTime>2026-10-22T09:00:00Z</startTime><endTime>2026-10-22T10:00:00Z</endTime></timeSpan><mediaSegmentDescriptor>${hostileCodec ? `<codecType>${hostileCodec}</codecType>` : ''}${hostile ? `<playbackURI>${hostile()}</playbackURI>` : ''}</mediaSegmentDescriptor></searchMatchItem></matchList></CMSearchResult>`,
    })
    orgId = await createOrg()
    otherOrg = await createOrg()
    sA = await addStore(orgId, 'VA')
    sNoPass = await addStore(orgId, 'VN')
    sDown = await addStore(orgId, 'VD', { port: await closedPort() })
    sWrong = await addStore(orgId, 'VW')
    sXml = await addStore(orgId, 'VX', { port: nvrXml.port })
    sEnd = await addStore(orgId, 'VE', { port: nvrEnd.port })
    sHostile = await addStore(orgId, 'VH', { port: nvrHostile.port })
    sOff = await addStore(orgId, 'VOF', { active: false })
    for (const s of [sA, sDown, sXml, sEnd, sHostile, sOff]) await savePassword(s, NVR_PASSWORD)
    await savePassword(sWrong, 'not-the-password')
    a1 = await addCamera(orgId, sA, 1, 'Front Door')
    a2 = await addCamera(orgId, sA, 2, 'Back Door')
    aOff = await addCamera(orgId, sA, 3, 'Switched off', false)
    n1 = await addCamera(orgId, sNoPass, 1, 'No password yet')
    d1 = await addCamera(orgId, sDown, 1, 'Down NVR')
    w1 = await addCamera(orgId, sWrong, 1, 'Wrong password')
    x1 = await addCamera(orgId, sXml, 1, 'Answers with a document')
    e1 = await addCamera(orgId, sEnd, 1, 'Endless download')
    h1 = await addCamera(orgId, sHostile, 1, 'Hostile NVR')
    offStoreCamera = await addCamera(orgId, sOff, 1, 'In a switched-off store')
    foreign = await addCamera(otherOrg, await addStore(otherOrg, 'VX2'), 1, 'Other org')
    // Final fix Y (review A M-3, ruling E-1): every holder of cctv.export is an administrator on every path (the database refuses it for
    // other roles), so the people with export here are administrators; the role itself still opens nothing (nobody, AC-8).
    viewer = await createUser(orgId, 'admin')
    nobody = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'admin')
    u1 = await createUser(orgId, 'admin')
    u2 = await createUser(orgId, 'admin')
    u3 = await createUser(orgId, 'admin')
    // P2-1: fast playback is a savable file, so it needs cctv.export (decision D-6a), given here with live and playback for the stores.
    for (const u of [viewer, u1, u2, u3]) await grant(orgId, u.id, WITH_EXPORT, [sA, sNoPass, sDown, sWrong, sXml, sEnd, sHostile].map(atLocation))
    await grant(orgId, manager.id, [...READ_EVERYTHING, 'cctv.export']) // AC-8: the grants, not the manager role
  })
  afterAll(async () => {
    await Promise.all([nvr.close(), nvrXml.close(), nvrEnd.close(), nvrHostile.close()])
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  let limits: ConversionLimiter
  beforeEach(() => {
    limits = createConversionLimiter()
    hostile = null
    hostileCodec = null
    for (const n of [nvr, nvrXml, nvrEnd, nvrHostile]) {
      n.requests.length = 0
      n.posts.length = 0
      n.downloadBodies.length = 0
      n.downloadsEnded.count = 0
    }
  })
  afterEach(async () => {
    // Nothing may be left running by a test.
    await waitFor(() => limits.running === 0, 8000)
  })

  const deps = (user: TestUser, extra: Partial<VodDeps> = {}): VodDeps => ({
    rls: user.client,
    admin: admin(),
    nvr: nvrClient,
    spawn: fakeSpawn('copy'),
    conversions: limits,
    now: () => NOW,
    timing: { killGraceMs: 300 },
    ...extra,
    env: { FFMPEG: FFMPEG_PATH, ...extra.env },
  })
  const query = (camera: string, start = START, minutes = 10, more = '') => {
    const p = parseVodQuery(new URLSearchParams(`camera=${camera}&start=${start}&minutes=${minutes}${more}`))
    if (!p.ok) throw new Error(`bad test query: ${p.error}`)
    return p.query
  }
  const get = (user: TestUser, camera: string, o: { start?: string; minutes?: number; more?: string; deps?: Partial<VodDeps>; signal?: AbortSignal } = {}) =>
    serveVod(deps(user, o.deps), { id: user.id, orgId }, query(camera, o.start, o.minutes, o.more), o.signal)
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

  describe('the video', () => {
    it('owner addition: refuses a camera on an NVR with monitoring switched off, before any NVR request or conversion', async () => {
      const sMon = await addStore(orgId, 'VMOFF')
      await savePassword(sMon, NVR_PASSWORD)
      const cam = await addCamera(orgId, sMon, 1, 'Real NVR camera')
      const watcher = await createUser(orgId, 'admin') // final fix Y (A M-3, E-1)
      await grant(orgId, watcher.id, WITH_EXPORT, atLocation(sMon))
      const rec = await primaryRecorderOf(sMon)
      expect((await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'Real NVR: not to be contacted' })).error).toBeNull()
      const spawn = fakeSpawn('copy')
      const res = await get(watcher, cam, { deps: { spawn } })
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toBe('Monitoring is switched off for this NVR.')
      expect(nvr.requests).toEqual([])
      expect(spawn.calls).toEqual([])
      await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: true, p_reason: 'Lab NVR' })
    })

    it('streams the NVR recording through the converter as video/mp4, with the headers the brief names', async () => {
      const spawn = fakeSpawn('copy')
      const res = await get(viewer, a1, { deps: { spawn } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('video/mp4')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(await readAll(res)).toEqual(FAKE_DOWNLOAD_BYTES) // the fake "ffmpeg" copies its input
      expect(spawn.calls).toEqual([{ command: FFMPEG_PATH, args: buildFfmpegArgs() }])
      await waitFor(() => limits.running === 0)
    })

    it('asks the NVR once for the part wanted: its address with the start and end moved to the clip, in NVR time', async () => {
      await readAll(await get(viewer, a1, { start: '2026-10-22T09:20:00Z', minutes: 10 }))
      expect(nvr.downloadBodies).toHaveLength(1)
      const body = nvr.downloadBodies[0]
      expect(body).toContain('<downloadRequest')
      expect(body).toContain('rtsp://127.0.0.1/Streaming/tracks/101?starttime=20261022T092000Z&amp;endtime=20261022T093000Z</playbackURI>')
      expect(nvr.posts.map((p) => p.path)).toEqual(['/ISAPI/ContentMgmt/search', '/ISAPI/ContentMgmt/download'])
    })

    it('ends the clip where the recording ends', async () => {
      await readAll(await get(viewer, a1, { start: '2026-10-22T09:55:00Z', minutes: 10 }))
      expect(nvr.downloadBodies[0]).toContain('starttime=20261022T095500Z&amp;endtime=20261022T100000Z')
    })

    it('treats the start as a shown time: the NVR is asked for the start minus the offset (ruling R13)', async () => {
      // The NVR recorded 09:00 to 10:00 on its clock; people see that as 14:30 to 15:30 with an offset of 330 minutes.
      const res = await get(viewer, a1, { start: '2026-10-22T14:40:00Z', minutes: 10, deps: { env: { PLAYBACK_OFFSET_MIN: '330' } } })
      expect(res.status).toBe(200)
      await readAll(res)
      expect(nvr.downloadBodies[0]).toContain('starttime=20261022T091000Z&amp;endtime=20261022T092000Z')
      // and the search was made for the NVR's own day
      expect(nvr.posts[0].body).toContain('<startTime>2026-10-21T18:30:00Z</startTime>')
    })

    it('uses the recording that covers the start, also one that began on the day before', async () => {
      // 10:30 on the 20th is after the 10:00 to 11:00 recording's start but inside it; 11:00 is after it.
      expect((await get(viewer, a1, { start: '2026-10-20T10:30:00Z' })).status).toBe(200)
      const after = await get(viewer, a1, { start: '2026-10-20T11:00:00Z' })
      expect(after.status).toBe(404)
      expect(await errorOf(after)).toBe('There is no recording at that time.')
    })

    it('contains nothing of the login or the address in what is sent to the browser', async () => {
      const res = await get(viewer, a1)
      const headers = JSON.stringify([...res.headers.entries()])
      expect(headers).not.toMatch(/secret-pass|127\.0\.0\.1|rtsp:|Digest/i)
      await readAll(res)
    })
  })

  describe('who may ask', () => {
    it('a camera the person may not see is "Camera not found." (404), the same as one that does not exist, and the NVR is never asked', async () => {
      const spawn = fakeSpawn('copy')
      for (const id of [foreign, aOff, ID]) {
        const res = await get(viewer, id, { deps: { spawn } })
        expect(res.status, id).toBe(404)
        expect(await errorOf(res)).toBe('Camera not found.')
      }
      const none = await get(nobody, a1, { deps: { spawn } })
      expect(none.status).toBe(404)
      const off = await get(manager, offStoreCamera, { deps: { spawn } })
      expect(off.status).toBe(404)
      const other = await get(viewer, '11111111-1111-4111-8111-111111111111', { deps: { spawn } })
      expect(other.status).toBe(404)
      expect(nvr.requests).toHaveLength(0)
      expect(spawn.calls).toHaveLength(0)
      expect(limits.running).toBe(0)
    })

    // P2-2 fix I-2: credential trouble is recorder information: camera terms (502) without the IT view, the specific 409 with it.
    it('a store with no saved NVR login: 502 in camera terms for a CCTV viewer, 409 with the plain message with the IT view; the NVR gets no request', async () => {
      const res = await get(viewer, n1)
      expect(res.status).toBe(502)
      expect(await errorOf(res)).toBe('The recordings of this camera cannot be reached right now.')
      const it = await get(manager, n1)
      expect(it.status).toBe(409)
      expect(await errorOf(it)).toBe('This NVR has no saved login.')
      expect(nvr.requests).toHaveLength(0)
    })

    it('somebody with a grant for one camera only can fast-play that camera and no other of its store', async () => {
      const cameraOnly = await createUser(orgId, 'admin') // final fix Y (A M-3, E-1)
      await grant(orgId, cameraOnly.id, WITH_EXPORT, atCamera(a1))
      expect((await get(cameraOnly, a2)).status).toBe(404)
      const ok = await get(cameraOnly, a1)
      expect(ok.status).toBe(200)
      await readAll(ok)
    })

    // AC-2 / D-6a (P2-1): live and playback rights are not enough for fast playback; it needs cctv.export.
    it('somebody with live and playback but no export gets "Camera not found." (404), and the NVR is never asked', async () => {
      const spawn = fakeSpawn('copy')
      const noExport = await createUser(orgId, 'user')
      await grant(orgId, noExport.id, CCTV_VIEW, atLocation(sA))
      const res = await get(noExport, a1, { deps: { spawn } })
      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe('Camera not found.')
      expect(nvr.requests).toHaveLength(0)
      expect(spawn.calls).toHaveLength(0)
    })

    // P2-2 fix M-3 (ruling): fast playback is a recording, so it needs cctv.export AND cctv.playback for the camera; export alone gets
    // the same refusal as no right at all, probe included, and the NVR is never asked.
    it('export without playback for that camera is "Camera not found." (404), the same as no right; probe too', async () => {
      const spawn = fakeSpawn('copy')
      const exportOnly = await createUser(orgId, 'admin') // final fix Y (A M-3, E-1)
      await grant(orgId, exportOnly.id, 'cctv.export', atLocation(sA))
      const split = await createUser(orgId, 'admin') // final fix Y (A M-3, E-1)
      await grant(orgId, split.id, 'cctv.export', atLocation(sA))
      await grant(orgId, split.id, 'cctv.playback', atCamera(a2)) // playback for another camera only
      for (const [who, more] of [[exportOnly, ''], [exportOnly, '&probe=1'], [split, ''], [split, '&probe=1']] as const) {
        const res = await get(who, a1, { more, deps: { spawn } })
        expect(res.status).toBe(404)
        expect(await errorOf(res)).toBe('Camera not found.')
      }
      expect(nvr.requests).toHaveLength(0)
      expect(spawn.calls).toHaveLength(0)
    })

    // P2-2 brief item 7: vod start / end / denied are audited (actor, capability, camera), never the address, the token or a password.
    it('records the start, the end and a refusal in the audit log', async () => {
      const person = await createUser(orgId, 'admin') // final fix Y (A M-3, E-1)
      await grant(orgId, person.id, WITH_EXPORT, atCamera(a1))
      const rows = async () => (await admin().from('admin_audit_log').select('action, entity_id, detail').eq('actor_id', person.id).order('created_at')).data ?? []
      expect((await get(person, a2)).status).toBe(404)
      const ok = await get(person, a1)
      expect(ok.status).toBe(200)
      await readAll(ok)
      await waitFor(() => limits.running === 0)
      let seen = await rows()
      for (let i = 0; i < 100 && !seen.some((r) => r.action === 'cctv_export_ended'); i++) {
        await new Promise((r) => setTimeout(r, 50))
        seen = await rows()
      }
      expect(seen.map((r) => [r.action, r.entity_id])).toEqual([
        ['cctv_export_denied', a2],
        ['cctv_export_started', a1],
        ['cctv_export_ended', a1],
      ])
      for (const r of seen) expect((r.detail as { capability: string }).capability).toBe('cctv.export')
      expect(JSON.stringify(seen)).not.toMatch(/127\.0\.0\.1|rtsp|password|token/i)
      // The probe is no export: nothing is recorded for it.
      await get(person, a1, { more: '&probe=1' })
      expect((await rows()).length).toBe(3)
    })
  })

  describe('plain errors', () => {
    it('no recording at that time is 404 and nothing is downloaded', async () => {
      const spawn = fakeSpawn('copy')
      const res = await get(viewer, a1, { start: '2026-10-22T12:00:00Z', deps: { spawn } })
      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe('There is no recording at that time.')
      const none = await get(viewer, a2) // camera 2 has no recordings at all
      expect(none.status).toBe(404)
      expect(nvr.downloadBodies).toEqual([])
      expect(spawn.calls).toHaveLength(0)
    })

    it('an NVR problem is 502: in camera terms for a CCTV viewer, in the words of describeNvrError with the IT view; no password, address or path appears', async () => {
      for (const camera of [w1, d1, x1]) {
        const res = await get(viewer, camera)
        expect(res.status, camera).toBe(502)
        expect(await res.json()).toEqual({ error: 'The recordings of this camera cannot be reached right now.' })
      }
      const cases: [string, string][] = [
        [w1, 'The NVR refused the user name or password.'],
        [d1, 'The NVR did not answer.'],
        [x1, 'The NVR gave an answer this app does not understand.'],
      ]
      for (const [camera, words] of cases) {
        const res = await get(manager, camera)
        expect(res.status, camera).toBe(502)
        const text = await res.text()
        expect(JSON.parse(text)).toEqual({ error: words })
        expect(text).not.toMatch(/secret-pass|not-the-password|127\.0\.0\.1|ISAPI|rtsp:/)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      }
      expect(nvrXml.downloadBodies).toHaveLength(2) // the document was the answer to a real download request (viewer and manager)
    })

    it('a missing ffmpeg is a plain 500 "ffmpeg is not installed on the server", before the NVR is asked for the download', async () => {
      const res = await serveVod(
        { rls: viewer.client, admin: admin(), nvr: nvrClient, conversions: limits, now: () => NOW, env: { FFMPEG: path.resolve('definitely-not-an-installed-program-xyz') } },
        { id: viewer.id, orgId },
        query(a1),
      )
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'ffmpeg is not installed on the server' })
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      expect(nvr.downloadBodies).toEqual([])
      expect(limits.running).toBe(0)
    })

    it('a program that cannot be started at the last moment is the same plain 500, and the place is given back', async () => {
      const res = await get(viewer, a1, {
        deps: {
          spawn: () => {
            throw Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })
          },
        },
      })
      expect(res.status).toBe(500)
      expect(await errorOf(res)).toBe('ffmpeg is not installed on the server')
      expect(limits.running).toBe(0)
    })

    it('a FFMPEG setting that is not a full path on one line is refused with a plain message and nothing is run or asked of the NVR', async () => {
      const spawn = fakeSpawn('copy')
      for (const bad of ['ffmpeg', './ffmpeg', '../ffmpeg', 'bin/ffmpeg', '/opt/ffmpeg\n-i evil']) {
        const res = await serveVod({ rls: viewer.client, admin: admin(), nvr: nvrClient, conversions: limits, now: () => NOW, env: { FFMPEG: bad }, spawn }, { id: viewer.id, orgId }, query(a1))
        expect(res.status, bad).toBe(500)
        expect(await errorOf(res)).toBe('FFMPEG must be the full path of the ffmpeg program.')
      }
      expect(spawn.calls).toHaveLength(0)
      expect(nvr.downloadBodies).toEqual([])
    })

    it('with no FFMPEG setting ffmpeg is only looked for on PATH entries that are full paths: a relative entry or "." is never used', async () => {
      const spawn = fakeSpawn('copy')
      const seen: string[] = []
      const lookup = { exists: (f: string) => (seen.push(f), false) }
      const tools = path.resolve('/opt/tools')
      const found = path.join(tools, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      const res = await serveVod(
        { rls: viewer.client, admin: admin(), nvr: nvrClient, conversions: limits, now: () => NOW, env: { PATH: ['.', '', 'bin', tools].join(path.delimiter) }, spawn, lookup },
        { id: viewer.id, orgId },
        query(a1),
      )
      expect(res.status).toBe(500)
      expect(await errorOf(res)).toBe('ffmpeg is not installed on the server')
      expect(seen).toEqual([found])
      expect(spawn.calls).toHaveLength(0)
      // and when it is there, it is that full path that is started
      const ok = await serveVod(
        { rls: viewer.client, admin: admin(), nvr: nvrClient, conversions: limits, now: () => NOW, env: { PATH: ['.', tools].join(path.delimiter) }, spawn, lookup: { exists: () => true } },
        { id: viewer.id, orgId },
        query(a1),
      )
      expect(ok.status).toBe(200)
      await readAll(ok)
      expect(spawn.calls[0].command).toBe(found)
    })

    it('ffmpeg not understanding the recording is a 502 with the plain format message, any other failure before video is a 502 too; the NVR transfer is ended and nothing is left running', async () => {
      const crash = fakeSpawn('crash')
      const other = await get(viewer, e1, { deps: { spawn: crash } })
      expect(other.status).toBe(502)
      expect(await errorOf(other)).toBe('The recording could not be converted for fast playback.')
      await waitFor(() => limits.running === 0)
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      nvrEnd.downloadsEnded.count = 0
      const spawn = fakeSpawn('fail')
      const res = await get(viewer, e1, { deps: { spawn } })
      expect(res.status).toBe(502)
      expect(await errorOf(res)).toBe("This recording's format is not supported for fast playback.")
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      await waitFor(() => limits.running === 0)
      expect(isAlive(spawn.children[0].pid)).toBe(false)
    })

    it('a start in the future or older than a year, and a request that is not valid, never reach the NVR', async () => {
      const future = await get(viewer, a1, { start: '2026-10-22T16:00:00Z' }) // shown now is 15:30; the allowance is 15 minutes
      expect(future.status).toBe(400)
      expect(await errorOf(future)).toBe('Choose a start time within the last year, not in the future.')
      expect((await get(viewer, a1, { start: '2025-10-01T10:00:00Z' })).status).toBe(400)
      expect((await get(viewer, a1, { start: '2026-10-22T15:44:00Z' })).status).toBe(404) // inside the allowance: asked, and there is no recording then
      expect(nvr.downloadBodies).toEqual([])
    })
  })

  describe('limits', () => {
    it('a person who starts a new playback has their previous one ended first (killed, NVR transfer ended), and the new one goes ahead', async () => {
      const spawnA = fakeSpawn('copy')
      const first = await get(u1, e1, { deps: { spawn: spawnA } })
      expect(first.status).toBe(200)
      const firstReader = first.body!.getReader()
      await firstReader.read()
      expect(limits.running).toBe(1)
      const other = await get(u2, e1) // somebody else is not touched
      expect(other.status).toBe(200)
      const otherReader = other.body!.getReader()
      await otherReader.read()

      const spawnB = fakeSpawn('copy')
      const second = await get(u1, e1, { deps: { spawn: spawnB } })
      expect(second.status).toBe(200)
      // the previous video was cut short, its process is gone
      await expect(
        (async () => {
          for (;;) if ((await firstReader.read()).done) return
        })(),
      ).rejects.toThrow()
      expect(isAlive(spawnA.children[0].pid)).toBe(false)
      await waitFor(() => nvrEnd.downloadsEnded.count >= 1)
      expect(limits.running).toBe(2) // the new one and the other person's
      expect(isAlive(spawnB.children[0].pid)).toBe(true)
      expect((await otherReader.read()).done).toBe(false) // still flowing

      await second.body!.cancel()
      await otherReader.cancel()
    })

    it('the new playback is refused (429) only when the previous one cannot be ended in time, and then the NVR is not asked', async () => {
      const stuck = limits.acquire(u1.id, () => {}) // a conversion that ignores the request to stop
      expect(stuck.ok).toBe(true)
      const res = await get(u1, e1, { deps: { timing: { killGraceMs: 300, supersedeMs: 250 } } })
      expect(res.status).toBe(429)
      expect(await errorOf(res)).toBe('You already have a fast playback running. Stop it first, then try again.')
      expect(nvrEnd.downloadBodies).toHaveLength(0)
      if (stuck.ok) stuck.release()
      expect(limits.running).toBe(0)
    })

    it('eight in all: the ninth person is 429 until one ends', async () => {
      limits = createConversionLimiter(1, 2)
      const a = await get(u1, e1)
      const b = await get(u2, e1)
      expect([a.status, b.status]).toEqual([200, 200])
      const c = await get(u3, e1)
      expect(c.status).toBe(429)
      expect(await errorOf(c)).toBe('The server is busy with other fast playbacks. Try again in a moment.')
      await a.body!.cancel()
      await waitFor(() => limits.running === 1)
      const d = await get(u3, e1)
      expect(d.status).toBe(200)
      await b.body!.cancel()
      await d.body!.cancel()
    })

    it('the real limiter allows eight', () => {
      const real = createConversionLimiter()
      const slots = Array.from({ length: 8 }, (_, i) => real.acquire(`p${i}`))
      expect(slots.every((s) => s.ok)).toBe(true)
      expect(real.acquire('p9')).toEqual({ ok: false, reason: 'total' })
      for (const s of slots) if (s.ok) s.release()
    })

    it('shares the 30 a minute count of video requests: over it is 429 and the NVR is not asked', async () => {
      const limiter = createWindowLimiter(2, 60_000)
      for (let i = 0; i < 2; i++) await readAll(await get(viewer, a1, { deps: { limiter } }))
      const before = nvr.requests.length
      const res = await get(viewer, a1, { deps: { limiter } })
      expect(res.status).toBe(429)
      expect(await errorOf(res)).toBe('Too many video requests. Please wait a minute and try again.')
      expect(nvr.requests).toHaveLength(before)
    })

    it('a request for a camera that cannot be seen takes no conversion place', async () => {
      for (let i = 0; i < 3; i++) expect((await get(u1, foreign)).status).toBe(404)
      expect(limits.running).toBe(0)
    })
  })

  describe('going away', () => {
    it('the person closing the page ends the NVR transfer and kills ffmpeg, and the place is free again', async () => {
      const spawn = fakeSpawn('copy')
      const gone = new AbortController()
      const res = await get(u1, e1, { deps: { spawn }, signal: gone.signal })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      await reader.read()
      const pid = spawn.children[0].pid
      expect(isAlive(pid)).toBe(true)
      gone.abort()
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return
        })(),
      ).rejects.toThrow()
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      await waitFor(() => limits.running === 0)
      expect(isAlive(pid)).toBe(false)
    })

    it('cancelling the response ends the NVR transfer and kills ffmpeg', async () => {
      const spawn = fakeSpawn('copy')
      const res = await get(u1, e1, { deps: { spawn } })
      const reader = res.body!.getReader()
      await reader.read()
      await reader.cancel()
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      await waitFor(() => limits.running === 0)
      expect(isAlive(spawn.children[0].pid)).toBe(false)
    })

    it('going away before the video has begun leaves nothing behind either', async () => {
      const gone = new AbortController()
      gone.abort()
      const res = await get(u1, a1, { signal: gone.signal })
      expect(res.status).toBe(499)
      expect(limits.running).toBe(0)
    })

    it('the longest time ends the video without an error and cleans up (an endless NVR download)', async () => {
      const spawn = fakeSpawn('copy')
      const res = await get(u1, e1, { deps: { spawn, timing: { maxMs: 600, killGraceMs: 300 } } })
      expect(res.status).toBe(200)
      const bytes = await readAll(res) // ends by itself
      expect(bytes.length).toBeGreaterThan(0)
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      await waitFor(() => limits.running === 0)
      expect(isAlive(spawn.children[0].pid)).toBe(false)
    })

    it('ffmpeg failing after the video has begun ends the video with an error and cleans up', async () => {
      const spawn = fakeSpawn('fail-late')
      const res = await get(u1, e1, { deps: { spawn } })
      expect(res.status).toBe(200)
      await expect(readAll(res)).rejects.toThrow()
      await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      await waitFor(() => limits.running === 0)
    })

    {
      it('ffmpeg that makes no output is given up on after the first-byte time with a 502, and killed', async () => {
        const spawn = fakeSpawn('hang')
        const res = await get(u1, e1, { deps: { spawn, timing: { firstByteMs: 400, killGraceMs: 300 } } })
        expect(res.status).toBe(502)
        await waitFor(() => limits.running === 0)
        expect(isAlive(spawn.children[0].pid)).toBe(false)
        await waitFor(() => nvrEnd.downloadsEnded.count === 1)
      })
    }
  })

  describe('the NVR is hostile', () => {
    const search = (uri: string) => {
      hostile = () => uri
    }
    it('a playback address with markup is escaped and goes only into the download request body', async () => {
      search('rtsp://h/p?starttime=20261022T090000Z&amp;endtime=20261022T100000Z&amp;x=&lt;/playbackURI&gt;&lt;evil/&gt;')
      const res = await get(u1, h1)
      expect(res.status).toBe(200)
      await readAll(res)
      expect(nvrHostile.downloadBodies).toHaveLength(1)
      const body = nvrHostile.downloadBodies[0]
      expect(body).not.toContain('<evil')
      expect(body.match(/<\/playbackURI>/g)).toHaveLength(1)
      expect(body).toContain('&lt;/playbackURI&gt;&lt;evil/&gt;')
      expect(body.match(/<playbackURI>/g)).toHaveLength(1)
    })

    it('an address that is another host is still only sent in the body to the same NVR: nothing is fetched from it', async () => {
      search('rtsp://evil.example:554/x?starttime=20261022T090000Z&amp;endtime=20261022T100000Z')
      const res = await get(u1, h1)
      expect(res.status).toBe(200) // the egress guard of the test run would have failed any other connection
      await readAll(res)
      expect(nvrHostile.downloadBodies[0]).toContain('rtsp://evil.example:554/x')
    })

    it('an address that is not rtsp or http(s), has a control character, or is longer than 512 characters is not used at all', async () => {
      for (const bad of ['file:///etc/passwd', 'ftp://h/x', 'javascript:alert(1)', `rtsp://h/${'a'.repeat(600)}`, 'rtsp://h/a b', '']) {
        search(bad)
        const res = await get(u1, h1)
        expect(res.status, bad.slice(0, 20)).toBe(404)
        expect(await errorOf(res)).toBe('This recording cannot be played at a faster speed.')
      }
      expect(nvrHostile.downloadBodies).toEqual([])
    })

    it('an address without starttime or endtime is refused (it would download a whole file), and nothing is asked of the NVR', async () => {
      for (const bad of ['rtsp://h/p?name=1', 'rtsp://h/p?starttime=20261022T090000Z', 'rtsp://h/p?endtime=20261022T100000Z']) {
        search(bad)
        const res = await get(u1, h1)
        expect(res.status, bad).toBe(404)
        expect(await errorOf(res)).toBe('This recording cannot be played at a faster speed.')
      }
      expect(nvrHostile.downloadBodies).toEqual([])
      expect(limits.running).toBe(0)
    })

    it('tags the picture hvc1 for H.265 recordings only', async () => {
      const wanted = 'rtsp://h/p?starttime=20261022T090000Z&amp;endtime=20261022T100000Z'
      search(wanted)
      for (const [codec, tagged] of [['H.265', true], ['HEVC', true], ['H.264-BP', false], [null, false]] as const) {
        hostileCodec = codec
        const spawn = fakeSpawn('copy')
        const res = await get(u1, h1, { deps: { spawn } })
        expect(res.status, String(codec)).toBe(200)
        await readAll(res)
        expect(spawn.calls[0].args, String(codec)).toEqual(buildFfmpegArgs({ hevc: tagged }))
        expect(spawn.calls[0].args.includes('hvc1'), String(codec)).toBe(tagged)
      }
    })

    it('a recording with no playback address at all cannot be fast-played', async () => {
      hostile = null
      const res = await get(u1, h1)
      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe('This recording cannot be played at a faster speed.')
    })
  })

  describe('the probe (?probe=1)', () => {
    const search265 = () => {
      hostile = () => 'rtsp://h/p?starttime=20261022T090000Z&amp;endtime=20261022T100000Z'
      hostileCodec = 'H.265'
    }
    it('does every check, then says ok without starting ffmpeg or downloading', async () => {
      const spawn = fakeSpawn('copy')
      const res = await get(viewer, a1, { more: '&probe=1', deps: { spawn } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, codec: 'h264' }) // the fake NVR calls its recordings H.264-BP
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(spawn.calls).toHaveLength(0)
      expect(nvr.downloadBodies).toEqual([])
      expect(limits.running).toBe(0)
    })

    it('gives the same plain errors as the video request would (camera terms without the IT view, P2-2 fix I-2)', async () => {
      const expected: [TestUser, string, number, string][] = [
        [viewer, foreign, 404, 'Camera not found.'],
        [viewer, n1, 502, 'The recordings of this camera cannot be reached right now.'],
        [viewer, w1, 502, 'The recordings of this camera cannot be reached right now.'],
        [viewer, a2, 404, 'There is no recording at that time.'],
        [manager, n1, 409, 'This NVR has no saved login.'],
        [manager, w1, 502, 'The NVR refused the user name or password.'],
      ]
      for (const [who, camera, status, words] of expected) {
        const res = await get(who, camera, { more: '&probe=1' })
        expect(res.status, camera).toBe(status)
        expect(await errorOf(res)).toBe(words)
      }
    })

    it('reports the video format of an H.265 recording', async () => {
      search265()
      const res = await get(u1, h1, { more: '&probe=1' })
      expect(await res.json()).toEqual({ ok: true, codec: 'h265' })
    })

    it('ignores the person\'s own running conversion (they are about to end it), but not a full server', async () => {
      const running = await get(u1, e1)
      const own = await get(u1, e1, { more: '&probe=1' })
      expect(own.status).toBe(200)
      expect(await own.json()).toMatchObject({ ok: true })
      expect(limits.running).toBe(1) // and it took nothing
      await running.body!.cancel()
      await waitFor(() => limits.running === 0)

      limits = createConversionLimiter(1, 1)
      const first = await get(u1, e1)
      const full = await get(u2, e1, { more: '&probe=1' })
      expect(full.status).toBe(429)
      expect(await errorOf(full)).toBe('The server is busy with other fast playbacks. Try again in a moment.')
      await first.body!.cancel()
    })

    it('says 500 when ffmpeg is not there', async () => {
      const missing = await get(viewer, a1, { more: '&probe=1', deps: { ffmpegAvailable: async () => false } })
      expect(missing.status).toBe(500)
      expect(await errorOf(missing)).toBe('ffmpeg is not installed on the server')

    })
  })

  describe.skipIf(!ffmpegWorks)('with the real ffmpeg', () => {
    let dir: string
    let sample: Buffer
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'vod-'))
      const out = path.join(dir, 'sample.mp4')
      // A tiny recording made once: two seconds of test picture, as a fragmented MP4 so that it can be read from a pipe.
      const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', out], { timeout: 30_000 })
      if (made.status !== 0) throw new Error('could not make the sample recording')
      sample = readFileSync(out)
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('turns the NVR download into a fragmented MP4 that begins with ftyp and has fragments', async () => {
      const real = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: RECORDINGS, downloadBytes: sample })
      try {
        const store = await addStore(orgId, 'VR', { port: real.port })
        await savePassword(store, NVR_PASSWORD)
        const cam = await addCamera(orgId, store, 1, 'Real ffmpeg')
        await grant(orgId, u1.id, WITH_EXPORT, atLocation(store))
        const res = await serveVod({ rls: u1.client, admin: admin(), nvr: nvrClient, conversions: limits, now: () => NOW, env: { PATH: process.env.PATH } }, { id: u1.id, orgId }, query(cam))
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('video/mp4')
        const bytes = await readAll(res)
        expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp')
        expect(bytes.includes(Buffer.from('moof', 'latin1'))).toBe(true)
        expect(bytes.length).toBeGreaterThan(500)
      } finally {
        await real.close()
      }
    })
  })
})
