import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fastPlaybackStartupNote, ffmpegRemux, passThroughRemux, remuxFromEnv } from '@/lib/streams/remux'
import { buildFfmpegArgs, ffmpegVersionOk, MSG_FFMPEG_PATH, MSG_NO_FFMPEG } from '@/lib/streams/vod'
import { fakeSpawn } from '../helpers/fake-spawn'

// P4-L2: the step that turns the NVR's download into a fragmented MP4 is an adapter. The real one runs ffmpeg (not installed on this PC:
// the real program is only exercised by the skipped-with-reason test in tests/integration/fast-playback.test.ts); tests use a fake one;
// the development pass-through serves the fake NVR's ready-made fragmented MP4 for browser checks and is refused in production and for
// any NVR that is not on this computer.

const bytes = (s: string) => new TextEncoder().encode(s)
const sourceOf = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(bytes(p))
      c.close()
    },
  })
const readAll = async (s: ReadableStream<Uint8Array>) => Buffer.from(await new Response(s).arrayBuffer()).toString()
const FF = path.resolve('/opt/fake/ffmpeg')

describe('the ffmpeg adapter', () => {
  it('is not ready without a usable program, in the plain words of fast playback', async () => {
    expect(await ffmpegRemux({ lookup: { exists: () => false } }).check({ PATH: '' })).toEqual({ ok: false, error: MSG_NO_FFMPEG })
    expect(await ffmpegRemux().check({ FFMPEG: 'ffmpeg' })).toEqual({ ok: false, error: MSG_FFMPEG_PATH })
    expect(await ffmpegRemux({ available: async () => false }).check({ FFMPEG: FF })).toEqual({ ok: false, error: MSG_NO_FFMPEG })
  })
  it('pipes the NVR bytes through the program (here the stand-in that copies) and ends cleanly', async () => {
    const spawn = fakeSpawn('copy')
    const remux = ffmpegRemux({ spawn })
    expect(await remux.check({ FFMPEG: FF })).toEqual({ ok: true })
    let exited = 0
    const r = await remux.start({ env: { FFMPEG: FF }, source: sourceOf('abc', 'def'), abortSource: () => {}, onExit: () => exited++ })
    expect(r.ok).toBe(true)
    if (r.ok) expect(await readAll(r.body)).toBe('abcdef')
    expect(spawn.calls[0].command).toBe(FF)
    expect(spawn.calls[0].args).toContain('-c:v')
    expect(spawn.calls[0].args[spawn.calls[0].args.indexOf('-c:v') + 1]).toBe('copy') // E-2: a remux, never a re-encode
    await new Promise((r2) => setTimeout(r2, 200))
    expect(exited).toBe(1)
  })
  it('review I-1: paces its input at the signed speed with -readrate (an input option, before -i); exports are not paced', async () => {
    expect(buildFfmpegArgs({ readrate: 16 })).toEqual(expect.arrayContaining(['-readrate', '16']))
    const a = buildFfmpegArgs({ readrate: 4 })
    expect(a.indexOf('-readrate')).toBeLessThan(a.indexOf('-i'))
    expect(buildFfmpegArgs()).not.toContain('-readrate')
    const spawn = fakeSpawn('copy')
    const r = await ffmpegRemux({ spawn }).start({ env: { FFMPEG: FF }, source: sourceOf('x'), abortSource: () => {}, readrate: 8 })
    if (r.ok) await readAll(r.body)
    expect(spawn.calls[0].args.slice(spawn.calls[0].args.indexOf('-readrate'), spawn.calls[0].args.indexOf('-readrate') + 2)).toEqual(['-readrate', '8'])
  })
  it('review I-1: needs ffmpeg 5.0 or newer (-readrate); older or unknown versions are "not set up"', () => {
    expect(ffmpegVersionOk('ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2023')).toBe(true)
    expect(ffmpegVersionOk('ffmpeg version 5.0 Copyright')).toBe(true)
    expect(ffmpegVersionOk('ffmpeg version n7.0.2 Copyright')).toBe(true)
    expect(ffmpegVersionOk('ffmpeg version N-112345-g1234abcd Copyright')).toBe(true) // a dated development build (newer than any release)
    expect(ffmpegVersionOk('ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright')).toBe(false)
    expect(ffmpegVersionOk('something else')).toBe(false)
    expect(ffmpegVersionOk('')).toBe(false)
  })
})

describe('the development pass-through', () => {
  it('is refused in production', async () => {
    expect(await passThroughRemux().check({ DRISHTI_ENV: 'production' }, { recorderHost: '127.0.0.1' })).toEqual({ ok: false, error: MSG_NO_FFMPEG })
  })
  it('is refused for an NVR that is not on this computer (a real NVR\'s bytes are never passed on raw)', async () => {
    expect(await passThroughRemux().check({}, { recorderHost: '10.20.30.40' })).toEqual({ ok: false, error: MSG_NO_FFMPEG })
    expect(await passThroughRemux().check({}, { recorderHost: '127.0.0.1' })).toEqual({ ok: true })
  })
  it('review m-6: an NVR host that is missing or empty is refused too (only a known loopback host passes)', async () => {
    for (const h of [null, '', '  ']) expect(await passThroughRemux().check({}, { recorderHost: h }), String(h)).toEqual({ ok: false, error: MSG_NO_FFMPEG })
  })
  it('review m-6: it expires — an NVR that stops sending ends it after the idle time, and the end is reported once', async () => {
    let aborted = 0
    let exited = 0
    const stalls = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('first')) } })
    const r = await passThroughRemux().start({ env: {}, source: stalls, abortSource: () => aborted++, onExit: () => exited++, idleMs: 200 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const reader = r.body.getReader()
      await reader.read()
      await expect(reader.read()).resolves.toMatchObject({ done: true })
    }
    expect(aborted).toBeGreaterThan(0)
    expect(exited).toBe(1)
  })
  it('review m-6: the longest time applies even when no limit is passed (the default is the conversion\'s 29.5 minutes)', async () => {
    const { PASS_THROUGH_DEFAULTS } = await import('@/lib/streams/remux')
    expect(PASS_THROUGH_DEFAULTS).toEqual({ maxMs: 29.5 * 60_000, idleMs: 60_000 })
  })
  it('passes the bytes on and reports the end once', async () => {
    let exited = 0
    const r = await passThroughRemux().start({ env: {}, source: sourceOf('x', 'y'), abortSource: () => {}, onExit: () => exited++ })
    expect(r.ok).toBe(true)
    if (r.ok) expect(await readAll(r.body)).toBe('xy')
    expect(exited).toBe(1)
  })
  it('a cancelled picture ends the NVR transfer', async () => {
    let aborted = 0
    let exited = 0
    const never = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('first')) } })
    const r = await passThroughRemux().start({ env: {}, source: never, abortSource: () => aborted++, onExit: () => exited++ })
    expect(r.ok).toBe(true)
    if (r.ok) await r.body.cancel()
    expect(aborted).toBeGreaterThan(0)
    expect(exited).toBe(1)
  })
})

describe('the start-up note (review I-1: ffmpeg 5.0 or newer)', () => {
  it('says nothing when fast playback can work, and the plain reason with the version and the runbook when not', async () => {
    expect(await fastPlaybackStartupNote({}, { name: 'x', check: async () => ({ ok: true }), start: async () => ({ ok: false, reason: 'failed' }) })).toBeNull()
    const note = await fastPlaybackStartupNote({}, ffmpegRemux({ available: async () => false }))
    expect(note).toMatch(/5\.0 or newer/)
    expect(note).toMatch(/runbooks\/ffmpeg\.md/)
  })
})

describe('choosing the adapter', () => {
  it('is ffmpeg unless FAST_PLAYBACK_REMUX=passthrough outside production', () => {
    expect(remuxFromEnv({}).name).toBe('ffmpeg')
    expect(remuxFromEnv({ FAST_PLAYBACK_REMUX: 'passthrough' }).name).toBe('passthrough')
    expect(remuxFromEnv({ FAST_PLAYBACK_REMUX: 'passthrough', DRISHTI_ENV: 'production' }).name).toBe('ffmpeg')
    expect(remuxFromEnv({ FAST_PLAYBACK_REMUX: 'something' }).name).toBe('ffmpeg')
  })
})
