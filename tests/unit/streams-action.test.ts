import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowLimiter } from '@/lib/streams/limiter'

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
const createAdminClient = vi.fn(() => ({ tag: 'admin' }))
const openStreams = vi.fn()

vi.mock('@/lib/auth/profile', () => ({ requireProfile: () => requireProfile() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
vi.mock('@/lib/streams/open', async (orig) => ({ ...(await orig<typeof import('@/lib/streams/open')>()), openStreams: (...a: unknown[]) => openStreams(...a) }))

const person = (id: string) => ({ id, org_id: 'o1', role: 'user', email: 'a@b.c', full_name: 'A', is_active: true, must_reset_password: false, store_id: null })

describe('stream actions', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
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
    expect(deps.admin).toEqual({ tag: 'admin' })
  })

  it('allows 30 requests a minute per person (both actions share the count), then asks them to wait', async () => {
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
