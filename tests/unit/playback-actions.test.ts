import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireProfile = vi.fn()
const createClient = vi.fn(async () => ({ tag: 'rls' }))
const createAdminClient = vi.fn(() => ({ tag: 'admin' }))
const listRecordedDays = vi.fn()
const listDaySegments = vi.fn()
const openPlayback = vi.fn()

vi.mock('@/lib/auth/profile', () => ({ requireProfile: () => requireProfile() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => createClient() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => createAdminClient() }))
vi.mock('@/lib/streams/playback', async (orig) => ({
  ...(await orig<typeof import('@/lib/streams/playback')>()),
  listRecordedDays: (...a: unknown[]) => listRecordedDays(...a),
  listDaySegments: (...a: unknown[]) => listDaySegments(...a),
  openPlayback: (...a: unknown[]) => openPlayback(...a),
}))

const person = (id: string) => ({ id, org_id: 'o1', role: 'user', email: 'a@b.c', full_name: 'A', is_active: true, must_reset_password: false, store_id: null })
const CAM = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'

describe('playback actions', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    requireProfile.mockResolvedValue(person('u1'))
    listRecordedDays.mockResolvedValue({ ok: true, days: [1] })
    listDaySegments.mockResolvedValue({ ok: true, segments: [], truncated: false, skipped: 0 })
    openPlayback.mockResolvedValue({ ok: true, token: 't', name: 'n' })
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
    expect(d1.admin).toEqual({ tag: 'admin' })
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

  it('opening video shares the 30 a minute count of the live wall; looking at recordings has its own, higher count', async () => {
    const live = await import('@/lib/actions/streams')
    const a = await import('@/lib/actions/playback')
    // The live actions need an openStreams that answers; the limiter is what is under test, so a failing open is fine (it still counts).
    for (let i = 0; i < 30; i++) await live.openStreamsAction(['c'], 'sub')
    await a.openPlaybackAction(CAM, '2026-10-20T10:00:00Z', 10)
    expect(openPlayback).toHaveBeenCalledTimes(1)
    const deps = openPlayback.mock.calls[0][0] as { limiter: { allow(k: string): boolean } }
    // The limiter that openPlayback receives is the one the live actions just used up, so the next request of this person is refused.
    expect(deps.limiter.allow('u1')).toBe(false)
    expect(deps.limiter.allow('someone-else')).toBe(true)
    // Browsing has a separate limiter.
    await a.listRecordedDaysAction(CAM, 2026, 10)
    const lookup = (listRecordedDays.mock.calls[0][0] as { limiter: { allow(k: string): boolean } }).limiter
    expect(lookup).not.toBe(deps.limiter)
    expect(lookup.allow('u1')).toBe(true)
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
