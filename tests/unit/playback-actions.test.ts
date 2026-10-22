import { resetProcessSingletons } from '../helpers/reset-singletons'
import { useMemoryLimiter } from '../helpers/limiter-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireProfile = vi.fn()
const createClient = vi.fn(async () => ({ tag: 'rls' }))
const audit: Record<string, unknown>[] = []
const adminFake = { tag: 'admin', from: () => ({ insert: async (row: Record<string, unknown>) => (audit.push(row), { error: null }) }) }
const createAdminClient = vi.fn(() => adminFake)
// P2-6 (D-14): the video path uses its own database role (media_service); the audit rows stay the web app's.
const mediaFake = { tag: 'media' }
const createMediaClient = vi.fn(() => mediaFake)
const listRecordedDays = vi.fn()
const listDaySegments = vi.fn()
const openPlayback = vi.fn()

vi.mock('@/lib/auth/profile', () => ({ requireProfile: () => requireProfile() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
vi.mock('@/lib/supabase/service-clients', () => ({ createMediaClient: () => createMediaClient() }))
const listOldestRecording = vi.fn()
const openFastPlayback = vi.fn()
vi.mock('@/lib/streams/playback', async (orig) => ({
  ...(await orig<typeof import('@/lib/streams/playback')>()),
  listRecordedDays: (...a: unknown[]) => listRecordedDays(...a),
  listDaySegments: (...a: unknown[]) => listDaySegments(...a),
  listOldestRecording: (...a: unknown[]) => listOldestRecording(...a),
  openPlayback: (...a: unknown[]) => openPlayback(...a),
}))
vi.mock('@/lib/streams/fast', async (orig) => ({
  ...(await orig<typeof import('@/lib/streams/fast')>()),
  openFastPlayback: (...a: unknown[]) => openFastPlayback(...a),
}))

const SOME = { organization: false, locations: ['l1'], cameras: [], assets: [] }
const withCaps = (caps: string[]) => ({ failed: false, grants: Object.fromEntries(caps.map((c) => [c, SOME])) })
const person = (id: string, caps: string[] = ['cctv.live', 'cctv.playback']) => ({ id, org_id: 'o1', role: 'user', email: 'a@b.c', full_name: 'A', is_active: true, must_reset_password: false, store_id: null, capabilities: withCaps(caps) })
const CAM = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'

describe('playback actions', () => {
  beforeEach(() => {
    vi.resetModules()
    resetProcessSingletons()
    useMemoryLimiter() // P2-6 (D-11): the shared video counts, in memory here
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    audit.length = 0
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    requireProfile.mockResolvedValue(person('u1'))
    listRecordedDays.mockResolvedValue({ ok: true, days: [1] })
    listDaySegments.mockResolvedValue({ ok: true, segments: [], truncated: false, skipped: 0 })
    openPlayback.mockResolvedValue({ ok: true, token: 't', name: 'n' })
    listOldestRecording.mockResolvedValue({ ok: true, oldest: '2026-09-03T08:14:00.000Z' })
    openFastPlayback.mockResolvedValue({ ok: true, token: 'fast-token', minutes: 10 })
  })

  // P4-L2 (decision D-L1): fast playback is a cctv.playback right; the action hands back a short-lived token for the stream path.
  describe('fast playback and the oldest recording (P4-L2)', () => {
    it('a playback viewer without export gets a fast playback token; the person, camera, start, length and speed go to the service', async () => {
      const a = await import('@/lib/actions/playback')
      expect(await a.openFastPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10, 16)).toEqual({ ok: true, token: 'fast-token', minutes: 10 })
      const [deps, who, cam, start, minutes, speed] = openFastPlayback.mock.calls[0]
      expect([who, cam, minutes, speed]).toEqual([{ id: 'u1', orgId: 'o1' }, CAM, 10, 16])
      expect((start as Date).toISOString()).toBe('2026-10-20T10:00:00.000Z')
      expect(deps.rls).toEqual({ tag: 'rls' })
      expect(deps.admin).toBe(mediaFake)
      const limits = await import('@/lib/streams/request-limit')
      expect(deps.limiter).toBe(limits.playbackRequestLimiter)
    })
    it('without cctv.playback (live only, export only, IT only) it is "Camera not found." and nothing is asked', async () => {
      for (const caps of [[], ['cctv.live'], ['cctv.export'], ['cctv.export', 'cctv.live'], ['it.monitoring.view']]) {
        requireProfile.mockResolvedValue(person('u1', caps))
        const a = await import('@/lib/actions/playback')
        expect(await a.openFastPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10, 4), caps.join()).toEqual({ ok: false, error: 'Camera not found.' })
        expect(await a.oldestRecordingAction(CAM), caps.join()).toEqual({ ok: false, error: 'Camera not found.' })
      }
      expect(openFastPlayback).not.toHaveBeenCalled()
      expect(listOldestRecording).not.toHaveBeenCalled()
    })
    it('checks its input first: camera, start, a whole length and a speed of 2x to 16x', async () => {
      const a = await import('@/lib/actions/playback')
      expect(await a.openFastPlaybackAction('nope', '2026-10-20T10:00:00Z', 10, 4)).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await a.openFastPlaybackAction(CAM, 'later', 10, 4)).toEqual({ ok: false, error: 'Choose a start time.' })
      expect(await a.openFastPlaybackAction(CAM, '2026-10-20T10:00:00Z', 2.5, 4)).toEqual({ ok: false, error: 'Choose how long to play.' })
      for (const s of [1, 3, 32, '4' as never]) expect(await a.openFastPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10, s), String(s)).toEqual({ ok: false, error: 'Choose a speed of 2x, 4x, 8x or 16x.' })
      expect(openFastPlayback).not.toHaveBeenCalled()
    })
    it('records the opening with the speed (never the token); a refused one is not recorded', async () => {
      const a = await import('@/lib/actions/playback')
      await a.openFastPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10, 8)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ action: 'cctv_playback_opened', actor_id: 'u1', entity_id: CAM, detail: { capability: 'cctv.playback', minutes: 10, speed: 8 } })
      expect(JSON.stringify(audit)).not.toContain('fast-token')
      openFastPlayback.mockResolvedValue({ ok: false, error: 'Camera not found.' })
      await a.openFastPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10, 8)
      expect(audit).toHaveLength(1)
    })
    it('the oldest recording: the person, the camera and the offset; counted as a lookup and recorded as a search', async () => {
      vi.stubEnv('PLAYBACK_OFFSET_MIN', '30')
      const a = await import('@/lib/actions/playback')
      expect(await a.oldestRecordingAction(CAM)).toEqual({ ok: true, oldest: '2026-09-03T08:14:00.000Z' })
      const [deps, who, cam, off] = listOldestRecording.mock.calls[0]
      expect([who, cam, off]).toEqual([{ id: 'u1', orgId: 'o1' }, CAM, 30])
      const limits = await import('@/lib/streams/request-limit')
      expect(deps.limiter).toBe(limits.lookupRequestLimiter)
      expect(audit[0]).toMatchObject({ action: 'cctv_playback_searched', detail: { what: 'oldest' } })
    })
  })

  it('a signed-out caller is sent to sign in and nothing else happens', async () => {
    requireProfile.mockRejectedValue(new Error('NEXT_REDIRECT'))
    const a = await import('@/lib/actions/playback')
    await expect(a.listRecordedDaysAction(CAM, 2026, 10)).rejects.toThrow('NEXT_REDIRECT')
    await expect(a.listDaySegmentsAction(CAM, '2026-10-20')).rejects.toThrow('NEXT_REDIRECT')
    await expect(a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)).rejects.toThrow('NEXT_REDIRECT')
    expect(createClient).not.toHaveBeenCalled()
    expect(listRecordedDays).not.toHaveBeenCalled()
    expect(listDaySegments).not.toHaveBeenCalled()
    expect(openPlayback).not.toHaveBeenCalled()
  })

  it('passes the signed-in person (never anything from the browser) and the offset from PLAYBACK_OFFSET_MIN', async () => {
    vi.stubEnv('PLAYBACK_OFFSET_MIN', '330')
    const a = await import('@/lib/actions/playback')
    await a.listRecordedDaysAction(CAM, 2026, 10)
    await a.listDaySegmentsAction(CAM, '2026-10-20')
    await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 30)
    const [d1, who1, cam1, y, m, off1] = listRecordedDays.mock.calls[0]
    expect([who1, cam1, y, m, off1]).toEqual([{ id: 'u1', orgId: 'o1' }, CAM, 2026, 10, 330])
    expect(d1.rls).toEqual({ tag: 'rls' })
    // P2-6: the media path's own client reads the route and the NVR login.
    expect(d1.admin).toBe(mediaFake)
    expect(listDaySegments.mock.calls[0][0].admin).toBe(mediaFake)
    expect(openPlayback.mock.calls[0][0].admin).toBe(mediaFake)
    expect(listDaySegments.mock.calls[0].slice(1)).toEqual([{ id: 'u1', orgId: 'o1' }, CAM, '2026-10-20', 330])
    const [d3, who3, cam3, start, minutes, off3] = openPlayback.mock.calls[0]
    expect([who3, cam3, minutes, off3]).toEqual([{ id: 'u1', orgId: 'o1' }, CAM, 30, 330])
    expect((start as Date).toISOString()).toBe('2026-10-20T10:00:00.000Z')
    expect(d3.rls).toEqual({ tag: 'rls' })
  })

  it('the offset is 0 when PLAYBACK_OFFSET_MIN is not set, and 0 (with a warning) when it is not a whole number of minutes within a day', async () => {
    const a = await import('@/lib/actions/playback')
    await a.listDaySegmentsAction(CAM, '2026-10-20')
    expect(listDaySegments.mock.calls[0][4]).toBe(0)
    for (const bad of ['abc', '1.5', '2000', '-1441', '5h', 'NaN']) {
      vi.stubEnv('PLAYBACK_OFFSET_MIN', bad)
      await a.listDaySegmentsAction(CAM, '2026-10-20')
      expect(listDaySegments.mock.calls.at(-1)?.[4], bad).toBe(0)
    }
    const warned = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).toContain('playback_offset_invalid')
    for (const [good, expected] of [['-330', -330], ['+60', 60], ['1440', 1440], ['0', 0], [' 330 ', 330]] as const) {
      vi.stubEnv('PLAYBACK_OFFSET_MIN', good)
      await a.listDaySegmentsAction(CAM, '2026-10-20')
      expect(listDaySegments.mock.calls.at(-1)?.[4], good).toBe(expected)
    }
  })

  it('checks its input before doing anything', async () => {
    const a = await import('@/lib/actions/playback')
    for (const bad of ['', 'nope', 42 as never, null as never]) {
      expect(await a.listRecordedDaysAction(bad, 2026, 10)).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await a.listDaySegmentsAction(bad, '2026-10-20')).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await a.openPlaybackAction(bad, '2026-10-20T10:00:00Z', 10)).toEqual({ ok: false, error: 'Camera not found.' })
    }
    for (const [y, m] of [[1999, 1], [2101, 1], [2026, 0], [2026, 13], [2026.5, 1], [Number.NaN, 1], ['2026' as never, 1]]) expect((await a.listRecordedDaysAction(CAM, y, m)).ok, `${y}-${m}`).toBe(false)
    for (const d of ['', '2026-02-30', '2026-1-1', 'today', null as never]) expect((await a.listDaySegmentsAction(CAM, d)).ok, String(d)).toBe(false)
    for (const s of ['', '2026-10-20', '2026-10-20T10:00:00+05:30', 'now', 5 as never]) expect(await a.openPlaybackAction(CAM, s, 10), String(s)).toEqual({ ok: false, error: 'Choose a start time.' })
    for (const n of [1.5, Number.NaN, '10' as never, null as never]) expect(await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', n), String(n)).toEqual({ ok: false, error: 'Choose how long to play.' })
    expect(listRecordedDays).not.toHaveBeenCalled()
    expect(listDaySegments).not.toHaveBeenCalled()
    expect(openPlayback).not.toHaveBeenCalled()
  })

  it('an answer from the service is passed on as it is, including its plain messages', async () => {
    const a = await import('@/lib/actions/playback')
    const segs = { ok: true, segments: [{ start: '2026-10-20T01:00:00.000Z', end: '2026-10-20T02:00:00.000Z' }], truncated: true, skipped: 2 }
    listDaySegments.mockResolvedValue(segs)
    expect(await a.listDaySegmentsAction(CAM, '2026-10-20')).toEqual(segs)
    listDaySegments.mockResolvedValue({ ok: false, error: 'The NVR did not answer.' })
    expect(await a.listDaySegmentsAction(CAM, '2026-10-20')).toEqual({ ok: false, error: 'The NVR did not answer.' })
  })

  // P2-2 brief item 2 replaces the shared count of ruling R17: live, playback and export each have their own limiter.
  it('opening a recording has its own count, separate from the live wall; looking at recordings has another', async () => {
    const live = await import('@/lib/actions/streams')
    const a = await import('@/lib/actions/playback')
    const limits = await import('@/lib/streams/request-limit')
    for (let i = 0; i < 30; i++) await live.openStreamsAction(['c'], 'sub')
    await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)
    expect(openPlayback).toHaveBeenCalledTimes(1)
    const deps = openPlayback.mock.calls[0][0] as { limiter: { allow(k: string): boolean | Promise<boolean> } }
    expect(deps.limiter).toBe(limits.playbackRequestLimiter)
    expect(await deps.limiter.allow('u1')).toBe(true) // the used-up live count does not touch playback
    await a.listRecordedDaysAction(CAM, 2026, 10)
    const lookup = (listRecordedDays.mock.calls[0][0] as { limiter: { allow(k: string): boolean | Promise<boolean> } }).limiter
    expect(lookup).toBe(limits.lookupRequestLimiter)
    expect(lookup).not.toBe(deps.limiter)
  })

  it('a person without cctv.playback gets "Camera not found." from every action and nothing is asked (P2-2)', async () => {
    for (const caps of [[], ['cctv.live'], ['cctv.export'], ['it.monitoring.view', 'admin.inventory']]) {
      requireProfile.mockResolvedValue(person('u1', caps))
      const a = await import('@/lib/actions/playback')
      expect(await a.listRecordedDaysAction(CAM, 2026, 10), caps.join()).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await a.listDaySegmentsAction(CAM, '2026-10-20')).toEqual({ ok: false, error: 'Camera not found.' })
      expect(await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)).toEqual({ ok: false, error: 'Camera not found.' })
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(listRecordedDays).not.toHaveBeenCalled()
    expect(listDaySegments).not.toHaveBeenCalled()
    expect(openPlayback).not.toHaveBeenCalled()
    expect(audit).toEqual([])
  })

  // P2-2 fix M-4.
  it('a summary that could not be read gives the plain access-check failure from every action, and nothing is asked', async () => {
    requireProfile.mockResolvedValue({ ...person('u1'), capabilities: { failed: true, grants: {} } })
    const a = await import('@/lib/actions/playback')
    const failed = { ok: false, error: 'Could not check your access. Please try again.' }
    expect(await a.listRecordedDaysAction(CAM, 2026, 10)).toEqual(failed)
    expect(await a.listDaySegmentsAction(CAM, '2026-10-20')).toEqual(failed)
    expect(await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)).toEqual(failed)
    expect(listRecordedDays).not.toHaveBeenCalled()
    expect(openPlayback).not.toHaveBeenCalled()
  })

  it('records a search and an opening in the audit log (actor, capability, camera; never the token)', async () => {
    const a = await import('@/lib/actions/playback')
    await a.listRecordedDaysAction(CAM, 2026, 10)
    await a.listDaySegmentsAction(CAM, '2026-10-20')
    await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)
    expect(audit.map((r) => [r.action, r.actor_id, r.entity_id, (r.detail as { capability: string }).capability])).toEqual([
      ['cctv_playback_searched', 'u1', CAM, 'cctv.playback'],
      ['cctv_playback_searched', 'u1', CAM, 'cctv.playback'],
      ['cctv_playback_opened', 'u1', CAM, 'cctv.playback'],
    ])
    expect(JSON.stringify(audit)).not.toContain('"t"')
    // A refused answer is not an opening.
    openPlayback.mockResolvedValue({ ok: false, error: 'Camera not found.' })
    await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)
    expect(audit).toHaveLength(3)
  })

  it('an unexpected failure becomes a plain message, without the cause, and the log holds only the kind of error', async () => {
    const boom = () => Object.assign(new TypeError('connect ECONNREFUSED rtsp://viewer:planted-secret@10.0.0.5'), { cause: new Error('planted-secret') })
    listRecordedDays.mockRejectedValue(boom())
    listDaySegments.mockRejectedValue(boom())
    openPlayback.mockRejectedValue(boom())
    const a = await import('@/lib/actions/playback')
    const results = [await a.listRecordedDaysAction(CAM, 2026, 10), await a.listDaySegmentsAction(CAM, '2026-10-20'), await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)]
    expect(results.map((r) => r.ok)).toEqual([false, false, false])
    expect(results[2]).toEqual({ ok: false, error: 'The video server is not available.' })
    expect(JSON.stringify(results)).not.toContain('planted-secret')
    const output = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(output).toContain('TypeError')
    for (const needle of ['planted-secret', 'rtsp://', 'viewer', '10.0.0.5', 'ECONNREFUSED']) expect(output, needle).not.toContain(needle)
  })
})
