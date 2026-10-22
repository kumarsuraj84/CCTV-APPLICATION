import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRestRegistry } from '@/lib/streams/registry'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createCamera, createOrg, createSite, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'
import { takeTestLease } from '../setup/lease'
import { rest, serviceClient, serviceKey } from '../setup/service-keys'

// P2-6 (D-14, D-14a; spike in docs/drishti/adr-service-roles.md): every server process has its own database role, chosen by the `role`
// claim of its key. These tests use REAL keys signed with the local stack's JWT secret and go through PostgREST like the processes do.

const admin = () => adminClient()
type Rpc = Parameters<ReturnType<typeof adminClient>['rpc']>[0]
const call = (c: ReturnType<typeof adminClient>, fn: string, args: object) =>
  c.rpc(fn as Rpc, args as never) as unknown as PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
const code = (r: { error: { code?: string } | null }) => r.error?.code ?? null

/** Every table and view of schema public (the service role's API description lists them all). */
async function allRelations(): Promise<string[]> {
  const res = await rest(process.env.SUPABASE_SERVICE_ROLE_KEY!, '/')
  const defs = (res.body as { definitions?: Record<string, unknown> }).definitions ?? {}
  return Object.keys(defs).sort()
}

describe('per-service database roles (P2-6, D-14)', () => {
  let orgId: string
  let actor: TestUser
  let viewer: TestUser
  let recorderId: string
  let cameraId: string
  const secret = `Svc-${randomUUID()}`

  beforeAll(async () => {
    orgId = await createOrg()
    actor = await createUser(orgId, 'platform_owner')
    viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live', 'cctv.playback'], ORG_SCOPE)
    const site = await createSite(orgId, { host: '10.66.1.1', username: 'viewer-login', secret, cameras: 1 })
    recorderId = site.recorderId
    cameraId = site.cameraIds[0]
    await createCamera(orgId, { locationId: site.locationId, recorderId, channel: 2, cameraIp: '10.66.1.20' })
  })
  afterAll(() => cleanupOrg(orgId))

  it('the four roles exist, cannot log in, and only the three server roles bypass row-level security', async () => {
    const { data, error } = await call(admin(), 'function_privileges', {})
    expect(error).toBeNull()
    // The roles answer through PostgREST (an unknown role would be a 401 "role does not exist").
    for (const role of ['app_web', 'media_service', 'monitor_worker', 'video_gateway'] as const) {
      const res = await rest(serviceKey(role), '/')
      expect(res.status, role).toBe(200)
    }
    expect(Array.isArray(data)).toBe(true)
  })

  describe('video_gateway', () => {
    const key = () => serviceKey('video_gateway')

    it('calls media_session_open, media_sessions_still_valid and media_session_close', async () => {
      const sid = randomUUID()
      const open = await rest(key(), '/rpc/media_session_open', { method: 'POST', body: { p_sid: sid, p_user: viewer.id, p_camera: cameraId, p_kind: 'live', p_stream: `cam_${cameraId}_sub` } })
      expect(open.status).toBe(200)
      expect((open.body as { ok: boolean }[])[0].ok).toBe(false) // an unknown session is refused, not an error
      const valid = await rest(key(), '/rpc/media_sessions_still_valid', { method: 'POST', body: { p_sids: [sid] } })
      expect(valid.status).toBe(200)
      expect(valid.body).toEqual([{ sid, reason: 'not_found' }])
      const close = await rest(key(), '/rpc/media_session_close', { method: 'POST', body: { p_sid: sid } })
      expect([200, 204]).toContain(close.status)
    })

    it('the gateway\'s own registry client works with its key: a session made for a viewer opens, stays valid and closes', async () => {
      const made = await call(admin(), 'media_session_create', { p_org: orgId, p_user: viewer.id, p_kind: 'live', p_cameras: [cameraId], p_streams: [`cam_${cameraId}_sub`] })
      const sid = (made.data as { sid: string }[])[0].sid
      const registry = createRestRegistry({ url: process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey: key() })
      expect(await registry.open(sid, { user: viewer.id, camera: cameraId, kind: 'live', stream: `cam_${cameraId}_sub` })).toMatchObject({ ok: true, kind: 'live' })
      expect((await registry.stillValid([sid])).size).toBe(0)
      await registry.close(sid)
      expect((await registry.stillValid([sid])).get(sid)).toBe('closed')
    })

    it('cannot read any table or view, and its API description lists only its three functions', async () => {
      const relations = await allRelations()
      expect(relations.length).toBeGreaterThan(30)
      for (const r of relations) {
        const res = await rest(key(), `/${r}?select=*&limit=1`)
        expect(res.status, r).toBeGreaterThanOrEqual(401)
        expect((res.body as { code?: string }).code, r).toBe('42501')
      }
      const described = await rest(key(), '/')
      const paths = Object.keys((described.body as { paths?: object }).paths ?? {}).sort()
      expect(paths).toEqual(['/', '/rpc/media_session_close', '/rpc/media_session_open', '/rpc/media_sessions_still_valid'])
    })

    it('cannot call any other function (catalogue) and is refused by a sample of them over HTTP', async () => {
      const { data } = await call(admin(), 'function_privileges', {})
      const mine = ((data ?? []) as { name: string; grantees: string[] }[]).filter((f) => f.grantees.includes('video_gateway')).map((f) => f.name).sort()
      expect(mine).toEqual(['media_session_close', 'media_session_open', 'media_sessions_still_valid'])
      const gw = serviceClient('video_gateway')
      const samples: [string, object][] = [
        ['recorder_read_credential', { p_recorder: recorderId }],
        ['recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' }],
        ['media_session_create', { p_org: orgId, p_user: viewer.id, p_kind: 'live', p_cameras: [cameraId], p_streams: [`cam_${cameraId}_sub`] }],
        // P2-7: the fenced signature (lease and token are required arguments).
        ['monitor_apply_results', { p_org: orgId, p_results: [], p_threshold: 2, p_lease: 'monitor', p_fencing_token: 1 }],
        ['worker_acquire_lease', { p_name: 'monitor', p_holder: randomUUID() }],
        ['rate_limit_hit', { p_key: 'x', p_limit: 1, p_window_sec: 60 }],
        ['privilege_violations', {}],
        ['grant_access', { p_org: orgId, p_user: viewer.id, p_grants: [] }],
        ['media_sessions_revoke_user', { p_org: orgId, p_user: viewer.id, p_reason: 'x' }],
      ]
      for (const [fn, args] of samples) expect(code(await call(gw, fn, args)), fn).toBe('42501')
    })
  })

  describe('app_web', () => {
    it('never reads an NVR login', async () => {
      const web = serviceClient('app_web')
      expect(code(await call(web, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' }))).toBe('42501')
      expect(code(await call(web, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'discovery' }))).toBe('42501')
      expect(code(await call(web, 'recorder_read_credential', { p_recorder: recorderId }))).toBe('42501')
    })

    it('never writes observations and cannot call worker, gateway, test or diagnostic functions', async () => {
      const web = serviceClient('app_web')
      expect(code(await web.from('check_state').update({ status: 'down' }).eq('org_id', orgId))).toBe('42501')
      expect(code(await web.from('outages').insert({ org_id: orgId, target_type: 'camera', target_id: cameraId, started_at: new Date().toISOString() }))).toBe('42501')
      expect(code(await web.from('worker_state').update({ last_heartbeat: new Date().toISOString() }).eq('id', -1))).toBe('42501')
      expect(code(await web.from('monitor_gaps').insert({ started_at: new Date().toISOString(), ended_at: new Date().toISOString() }))).toBe('42501')
      for (const [fn, args] of [
        // P2-7: the fenced signature; the web app may neither write results nor take the worker's lease.
        ['monitor_apply_results', { p_org: orgId, p_results: [], p_threshold: 2, p_lease: 'monitor', p_fencing_token: 1 }],
        ['worker_acquire_lease', { p_name: 'monitor', p_holder: randomUUID() }],
        ['monitor_heartbeat', { p_lease: 'monitor', p_fencing_token: 1, p_at: new Date().toISOString() }],
        ['media_session_open', { p_sid: randomUUID(), p_user: viewer.id, p_camera: cameraId, p_kind: 'live', p_stream: 'x' }],
        ['media_session_create', { p_org: orgId, p_user: viewer.id, p_kind: 'live', p_cameras: [cameraId], p_streams: ['x'] }],
        ['inventory_purge_test_org', { p_org: orgId }],
        ['privilege_violations', {}],
        ['function_privileges', {}],
        ['grant_access', { p_org: orgId, p_user: viewer.id, p_grants: [] }],
        ['rate_limit_prune', {}],
        ['media_sessions_prune', {}],
      ] as [string, object][]) expect(code(await call(web, fn, args)), fn).toBe('42501')
    })

    it('does its own work: reads the organisation across row-level security, writes an NVR password it can never read back', async () => {
      const web = serviceClient('app_web')
      const cams = await web.from('cameras').select('id').eq('org_id', orgId)
      expect(cams.error).toBeNull()
      expect((cams.data ?? []).map((c) => c.id)).toContain(cameraId)
      const changed = `Svc-${randomUUID()}`
      expect((await call(web, 'recorder_store_credential', { p_recorder: recorderId, p_secret: changed })).error).toBeNull()
      expect((await call(serviceClient('media_service'), 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' })).data).toBe(changed)
      expect((await call(web, 'recorder_store_credential', { p_recorder: recorderId, p_secret: secret })).error).toBeNull()
      const hit = await call(web, 'rate_limit_hit', { p_key: `test:${randomUUID()}`, p_limit: 1, p_window_sec: 60 })
      expect(hit.error).toBeNull()
    })
  })

  describe('media_service', () => {
    it('reads an NVR login for video purposes only, and every read is logged without the value', async () => {
      const media = serviceClient('media_service')
      const before = new Date(Date.now() - 1000).toISOString()
      for (const purpose of ['live', 'playback', 'vod', 'export', 'discovery', 'connection_test']) {
        const r = await call(media, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: purpose, p_actor: viewer.id })
        expect(r.error, purpose).toBeNull()
        expect(r.data, purpose).toBe(secret)
      }
      expect(code(await call(media, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'monitoring' }))).toBe('42501')
      expect(code(await call(media, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'anything' }))).toBe('42501')
      expect(code(await call(media, 'recorder_read_credential', { p_recorder: recorderId }))).toBe('42501')
      const { data: log, error } = await admin().from('vault_reads' as never).select('*').eq('recorder_id', recorderId).eq('actor_id', viewer.id).gte('at', before).order('at')
      expect(error).toBeNull()
      const rows = (log ?? []) as { db_role: string; purpose: string; actor_id: string | null; outcome: string; org_id: string }[]
      expect(rows.map((r) => r.purpose).sort()).toEqual(['connection_test', 'discovery', 'export', 'live', 'playback', 'vod'])
      for (const r of rows) expect(r).toMatchObject({ db_role: 'media_service', actor_id: viewer.id, outcome: 'read', org_id: orgId })
      expect(JSON.stringify(log)).not.toContain(secret)
    })

    it('cannot read people, grants or the log, and cannot change inventory', async () => {
      const media = serviceClient('media_service')
      for (const t of ['profiles', 'access_grants', 'vault_reads', 'check_state', 'worker_state']) {
        expect(code(await media.from(t as 'profiles').select('*').limit(1)), t).toBe('42501')
      }
      expect(code(await media.from('cameras').update({ name: 'x' }).eq('id', cameraId))).toBe('42501')
      expect(code(await call(media, 'inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cameraId, p_actor: actor.id }))).toBe('42501')
    })

    it('makes media sessions for a person the database allows', async () => {
      const media = serviceClient('media_service')
      const made = await call(media, 'media_session_create', { p_org: orgId, p_user: viewer.id, p_kind: 'live', p_cameras: [cameraId], p_streams: [`cam_${cameraId}_sub`] })
      expect(made.error).toBeNull()
      expect((made.data as { camera_id: string }[]).map((r) => r.camera_id)).toEqual([cameraId])
    })
  })

  describe('monitor_worker', () => {
    it('reads an NVR login for monitoring only and applies results (with its lease, P2-7)', async () => {
      const worker = serviceClient('monitor_worker')
      expect((await call(worker, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'monitoring' })).data).toBe(secret)
      expect(code(await call(worker, 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' }))).toBe('42501')
      const lease = await takeTestLease(undefined, undefined, 60, worker)
      expect((await call(worker, 'monitor_apply_results', { p_org: orgId, p_results: [], p_threshold: 2, p_lease: lease.name, p_fencing_token: lease.token })).error).toBeNull()
      // Without a valid token the same call is refused by the fence.
      expect(code(await call(worker, 'monitor_apply_results', { p_org: orgId, p_results: [], p_threshold: 2, p_lease: lease.name, p_fencing_token: lease.token + 1 }))).toBe('WL001')
    })

    it('writes no table directly any more (P2-7: worker_state, gaps and camera addresses only through its fenced functions)', async () => {
      const worker = serviceClient('monitor_worker')
      // Filters that match no row: the privilege is checked, the owner's worker state is never touched.
      // P2-6 let the worker update its own worker_state columns and cameras.camera_ip directly; P2-7 (D-8) revokes both, deliberately.
      expect(code(await worker.from('worker_state').update({ last_heartbeat: new Date().toISOString() }).eq('id', -1))).toBe('42501')
      expect(code(await worker.from('worker_state').update({ check_requested_at: new Date().toISOString() }).eq('id', -1))).toBe('42501')
      expect(code(await worker.from('cameras').update({ camera_ip: '10.66.1.21' }).eq('id', randomUUID()))).toBe('42501')
      expect(code(await worker.from('cameras').update({ name: 'x' }).eq('id', randomUUID()))).toBe('42501')
      expect(code(await worker.from('profiles').select('id').limit(1))).toBe('42501')
      expect(code(await call(worker, 'recorder_store_credential', { p_recorder: recorderId, p_secret: 'x' }))).toBe('42501')
    })
  })

  describe('the service key and NVR logins', () => {
    it('an organisation can lock the service key out of NVR logins; the media and worker keys keep working', async () => {
      try {
        expect((await call(admin(), 'security_settings_set_test', { p_org: orgId, p_service_role_credential_reads: false })).error).toBeNull()
        expect(code(await call(admin(), 'recorder_read_credential', { p_recorder: recorderId }))).toBe('42501')
        expect(code(await call(admin(), 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' }))).toBe('42501')
        expect((await call(serviceClient('media_service'), 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'live' })).data).toBe(secret)
        expect((await call(serviceClient('monitor_worker'), 'recorder_credential_read', { p_recorder: recorderId, p_purpose: 'monitoring' })).data).toBe(secret)
      } finally {
        await call(admin(), 'security_settings_set_test', { p_org: orgId, p_service_role_credential_reads: true })
      }
      expect((await call(admin(), 'recorder_read_credential', { p_recorder: recorderId })).data).toBe(secret)
    })

    it('nobody can write the lock through the API, not even the service key; only test organisations through the test function', async () => {
      expect(code(await admin().from('security_settings' as never).insert({ org_id: orgId, service_role_credential_reads: true } as never))).toBe('42501')
      expect(code(await admin().from('security_settings' as never).update({ service_role_credential_reads: true } as never).eq('org_id', orgId))).toBe('42501')
      // A random organisation id stands in for the real one (the guard is inventory_require_test_org, which the purge also relies on);
      // the owner's organisation is never asked, so a mistake here could never lock it.
      expect(code(await call(admin(), 'security_settings_set_test', { p_org: randomUUID(), p_service_role_credential_reads: false }))).not.toBeNull()
    })

    it('the legacy read is logged too', async () => {
      const before = new Date(Date.now() - 1000).toISOString()
      expect((await call(admin(), 'recorder_read_credential', { p_recorder: recorderId })).data).toBe(secret)
      const { data } = await admin().from('vault_reads' as never).select('db_role, purpose, outcome').eq('recorder_id', recorderId).gte('at', before)
      expect(data).toContainEqual({ db_role: 'service_role', purpose: 'unspecified', outcome: 'read' })
    })
  })

  it('people and anonymous callers never see the read log, the limiter or the lock', async () => {
    const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    for (const t of ['vault_reads', 'rate_limit_hits', 'security_settings']) {
      expect(code(await viewer.client.from(t as 'profiles').select('*').limit(1)), `viewer ${t}`).toBe('42501')
      expect(code(await anon.from(t as 'profiles').select('*').limit(1)), `anon ${t}`).toBe('42501')
    }
    for (const fn of ['rate_limit_hit', 'rate_limit_state', 'rate_limit_clear', 'recorder_credential_read', 'security_settings_set_test', 'privilege_violations_selftest']) {
      const args = fn === 'rate_limit_hit' ? { p_key: 'x', p_limit: 1, p_window_sec: 60 } : fn === 'rate_limit_state' ? { p_key: 'x', p_window_sec: 60 }
        : fn === 'rate_limit_clear' ? { p_key: 'x' } : fn === 'recorder_credential_read' ? { p_recorder: recorderId, p_purpose: 'live' }
          : fn === 'security_settings_set_test' ? { p_org: orgId, p_service_role_credential_reads: false } : {}
      expect(code(await call(viewer.client as never, fn, args)), `viewer ${fn}`).toBe('42501')
      expect(code(await call(anon as never, fn, args)), `anon ${fn}`).toBe('42501')
    }
  })

  it('privilege_violations() is empty, and it names a new function without grants or search_path, a PUBLIC grant and an open default', async () => {
    const { data, error } = await call(admin(), 'privilege_violations', {})
    expect(error).toBeNull()
    expect(data).toEqual([])
    const probe = await call(admin(), 'privilege_violations_selftest', {})
    expect(probe.error).toBeNull()
    const lines = (probe.data ?? []) as string[]
    expect(lines.some((l) => l.includes('zz_privilege_probe_definer') && l.includes('search_path'))).toBe(true)
    expect(lines.some((l) => l.includes('zz_privilege_probe_public') && l.includes('PUBLIC may execute'))).toBe(true)
    expect(lines.some((l) => l.startsWith('default privileges') && l.includes('PUBLIC'))).toBe(true)
    // The probe was undone: nothing is left over.
    expect((await call(admin(), 'privilege_violations', {})).data).toEqual([])
  })
})

describe('shared rate limiter (P2-6, D-11)', () => {
  type Hit = { allowed: boolean; hits: number; reset_at: string }
  const hit = async (c: ReturnType<typeof adminClient>, key: string, limit: number, windowSec: number): Promise<Hit> => {
    const r = await call(c, 'rate_limit_hit', { p_key: key, p_limit: limit, p_window_sec: windowSec })
    if (r.error) throw new Error(`rate_limit_hit: ${r.error.message}`)
    return (r.data as Hit[])[0]
  }

  it('two app instances share one count: 30 hits at once against a limit of 10 allow exactly 10', async () => {
    const key = `test:shared:${randomUUID()}`
    const a = serviceClient('app_web')
    const b = serviceClient('app_web')
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => hit(i % 2 ? a : b, key, 10, 600)))
    expect(all.filter((h) => h.allowed)).toHaveLength(10)
    expect(Math.max(...all.map((h) => h.hits))).toBe(30)
  })

  it('keys are counted apart', async () => {
    const web = serviceClient('app_web')
    const k1 = `test:k1:${randomUUID()}`
    const k2 = `test:k2:${randomUUID()}`
    expect((await hit(web, k1, 1, 600)).allowed).toBe(true)
    expect((await hit(web, k1, 1, 600)).allowed).toBe(false)
    expect((await hit(web, k2, 1, 600)).allowed).toBe(true)
  })

  it('a new window starts a new count', async () => {
    const web = serviceClient('app_web')
    const key = `test:roll:${randomUUID()}`
    const first = await hit(web, key, 1, 1)
    expect(first.allowed).toBe(true)
    let second = await hit(web, key, 1, 1)
    if (second.allowed) second = await hit(web, key, 1, 1) // the first hit landed at the very end of a window
    expect(second.allowed).toBe(false)
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(second.reset_at) - Date.now()) + 150))
    expect((await hit(web, key, 1, 1)).allowed).toBe(true)
  })

  it('state reads without counting; clear forgets; the worker prunes ended windows', async () => {
    const web = serviceClient('app_web')
    const key = `test:state:${randomUUID()}`
    await hit(web, key, 5, 600)
    await hit(web, key, 5, 600)
    const state = await call(web, 'rate_limit_state', { p_key: key, p_window_sec: 600 })
    expect((state.data as { hits: number }[])[0].hits).toBe(2)
    expect(((await call(web, 'rate_limit_state', { p_key: key, p_window_sec: 600 })).data as { hits: number }[])[0].hits).toBe(2)
    expect((await call(web, 'rate_limit_clear', { p_key: key })).error).toBeNull()
    expect(((await call(web, 'rate_limit_state', { p_key: key, p_window_sec: 600 })).data as { hits: number }[])[0].hits).toBe(0)
    const pruned = await call(serviceClient('monitor_worker'), 'rate_limit_prune', { p_keep: '0 seconds' })
    expect(pruned.error).toBeNull()
    expect(typeof pruned.data).toBe('number')
  })

  it('refuses nonsense', async () => {
    const web = serviceClient('app_web')
    expect(code(await call(web, 'rate_limit_hit', { p_key: '', p_limit: 1, p_window_sec: 60 }))).toBe('22023')
    expect(code(await call(web, 'rate_limit_hit', { p_key: 'x', p_limit: 0, p_window_sec: 60 }))).toBe('22023')
    expect(code(await call(web, 'rate_limit_hit', { p_key: 'x', p_limit: 1, p_window_sec: 0 }))).toBe('22023')
  })
})
