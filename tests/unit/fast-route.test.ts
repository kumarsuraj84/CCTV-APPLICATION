import { beforeEach, describe, expect, it, vi } from 'vitest'

// P4-L2 (decision D-L1): GET /api/playback/stream is the ONLY way fast playback reaches a browser. It needs a signed-in person with
// cctv.playback (export is not needed and not enough), the fast-playback token in the x-playback-token header (never in the address),
// and is refused to anything that is not a script fetch of the Playback screen (a typed address, a link, a <video src>, a frame), so it can
// never be opened or saved as a file. The camera, the person the token was made for and its media session are checked by the service.

const mocks = vi.hoisted(() => ({
  profile: null as null | Record<string, unknown>,
  profileCalls: 0,
  clients: 0,
  admins: 0,
  audit: [] as Record<string, unknown>[],
  serve: vi.fn(),
}))
const SOME = { organization: false, locations: ['l1'], cameras: [], assets: [] }
const caps = (...list: string[]) => ({ failed: false, grants: Object.fromEntries(list.map((c) => [c, SOME])) })
const freshSession = () => ({ mfaEnforced: false, privileged: false, aal2: false, hasFactor: false, sessionId: 's', signedInAt: Math.floor(Date.now() / 1000) - 3 * 3600, lastAuthAt: Math.floor(Date.now() / 1000) - 3 * 3600 })
vi.mock('@/lib/auth/profile', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/profile')>()),
  getCurrentProfile: async () => {
    mocks.profileCalls++
    return mocks.profile ? { session: freshSession(), ...mocks.profile } : null
  },
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => (mocks.clients++, { tag: 'rls' }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => (mocks.admins++, { tag: 'admin', from: () => ({ insert: async (row: Record<string, unknown>) => (mocks.audit.push(row), { error: null }) }) }),
}))
vi.mock('@/lib/supabase/service-clients', () => ({ createMediaClient: () => ({ tag: 'media' }) }))
vi.mock('@/lib/streams/fast', async (original) => ({ ...(await original<typeof import('@/lib/streams/fast')>()), serveFastStream: mocks.serve }))

import { GET, HEAD } from '@/app/api/playback/stream/route'

const request = (headers: Record<string, string> = { 'x-playback-token': 'tok.en', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, url = 'http://localhost:3212/api/playback/stream') => new Request(url, { headers })

beforeEach(() => {
  mocks.profile = { id: 'user-1', org_id: 'org-1', role: 'user', must_reset_password: false, capabilities: caps('cctv.live', 'cctv.playback') }
  mocks.profileCalls = 0
  mocks.clients = 0
  mocks.admins = 0
  mocks.audit = []
  mocks.serve.mockReset()
  mocks.serve.mockResolvedValue(new Response('fragments', { status: 200, headers: { 'Content-Type': 'application/vnd.ckdrishti.stream' } }))
})

describe('GET /api/playback/stream', () => {
  it('needs a signed-in person: 401 JSON, no database client is made', async () => {
    mocks.profile = null
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(mocks.clients + mocks.admins).toBe(0)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('refuses a person who must choose a password, or has not entered their authenticator code', async () => {
    mocks.profile = { ...mocks.profile!, must_reset_password: true }
    expect((await GET(request())).status).toBe(403)
    mocks.profile = { ...mocks.profile!, must_reset_password: false, session: { ...freshSession(), hasFactor: true, aal2: false } }
    expect((await GET(request())).status).toBe(403)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('D-L1: cctv.playback is what counts; export alone, live alone or nothing is 403 and no camera is looked up', async () => {
    for (const c of [caps(), caps('cctv.live'), caps('cctv.export'), caps('cctv.export', 'cctv.live'), caps('it.inventory.view')]) {
      mocks.profile = { ...mocks.profile!, capabilities: c }
      const res = await GET(request())
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Playback is not available for your account.' })
    }
    expect(mocks.clients).toBe(0)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('a summary that cannot be read is the plain 503 access-check failure', async () => {
    mocks.profile = { ...mocks.profile!, capabilities: { failed: true, grants: {} } }
    const res = await GET(request())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Could not check your access. Please try again.' })
  })

  it('is never a file: a typed address, a link, a <video>, a frame or a download is refused before anything is read', async () => {
    const cases: Record<string, string>[] = [
      {}, // no token header at all: what a typed address or a link sends
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'x-playback-token': 'tok.en' },
      { 'sec-fetch-dest': 'video', 'x-playback-token': 'tok.en' },
      { 'sec-fetch-dest': 'iframe', 'x-playback-token': 'tok.en' },
      { 'sec-fetch-dest': 'embed', 'x-playback-token': 'tok.en' },
      { 'sec-fetch-mode': 'navigate', 'x-playback-token': 'tok.en' },
    ]
    for (const h of cases) {
      const res = await GET(request(h))
      expect(res.status, JSON.stringify(h)).toBe(400)
      expect(res.headers.get('content-disposition')).toBeNull()
    }
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('a token in the address is not accepted (addresses end up in history and logs)', async () => {
    const res = await GET(request({ 'sec-fetch-mode': 'cors' }, 'http://localhost:3212/api/playback/stream?token=tok.en'))
    expect(res.status).toBe(400)
    expect(mocks.serve).not.toHaveBeenCalled()
  })

  it('hands the person, the token and the request signal to the service, on the video path\'s own database role', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    const [deps, actor, token, signal] = mocks.serve.mock.calls[0]
    expect(deps).toMatchObject({ rls: { tag: 'rls' }, admin: { tag: 'media' } })
    expect(actor).toEqual({ id: 'user-1', orgId: 'org-1' })
    expect(token).toBe('tok.en')
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('needs no fresh sign-in: it is viewing (cctv.playback has no MFA), not a download', async () => {
    // freshSession() above is three hours old; /api/vod (export) refuses that, this does not.
    expect((await GET(request())).status).toBe(200)
  })

  it('turns an unexpected failure into one plain 500 that says nothing of the cause', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.serve.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:80 password=hunter2'))
    const res = await GET(request())
    expect(res.status).toBe(500)
    expect(await res.text()).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/)
    spy.mockRestore()
  })

  it('has only GET and a HEAD that is refused without starting anything', async () => {
    const route = await import('@/app/api/playback/stream/route')
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k)).sort()).toEqual(['GET', 'HEAD'])
    expect(HEAD().status).toBe(405)
    expect(mocks.profileCalls).toBe(0)
  })
})
