import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NvrClient } from '@/lib/nvr/client'
import { adminRegistry, type RegistryClient } from '@/lib/streams/registry'
import { createConversionLimiter, parseVodQuery, serveVod, VOD_FAIL_CLOSED_AFTER_MS, VOD_VALIDATE_EVERY_MS, type ConversionLimiter, type VodDeps } from '@/lib/streams/vod'
import { ADMINISTRATOR_SET, adminClient, atLocation, CCTV_VIEW, cleanupOrg, createLocation, createOrg, createRecorder, createUser, grant, type TestUser } from '../setup/fixtures'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import { fakeSpawn, isAlive } from '../helpers/fake-spawn'

// P2-4 brief item 4 / test (f): fast playback (/api/vod) registers a media session of kind vod for every download and a timer inside the
// response re-checks it with the same SQL as the gateway; when access is gone (or cannot be checked for the fail-closed time) the NVR
// transfer is aborted and ffmpeg is killed. Loopback only: a fake NVR with an endless download and a stand-in for ffmpeg.

const NVR_USER = 'viewer'
const NVR_PASSWORD = 'secret-pass'
const admin = () => adminClient()
const NOW = Date.UTC(2026, 9, 22, 10, 0, 0)
const START = '2026-10-22T09:20:00Z'
const FFMPEG_PATH = path.resolve('/opt/fake/ffmpeg')
const WITH_EXPORT = [...CCTV_VIEW, 'cctv.export']

const waitFor = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  expect(check()).toBe(true)
}

describe('fast playback stops when access goes (P2-4)', () => {
  let orgId: string, store: string, cam: string, actor: TestUser
  let nvr: FakeNvr
  let limits: ConversionLimiter

  beforeAll(async () => {
    nvr = await startFakeNvr({ username: NVR_USER, password: NVR_PASSWORD, recordings: [{ start: '2026-10-22T09:00:00', end: '2026-10-22T10:00:00', channel: 1 }], download: 'endless' })
    orgId = await createOrg()
    store = await createLocation(orgId, { code: `VR${Date.now() % 100000}` })
    const rec = await createRecorder(orgId, store, { host: '127.0.0.1', httpPort: nvr.port, rtspPort: 554, username: NVR_USER, secret: NVR_PASSWORD })
    const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: store, recorder_id: rec, channel: 1, name: 'Till' }).select('id').single()
    if (error || !data) throw new Error(error?.message)
    cam = data.id
    actor = await createUser(orgId, 'platform_owner')
    await grant(orgId, actor.id, ADMINISTRATOR_SET)
  })
  afterAll(async () => {
    await nvr.close()
    await cleanupOrg(orgId)
  })
  beforeEach(() => {
    limits = createConversionLimiter()
    nvr.downloadsEnded.count = 0
  })
  afterEach(async () => {
    await waitFor(() => limits.running === 0)
  })

  const exporter = async () => {
    const u = await createUser(orgId, 'admin')
    const ids = await grant(orgId, u.id, WITH_EXPORT, atLocation(store))
    return { u, exportGrant: ids[2] }
  }
  const deps = (u: TestUser, extra: Partial<VodDeps> = {}): VodDeps => ({
    rls: u.client, admin: admin(), nvr: (ep) => new NvrClient(ep, { timeoutMs: 3000 }), spawn: fakeSpawn('copy'), conversions: limits, now: () => NOW,
    timing: { killGraceMs: 300, validateMs: 250, failClosedMs: 1000 }, ...extra, env: { FFMPEG: FFMPEG_PATH },
  })
  const get = (u: TestUser, d: VodDeps, probe = false) => {
    const p = parseVodQuery(new URLSearchParams(`camera=${cam}&start=${START}&minutes=10${probe ? '&probe=1' : ''}`))
    if (!p.ok) throw new Error(p.error)
    return serveVod(d, { id: u.id, orgId }, p.query)
  }
  const sessionsOf = async (u: TestUser) => (await admin().from('media_sessions').select('kind, capability, camera_id, opened_at, closed_at, revoked_at, revoke_reason').eq('user_id', u.id)).data ?? []

  /** Starts a download, reads its first bytes, runs `revoke`, and resolves with the milliseconds until the transfer and ffmpeg are gone. */
  async function cutAfter(u: TestUser, d: VodDeps, revoke: () => Promise<void>) {
    const spawn = d.spawn as ReturnType<typeof fakeSpawn>
    const res = await get(u, d)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read()
    const pid = spawn.children[0].pid
    expect(isAlive(pid)).toBe(true)
    const t0 = Date.now()
    await revoke()
    const drained = (async () => {
      try {
        for (;;) if ((await reader.read()).done) return
      } catch {
        // the video ends with an error: that is the cut
      }
    })()
    await waitFor(() => nvr.downloadsEnded.count === 1)
    await waitFor(() => !isAlive(pid))
    await drained
    await waitFor(() => limits.running === 0)
    return Date.now() - t0
  }

  it('the production timer checks every 15 seconds and gives up after 45 seconds without an answer', () => {
    expect(VOD_VALIDATE_EVERY_MS).toBe(15_000)
    expect(VOD_FAIL_CLOSED_AFTER_MS).toBe(45_000)
  })

  it('each download is a media session of kind vod (cctv.export), opened at once and closed when it ends; the probe makes none', async () => {
    const { u } = await exporter()
    const probe = await get(u, deps(u), true)
    expect(probe.status).toBe(200)
    expect(await sessionsOf(u)).toEqual([])
    const res = await get(u, deps(u, { timing: { maxMs: 400, killGraceMs: 300, validateMs: 250 } }))
    expect(res.status).toBe(200)
    await res.arrayBuffer()
    await waitFor(() => limits.running === 0)
    await new Promise((r) => setTimeout(r, 200))
    const rows = await sessionsOf(u)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'vod', capability: 'cctv.export', camera_id: cam, revoked_at: null })
    expect(rows[0].opened_at).not.toBeNull()
    expect(rows[0].closed_at).not.toBeNull()
  })

  it('removing the export grant mid-download aborts the NVR transfer and kills ffmpeg within the check interval', async () => {
    const { u, exportGrant } = await exporter()
    const ms = await cutAfter(u, deps(u), async () => {
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [exportGrant], p_reason: 'test: no more downloads' })).error).toBeNull()
    })
    expect(ms).toBeLessThan(3000)
    expect((await sessionsOf(u))[0]).toMatchObject({ revoke_reason: 'access_changed' })
    console.log(JSON.stringify({ vod_revocation_ms: { grant_removed: ms, validateMs: 250 } }))
  })

  it('deactivating the person aborts the download the same way', async () => {
    const { u } = await exporter()
    const ms = await cutAfter(u, deps(u), async () => {
      expect((await admin().rpc('set_person_active', { p_org: orgId, p_actor: actor.id, p_user: u.id, p_active: false })).error).toBeNull()
    })
    expect(ms).toBeLessThan(3000)
    console.log(JSON.stringify({ vod_revocation_ms: { deactivated: ms, validateMs: 250 } }))
  })

  it('fails closed: when the registry cannot be asked the download is cut after the fail-closed time', async () => {
    const { u } = await exporter()
    let failing = false
    const real = (await import('@/lib/streams/registry')).adminRegistry(admin())
    const flaky: RegistryClient = { ...real, stillValid: async (sids) => (failing ? Promise.reject(new Error('down')) : real.stillValid(sids)) }
    const ms = await cutAfter(u, deps(u, { registry: flaky }), async () => {
      failing = true
    })
    expect(ms).toBeGreaterThanOrEqual(700) // not before the fail-closed time (1 s here, from the last good check)
    expect(ms).toBeLessThan(4000)
    console.log(JSON.stringify({ vod_fail_closed_ms: { ms, validateMs: 250, failClosedMs: 1000 } }))
  })

  /** The admin client, counting every NVR login read and every session call it makes. */
  function counting(over: { create?: 'refuse' | 'fail' } = {}) {
    const calls: string[] = []
    const client = new Proxy(admin(), {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (fn: string, args: object) => {
            calls.push(fn)
            if (fn === 'media_session_create' && over.create === 'fail') return { data: null, error: { code: '08006', message: 'down' } }
            const r = await (target.rpc as unknown as (f: string, a: object) => Promise<{ data: unknown; error: unknown }>)(fn, args)
            return fn === 'media_session_create' && over.create === 'refuse' ? { ...r, data: [] } : r
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as ReturnType<typeof admin>
    return { client, calls }
  }

  it('review m-6: no NVR login is read when the registry refuses the download or cannot be asked; with a session it is read after it', async () => {
    const { u } = await exporter()
    for (const create of ['refuse', 'fail'] as const) {
      const c = counting({ create })
      const res = await get(u, deps(u, { admin: c.client, registry: { open: async () => ({ ok: false, reason: 'x' }), stillValid: async () => new Map(), close: async () => {} } }))
      expect(res.status, create).toBe(create === 'refuse' ? 404 : 503)
      expect(c.calls.filter((f) => /credential/.test(f)), create).toEqual([])
    }
    const ok = counting()
    // The registry through a plain client (the counting proxy only answers awaited rpc calls).
    const res = await get(u, deps(u, { admin: ok.client, registry: adminRegistry(admin()), timing: { maxMs: 300, killGraceMs: 300, validateMs: 250 } }))
    expect(res.status).toBe(200)
    await res.arrayBuffer()
    const i = ok.calls.indexOf('media_session_create')
    expect(i).toBeGreaterThanOrEqual(0)
    // P2-6: the logged credential read (purpose vod).
    expect(ok.calls.indexOf('recorder_credential_read')).toBeGreaterThan(i)
  })

  it('review m-7: a session that was made but could not be opened is closed again', async () => {
    const { u } = await exporter()
    const closed: string[] = []
    const throwing: RegistryClient = { open: async () => { throw new Error('down') }, stillValid: async () => new Map(), close: async (sid) => void closed.push(sid) }
    const res = await get(u, deps(u, { registry: throwing }))
    expect(res.status).toBe(503)
    expect(closed).toHaveLength(1)
    expect((await sessionsOf(u)).map((r) => r.kind)).toEqual(['vod'])
  })

  it('a download the registry will not register is "Camera not found." and nothing is asked of the NVR or started', async () => {
    const { u } = await exporter()
    const spawn = fakeSpawn('copy')
    const refusing: RegistryClient = { open: async () => ({ ok: false, reason: 'access_changed' }), stillValid: async () => new Map(), close: async () => {} }
    const before = nvr.requests.length
    const viaProxy = new Proxy(admin(), {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (fn: string, args: object) => {
            const r = await (target.rpc as unknown as (f: string, a: object) => Promise<{ data: unknown; error: unknown }>)(fn, args)
            return fn === 'media_session_create' ? { ...r, data: [] } : r
          }
        }
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    }) as ReturnType<typeof admin>
    const res = await get(u, deps(u, { admin: viaProxy, spawn, registry: refusing }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('Camera not found.')
    expect(spawn.calls).toHaveLength(0)
    expect(nvr.requests.slice(before).filter((r) => r.includes('download'))).toHaveLength(0)
  })
})
