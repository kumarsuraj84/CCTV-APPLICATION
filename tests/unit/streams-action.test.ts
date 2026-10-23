import { resetProcessSingletons } from '../helpers/reset-singletons'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowLimiter } from '@/lib/streams/limiter'
import { useMemoryLimiter } from '../helpers/limiter-store'

describe('createWindowLimiter', () => {
  it('allows the limit, refuses the next, and frees a slot as the window moves on', () => {
    let t = 1_000_000
    const l = createWindowLimiter(3, 60_000, () => t)
    expect([l.allow('a'), l.allow('a'), l.allow('a'), l.allow('a')]).toEqual([true, true, true, false])
    t += 59_999
    expect(l.allow('a')).toBe(false)
    t += 2
    expect(l.allow('a')).toBe(true)
  })

  it('does not count refused attempts, so waiting always helps', () => {
    let t = 0
    const l = createWindowLimiter(1, 1000, () => t)
    expect(l.allow('a')).toBe(true)
    for (let i = 0; i < 50; i++) {
      t += 10
      expect(l.allow('a')).toBe(false)
    }
    t = 1001
    expect(l.allow('a')).toBe(true)
  })

  it('keeps people apart', () => {
    const l = createWindowLimiter(1, 60_000, () => 5)
    expect(l.allow('a')).toBe(true)
    expect(l.allow('b')).toBe(true)
    expect(l.allow('a')).toBe(false)
  })

  it('never keeps more than a bounded number of people', () => {
    let t = 0
    const l = createWindowLimiter(1, 60_000, () => t)
    for (let i = 0; i < 12_000; i++) l.allow(`p${i}`)
    t = 1
    expect(l.allow('p11999')).toBe(false) // recent entries survive
    expect(l.allow('fresh')).toBe(true)
  })
})

const requireProfile = vi.fn()
const createClient = vi.fn(async () => ({ tag: 'rls' }))
const audit: Record<string, unknown>[] = []
const adminFake = { tag: 'admin', from: () => ({ insert: async (row: Record<string, unknown>) => (audit.push(row), { error: null }) }) }
const createAdminClient = vi.fn(() => adminFake)
// P2-6 (D-14): the video path uses its own database role (media_service); the audit row stays the web app's.
const mediaFake = { tag: 'media' }
const createMediaClient = vi.fn(() => mediaFake)
const openStreams = vi.fn()

vi.mock('@/lib/auth/profile', () => ({ requireProfile: () => requireProfile() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
vi.mock('@/lib/supabase/service-clients', () => ({ createMediaClient: () => createMediaClient() }))
vi.mock('@/lib/streams/open', async (orig) => ({ ...(await orig<typeof import('@/lib/streams/open')>()), openStreams: (...a: unknown[]) => openStreams(...a) }))

const SOME = { organization: false, locations: ['l1'], cameras: [], assets: [] }
const person = (id: string, caps: string[] = ['cctv.live']) => ({
  id, org_id: 'o1', role: 'user', email: 'a@b.c', full_name: 'A', is_active: true, must_reset_password: false, store_id: null,
  capabilities: { failed: false, grants: Object.fromEntries(caps.map((c) => [c, SOME])) },
})

describe('stream actions', () => {
  beforeEach(() => {
    vi.resetModules()
    resetProcessSingletons()
    useMemoryLimiter() // P2-6 (D-11): the shared live count, in memory here
    vi.clearAllMocks()
    audit.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    openStreams.mockResolvedValue({ ok: true, streams: [] })
  })

  it('a signed-out caller is sent to sign in and nothing is opened', async () => {
    requireProfile.mockRejectedValue(new Error('NEXT_REDIRECT'))
    const { openStreamsAction, refreshStreamTokensAction } = await import('@/lib/actions/streams')
    await expect(openStreamsAction(['c'], 'sub')).rejects.toThrow('NEXT_REDIRECT')
    await expect(refreshStreamTokensAction(['c'], 'sub')).rejects.toThrow('NEXT_REDIRECT')
    expect(createClient).not.toHaveBeenCalled()
    expect(openStreams).not.toHaveBeenCalled()
  })

  it('passes the signed-in person (not anything from the browser) and the kind to openStreams', async () => {
    requireProfile.mockResolvedValue(person('u1'))
    const { openStreamsAction } = await import('@/lib/actions/streams')
    await openStreamsAction(['c1', 'c2'], 'main')
    expect(openStreams).toHaveBeenCalledTimes(1)
    const [deps, actor, ids, kind] = openStreams.mock.calls[0]
    expect(actor).toEqual({ id: 'u1', orgId: 'o1' })
    expect(ids).toEqual(['c1', 'c2'])
    expect(kind).toBe('main')
    expect(deps.rls).toEqual({ tag: 'rls' })
    // P2-6: the media path's own client (it may read the NVR login for `live`; the web app's own role may not).
    expect(deps.admin).toBe(mediaFake)
  })

  it('P2-2: a person without cctv.live gets the same empty answer as for cameras they may not watch, and nothing is opened or asked', async () => {
    const { openStreamsAction, refreshStreamTokensAction } = await import('@/lib/actions/streams')
    for (const caps of [[], ['cctv.playback'], ['cctv.export'], ['cctv.playback', 'cctv.export', 'it.monitoring.view', 'admin.inventory']]) {
      requireProfile.mockResolvedValue(person('u1', caps))
      expect(await openStreamsAction(['c1'], 'sub'), caps.join()).toEqual({ ok: true, streams: [] })
      expect(await refreshStreamTokensAction(['c1'], 'main')).toEqual({ ok: true, streams: [] })
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(createMediaClient).not.toHaveBeenCalled()
    expect(openStreams).not.toHaveBeenCalled()
  })

  // P2-2 fix M-4: an unreadable summary is the plain access-check failure (not "nothing to show"), and nothing is opened.
  it('a summary that could not be read gives the plain access-check failure and opens nothing', async () => {
    requireProfile.mockResolvedValue({ ...person('u1'), capabilities: { failed: true, grants: {} } })
    const { openStreamsAction, refreshStreamTokensAction } = await import('@/lib/actions/streams')
    expect(await openStreamsAction(['c1'], 'sub')).toEqual({ ok: false, error: 'Could not check your access. Please try again.' })
    expect(await refreshStreamTokensAction(['c1'], 'sub')).toEqual({ ok: false, error: 'Could not check your access. Please try again.' })
    expect(openStreams).not.toHaveBeenCalled()
  })

  it('records an opening (not the 8-minute token refresh) with the cameras opened and the kind, never a token', async () => {
    requireProfile.mockResolvedValue(person('u1'))
    openStreams.mockResolvedValue({ ok: true, streams: [{ cameraId: 'c1', name: 'N', storeCode: 'S', channel: 1, token: 'secret-token', kind: 'sub' }] })
    const { openStreamsAction, refreshStreamTokensAction } = await import('@/lib/actions/streams')
    await openStreamsAction(['c1', 'c2'], 'sub')
    await refreshStreamTokensAction(['c1'], 'sub')
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'cctv_live_opened', actor_id: 'u1', org_id: 'o1', entity_id: 'c1', detail: { capability: 'cctv.live', cameraIds: ['c1'], count: 1, kind: 'sub' } })
    expect(JSON.stringify(audit)).not.toContain('secret-token')
  })

  // P5.4 review M-10: the record comes from the action itself, after a successful opening only (tests/integration/audit-coverage.test.ts
  // checks the row reaches the database; this checks who writes it and when).
  it('records nothing when the opening fails, opens no camera, or throws', async () => {
    requireProfile.mockResolvedValue(person('u1'))
    const { openStreamsAction } = await import('@/lib/actions/streams')
    openStreams.mockResolvedValue({ ok: false, error: 'Live video is not set up yet.' })
    await openStreamsAction(['c1'], 'sub')
    openStreams.mockResolvedValue({ ok: true, streams: [] })
    await openStreamsAction(['c1'], 'sub')
    openStreams.mockRejectedValue(new Error('boom'))
    await openStreamsAction(['c1'], 'sub')
    expect(audit).toEqual([])
    openStreams.mockResolvedValue({ ok: true, streams: [{ cameraId: 'c9', name: 'N', storeCode: 'S', channel: 1, token: 't', kind: 'main' }] })
    await openStreamsAction(['c9'], 'main')
    expect(audit.map((r) => [r.action, r.entity_id])).toEqual([['cctv_live_opened', 'c9']])
  })

  it('allows 30 requests a minute per person (both live actions share the live count), then asks them to wait', async () => {
    requireProfile.mockResolvedValue(person('u1'))
    const { openStreamsAction, refreshStreamTokensAction } = await import('@/lib/actions/streams')
    for (let i = 0; i < 30; i++) expect((i % 2 ? await refreshStreamTokensAction(['c'], 'sub') : await openStreamsAction(['c'], 'sub')).ok).toBe(true)
    const overLimit = await openStreamsAction(['c'], 'sub')
    expect(overLimit).toEqual({ ok: false, error: 'Too many video requests. Please wait a minute and try again.' })
    expect(openStreams).toHaveBeenCalledTimes(30)
    // Somebody else is not affected.
    requireProfile.mockResolvedValue(person('u2'))
    expect((await openStreamsAction(['c'], 'sub')).ok).toBe(true)
  })

  it('an unexpected failure becomes the plain message, without the cause, and the log holds only the kind of error', async () => {
    requireProfile.mockResolvedValue(person('u1'))
    openStreams.mockRejectedValue(Object.assign(new TypeError('connect ECONNREFUSED rtsp://viewer:planted-secret@10.0.0.5'), { cause: new Error('planted-secret') }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { openStreamsAction } = await import('@/lib/actions/streams')
    const res = await openStreamsAction(['c'], 'sub')
    expect(res).toEqual({ ok: false, error: 'The video server is not available.' })
    expect(JSON.stringify(res)).not.toContain('planted-secret')
    const output = logged.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(output).toContain('open_streams_action_failed')
    expect(output).toContain('TypeError')
    for (const needle of ['planted-secret', 'rtsp://', 'viewer', '10.0.0.5', 'ECONNREFUSED']) expect(output, needle).not.toContain(needle)
  })

  it('an answer from openStreams is passed on as it is', async () => {
    requireProfile.mockResolvedValue(person('u1'))
    const streams = [{ cameraId: 'c', name: 'N', storeCode: 'S', channel: 1, token: 't', kind: 'sub' }]
    openStreams.mockResolvedValue({ ok: true, streams })
    const { openStreamsAction } = await import('@/lib/actions/streams')
    expect(await openStreamsAction(['c'], 'sub')).toEqual({ ok: true, streams })
    openStreams.mockResolvedValue({ ok: false, error: 'Live video is not set up yet.' })
    expect(await openStreamsAction(['c'], 'sub')).toEqual({ ok: false, error: 'Live video is not set up yet.' })
  })
})
