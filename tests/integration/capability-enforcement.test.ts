import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { requestCheckNow } from '@/lib/monitor/check-now'
import { discoverLocationCameras } from '@/lib/monitor/discovery'
import { NvrClient } from '@/lib/nvr/client'
import { getVisibleGroup, listVisibleGroups } from '@/lib/queries/groups'
import { getVisibleStore, listVisibleDevices } from '@/lib/queries/inventory'
import { openFastPlayback } from '@/lib/streams/fast'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { openStreams } from '@/lib/streams/open'
import { listDaySegments, listRecordedDays, openPlayback } from '@/lib/streams/playback'
import { createConversionLimiter, parseVodQuery, serveVod } from '@/lib/streams/vod'
import { adminClient, atCamera, atLocation, cleanupOrg, createOrg, createSite, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'
import { fakeRemux } from '../helpers/fake-remux'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

// P2-2 brief item 8: direct-call negative tests per operation. For each operation, a person holding only a DIFFERENT capability, the
// right capability on a different location or camera, an expired grant, a revoked grant (revoked mid-test), a deactivated account or
// only the administrator role is refused with the operation's plain "not found / not available" shape, and NO request reaches the NVR
// or go2rtc. The matching capability is let through (the positive control of each row).

const admin = () => adminClient()
const readWorker = async () => (await admin().from('worker_state').select('*').eq('id', 1).single()).data!
const SECRET = 'capability-enforcement-test-secret-0123456789'
const NVR_USER = 'viewer'
const NVR_PASSWORD = 'nvr-pass-1'

// P4-L2 (decision D-L1): `fast` is fast playback 2x-16x through the stream path (openFastPlayback): cctv.playback, export not needed.
type Op = 'live' | 'refresh' | 'calendar' | 'segments' | 'playback' | 'fast' | 'vod' | 'probe' | 'groupRead' | 'devices' | 'storeDevices' | 'checkNow' | 'discovery'
const OPS: Op[] = ['live', 'refresh', 'calendar', 'segments', 'playback', 'fast', 'vod', 'probe', 'groupRead', 'devices', 'storeDevices', 'checkNow', 'discovery']

describe('capability enforcement per operation (P2-2)', () => {
  let orgId: string, otherOrg: string
  let s1: string, s2: string, c11: string, c12: string, c21: string, d1: string, group: string
  let nvr: FakeNvr
  const go2rtcCalls: string[] = []
  const go2rtc = {
    register: async (name: string) => void go2rtcCalls.push(`register ${name}`),
    inspect: async (name: string) => (go2rtcCalls.push(`inspect ${name}`), { busy: false }),
    prune: async () => void go2rtcCalls.push('prune'),
  } as unknown as Go2rtcClient
  const people: Record<string, { user: TestUser; role: 'user' | 'operator' | 'admin'; allowed: Op[] }> = {}
  let savedWorker: Awaited<ReturnType<typeof readWorker>>
  const savedSecret = process.env.STREAM_TOKEN_SECRET

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    savedWorker = await readWorker()
    nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, channels: [{ channel: 1, name: 'Door' }], statuses: { 1: true }, recordings: [{ start: '2026-10-20T09:00:00', end: '2026-10-20T10:00:00' }] })
    orgId = await createOrg()
    otherOrg = await createOrg()
    // P2-5b: a store is a location with its NVR (a recorder of its own, its login in the vault, keyed by recorder).
    const store = async (org: string, code: string) =>
      (await createSite(org, { code, name: code, host: '127.0.0.1', httpPort: nvr.port, rtspPort: 554, username: NVR_USER, secret: NVR_PASSWORD })).locationId
    const camera = async (org: string, s: string, ch: number) => (await admin().from('cameras').insert({ org_id: org, location_id: s, channel: ch, name: `cam ${ch}`, camera_ip: '192.0.2.50' }).select('id').single()).data!.id
    s1 = await store(orgId, 'E1')
    s2 = await store(orgId, 'E2')
    c11 = await camera(orgId, s1, 1)
    c12 = await camera(orgId, s1, 2)
    c21 = await camera(orgId, s2, 1)
    d1 = (await admin().from('assets').insert({ org_id: orgId, location_id: s1, type: 'server', name: 'Server', ip: '192.0.2.60' }).select('id').single()).data!.id
    group = (await admin().from('camera_groups').insert({ org_id: orgId, name: 'Only c11' }).select('id').single()).data!.id
    await admin().from('camera_group_items').insert({ org_id: orgId, group_id: group, camera_id: c11 })

    const add = async (key: string, role: 'user' | 'operator' | 'admin', allowed: Op[], grants: [string | string[], ReturnType<typeof atLocation> | typeof ORG_SCOPE][] = [], o: { validFrom?: string; validUntil?: string; mustReset?: boolean } = {}) => {
      const user = await createUser(orgId, role, { mustReset: o.mustReset })
      for (const [caps, scope] of grants) await grant(orgId, user.id, caps, scope, o)
      people[key] = { user, role, allowed }
    }
    const EVERYTHING = ['cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate']
    await add('liveOnly', 'user', ['live', 'refresh', 'groupRead'], [['cctv.live', atLocation(s1)]])
    // D-L1 (P4-L2): fast playback is part of cctv.playback; the saveable file (/api/vod) still needs cctv.export AND cctv.playback (fix M-3).
    await add('playbackOnly', 'user', ['calendar', 'segments', 'playback', 'fast', 'groupRead'], [['cctv.playback', atLocation(s1)]])
    // Fix M-3: export alone opens nothing (no file, and no fast playback either).
    await add('exportOnly', 'user', ['groupRead'], [['cctv.export', atLocation(s1)]])
    await add('exportPlayback', 'user', ['calendar', 'segments', 'playback', 'fast', 'vod', 'probe', 'groupRead'], [[['cctv.export', 'cctv.playback'], atLocation(s1)]])
    await add('mustReset', 'operator', [], [[EVERYTHING, atLocation(s1)]], { mustReset: true })
    await add('itOnly', 'operator', ['devices', 'storeDevices', 'checkNow'], [[['it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate'], atLocation(s1)]])
    await add('otherStore', 'operator', ['checkNow'], [[EVERYTHING, atLocation(s2)]]) // check-now runs for everything; any whole location counts
    await add('otherCamera', 'operator', [], [[['cctv.live', 'cctv.playback', 'cctv.export'], atCamera(c12)]])
    await add('expired', 'operator', [], [[EVERYTHING, atLocation(s1)]], { validFrom: '2020-01-01T00:00:00Z', validUntil: '2020-02-01T00:00:00Z' })
    await add('future', 'operator', [], [[EVERYTHING, atLocation(s1)]], { validFrom: '2099-01-01T00:00:00Z' })
    await add('adminRoleOnly', 'admin', [], [])
    await add('adminInventory', 'admin', ['discovery'], [['admin.inventory', ORG_SCOPE]])
    await add('revoked', 'operator', [], [[EVERYTHING, atLocation(s1)]])
    await add('deactivated', 'operator', [], [[EVERYTHING, atLocation(s1)]])
    await admin().from('profiles').update({ is_active: false }).eq('id', people.deactivated.user.id)
  })
  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await admin().from('worker_state').update(savedWorker).eq('id', 1)
    await nvr.close()
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })
  beforeEach(async () => {
    go2rtcCalls.length = 0
    nvr.requests.length = 0
    await admin().from('worker_state').update({ last_heartbeat: null, run_started_at: null, run_finished_at: null, check_requested_at: null }).eq('id', 1)
  })

  const nvrClient = (ep: ConstructorParameters<typeof NvrClient>[0]) => new NvrClient(ep, { timeoutMs: 3000 })
  const start = () => new Date(Date.now() - 2 * 3600_000)
  const vodQuery = (probe: boolean) => {
    const p = parseVodQuery(new URLSearchParams(`camera=${c11}&start=${start().toISOString().slice(0, 19)}Z&minutes=5${probe ? '&probe=1' : ''}`))
    if (!p.ok) throw new Error(p.error)
    return p.query
  }

  /** Runs one operation as the person; true when it was let through, false when refused with the operation's refusal shape. */
  async function run(op: Op, u: TestUser, role: 'user' | 'operator' | 'admin'): Promise<boolean> {
    const actor = { id: u.id, orgId }
    const d = { admin: admin(), rls: u.client }
    switch (op) {
      case 'live':
      case 'refresh': {
        const r = await openStreams({ ...d, go2rtc, env: {} }, actor, [c11], op === 'live' ? 'sub' : 'main')
        if (!r.ok) throw new Error(r.error)
        return r.streams.length === 1
      }
      case 'calendar': {
        const r = await listRecordedDays({ ...d, nvr: nvrClient }, actor, c11, 2026, 10, 0)
        if (!r.ok) expect(r.error).toBe('Camera not found.')
        return r.ok
      }
      case 'segments': {
        const r = await listDaySegments({ ...d, nvr: nvrClient }, actor, c11, '2026-10-20', 0)
        if (!r.ok) expect(r.error).toBe('Camera not found.')
        return r.ok
      }
      case 'playback': {
        const r = await openPlayback({ ...d, go2rtc, env: {} }, actor, c11, start(), 5, 0)
        if (!r.ok) expect(r.error).toBe('Camera not found.')
        return r.ok
      }
      case 'fast': {
        const r = await openFastPlayback({ ...d, remux: fakeRemux('copy'), offsetMin: 0 }, actor, c11, start(), 5, 8)
        if (!r.ok) expect(r.error).toBe('Camera not found.')
        return r.ok
      }
      case 'vod':
      case 'probe': {
        const res = await serveVod({ ...d, nvr: nvrClient, conversions: createConversionLimiter(), ffmpegAvailable: async () => false, env: { FFMPEG: 'C:\\no\\ffmpeg.exe' } }, actor, vodQuery(op === 'probe'))
        const body = res.status === 200 ? null : ((await res.json()) as { error: string }).error
        if (res.status === 404 && body === 'Camera not found.') return false
        return true // got past the camera check (it then fails later on purpose: no recording at that time / no ffmpeg)
      }
      case 'groupRead': {
        const g = await getVisibleGroup(u.client, group)
        const listed = (await listVisibleGroups(u.client)).some((x) => x.id === group)
        expect(listed).toBe(g !== null)
        return g !== null
      }
      case 'devices':
        return (await listVisibleDevices(u.client)).some((x) => x.id === d1)
      case 'storeDevices': {
        const s = await getVisibleStore(u.client, s1)
        if (!s) return false
        const devices = s.devices.some((x) => x.id === d1)
        expect(s.showsAddresses).toBe(devices) // camera addresses go with the IT view, never with CCTV alone
        return devices
      }
      case 'checkNow': {
        const r = await requestCheckNow(d, { ...actor, role })
        if (!r.ok) expect(r.error).toBe('You are not allowed to start a check.')
        return r.ok
      }
      case 'discovery': {
        const r = await discoverLocationCameras(d, { ...actor, role }, s1, { nvr: (ep) => nvrClient({ ...ep }) })
        if (!r.ok) expect(['Only administrators can look for cameras.', 'Location not found.']).toContain(r.error)
        return r.ok
      }
    }
  }

  const touchesBackend = (op: Op) => ['live', 'refresh', 'calendar', 'segments', 'playback', 'fast', 'vod', 'probe', 'discovery'].includes(op)

  it('every person × operation: refused unless the matching capability covers the target, and a refusal reaches neither the NVR nor go2rtc', async () => {
    // Revoked mid-test: allowed at first, then every grant is revoked.
    const revoked = people.revoked.user
    expect(await run('live', revoked, 'operator')).toBe(true)
    const { data: live } = await admin().from('access_grants').select('id').eq('user_id', revoked.id).is('revoked_at', null)
    await admin().rpc('revoke_grant', { p_org: orgId, p_user: revoked.id, p_grant_ids: (live ?? []).map((g) => g.id), p_reason: 'revoked mid-test' })

    const outcome: string[] = []
    for (const [key, p] of Object.entries(people)) {
      for (const op of OPS) {
        go2rtcCalls.length = 0
        nvr.requests.length = 0
        await admin().from('worker_state').update({ check_requested_at: null, run_started_at: null, run_finished_at: null }).eq('id', 1)
        const allowed = await run(op, p.user, p.role)
        const expected = p.allowed.includes(op)
        if (allowed !== expected) outcome.push(`${key} ${op}: ${allowed ? 'allowed' : 'refused'}, expected ${expected ? 'allowed' : 'refused'}`)
        if (!allowed && touchesBackend(op)) {
          if (go2rtcCalls.length > 0) outcome.push(`${key} ${op}: refused but go2rtc was asked (${go2rtcCalls.join(', ')})`)
          if (nvr.requests.length > 0) outcome.push(`${key} ${op}: refused but the NVR was asked`)
        }
        if (!allowed && op === 'checkNow' && (await admin().from('worker_state').select('check_requested_at').eq('id', 1).single()).data!.check_requested_at !== null) {
          outcome.push(`${key} checkNow: refused but a request was recorded`)
        }
      }
    }
    expect(outcome).toEqual([])
  })

  it('cross-store and camera-only: a grant for store E2 or camera c12 gives nothing on c11 / E1, and never another organisation', async () => {
    const other = people.otherStore.user
    const r = await openStreams({ admin: admin(), rls: other.client, go2rtc, env: {} }, { id: other.id, orgId }, [c11, c21], 'sub')
    expect(r.ok && r.streams.map((s) => s.cameraId)).toEqual([c21])
    const cam = people.otherCamera.user
    const c = await openStreams({ admin: admin(), rls: cam.client, go2rtc, env: {} }, { id: cam.id, orgId }, [c11, c12, c21], 'sub')
    expect(c.ok && c.streams.map((s) => s.cameraId)).toEqual([c12])
    // An administrator of another organisation with admin.inventory there finds no store of ours.
    const stranger = await createUser(otherOrg, 'admin')
    await grant(otherOrg, stranger.id, 'admin.inventory')
    nvr.requests.length = 0
    expect(await discoverLocationCameras({ admin: admin(), rls: stranger.client }, { id: stranger.id, orgId: otherOrg, role: 'admin' }, s1)).toEqual({ ok: false, error: 'Location not found.' })
    expect(nvr.requests).toEqual([])
  })
})
