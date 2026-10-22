import { afterEach, describe, expect, it, vi } from 'vitest'
import { processSingleton } from '@/lib/process-singleton'

const NAMES = ['cctv.liveRequestLimiter', 'cctv.playbackRequestLimiter', 'cctv.lookupRequestLimiter', 'cctv.exportRequestLimiter', 'cctv.conversionLimiter', 'cctv.fastPlaybackAvailable', 'cctv.test-thing']
afterEach(() => {
  for (const n of NAMES) delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(n)]
})

describe('processSingleton', () => {
  it('makes the value once and gives the same one to every caller', () => {
    const make = vi.fn(() => ({ n: 1 }))
    const a = processSingleton('cctv.test-thing', make)
    const b = processSingleton('cctv.test-thing', make)
    expect(a).toBe(b)
    expect(make).toHaveBeenCalledTimes(1)
  })
  it('keeps falsy values too (0 is a value, not "nothing yet")', () => {
    const make = vi.fn(() => 0)
    expect(processSingleton('cctv.test-thing', make)).toBe(0)
    expect(processSingleton('cctv.test-thing', make)).toBe(0)
    expect(make).toHaveBeenCalledTimes(1)
  })
})

describe('the limiters when their modules are loaded twice (a second bundle, or a reload in development)', () => {
  it('the video request limiter is one count: what one copy counts, the other sees', async () => {
    vi.resetModules()
    const a = await import('@/lib/streams/request-limit')
    const aLimiter = await import('@/lib/streams/limiter')
    vi.resetModules()
    const b = await import('@/lib/streams/request-limit')
    const bLimiter = await import('@/lib/streams/limiter')
    expect(bLimiter.createWindowLimiter).not.toBe(aLimiter.createWindowLimiter) // the modules really were loaded twice
    expect(b).not.toBe(a)
    expect(b.liveRequestLimiter).toBe(a.liveRequestLimiter)
    expect(b.playbackRequestLimiter).toBe(a.playbackRequestLimiter)
    expect(b.lookupRequestLimiter).toBe(a.lookupRequestLimiter)
    expect(b.exportRequestLimiter).toBe(a.exportRequestLimiter)

    const who = `person-${Math.random()}`
    for (let i = 0; i < a.STREAM_REQUESTS_PER_MINUTE - 1; i++) expect(a.liveRequestLimiter.allow(who)).toBe(true)
    expect(b.liveRequestLimiter.allow(who)).toBe(true) // the 30th, counted by the other copy
    expect(a.liveRequestLimiter.allow(who)).toBe(false)
    expect(b.liveRequestLimiter.allow(who)).toBe(false)
  })

  it('P2-2 (brief item 2): live, playback, recording search and export each have their own count', async () => {
    vi.resetModules()
    const l = await import('@/lib/streams/request-limit')
    const all = [l.liveRequestLimiter, l.playbackRequestLimiter, l.lookupRequestLimiter, l.exportRequestLimiter]
    expect(new Set(all).size).toBe(4)
    const who = `person-${Math.random()}`
    for (let i = 0; i < l.STREAM_REQUESTS_PER_MINUTE; i++) l.liveRequestLimiter.allow(who)
    expect(l.liveRequestLimiter.allow(who)).toBe(false)
    // Using up live video leaves playback, the recording search and export untouched.
    expect(l.playbackRequestLimiter.allow(who)).toBe(true)
    expect(l.lookupRequestLimiter.allow(who)).toBe(true)
    expect(l.exportRequestLimiter.allow(who)).toBe(true)
    expect('streamRequestLimiter' in l).toBe(false)
  })

  it('the conversion limiter is one count, and so is the ffmpeg check', async () => {
    vi.resetModules()
    const a = await import('@/lib/streams/vod')
    vi.resetModules()
    const b = await import('@/lib/streams/vod')
    expect(b).not.toBe(a)
    expect(b.createConversionLimiter).not.toBe(a.createConversionLimiter) // loaded twice
    expect(b.conversionLimiter).toBe(a.conversionLimiter)
    expect(b.fastPlaybackAvailable).toBe(a.fastPlaybackAvailable)

    const first = a.conversionLimiter.acquire('p1')
    expect(first.ok).toBe(true)
    expect(b.conversionLimiter.acquire('p1')).toEqual({ ok: false, reason: 'person' }) // the other copy sees it
    expect(b.conversionLimiter.running).toBe(1)
    const eight = Array.from({ length: 7 }, (_, i) => (i % 2 ? a : b).conversionLimiter.acquire(`q${i}`))
    expect(eight.every((s) => s.ok)).toBe(true)
    expect(a.conversionLimiter.acquire('late')).toEqual({ ok: false, reason: 'total' })
    expect(b.conversionLimiter.acquire('late')).toEqual({ ok: false, reason: 'total' })
    if (first.ok) first.release()
    expect(b.conversionLimiter.acquire('late').ok).toBe(true)
  })
})
