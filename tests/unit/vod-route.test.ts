import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  profile: null as null | { id: string; org_id?: string; role: string; must_reset_password: boolean; capabilities?: unknown },
  profileCalls: 0,
  clients: 0,
  admins: 0,
  audit: [] as Record<string, unknown>[],
  serve: vi.fn(),
}))
const SOME = { organization: false, locations: ['l1'], cameras: [], assets: [] }
const caps = (...list: string[]) => ({ failed: false, grants: Object.fromEntries(list.map((c) => [c, SOME])) })

vi.mock('@/lib/auth/profile', () => ({
  getCurrentProfile: async () => {
    mocks.profileCalls++
    return mocks.profile
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    mocks.clients++
    return { tag: 'rls' }
  },
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    mocks.admins++
    return { tag: 'admin', from: () => ({ insert: async (row: Record<string, unknown>) => (mocks.audit.push(row), { error: null }) }) }
  },
}))
// P2-6 (D-14): fast playback runs on the video path's own database role (media_service).
vi.mock('@/lib/supabase/service-clients', () => ({ createMediaClient: () => ({ tag: 'media' }) }))
vi.mock('@/lib/streams/vod', async (original) => ({ ...(await original<typeof import('@/lib/streams/vod')>()), serveVod: mocks.serve }))

import { GET, HEAD } from '@/app/api/vod/route'
import { exportRequestLimiter } from '@/lib/streams/request-limit'

const ID = '0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111'
const request = (qs: string, init?: RequestInit) => new Request(`http://localhost:3212/api/vod?${qs}`, init)
const VALID = `camera=${ID}&start=2026-10-22T09:20:00Z&minutes=10`

beforeEach(() => {
  mocks.profile = { id: 'user-1', org_id: 'org-1', role: 'user', must_reset_password: false, capabilities: caps('cctv.export', 'cctv.playback') }
  mocks.profileCalls = 0
  mocks.clients = 0
  mocks.admins = 0
  mocks.audit = []
  mocks.serve.mockReset()
  mocks.serve.mockResolvedValue(new Response('video', { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
})

describe('GET /api/vod', () => {
  it('needs a signed-in person: 401 JSON, and no database client is even made', async () => {
    mocks.profile = null
    const res = await GET(request(VALID))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Please sign in.' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(mocks.clients + mocks.admins).toBe(0)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('refuses somebody who must still choose their own password (403)', async () => {
    mocks.profile = { id: 'user-1', role: 'admin', must_reset_password: true }
    const res = await GET(request(VALID))
    expect(res.status).toBe(403)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  // D-6a / P2-2: cctv.export replaces the interim administrators-only rule. The role does not matter either way.
  it('needs cctv.export: without it every role gets 403, the refusal is audited, and no camera is looked up', async () => {
    for (const role of ['user', 'operator', 'manager', 'admin', 'platform_owner']) {
      for (const c of [caps(), caps('cctv.playback', 'cctv.live'), caps('admin.inventory', 'it.monitoring.view')]) {
        for (const qs of [VALID, `${VALID}&probe=1`]) {
          mocks.profile = { id: 'user-1', org_id: 'org-1', role, must_reset_password: false, capabilities: c }
          const res = await GET(request(qs))
          expect(res.status, `${role} ${qs}`).toBe(403)
          expect(await res.json()).toEqual({ error: 'Fast playback is not available for your account.' })
          expect(res.headers.get('cache-control')).toBe('no-store')
        }
      }
    }
    expect(mocks.clients).toBe(0) // no person's client, so no camera lookup, no NVR login, no NVR request
    expect(mocks.serve).not.toHaveBeenCalled()
    expect(mocks.audit.length).toBeGreaterThan(0)
    expect(mocks.audit[0]).toMatchObject({ action: 'cctv_export_denied', actor_id: 'user-1', detail: { capability: 'cctv.export', reason: 'no_capability' } })
  })

  // P2-2 fix M-3: fast playback is a recording: cctv.export AND cctv.playback (the camera itself is checked by the service).
  it('export without playback is refused like no right at all, before any camera lookup', async () => {
    mocks.profile = { id: 'user-m3', org_id: 'org-1', role: 'admin', must_reset_password: false, capabilities: caps('cctv.export', 'cctv.live') }
    const res = await GET(request(VALID))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Fast playback is not available for your account.' })
    expect(mocks.clients).toBe(0)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  // P2-2 fix M-4: a summary that cannot be read is the plain access-check failure, audited as such, never "not for your account".
  it('a summary that could not be read is a plain 503 access-check failure, audited with reason access_check_failed', async () => {
    mocks.profile = { id: 'user-m4', org_id: 'org-1', role: 'user', must_reset_password: false, capabilities: { failed: true, grants: {} } }
    const res = await GET(request(VALID))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Could not check your access. Please try again.' })
    expect(mocks.serve).not.toHaveBeenCalled()
    expect(mocks.audit[0]).toMatchObject({ action: 'cctv_export_denied', detail: { capability: 'cctv.export', reason: 'access_check_failed' } })
  })

  it('lets anybody holding cctv.export and cctv.playback through, probe too (the camera itself is checked by the service)', async () => {
    for (const role of ['user', 'admin']) {
      for (const qs of [VALID, `${VALID}&probe=1`]) {
        mocks.profile = { id: 'user-1', org_id: 'org-1', role, must_reset_password: false, capabilities: caps('cctv.export', 'cctv.playback') }
        expect((await GET(request(qs))).status, `${role} ${qs}`).toBe(200)
      }
    }
    expect(mocks.serve).toHaveBeenCalledTimes(4)
  })

  it('checks the input before anything else: a bad camera is 404, other bad input is 400, and the database is not touched', async () => {
    const cases: [string, number][] = [
      ['start=2026-10-22T09:20:00Z&minutes=10', 404],
      [`camera=nope&start=2026-10-22T09:20:00Z&minutes=10`, 404],
      [`camera=${ID}&start=2026-10-22&minutes=10`, 400],
      [`camera=${ID}&start=2026-10-22T09:20:00Z&minutes=31`, 400],
      [`camera=${ID}&start=2026-10-22T09:20:00Z`, 400],
      [`camera=${ID}&start=2026-10-22T09:20:00Z&minutes=10&probe=2`, 400],
    ]
    for (const [qs, status] of cases) {
      const res = await GET(request(qs))
      expect(res.status, qs).toBe(status)
      expect(typeof ((await res.json()) as { error: string }).error).toBe('string')
    }
    expect(mocks.clients + mocks.admins).toBe(0)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('hands the person, the checked query, the export count and the request signal to the service', async () => {
    const controller = new AbortController()
    const res = await GET(request(`${VALID}&probe=1`, { signal: controller.signal }))
    expect(res.status).toBe(200)
    expect(mocks.serve).toHaveBeenCalledTimes(1)
    const [deps, actor, query, signal] = mocks.serve.mock.calls[0]
    expect(deps).toMatchObject({ rls: { tag: 'rls' }, admin: { tag: 'media' }, limiter: exportRequestLimiter })
    // The organisation goes along so that every service-role read of the service is scoped to it (P2-1).
    // P3-1: and the session's verified level (aal2), so the fast-playback session counts export while multi-factor is switched on.
    expect(actor).toEqual({ id: 'user-1', orgId: 'org-1', aal2: false })
    expect(query).toMatchObject({ camera: ID, minutes: 10, probe: true })
    expect(query.start.toISOString()).toBe('2026-10-22T09:20:00.000Z')
    expect(signal).toBeInstanceOf(AbortSignal)
    controller.abort()
    expect(signal.aborted).toBe(true) // the person going away reaches the service
  })

  it('turns an unexpected failure into one plain 500 that says nothing of the cause', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.serve.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:80 password=hunter2'))
    const res = await GET(request(VALID))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/)
    expect(JSON.parse(text).error).toBeTypeOf('string')
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('vod_route_failed')
    expect(logged).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/)
    spy.mockRestore()
  })

  it('has no way to change anything: only GET (and a HEAD that is refused without starting anything)', async () => {
    const route = await import('@/app/api/vod/route')
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k)).sort()).toEqual(['GET', 'HEAD'])
    const res = HEAD()
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    expect(mocks.profileCalls).toBe(0)
    expect(mocks.serve).not.toHaveBeenCalled()
  })
})
