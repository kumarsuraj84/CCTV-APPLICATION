import { describe, expect, it } from 'vitest'
import { framingKey, xorFrame } from '@/lib/streams/framing'
import { paceFragmentedMp4, type PaceEnd } from '@/lib/streams/pace'
import { fmp4Init, makeFmp4, streamOf } from '../helpers/fmp4'

// P4-L2 review I-1 (owner ruling: playback-only people must not be able to dump recordings): the stream layer releases the fragmented MP4
// no faster than the signed speed times real time (plus a short burst for the player's start), caps the bytes of one stream, and ends a
// stream nobody reads (review I-2). It works on the recording's own timestamps (tfdt), so it holds for every remux adapter, the fake one
// in the tests included.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MB = 100_000 // bytes of mdat per fragment

/** Reads as fast as possible for `ms`, then cancels; returns the bytes received. */
async function readFor(stream: ReadableStream<Uint8Array>, ms: number): Promise<number> {
  const reader = stream.getReader()
  let bytes = 0
  const stop = Date.now() + ms
  for (;;) {
    const left = stop - Date.now()
    if (left <= 0) break
    const r = await Promise.race([reader.read(), wait(left).then(() => null)])
    if (r === null || r.done) break
    bytes += r.value.byteLength
  }
  await reader.cancel().catch(() => {})
  return bytes
}

describe('paceFragmentedMp4', () => {
  it('releases the recording no faster than speed x real time plus the burst, even when the NVR sends everything at once', async () => {
    const init = fmp4Init().length
    const fragment = makeFmp4({ fragments: 1, payloadBytes: MB }).length - init
    const src = streamOf(makeFmp4({ fragments: 60, fragmentSec: 1, payloadBytes: MB }))
    const got = await readFor(paceFragmentedMp4(src, { speed: 4, burstSec: 2, maxBytes: 1e9, viewerIdleMs: 10_000 }), 1000)
    // after 1 s at 4x with a 2 s burst: at most 2 + 4 + one fragment of recording (the fragment that is released at its time)
    expect(got).toBeLessThanOrEqual(init + 7 * fragment)
    expect(got).toBeGreaterThanOrEqual(init + 3 * fragment) // and it does flow
  })

  it('16x stays possible: an hour of recording is released in about 3.75 minutes (here: 40 s of recording at 16x in about 2.5 s)', async () => {
    let end: PaceEnd | null = null
    const t0 = Date.now()
    const stream = paceFragmentedMp4(streamOf(makeFmp4({ fragments: 40, fragmentSec: 1, payloadBytes: 1000 })), { speed: 16, burstSec: 0, maxBytes: 1e9, viewerIdleMs: 10_000, onEnd: (e) => (end = e) })
    await new Response(stream).arrayBuffer()
    const ms = Date.now() - t0
    expect(ms).toBeGreaterThanOrEqual(39_000 / 16 - 200)
    expect(ms).toBeLessThan(39_000 / 16 + 1500)
    expect(end).toMatchObject({ reason: 'complete' })
    expect(end!.mediaSec).toBeGreaterThanOrEqual(39)
  })

  it('caps the bytes of one stream: past the cap it ends (and the NVR transfer with it)', async () => {
    let end: PaceEnd | null = null
    const src = streamOf(makeFmp4({ fragments: 50, payloadBytes: MB }))
    const bytes = new Uint8Array(await new Response(paceFragmentedMp4(src, { speed: 1000, burstSec: 1000, maxBytes: 5 * MB, viewerIdleMs: 10_000, onEnd: (e) => (end = e) })).arrayBuffer())
    expect(bytes.length).toBeLessThanOrEqual(6 * (MB + 200))
    expect(end).toMatchObject({ reason: 'bytes' })
    expect(src.cancelled()).toBe(true)
  })

  it('review I-2: a reader that stops reading (a paused or hidden player) ends the stream after the idle time, and the source is let go', async () => {
    let end: PaceEnd | null = null
    const src = streamOf(makeFmp4({ fragments: 100, payloadBytes: 1000 }))
    const reader = paceFragmentedMp4(src, { speed: 1000, burstSec: 1000, maxBytes: 1e9, viewerIdleMs: 300, onEnd: (e) => (end = e) }).getReader()
    await reader.read()
    await reader.read()
    await wait(700) // the viewer reads nothing
    expect(end).toMatchObject({ reason: 'idle' })
    expect(src.cancelled()).toBe(true)
  })

  it('a stream that is not a fragmented MP4 (no timestamps to pace by) is ended with an error, never passed on unpaced', async () => {
    let end: PaceEnd | null = null
    const stream = paceFragmentedMp4(streamOf(new TextEncoder().encode('<html>this is not a recording</html>')), { speed: 2, burstSec: 1, maxBytes: 1e9, viewerIdleMs: 1000, onEnd: (e) => (end = e) })
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow()
    expect(end).toMatchObject({ reason: 'format', bytes: 0 })
  })

  it('the person going away (cancel) ends it at once', async () => {
    let end: PaceEnd | null = null
    const src = streamOf(makeFmp4({ fragments: 10, payloadBytes: MB })) // more than one chunk: the source is still running
    const r = paceFragmentedMp4(src, { speed: 2, burstSec: 0, maxBytes: 1e9, viewerIdleMs: 10_000, onEnd: (e) => (end = e) }).getReader()
    await r.read()
    await r.cancel()
    expect(end).toMatchObject({ reason: 'cancelled' })
    expect(src.cancelled()).toBe(true)
  })
})

describe('framing (obfuscation, not encryption)', () => {
  const token = 'eyJzaWQiOiJ4In0.' + Buffer.alloc(32, 7).toString('base64url')
  it('a saved body is not a playable file: it does not begin with an MP4 box', () => {
    const key = framingKey(token)
    expect(key).toHaveLength(32)
    const bytes = makeFmp4({ fragments: 2 })
    const framed = xorFrame(bytes, key, 0)
    expect(Buffer.from(framed.subarray(4, 8)).toString('latin1')).not.toBe('ftyp')
  })
  it('the page undoes it chunk by chunk at any offset', () => {
    const key = framingKey(token)
    const bytes = makeFmp4({ fragments: 3 })
    const framed = xorFrame(bytes, key, 0)
    const back = Buffer.concat([xorFrame(framed.subarray(0, 11), key, 0), xorFrame(framed.subarray(11, 500), key, 11), xorFrame(framed.subarray(500), key, 500)])
    expect(back).toEqual(bytes)
  })
  it('the key comes from the token alone (no Web Crypto needed on a plain-http address); a token without a signature gives no key', () => {
    expect(() => framingKey('no-signature')).toThrow()
    expect(Buffer.from(framingKey(token))).toEqual(Buffer.alloc(32, 7))
  })
})
