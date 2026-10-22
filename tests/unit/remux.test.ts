import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ffmpegRemux, passThroughRemux, remuxFromEnv } from '@/lib/streams/remux'
import { MSG_FFMPEG_PATH, MSG_NO_FFMPEG } from '@/lib/streams/vod'
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
})

describe('the development pass-through', () => {
  it('is refused in production', async () => {
    expect(await passThroughRemux().check({ DRISHTI_ENV: 'production' }, { recorderHost: '127.0.0.1' })).toEqual({ ok: false, error: MSG_NO_FFMPEG })
  })
  it('is refused for an NVR that is not on this computer (a real NVR\'s bytes are never passed on raw)', async () => {
    expect(await passThroughRemux().check({}, { recorderHost: '10.20.30.40' })).toEqual({ ok: false, error: MSG_NO_FFMPEG })
    expect(await passThroughRemux().check({}, { recorderHost: '127.0.0.1' })).toEqual({ ok: true })
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

describe('choosing the adapter', () => {
  it('is ffmpeg unless FAST_PLAYBACK_REMUX=passthrough outside production', () => {
    expect(remuxFromEnv({}).name).toBe('ffmpeg')
    expect(remuxFromEnv({ FAST_PLAYBACK_REMUX: 'passthrough' }).name).toBe('passthrough')
    expect(remuxFromEnv({ FAST_PLAYBACK_REMUX: 'passthrough', DRISHTI_ENV: 'production' }).name).toBe('ffmpeg')
    expect(remuxFromEnv({ FAST_PLAYBACK_REMUX: 'something' }).name).toBe('ffmpeg')
  })
})
