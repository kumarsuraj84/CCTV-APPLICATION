// P5.5 item 3: the Release 1 exit criteria (docs/drishti/RELEASE-1.md, "Exit criteria for Release 1"), one assertion group per criterion,
// plus the owner rulings the release rests on (E-1 export only for administrators, D-L1 fast playback as a stream for cctv.playback,
// C-1 the Organisation â†’ Region â†’ Cluster â†’ Location â†’ NVR â†’ Camera scopes, P-1 the super administrator).
//
// Everything runs against the REAL local database through the application's own services and the people's own signed-in clients, in
// synthetic `test-â€¦` organisations made and removed here (the run's ledger catches anything left behind). Fakes on loopback only: fake
// NVRs (tests/helpers/fake-servers.ts), a fake go2rtc API and video socket, the real gateway in-process with its REST registry. No real
// NVR, camera or store is contacted and the owner's organisation is never read or written.
//
// The permission matrix is checked against an ORACLE written here in TypeScript from the fixture's own layout (which camera is in which
// location, cluster, region and on which NVR), not against another database answer, so a wrong scope rule in SQL makes it fail.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { applyChange, previewChange } from '@/lib/admin/access'
import { MSG_EXPORT_ADMINS_ONLY } from '@/lib/admin/access-rules'
import type { Actor } from '@/lib/admin/types'
import { createUser as createPerson, updateUser } from '@/lib/admin/users'
import { readCapabilities } from '@/lib/auth/capabilities'
import { addCameras, addGroupRule, createGroup } from '@/lib/groups/service'
import { applyLocationImport, checkLocationImport } from '@/lib/import/locations-import'
import { saveCluster, saveRegion } from '@/lib/inventory/hierarchy'
import { saveLocation } from '@/lib/inventory/locations'
import { saveRecorder } from '@/lib/inventory/recorder-admin'
import { treeLocations } from '@/lib/live/tree'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { discoverRecorderCameras } from '@/lib/monitor/discovery'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { NvrClient } from '@/lib/nvr/client'
import { getVisibleGroup } from '@/lib/queries/groups'
import { getVisibleStore, listVisibleDevices } from '@/lib/queries/inventory'
import { loadLiveLanding } from '@/lib/queries/live-landing'
import { openFastPlayback, serveFastStream, type FastDeps } from '@/lib/streams/fast'
import { createGateway, type GatewayServer } from '@/lib/streams/gateway'
import { openStreams } from '@/lib/streams/open'
import { openPlayback } from '@/lib/streams/playback'
import { createRestRegistry } from '@/lib/streams/registry'
import { createConversionLimiter, parseVodQuery, serveVod } from '@/lib/streams/vod'
import type { Database } from '@/types/database'
import { fakeRemux } from '../helpers/fake-remux'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { openSocket, startFakeGo2rtcWs, waitFor, type FakeGo2rtcWs, type Outcome } from '../helpers/fake-go2rtc-ws'
import { closedPort, startFakeNvr, startFakeRtsp, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'
import { makeFmp4 } from '../helpers/fmp4'
import {
  ADMINISTRATOR_SET, adminClient, atCamera, atCluster, atLocation, atRecorder, atRegion, cleanupOrg, createCamera, createCluster, createLocation, createOrg,
  createRecorder, createRegion, createUser, grant, ORG_SCOPE, type GrantScope, type TestUser,
} from '../setup/fixtures'
import { testFence } from '../setup/lease'

const admin = () => adminClient()
const ROOT = path.resolve(__dirname, '../..')
const SECRET = 'release1-exit-test-secret-0123456789abcdef'
const APP = 'http://app.test:3212'
const NVR_USER = 'viewer'
const NVR_PASSWORD = 'secret-pass'
const LIVE = 'cctv.live'
const PLAYBACK = 'cctv.playback'
const EXPORT = 'cctv.export'
const CCTV = [LIVE, PLAYBACK, EXPORT] as const
type Cap = (typeof CCTV)[number]
const sorted = (a: Iterable<string>) => [...a].sort()
const nvrClient = (ep: ConstructorParameters<typeof NvrClient>[0]) => new NvrClient(ep, { timeoutMs: 3000 })
// Fast playback runs on the shown (India) clock: "now" is 22 Oct 2026 10:00 real time = 15:30 shown; the fake NVR has 09:00-10:00.
const FAST_NOW = Date.UTC(2026, 9, 22, 10, 0, 0)
const FAST_START = new Date('2026-10-22T09:20:00Z')
const RECORDINGS = [{ start: '2026-10-22T09:00:00', end: '2026-10-22T10:00:00', channel: 1 }]
const CLIP = makeFmp4({ fragments: 3, fragmentSec: 1, payloadBytes: 1000 })

/** The person chooses their own password, as /change-password does (lib/actions/auth.ts): their own update, then the flag. */
async function choosePassword(email: string, oneTime: string): Promise<{ client: ReturnType<typeof createClient<Database>> }> {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } }
  const client = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, opts)
  const first = await client.auth.signInWithPassword({ email, password: oneTime })
  if (first.error || !first.data.user) throw new Error(`one-time sign-in failed: ${first.error?.message}`)
  const chosen = `${oneTime}-Own-9!`
  const upd = await client.auth.updateUser({ password: chosen })
  if (upd.error) throw new Error(`choosing a password failed: ${upd.error.message}`)
  const flag = await admin().from('profiles').update({ must_reset_password: false }).eq('id', first.data.user.id)
  if (flag.error) throw new Error(`clearing the flag failed: ${flag.error.message}`)
  const fresh = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, opts)
  const again = await fresh.auth.signInWithPassword({ email, password: chosen })
  if (again.error) throw new Error(`sign-in with the chosen password failed: ${again.error.message}`)
  return { client: fresh }
}

/** Grants (and removals) the way an administrator saves them in the access editor: preview, then save the previewed change. */
async function editAccess(actor: Actor, userId: string, changes: Record<string, unknown>[]) {
  const version = Number((await admin().from('profiles').select('access_version').eq('id', userId).single()).data!.access_version)
  const p = await previewChange(admin(), actor, userId, { changes, expectedVersion: version })
  if (!p.ok) return p
  return applyChange(admin(), actor, userId, { changes, expectedVersion: p.version, token: p.token })
}
const grantChange = (capability: string, scope: GrantScope, reason = 'release 1 exit test') =>
  ({ op: 'grant', capability, scope_kind: scope.kind, scope_id: scope.kind === 'organization' ? null : scope.id, valid_until: null, reason })

describe('Release 1 exit criteria (RELEASE-1.md)', () => {
  // â”€â”€ Organisation A: the permission matrix estate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // R1 â”€ C1 â”€ L1 (NVR a1, a2), L2 (NVR b)        R2 â”€ C3 â”€ L4 (NVR d)        L5 (no cluster: NVR e)
  //      â”” C2 â”€ L3 (NVR c1, c2, c3: the multi-NVR location)
  // Two cameras per NVR, channels 1 and 2 on every NVR (the same numbers on each NVR of a location).
  let orgA: string, orgB: string
  let R1: string, R2: string, C1: string, C2: string, C3: string
  const L: Record<string, string> = {}
  const NVR: Record<string, string> = {}
  const cams: { id: string; location: string; recorder: string; nvr: string; channel: number }[] = []
  const locationOf: Record<string, { cluster: string | null; region: string | null }> = {}
  const nvrPorts: Record<string, { http: number; rtsp: number }> = {}
  let foreignCamera: string
  let superAdmin: TestUser, superActor: Actor
  let go2rtc: FakeGo2rtc
  let nvrC1: FakeNvr
  let rtspC1: FakeRtsp
  const savedSecret = process.env.STREAM_TOKEN_SECRET

  type Person = { key: string; u: TestUser; role: 'user' | 'operator' | 'admin'; grants: [readonly string[], GrantScope][] }
  const people: Record<string, Person> = {}

  // The oracle: does this grant scope cover this camera? Written from the layout above, never from the database.
  function covers(scope: GrantScope, c: (typeof cams)[number]): boolean {
    const loc = locationOf[c.location]
    switch (scope.kind) {
      case 'organization': return true
      case 'region': return loc.region === scope.id
      case 'cluster': return loc.cluster === scope.id
      case 'location': return c.location === scope.id
      case 'recorder': return c.recorder === scope.id
      case 'camera': return c.id === scope.id
      default: return false
    }
  }
  function expected(p: Person, cap: Cap): string[] {
    return sorted(cams.filter((c) => p.grants.some(([caps, scope]) => caps.includes(cap) && covers(scope, c))).map((c) => c.id))
  }
  const allIds = () => cams.map((c) => c.id)
  const allowedBy = async (u: TestUser, cap: Cap) => sorted(((await u.client.rpc('cameras_with_capability', { p_cap: cap, p_ids: allIds() })).data ?? []) as string[])

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgA = await createOrg()
    orgB = await createOrg()
    R1 = await createRegion(orgA, { name: 'Exit region 1' })
    R2 = await createRegion(orgA, { name: 'Exit region 2' })
    C1 = await createCluster(orgA, R1, { name: 'Exit cluster 1' })
    C2 = await createCluster(orgA, R1, { name: 'Exit cluster 2' })
    C3 = await createCluster(orgA, R2, { name: 'Exit cluster 3' })
    nvrC1 = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, statuses: { 1: true, 2: false }, channels: [{ channel: 1, name: 'Door' }, { channel: 2, name: 'Till' }], recordings: RECORDINGS, downloadBytes: CLIP })
    rtspC1 = await startFakeRtsp('refuse')
    const layout: [string, string | null, string | null, string[]][] = [
      ['L1', C1, R1, ['a1', 'a2']], ['L2', C1, R1, ['b']], ['L3', C2, R1, ['c1', 'c2', 'c3']], ['L4', C3, R2, ['d']], ['L5', null, null, ['e']],
    ]
    let port = 0
    for (const [name, cluster, region, nvrs] of layout) {
      L[name] = await createLocation(orgA, { clusterId: cluster, name: `Exit ${name}` })
      locationOf[L[name]] = { cluster, region }
      for (const n of nvrs) {
        // c1 is a real fake NVR (monitor round, fast playback); the others get ports nothing listens on (never contacted here).
        const http = n === 'c1' ? nvrC1.port : await closedPort()
        const rtsp = n === 'c1' ? rtspC1.port : 20_000 + ++port
        nvrPorts[n] = { http, rtsp }
        NVR[n] = await createRecorder(orgA, L[name], { host: '127.0.0.1', httpPort: http, rtspPort: rtsp, username: NVR_USER, secret: NVR_PASSWORD, name: `NVR ${n}` })
        for (const ch of [1, 2]) cams.push({ id: await createCamera(orgA, { locationId: L[name], recorderId: NVR[n], channel: ch, name: `${n} camera ${ch}` }), location: L[name], recorder: NVR[n], nvr: n, channel: ch })
      }
    }
    const lb = await createLocation(orgB, { name: 'Other organisation location' })
    const rb = await createRecorder(orgB, lb, { host: '127.0.0.1', httpPort: await closedPort(), rtspPort: 29_999, secret: NVR_PASSWORD })
    foreignCamera = await createCamera(orgB, { locationId: lb, recorderId: rb, channel: 1 })

    superAdmin = await createUser(orgA, 'platform_owner')
    expect((await admin().rpc('grant_platform_owner_all', { p_org: orgA, p_user: superAdmin.id })).error).toBeNull()
    superActor = { id: superAdmin.id, orgId: orgA, role: 'platform_owner' }

    const camOf = (n: string, ch: number) => cams.find((c) => c.nvr === n && c.channel === ch)!.id
    const add = async (key: string, role: Person['role'], grants: Person['grants'], org = orgA) => {
      const u = await createUser(org, role)
      for (const [caps, scope] of grants) await grant(org, u.id, caps, scope, {})
      people[key] = { key, u, role, grants: org === orgA ? grants : [] }
    }
    await add('organisation', 'user', [[[LIVE, PLAYBACK], ORG_SCOPE]])
    await add('region R1 live', 'user', [[[LIVE], atRegion(R1)]])
    await add('cluster C1', 'user', [[[LIVE, PLAYBACK], atCluster(C1)]])
    await add('location L3 (three NVRs)', 'operator', [[[LIVE, PLAYBACK], atLocation(L[`L3`])]])
    await add('NVR c2 only', 'user', [[[LIVE], atRecorder(NVR.c2)]])
    await add('one camera', 'user', [[[LIVE, PLAYBACK], atCamera(camOf('d', 1))]])
    await add('live L5, playback C2', 'user', [[[LIVE], atLocation(L.L5)], [[PLAYBACK], atCluster(C2)]])
    await add('live only, region R2', 'user', [[[LIVE], atRegion(R2)]])
    await add('administrator: export C1', 'admin', [[[LIVE, PLAYBACK, EXPORT], atCluster(C1)]])
    await add('administrator: export without playback', 'admin', [[[EXPORT], atLocation(L.L2)], [[LIVE], atLocation(L.L2)]])
    await add('IT only at L1', 'user', [[['it.inventory.view', 'it.monitoring.view'], atLocation(L.L1)]])
    await add('nothing', 'user', [])
    await add('other organisation', 'admin', [[[LIVE, PLAYBACK, EXPORT], ORG_SCOPE]], orgB)
    go2rtc = await startFakeGo2rtc()
  }, 180_000)

  afterAll(async () => {
    await go2rtc?.close()
    await nvrC1?.close()
    await rtspC1?.close()
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  }, 120_000)

  // â”€â”€ Exit criterion 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('EX-1 cross-user / location / cluster / region / NVR / camera / action permission tests', () => {
    it('EX-1.1 matrix: for every person and every action (live, playback, export) the database allows exactly the oracle\'s cameras', async () => {
      const wrong: string[] = []
      for (const p of Object.values(people)) {
        for (const cap of CCTV) {
          const db = await allowedBy(p.u, cap)
          const want = expected(p, cap)
          if (JSON.stringify(db) !== JSON.stringify(want)) wrong.push(`${p.key} ${cap}: database ${db.length}, oracle ${want.length}`)
        }
        // What the person can read at all (row security on cameras) is the union of their CCTV rights; IT rights show no camera (AC-4).
        const { data, error } = await p.u.client.from('cameras').select('id').in('id', [...allIds(), foreignCamera])
        expect(error, p.key).toBeNull()
        // (The other organisation's person reads exactly their own organisation's camera.)
        const union = p.key === 'other organisation' ? [foreignCamera] : sorted(new Set(CCTV.flatMap((cap) => expected(p, cap))))
        if (JSON.stringify(sorted((data ?? []).map((r) => r.id))) !== JSON.stringify(union)) wrong.push(`${p.key}: readable cameras differ from the union of the grants`)
      }
      expect(wrong.join('\n')).toBe('')
      // The matrix is not trivial: it holds everything, nothing and many sizes in between.
      const sizes = new Set(Object.values(people).map((p) => expected(p, LIVE).length))
      expect(sizes.has(cams.length)).toBe(true)
      expect(sizes.has(0)).toBe(true)
      expect(sizes.size).toBeGreaterThanOrEqual(6)
    })

    it('EX-1.2 cross-organisation: the other organisation\'s administrator with every CCTV right sees and opens none of A\'s cameras, and A sees none of theirs', async () => {
      const stranger = people['other organisation'].u
      expect((await stranger.client.from('cameras').select('id').in('id', allIds())).data).toEqual([])
      for (const cap of CCTV) expect(await allowedBy(stranger, cap)).toEqual([])
      const r = await openStreams({ admin: admin(), rls: stranger.client, go2rtc: go2rtc.client, env: {} }, { id: stranger.id, orgId: orgB }, allIds().slice(0, 10), 'sub')
      expect(r).toEqual({ ok: true, streams: [] })
      expect((await people.organisation.u.client.from('cameras').select('id').eq('id', foreignCamera)).data).toEqual([])
      // Positive control: the stranger does see their own organisation's camera.
      expect((await stranger.client.from('cameras').select('id').eq('id', foreignCamera)).data).toEqual([{ id: foreignCamera }])
    })

    it('EX-1.3 the live action (openStreams) hands out tokens for exactly the person\'s live cameras, and touches go2rtc for nothing else', async () => {
      const wrong: string[] = []
      for (const p of Object.values(people)) {
        if (p.key === 'other organisation') continue
        go2rtc.seen.length = 0
        const r = await openStreams({ admin: admin(), rls: p.u.client, go2rtc: go2rtc.client, env: {} }, { id: p.u.id, orgId: orgA }, allIds(), 'sub')
        if (!r.ok) throw new Error(`${p.key}: ${r.error}`)
        const got = sorted(r.streams.map((s) => s.cameraId))
        if (JSON.stringify(got) !== JSON.stringify(expected(p, LIVE))) wrong.push(`${p.key}: opened ${got.length}, oracle ${expected(p, LIVE).length}`)
        const registered = new Set(go2rtc.seen.filter((s) => s.method === 'PUT').map((s) => s.name))
        for (const name of registered) if (!expected(p, LIVE).some((c) => name === `cam_${c}_sub`)) wrong.push(`${p.key}: go2rtc was asked for ${name}`)
      }
      expect(wrong.join('\n')).toBe('')
    })

    it('EX-1.4 playback (1x) and export (the file path) per camera follow the matrix: playback needs cctv.playback; a file needs export AND playback', async () => {
      const wrong: string[] = []
      const start = new Date(Date.now() - 2 * 3600_000)
      for (const key of ['cluster C1', 'live only, region R2', 'live L5, playback C2', 'administrator: export C1', 'administrator: export without playback', 'one camera', 'nothing']) {
        const p = people[key]
        const may = new Set(expected(p, PLAYBACK))
        const mayFile = new Set(expected(p, EXPORT).filter((c) => may.has(c)))
        for (const c of cams) {
          const r = await openPlayback({ admin: admin(), rls: p.u.client, go2rtc: go2rtc.client, env: {} }, { id: p.u.id, orgId: orgA }, c.id, start, 5, 0)
          if (r.ok !== may.has(c.id)) wrong.push(`${key} playback ${c.nvr}/${c.channel}: ${r.ok ? 'opened' : 'refused'}`)
          if (!r.ok) expect(r.error).toBe('Camera not found.')
          const q = parseVodQuery(new URLSearchParams(`camera=${c.id}&start=${start.toISOString().slice(0, 19)}Z&minutes=5&probe=1`))
          if (!q.ok) throw new Error(q.error)
          const res = await serveVod({ admin: admin(), rls: p.u.client, nvr: nvrClient, conversions: createConversionLimiter(), ffmpegAvailable: async () => false, env: { FFMPEG: 'C:\\no\\ffmpeg.exe' } }, { id: p.u.id, orgId: orgA }, q.query)
          const body = res.status === 200 ? null : ((await res.json()) as { error: string }).error
          const refused = (res.status === 404 && body === 'Camera not found.') || res.status === 403
          if (refused === mayFile.has(c.id)) wrong.push(`${key} export ${c.nvr}/${c.channel}: ${refused ? 'refused' : 'let through'} (${res.status})`)
        }
      }
      expect(wrong.join('\n')).toBe('')
      // Export somewhere is real for the administrator of C1 (the positive control of the file path).
      expect(expected(people['administrator: export C1'], EXPORT).length).toBeGreaterThan(0)
    })
  })

  describe('EX-1 playback and export denied despite live', () => {
    it('EX-1.5 a live-only person gets no playback token, no fast playback token, no file, no calendar; the NVR is never asked', async () => {
      const p = people['live only, region R2']
      const cam = cams.find((c) => c.nvr === 'd')!.id
      expect(await allowedBy(p.u, LIVE)).toContain(cam)
      const who = { id: p.u.id, orgId: orgA }
      nvrC1.requests.length = 0
      expect(await openPlayback({ admin: admin(), rls: p.u.client, go2rtc: go2rtc.client, env: {} }, who, cam, new Date(Date.now() - 3600_000), 5, 0)).toEqual({ ok: false, error: 'Camera not found.' })
      const fast = await openFastPlayback({ rls: p.u.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), conversions: createConversionLimiter(), now: () => FAST_NOW, offsetMin: 0 }, who, cam, FAST_START, 5, 8)
      expect(fast).toEqual({ ok: false, error: 'Camera not found.' })
      // The same for a live-only camera on the reachable fake NVR: refused before any NVR request.
      const liveOnC1 = await createUser(orgA, 'user')
      await grant(orgA, liveOnC1.id, LIVE, atRecorder(NVR.c1))
      const c1cam = cams.find((c) => c.nvr === 'c1')!.id
      const f2 = await openFastPlayback({ rls: liveOnC1.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), conversions: createConversionLimiter(), now: () => FAST_NOW, offsetMin: 0 }, { id: liveOnC1.id, orgId: orgA }, c1cam, FAST_START, 5, 8)
      expect(f2).toEqual({ ok: false, error: 'Camera not found.' })
      expect(nvrC1.requests).toEqual([])
    })

    it('EX-1.6 live and playback without export: fast playback is a stream (no file headers), the file path is "Camera not found."', async () => {
      const viewer = await createUser(orgA, 'user')
      await grant(orgA, viewer.id, [LIVE, PLAYBACK], atRecorder(NVR.c1))
      const cam = cams.find((c) => c.nvr === 'c1' && c.channel === 1)!.id
      const limits = createConversionLimiter()
      const deps: FastDeps = { rls: viewer.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), conversions: limits, now: () => FAST_NOW, offsetMin: 0, timing: { killGraceMs: 300 } }
      const who = { id: viewer.id, orgId: orgA }
      const t = await openFastPlayback(deps, who, cam, FAST_START, 5, 16)
      if (!t.ok) throw new Error(t.error)
      const res = await serveFastStream(deps, who, t.token)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/vnd.ckdrishti.stream')
      expect(res.headers.get('content-disposition')).toBeNull()
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
      await waitFor(() => limits.running === 0, 8000, 'the stream to end')
      const q = parseVodQuery(new URLSearchParams(`camera=${cam}&start=2026-10-22T09:20:00Z&minutes=5`))
      if (!q.ok) throw new Error(q.error)
      nvrC1.requests.length = 0
      const file = await serveVod({ admin: admin(), rls: viewer.client, nvr: nvrClient, conversions: createConversionLimiter(), ffmpegAvailable: async () => true, env: {} }, who, q.query)
      expect([403, 404]).toContain(file.status)
      expect(((await file.json()) as { error: string }).error).toMatch(/^(Camera not found\.|Downloading recordings is not available for your account\.)$/)
      expect(nvrC1.requests).toEqual([])
    })
  })

  describe('EX-1 camera-only (CCTV-only) users see no IT data', () => {
    beforeAll(async () => {
      // NVR d down, its cameras "recorder not reachable"; the checker's own words on a camera (IT detail) must never reach a CCTV viewer.
      const at = new Date().toISOString()
      const d = cams.filter((c) => c.nvr === 'd')
      const rows = [
        { org_id: orgA, target_type: 'recorder', target_id: NVR.d, status: 'down', last_checked_at: at, error: 'NVR login refused at 127.0.0.1' },
        ...d.map((c) => ({ org_id: orgA, target_type: 'camera', target_id: c.id, status: 'down', method: 'nvr_down', last_checked_at: at, error: 'The NVR at 127.0.0.1 did not answer' })),
      ]
      const { error } = await admin().from('check_state').insert(rows as never)
      expect(error).toBeNull()
      expect((await admin().from('assets').insert({ org_id: orgA, location_id: L.L4, type: 'server', name: 'Back office PC', ip: '192.0.2.77' })).error).toBeNull()
      expect((await admin().from('assets').insert({ org_id: orgA, location_id: L.L1, type: 'server', name: 'L1 PC', ip: '192.0.2.78' })).error).toBeNull()
    })

    it('EX-1.7 a camera-only and a location CCTV viewer read no asset, NVR row, NVR status, address, login, mapping, reason or NVR figure', async () => {
      for (const key of ['one camera', 'live only, region R2']) {
        const c = people[key].u.client
        const empty = async (q: PromiseLike<{ data: unknown[] | null; error: unknown }>, what: string) => {
          const { data, error } = await q
          expect(error, `${key} ${what}`).toBeNull()
          expect(data, `${key} ${what}`).toEqual([])
        }
        await empty(c.from('assets').select('id'), 'assets')
        await empty(c.from('recorders').select('id'), 'recorders')
        await empty(c.from('recorder_status').select('recorder_id'), 'recorder_status')
        await empty(c.from('recorder_endpoints').select('recorder_id'), 'recorder_endpoints')
        await empty(c.from('camera_endpoints').select('camera_id'), 'camera_endpoints')
        await empty(c.from('asset_endpoints').select('asset_id'), 'asset_endpoints')
        await empty(c.from('camera_channel_mappings').select('camera_id'), 'camera_channel_mappings')
        await empty(c.from('check_state').select('target_id').eq('target_type', 'recorder'), 'recorder check_state')
        await empty(c.rpc('wifi_inventory') as never, 'wifi_inventory')
        expect(await listVisibleDevices(c), key).toEqual([])
        // The camera address and its NVR are not columns a signed-in person may select.
        expect((await c.from('cameras').select('camera_ip').limit(1)).error, key).not.toBeNull()
        expect((await c.from('cameras').select('recorder_id').limit(1)).error, key).not.toBeNull()
        // Location figures: cameras yes, NVR figures never.
        const { data: ls } = await c.from('location_status').select('location_id, cameras_total, recorders_total, recorders_down, nvr_status, nvr_down_since').eq('location_id', L.L4)
        expect(ls?.length, key).toBe(1)
        expect(ls![0].cameras_total, key).toBeGreaterThan(0)
        // L4 has one NVR (down): the figures count only the NVRs the person may see, i.e. none (0 or empty, never 1 and never its state).
        expect(ls![0].recorders_total ?? 0, key).toBe(0)
        expect(ls![0].recorders_down ?? 0, key).toBe(0)
        expect(ls![0].nvr_status, key).toBeNull()
        expect(ls![0].nvr_down_since, key).toBeNull()
        const roll = ((await c.rpc('status_rollups', { p_cap: LIVE })).data ?? []) as { recorders_total: number | null }[]
        expect(roll.length, key).toBeGreaterThan(0)
        for (const r of roll) expect(r.recorders_total, key).toBeNull()
        // The reason for a down camera is in camera terms; the NVR's reason is not given at all.
        const dcam = cams.find((x) => x.nvr === 'd' && x.channel === 1)!.id
        const reasons = ((await c.rpc('status_reasons', { p_type: 'camera', p_ids: [dcam] })).data ?? []) as { reason: string }[]
        expect(reasons.map((r) => r.reason), key).toEqual(['Recorder not reachable.'])
        expect((await c.rpc('status_reasons', { p_type: 'recorder', p_ids: [NVR.d] })).data ?? [], key).toEqual([])
        const store = await getVisibleStore(c, L.L4)
        expect(store?.devices, key).toEqual([])
        expect(store?.showsAddresses, key).toBe(false)
        expect(store?.recorders, key).toEqual([])
        const summary = await readCapabilities(c)
        expect(summary.failed, key).toBe(false)
        expect(Object.keys(summary.grants).filter((k) => k.startsWith('it.') || k.startsWith('wifi.')), key).toEqual([])
      }
    })

    it('EX-1.8 positive control: the IT view at L1 does show L1\'s NVRs, their status and its PC (so the empty answers above are real refusals)', async () => {
      const c = people['IT only at L1'].u.client
      expect(sorted(((await c.from('recorders').select('id')).data ?? []).map((r) => r.id))).toEqual(sorted([NVR.a1, NVR.a2]))
      expect(((await c.from('recorder_status').select('recorder_id')).data ?? []).length).toBe(2)
      expect((await listVisibleDevices(c)).map((d) => d.name)).toEqual(['L1 PC'])
      expect((await c.from('cameras').select('id')).data).toEqual([]) // IT rights never show a camera (AC-4)
    })
  })

  describe('EX-1 locations with several NVRs', () => {
    it('EX-1.9 a location grant covers every camera of all three NVRs; live opens each camera through ITS OWN NVR (address, video port, channel)', async () => {
      const p = people['location L3 (three NVRs)']
      const l3 = cams.filter((c) => c.location === L.L3)
      expect(l3).toHaveLength(6)
      go2rtc.seen.length = 0
      const r = await openStreams({ admin: admin(), rls: p.u.client, go2rtc: go2rtc.client, env: {} }, { id: p.u.id, orgId: orgA }, l3.map((c) => c.id), 'sub')
      if (!r.ok) throw new Error(r.error)
      expect(sorted(r.streams.map((s) => s.cameraId))).toEqual(sorted(l3.map((c) => c.id)))
      for (const c of l3) {
        // What go2rtc holds for the stream (registered by this or an earlier opening of the same camera).
        const registered = go2rtc.streams.get(`cam_${c.id}_sub`)
        expect(registered, `${c.nvr}/${c.channel}`).toBeDefined()
        const src = new URL(registered!)
        expect(`${src.hostname}:${src.port}${src.pathname}`).toBe(`127.0.0.1:${nvrPorts[c.nvr].rtsp}/Streaming/Channels/${c.channel}02`)
      }
      // The same channel numbers on the three NVRs never collide: six different streams.
      expect(new Set(r.streams.map((s) => s.cameraId)).size).toBe(6)
    })

    it('EX-1.10 an NVR grant covers only that NVR\'s cameras of the location, and never makes the location whole', async () => {
      const p = people['NVR c2 only']
      expect(await allowedBy(p.u, LIVE)).toEqual(sorted(cams.filter((c) => c.nvr === 'c2').map((c) => c.id)))
      expect((await p.u.client.rpc('has_capability_for', { p_cap: LIVE, p_kind: 'location', p_id: L.L3 })).data).toBe(false)
      expect((await p.u.client.from('recorders').select('id')).data).toEqual([]) // a CCTV grant on an NVR still shows no NVR row (AC-4)
    })

    it('EX-1.11 a monitor round over the multi-NVR location: the down NVR marks only its own cameras, with the NVR as the cause', async () => {
      // A runner scoped to organisation A only, with this file's test lease, and with no write to the shared worker_state row.
      class ScopedDb extends SupabaseMonitorDb {
        override async markRound(): Promise<void> {}
      }
      const runner = new MonitorRunner({ db: new ScopedDb(admin(), { orgId: orgA, fence: await testFence() }), probes: realProbes, cfg: { ...loadMonitorConfig({}), nvrTimeoutMs: 2000 }, clock: () => new Date() })
      // Only the multi-NVR location is in the round: switch the others off (nothing contacts a switched-off NVR).
      for (const n of ['a1', 'a2', 'b', 'd', 'e']) expect((await admin().rpc('recorder_set_monitoring', { p_org: orgA, p_recorder: NVR[n], p_enabled: false, p_reason: 'exit test: not in this round' })).error).toBeNull()
      expect((await admin().rpc('recorder_set_monitoring', { p_org: orgA, p_recorder: NVR.c3, p_enabled: false, p_reason: 'exit test: switched off' })).error).toBeNull()
      try {
        // Final fix X (review C M-6): an NVR is called down after three failed reachability checks; as in production the NVR checks
        // (every minute) run more often than the camera rounds (every five).
        await runner.runDevices()
        for (let i = 0; i < 2; i++) {
          await runner.runDevices()
          await runner.runCameras()
        }
        const state = async (type: string, id: string) => (await admin().from('check_state').select('status, method').eq('org_id', orgA).eq('target_type', type).eq('target_id', id).maybeSingle()).data
        expect((await state('recorder', NVR.c1))?.status).toBe('up')
        expect((await state('recorder', NVR.c2))?.status).toBe('down')
        expect(await state('recorder', NVR.c3)).toBeNull() // switched off: never checked
        for (const c of cams.filter((x) => x.nvr === 'c2')) expect(await state('camera', c.id)).toMatchObject({ status: 'down', method: 'nvr_down' })
        // c1's cameras are checked on c1's own channel list: channel 1 online; channel 2 offline by the NVR's own report.
        expect((await state('camera', cams.find((x) => x.nvr === 'c1' && x.channel === 1)!.id))?.status).toBe('up')
        expect((await state('camera', cams.find((x) => x.nvr === 'c1' && x.channel === 2)!.id))?.method).not.toBe('nvr_down')
        for (const c of cams.filter((x) => x.nvr === 'c3')) expect(await state('camera', c.id)).toBeNull()
      } finally {
        for (const n of ['a1', 'a2', 'b', 'c3', 'd', 'e']) await admin().rpc('recorder_set_monitoring', { p_org: orgA, p_recorder: NVR[n], p_enabled: true, p_reason: 'exit test: back on' })
      }
    }, 60_000)
  })

  describe('EX-1 revocation within 60 s, for open video and for tokens issued before', () => {
    let api: FakeGo2rtc, video: FakeGo2rtcWs, gateway: GatewayServer, port: number
    const sockets: WebSocket[] = []
    beforeAll(async () => {
      api = await startFakeGo2rtc()
      video = await startFakeGo2rtcWs()
      // The PRODUCTION check interval (15 s, the default): the bound is measured as it would be in production.
      gateway = createGateway({ go2rtcUrl: video.url, secret: SECRET, allowedOrigins: [APP], registry: createRestRegistry({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY! }) })
      port = await new Promise<number>((resolve) => gateway.listen(0, '127.0.0.1', () => resolve((gateway.address() as AddressInfo).port)))
    })
    afterAll(async () => {
      sockets.forEach((s) => s.terminate())
      await gateway?.shutdown(1000)
      await api?.close()
      await video?.close()
    })
    const connect = (token: string) => {
      const s = openSocket(`ws://127.0.0.1:${port}/g/ws?token=${encodeURIComponent(token)}`, APP)
      sockets.push(s.ws)
      return s
    }
    async function watchLive(u: TestUser, cameras: string[]) {
      const r = await openStreams({ admin: admin(), rls: u.client, go2rtc: api.client, env: {} }, { id: u.id, orgId: orgA }, cameras, 'sub')
      if (!r.ok) throw new Error(r.error)
      expect(r.streams).toHaveLength(cameras.length)
      return r.streams.map((s) => s.token)
    }
    async function open(token: string) {
      const s = connect(token)
      expect(await s.opened).toBe(true)
      await new Promise((r) => setTimeout(r, 300)) // the registry answered and the upstream is connected
      expect(s.ws.readyState, 'open after the registry answered').toBe(WebSocket.OPEN)
      return s
    }
    const closeWithin = async (s: { closed: Promise<Outcome> }, since: number, boundMs: number) => {
      const r = await Promise.race([s.closed, new Promise<Outcome>((resolve) => setTimeout(() => resolve({ error: 'still open' }), boundMs))])
      return { outcome: r, ms: Date.now() - since }
    }

    it('EX-1.12 removing a grant (access editor), moving a location out of a cluster, and deactivating a person each close the open socket with 4403 in under 60 s', async () => {
      const lc = cams.find((c) => c.nvr === 'b' && c.channel === 1)!.id // in L2, cluster C1
      const lc2 = cams.find((c) => c.nvr === 'a1' && c.channel === 1)!.id // in L1, cluster C1
      const l5 = cams.find((c) => c.nvr === 'e' && c.channel === 1)!.id
      const editorCase = await createUser(orgA, 'user')
      const [editorGrant] = await grant(orgA, editorCase.id, LIVE, atCluster(C1))
      const moveCase = await createUser(orgA, 'user')
      await grant(orgA, moveCase.id, LIVE, atCluster(C1))
      const offCase = await createUser(orgA, 'user')
      await grant(orgA, offCase.id, LIVE, atLocation(L.L5))
      const bystander = await createUser(orgA, 'user')
      await grant(orgA, bystander.id, LIVE, ORG_SCOPE)

      const [tEditor] = await watchLive(editorCase, [lc])
      const [tMove] = await watchLive(moveCase, [lc2])
      const [tOff] = await watchLive(offCase, [l5])
      const [tBy] = await watchLive(bystander, [lc])
      const sEditor = await open(tEditor)
      const sMove = await open(tMove)
      const sOff = await open(tOff)
      const sBy = await open(tBy)
      // Tokens issued BEFORE the changes, inside their 90 s window, for the same cameras.
      const [spareEditor] = await watchLive(editorCase, [lc])

      const t0 = Date.now()
      const removed = await editAccess(superActor, editorCase.id, [{ op: 'revoke', grant_id: editorGrant, reason: 'exit test: removed in the editor' }])
      expect(removed).toMatchObject({ ok: true, revoked: 1 })
      expect((await admin().rpc('inventory_move_location', { p_org: orgA, p_location: L.L1, p_cluster: C2, p_actor: superAdmin.id })).error).toBeNull()
      expect(await updateUser(admin(), superActor, offCase.id, { is_active: false })).toMatchObject({ ok: true })
      try {
        const [a, b, c] = await Promise.all([closeWithin(sEditor, t0, 60_000), closeWithin(sMove, t0, 60_000), closeWithin(sOff, t0, 60_000)])
        console.log(JSON.stringify({ release1_revocation_ms: { editor_removal: a.ms, location_moved_out_of_cluster: b.ms, deactivated: c.ms }, checkEverySec: gateway.health().validateEverySec }))
        expect(gateway.health().validateEverySec).toBe(15)
        expect(a.outcome).toEqual({ code: 4403, reason: 'Access changed' })
        expect(b.outcome).toEqual({ code: 4403, reason: 'Access changed' })
        expect(c.outcome).toEqual({ code: 4403, reason: 'Access changed' })
        for (const x of [a, b, c]) expect(x.ms).toBeLessThan(60_000)
        // The bystander on the same camera is untouched.
        expect(sBy.ws.readyState).toBe(WebSocket.OPEN)
        // The token issued before the removal cannot open anything now.
        expect(await connect(spareEditor).closed).toEqual({ code: 1008, reason: 'Not allowed' })
      } finally {
        await admin().rpc('inventory_move_location', { p_org: orgA, p_location: L.L1, p_cluster: C1, p_actor: superAdmin.id })
      }
    }, 90_000)

    it('EX-1.13 tokens issued before a revocation open nothing: a live token, a 1x playback token (gateway) and a fast playback token', async () => {
      const u = await createUser(orgA, 'user')
      const ids = await grant(orgA, u.id, [LIVE, PLAYBACK], atRecorder(NVR.c1))
      const cam = cams.find((c) => c.nvr === 'c1' && c.channel === 1)!.id
      const who = { id: u.id, orgId: orgA }
      const [live] = await watchLive(u, [cam])
      const pb = await openPlayback({ admin: admin(), rls: u.client, go2rtc: api.client, env: {} }, who, cam, new Date(Date.now() - 2 * 3600_000), 5, 0)
      if (!pb.ok) throw new Error(pb.error)
      const limits = createConversionLimiter()
      const deps: FastDeps = { rls: u.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), conversions: limits, now: () => FAST_NOW, offsetMin: 0, timing: { killGraceMs: 300 } }
      const fast = await openFastPlayback(deps, who, cam, FAST_START, 5, 8)
      if (!fast.ok) throw new Error(fast.error)
      // Positive control: a 1x playback token of the same person opens before any revocation.
      const pbControl = await openPlayback({ admin: admin(), rls: u.client, go2rtc: api.client, env: {} }, who, cam, new Date(Date.now() - 3 * 3600_000), 5, 0)
      if (!pbControl.ok) throw new Error(pbControl.error)
      const control = await open(pbControl.token)
      control.ws.close()

      expect((await admin().rpc('revoke_grant', { p_org: orgA, p_user: u.id, p_grant_ids: ids, p_reason: 'exit test: all video taken away' })).error).toBeNull()
      expect(await connect(live).closed).toEqual({ code: 1008, reason: 'Not allowed' })
      expect(await connect(pb.token).closed).toEqual({ code: 1008, reason: 'Not allowed' })
      nvrC1.requests.length = 0
      const res = await serveFastStream(deps, who, fast.token)
      expect(res.status).toBe(404)
      expect(nvrC1.requests).toEqual([])
    }, 60_000)
  })

  // â”€â”€ Exit criterion 2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('EX-2 pilot-style rehearsal on lab fakes: add NVRs, build the hierarchy, import, groups, users, sign in as each user type', () => {
    let orgP: string
    let nvr: FakeNvr
    let boss: TestUser, bossActor: Actor
    beforeAll(async () => {
      orgP = await createOrg()
      nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, statuses: { 1: true, 2: true, 3: true, 4: true }, channels: [1, 2, 3, 4].map((ch) => ({ channel: ch, name: `Pilot camera ${ch}`, ip: `192.0.2.${100 + ch}` })) })
      // The first super administrator, as the owner's set-up script makes them (scripts/create-dev-admin.mjs: the full set).
      boss = await createUser(orgP, 'platform_owner')
      expect((await admin().rpc('grant_platform_owner_all', { p_org: orgP, p_user: boss.id })).error).toBeNull()
      bossActor = { id: boss.id, orgId: orgP, role: 'platform_owner' }
    })
    afterAll(async () => {
      await nvr?.close()
      await cleanupOrg(orgP)
    }, 60_000)

    it('EX-2.1 the whole rehearsal: every user type sees exactly the right cameras, on the Live screen and when opening video', async () => {
      const clients = { admin: admin(), rls: boss.client }
      // 1. Hierarchy and the first location with its NVR (the screens' services), cameras found on the fake NVR.
      const region = await saveRegion(clients, bossActor, { code: 'PN', name: 'Pilot North' })
      if (!region.ok) throw new Error(region.error)
      const cluster = await saveCluster(clients, bossActor, { code: 'PN-1', name: 'Pilot North 1', regionId: region.id })
      if (!cluster.ok) throw new Error(cluster.error)
      const first = await saveLocation(clients, bossActor, { code: 'PIL1', kind: 'store', name: 'Pilot one', city: 'Patna', clusterId: cluster.id })
      if (!first.ok) throw new Error(first.error)
      const rec = await saveRecorder(clients, bossActor, first.locationId, { name: 'Ground floor', host: '127.0.0.1', httpPort: nvr.port, rtspPort: 554, username: NVR_USER, password: NVR_PASSWORD, expectedChannels: 4, clockOffsetSec: null })
      if (!rec.ok) throw new Error(rec.error)
      const found = await discoverRecorderCameras(clients, bossActor, rec.recorderId, { nvr: nvrClient })
      if (!found.ok) throw new Error(found.error)
      const pil1 = ((await admin().from('cameras').select('id').eq('location_id', first.locationId).is('archived_at', null)).data ?? []).map((c) => c.id)
      expect(pil1).toHaveLength(4)

      // 2. A synthetic CSV: a second location in the same cluster with two NVRs, a third in a new region and cluster.
      const csv = [
        'code,name,display_name,kind,city,zone,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring',
        'PIL2,,Pilot two,store,Gaya,BR,PN,PN-1,192.0.2.21,,,viewer,Pw-pilot-2a,3,Ground floor,',
        'PIL2,,,,,,,,192.0.2.22,8554,8080,viewer,Pw-pilot-2b,2,First floor,',
        'PIL3,,Pilot three,store,Ranchi,JH,PS,PS-1,192.0.2.31,,,viewer,Pw-pilot-3,3,NVR,',
      ].join('\n')
      const check = await checkLocationImport(clients, bossActor, csv, { skipBadRows: false })
      if (!check.ok) throw new Error(check.error)
      expect(check.preview.errors).toEqual([])
      const applied = await applyLocationImport(clients, bossActor, csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
      if (!applied.ok) throw new Error(applied.error)
      expect(applied.result).toMatchObject({ locationsCreated: 2, recordersCreated: 3, camerasCreated: 8, regionsCreated: 1, clustersCreated: 1 })
      const locId = async (code: string) => (await admin().from('locations').select('id').eq('org_id', orgP).eq('code', code).single()).data!.id
      const camsOf = async (loc: string) => sorted(((await admin().from('cameras').select('id').eq('location_id', loc).is('archived_at', null)).data ?? []).map((c) => c.id))
      const pil2 = await camsOf(await locId('PIL2'))
      const pil3 = await camsOf(await locId('PIL3'))
      expect(pil2).toHaveLength(5)
      expect(pil3).toHaveLength(3)
      const psCluster = (await admin().from('clusters').select('id').eq('org_id', orgP).eq('code', 'PS-1').single()).data!.id

      // 3. People, made on the people screen's service, each with a one-time password they replace at the first sign-in.
      const make = async (role: Actor['role'], name: string) => {
        const r = await createPerson(admin(), bossActor, { email: `${crypto.randomUUID()}@example.test`, full_name: name, role })
        if (!r.ok) throw new Error(r.error)
        const email = (await admin().from('profiles').select('email').eq('id', r.userId).single()).data!.email
        return { id: r.userId, email, oneTime: r.oneTimePassword }
      }
      const clusterViewer = await make('user', 'Cluster viewer')
      const operator = await make('operator', 'Location operator')
      const cameraViewer = await make('user', 'Camera viewer')
      const itViewer = await make('user', 'IT viewer')
      const administrator = await make('admin', 'Administrator')
      const second = await make('platform_owner', 'Second super administrator')
      // 4. Rights in the access editor (preview, then save), cluster-, location-, camera- and region-scoped; the administrator set.
      const save = async (id: string, changes: Record<string, unknown>[]) => expect(await editAccess(bossActor, id, changes)).toMatchObject({ ok: true })
      await save(clusterViewer.id, [grantChange(LIVE, atCluster(cluster.id)), grantChange(PLAYBACK, atCluster(cluster.id))])
      await save(operator.id, [grantChange(LIVE, atLocation(await locId('PIL3')))])
      await save(cameraViewer.id, [grantChange(LIVE, atCamera(pil2[0]))])
      await save(itViewer.id, [grantChange('it.inventory.view', atRegion(region.id)), grantChange('it.monitoring.view', atRegion(region.id))])
      await save(administrator.id, ADMINISTRATOR_SET.map((c) => grantChange(c, ORG_SCOPE)))
      // 5. Groups: a static group by the operator (their cameras) and a dynamic cluster group by the super administrator.
      const signedOperator = await choosePassword(operator.email, operator.oneTime)
      const opActor: Actor = { id: operator.id, orgId: orgP, role: 'operator' }
      const g = await createGroup({ admin: admin(), rls: signedOperator.client as never }, opActor, 'Pilot three wall')
      if (!g.ok) throw new Error(g.error)
      expect(await addCameras({ admin: admin(), rls: signedOperator.client as never }, opActor, g.groupId, pil3.slice(0, 2))).toMatchObject({ ok: true, added: 2 })
      const dyn = await createGroup(clients, bossActor, 'PN-1 wall')
      if (!dyn.ok) throw new Error(dyn.error)
      expect((await addGroupRule(clients, bossActor, dyn.groupId, { kind: 'cluster', refId: cluster.id })).ok).toBe(true)

      // 6. Sign in as each user type and look.
      const signed = {
        cluster: await choosePassword(clusterViewer.email, clusterViewer.oneTime),
        camera: await choosePassword(cameraViewer.email, cameraViewer.oneTime),
        it: await choosePassword(itViewer.email, itViewer.oneTime),
        admin: await choosePassword(administrator.email, administrator.oneTime),
        owner: await choosePassword(second.email, second.oneTime),
        operator: signedOperator,
      }
      const everything = sorted([...pil1, ...pil2, ...pil3])
      const want: Record<keyof typeof signed, string[]> = {
        cluster: sorted([...pil1, ...pil2]), camera: [pil2[0]], it: [], admin: everything, owner: everything, operator: pil3,
      }
      const ids: Record<keyof typeof signed, string> = { cluster: clusterViewer.id, camera: cameraViewer.id, it: itViewer.id, admin: administrator.id, owner: second.id, operator: operator.id }
      const wrong: string[] = []
      for (const k of Object.keys(signed) as (keyof typeof signed)[]) {
        const c = signed[k].client
        const seen = sorted(((await c.from('cameras').select('id')).data ?? []).map((r) => r.id))
        if (JSON.stringify(seen) !== JSON.stringify(want[k])) wrong.push(`${k}: sees ${seen.length} cameras, expected ${want[k].length}`)
        const caps = await readCapabilities(c as never)
        const landing = await loadLiveLanding(c as never, caps, {})
        const shownLocations = sorted(treeLocations(landing.tree).map((l) => l.id))
        const wantLocations = sorted(new Set(await Promise.all(want[k].map(async (cam) => (await admin().from('cameras').select('location_id').eq('id', cam).single()).data!.location_id))))
        if (JSON.stringify(shownLocations) !== JSON.stringify(wantLocations)) wrong.push(`${k}: the Live tree lists ${shownLocations.length} locations, expected ${wantLocations.length}`)
        if (want[k].length > 0) {
          const r = await openStreams({ admin: admin(), rls: c as never, go2rtc: go2rtc.client, env: {} }, { id: ids[k], orgId: orgP }, everything.slice(0, 20), 'sub')
          if (!r.ok) throw new Error(`${k}: ${r.error}`)
          const opened = sorted(r.streams.map((s) => s.cameraId))
          const wantOpened = want[k].filter((x) => everything.slice(0, 20).includes(x))
          if (JSON.stringify(opened) !== JSON.stringify(sorted(wantOpened))) wrong.push(`${k}: opened ${opened.length} streams, expected ${wantOpened.length}`)
        }
      }
      expect(wrong.join('\n')).toBe('')
      // Groups never widen access: the cluster viewer sees the dynamic group with its cluster cameras and not the operator's group.
      const dynSeen = await getVisibleGroup(signed.cluster.client as never, dyn.groupId)
      expect(sorted((dynSeen?.cameras ?? []).map((x) => x.id))).toEqual(sorted([...pil1, ...pil2]))
      expect(await getVisibleGroup(signed.cluster.client as never, g.groupId)).toBeNull()
      expect(await getVisibleGroup(signed.operator.client as never, dyn.groupId)).toBeNull()
      // The IT viewer sees the region's NVRs (the IT view) but no camera.
      expect(((await signed.it.client.from('recorders').select('id')).data ?? []).length).toBe(3)
      // The second region's cluster is not the cluster viewer's.
      expect((await signed.cluster.client.rpc('has_capability_for', { p_cap: LIVE, p_kind: 'cluster', p_id: psCluster })).data).toBe(false)
    }, 180_000)
  })

  // â”€â”€ Exit criterion 3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('EX-3 evidence: browser journeys, load test results with workload and limits, backup and restore', () => {
    const evidence = path.join(ROOT, 'docs/drishti/evidence/p5')
    it('EX-3.1 the load test results are published with the workload, the machine, the numbers and what was not measured', () => {
      const file = path.join(evidence, 'load-test.md')
      expect(existsSync(file)).toBe(true)
      const text = readFileSync(file, 'utf8')
      for (const heading of ['Workload', 'Machine', 'Media path', 'Metadata scale', 'Limits', 'Not measured']) expect(text, heading).toContain(heading)
      for (const term of ['p50', 'p95', 'p99', 'CPU', 'RAM', 'EXPLAIN', 'worker round']) expect(text.toLowerCase(), term).toContain(term.toLowerCase())
      expect(text).toMatch(/real NVR/i)
      expect(text).toMatch(/WAN/)
      expect(text).toMatch(/H\.265/)
    })
    it('EX-3.2 the browser journeys have screenshots at 1366, 1920 and 375 px for each journey', () => {
      const dir = path.join(evidence, 'journeys')
      expect(existsSync(dir)).toBe(true)
      const files = readdirSync(dir).filter((f) => f.endsWith('.png'))
      for (const journey of ['a-', 'b-', 'c-', 'd-', 'e-', 'f-']) {
        for (const width of ['1366', '1920', '375']) expect(files.some((f) => f.startsWith(`J${journey}`) && f.includes(`-${width}`)), `J${journey}*-${width}.png`).toBe(true)
      }
      expect(existsSync(path.join(dir, 'journeys-report.json'))).toBe(true)
    })
    it('EX-3.3 backup and restore were proven in a disposable database with every check passing', () => {
      const proof = JSON.parse(readFileSync(path.join(evidence, 'backup-restore-proof.json'), 'utf8')) as Record<string, unknown>
      const text = JSON.stringify(proof)
      expect(text).not.toMatch(/"ok"\s*:\s*false|"passed"\s*:\s*false/)
      expect(text).toMatch(/drishti_restore/)
    })
    // Honest limit: the independent security review is work package P5.6 (dispatched by the controller), not done when this was written.
    it.todo('EX-3.4 independent security review with no open Critical or Important findings (P5.6; not done yet)')
    // Honest limit: typecheck, lint, unit, integration and the production build are the gates run around this file, not inside it.
  })

  // â”€â”€ Exit criterion 4 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('EX-4 honest limits are stated', () => {
    it('EX-4.1 Release 1 and the load test say that real hardware (Hikvision firmware, H.265, SD-WAN, real WAN) is unvalidated until the pilot', () => {
      const release = readFileSync(path.join(ROOT, 'docs/drishti/RELEASE-1.md'), 'utf8')
      expect(release).toMatch(/Hikvision firmware, H\.265, real SD-WAN\) is unvalidated until the supervised pilot/)
      const load = readFileSync(path.join(ROOT, 'docs/drishti/evidence/p5/load-test.md'), 'utf8')
      expect(load).toMatch(/fake/i)
      expect(load).toMatch(/pilot/i)
    })
  })

  // â”€â”€ Owner rulings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  describe('owner rulings E-1, D-L1, C-1, P-1', () => {
    it('E-1: export is given only to administrators: refused for a viewer, operator and manager in the editor and in the database; leaving the administrator role removes it', async () => {
      const plain = await createUser(orgA, 'admin')
      await grant(orgA, plain.id, ADMINISTRATOR_SET)
      const actor: Actor = { id: plain.id, orgId: orgA, role: 'admin' }
      for (const role of ['user', 'operator', 'manager'] as const) {
        const target = await createUser(orgA, role)
        expect(await editAccess(actor, target.id, [grantChange(EXPORT, atLocation(L.L1))]), role).toMatchObject({ ok: false, error: MSG_EXPORT_ADMINS_ONLY })
        const db = await admin().rpc('apply_access_change', { p_org: orgA, p_user: target.id, p_changes: [grantChange(EXPORT, atLocation(L.L1))], p_actor: plain.id })
        expect(db.error?.code, role).toBe('42501')
        expect((await admin().from('access_grants').select('id').eq('user_id', target.id).eq('capability', EXPORT)).data, role).toEqual([])
      }
      // An administrator may receive it (from a super administrator: a plain administrator manages only viewers, operators, managers).
      const other = await createUser(orgA, 'admin')
      expect(await editAccess(superActor, other.id, [grantChange(EXPORT, atLocation(L.L1), 'exit test: export for an administrator')])).toMatchObject({ ok: true })
      expect(await allowedBy(other, EXPORT)).toEqual(sorted(cams.filter((c) => c.location === L.L1).map((c) => c.id)))
      expect(await updateUser(admin(), superActor, other.id, { role: 'manager' })).toMatchObject({ ok: true })
      expect(await allowedBy(other, EXPORT)).toEqual([])
    })

    it('D-L1: fast playback needs cctv.playback only (export not needed) and is a stream; export alone opens neither fast playback nor a file', async () => {
      const cam = cams.find((c) => c.nvr === 'c1' && c.channel === 1)!.id
      const make = async (caps: string[], role: 'user' | 'admin' = 'user') => {
        const u = await createUser(orgA, role)
        await grant(orgA, u.id, caps, atRecorder(NVR.c1))
        return u
      }
      const fastFor = async (u: TestUser) => openFastPlayback({ rls: u.client, admin: admin(), nvr: nvrClient, remux: fakeRemux('copy'), conversions: createConversionLimiter(), now: () => FAST_NOW, offsetMin: 0 }, { id: u.id, orgId: orgA }, cam, FAST_START, 5, 4)
      expect((await fastFor(await make([PLAYBACK]))).ok).toBe(true)
      expect(await fastFor(await make([EXPORT], 'admin'))).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await fastFor(await make([LIVE, EXPORT], 'admin'))).toEqual({ ok: false, error: 'Camera not found.' })
    })

    it('C-1: scopes expand when evaluated â€” a camera added later is covered, a location moved or archived leaves at once, an NVR grant follows the active mapping', async () => {
      const holderCluster = await createUser(orgA, 'user')
      await grant(orgA, holderCluster.id, LIVE, atCluster(C3))
      const holderRegion = await createUser(orgA, 'user')
      await grant(orgA, holderRegion.id, LIVE, atRegion(R2))
      const loc = await createLocation(orgA, { clusterId: C3, name: 'Exit C-1 location' })
      const r1 = await createRecorder(orgA, loc, { host: '127.0.0.1', httpPort: await closedPort(), rtspPort: 21_901, secret: NVR_PASSWORD })
      const r2 = await createRecorder(orgA, loc, { host: '127.0.0.1', httpPort: await closedPort(), rtspPort: 21_902, secret: NVR_PASSWORD })
      const holderNvr = await createUser(orgA, 'user')
      await grant(orgA, holderNvr.id, LIVE, atRecorder(r1))
      const k = await createCamera(orgA, { locationId: loc, recorderId: r1, channel: 1, name: 'added later' })
      const has = async (u: TestUser) => ((await u.client.rpc('cameras_with_capability', { p_cap: LIVE, p_ids: [k] })).data ?? []).includes(k)
      expect([await has(holderCluster), await has(holderRegion), await has(holderNvr)]).toEqual([true, true, true])
      // The camera moves to the location's other NVR: the NVR grant leaves it at once, the place grants keep it.
      expect((await admin().rpc('camera_remap', { p_org: orgA, p_camera: k, p_recorder: r2, p_channel: 1 })).error).toBeNull()
      expect([await has(holderCluster), await has(holderRegion), await has(holderNvr)]).toEqual([true, true, false])
      // The location leaves the cluster (and with it the region): both lose it at once.
      expect((await admin().rpc('inventory_move_location', { p_org: orgA, p_location: loc, p_cluster: null as unknown as string, p_actor: superAdmin.id })).error).toBeNull()
      expect([await has(holderCluster), await has(holderRegion)]).toEqual([false, false])
      expect((await admin().rpc('inventory_move_location', { p_org: orgA, p_location: loc, p_cluster: C3, p_actor: superAdmin.id })).error).toBeNull()
      expect([await has(holderCluster), await has(holderRegion)]).toEqual([true, true])
      // Archived grants nothing; restored gives it back.
      expect((await admin().rpc('inventory_archive', { p_org: orgA, p_kind: 'camera', p_id: k, p_actor: superAdmin.id })).error).toBeNull()
      expect([await has(holderCluster), await has(holderRegion)]).toEqual([false, false])
      expect((await admin().rpc('inventory_restore', { p_org: orgA, p_kind: 'camera', p_id: k, p_actor: superAdmin.id } as never)).error).toBeNull()
      expect([await has(holderCluster), await has(holderRegion)]).toEqual([true, true])
      // A region grant shows the names of its clusters; a camera grant shows no region or cluster name (review M15).
      expect(((await holderRegion.client.from('clusters').select('id')).data ?? []).map((c) => c.id)).toEqual([C3])
      expect((await people['one camera'].u.client.from('regions').select('id')).data).toEqual([])
    })

    it('P-1: a super administrator holds every catalogue capability organisation-wide; an administrator cannot take it away; the last one cannot be removed', async () => {
      const catalogue = sorted(((await admin().from('capabilities').select('key')).data ?? []).map((c) => c.key))
      const summary = ((await superAdmin.client.rpc('my_access_summary')).data ?? []) as { capability: string; organization_wide: boolean }[]
      expect(sorted(summary.filter((s) => s.organization_wide).map((s) => s.capability))).toEqual(catalogue)
      // A plain administrator cannot remove one of the super administrator's grants.
      const plain = await createUser(orgA, 'admin')
      await grant(orgA, plain.id, ADMINISTRATOR_SET)
      const g = (await admin().from('access_grants').select('id').eq('user_id', superAdmin.id).eq('capability', LIVE).is('revoked_at', null).single()).data!.id
      const refused = await editAccess({ id: plain.id, orgId: orgA, role: 'admin' }, superAdmin.id, [{ op: 'revoke', grant_id: g, reason: 'exit test: may not' }])
      expect(refused.ok).toBe(false)
      expect((await admin().from('access_grants').select('revoked_at').eq('id', g).single()).data!.revoked_at).toBeNull()
      // The last active super administrator of the organisation cannot be deactivated, not even by the service role (DR001).
      const off = await admin().from('profiles').update({ is_active: false }).eq('id', superAdmin.id)
      expect(off.error?.code).toBe('DR001')
      expect((await admin().from('profiles').select('is_active').eq('id', superAdmin.id).single()).data!.is_active).toBe(true)
    })
  })
})
