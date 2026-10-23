import { describe, expect, it } from 'vitest'
import { framingKey, xorFrame } from '@/lib/streams/framing'
import { PACE_MIN_CHARGE_SEC, PACE_MIN_RATE, paceFragmentedMp4, type PaceEnd } from '@/lib/streams/pace'
import { box, fmp4Fragment, fmp4Init, makeFmp4, streamOf } from '../helpers/fmp4'

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

  // Release 1 clean-ups (P4-L2 re-review N-2): a stream that released one fragment was charged 0 seconds (the fragment's length is only
  // known from the next one). Every stream that released any recording is charged at least 60 s, and the time is a running maximum.
  it('N-2: a stream that released one fragment is charged at least 60 s; nothing released costs nothing', async () => {
    let end: PaceEnd | null = null
    await new Response(paceFragmentedMp4(streamOf(makeFmp4({ fragments: 1, payloadBytes: 1000 })), { speed: 16, burstSec: 1000, maxBytes: 1e9, viewerIdleMs: 5000, onEnd: (e) => (end = e) })).arrayBuffer()
    expect(end).toMatchObject({ reason: 'complete', mediaSec: 60 })
    let none: PaceEnd | null = null
    await new Response(paceFragmentedMp4(streamOf(fmp4Init()), { speed: 16, burstSec: 1000, maxBytes: 1e9, viewerIdleMs: 5000, onEnd: (e) => (none = e) })).arrayBuffer()
    expect(none).toMatchObject({ mediaSec: 0 })
  })

  it('N-2: the charged time is the latest recording time released, even when a fragment goes back in time', async () => {
    let end: PaceEnd | null = null
    const bytes = Buffer.concat([fmp4Init(), fmp4Fragment(0, 1000), fmp4Fragment(100, 1000), fmp4Fragment(50, 1000)])
    await new Response(paceFragmentedMp4(streamOf(bytes), { speed: 16, burstSec: 1000, maxBytes: 1e9, viewerIdleMs: 5000, onEnd: (e) => (end = e) })).arrayBuffer()
    expect(end).toMatchObject({ reason: 'complete', mediaSec: 200 }) // 100 + one gap of 100; before: 50 + 100 = 150
  })

  // N-6: boxes other than moof/mdat after the init segment had no time and were released unpaced; only the byte cap bounded them.
  it('N-6: a large box between fragments (or a run of them) ends the stream as not a recording; a small styp per fragment is fine', async () => {
    const free = (n: number) => box('free', Buffer.alloc(n))
    for (const bytes of [
      Buffer.concat([fmp4Init(), fmp4Fragment(0, 1000), free(200_000), fmp4Fragment(1, 1000)]),
      Buffer.concat([fmp4Init(), fmp4Fragment(0, 1000), ...Array.from({ length: 6 }, () => free(100)), fmp4Fragment(1, 1000)]),
    ]) {
      let end: PaceEnd | null = null
      await expect(new Response(paceFragmentedMp4(streamOf(bytes), { speed: 16, burstSec: 1000, maxBytes: 1e9, viewerIdleMs: 5000, onEnd: (e) => (end = e) })).arrayBuffer()).rejects.toThrow()
      expect(end).toMatchObject({ reason: 'format' })
    }
    let ok: PaceEnd | null = null
    const styp = box('styp', Buffer.from('msdh', 'latin1'), Buffer.alloc(4), Buffer.from('msdhmsix', 'latin1'))
    const good = Buffer.concat([fmp4Init(), ...[0, 1, 2].flatMap((s) => [styp, fmp4Fragment(s, 1000)])])
    await new Response(paceFragmentedMp4(streamOf(good), { speed: 16, burstSec: 1000, maxBytes: 1e9, viewerIdleMs: 5000, onEnd: (e) => (ok = e) })).arrayBuffer()
    expect(ok).toMatchObject({ reason: 'complete' })
  })

  // N-3: a reader that takes one fragment every ~50 s held a viewer place for the whole clip while being charged almost nothing.
  describe('N-3: a reader far slower than the signed speed gives its place back', () => {
    const slowRule = { windowMs: 800, fraction: 0.25 }
    it('ends a stream whose reader takes under a quarter of the signed speed while the stream waits for it', async () => {
      let end: PaceEnd | null = null
      const src = streamOf(makeFmp4({ fragments: 200, fragmentSec: 1, payloadBytes: 1000 }))
      const reader = paceFragmentedMp4(src, { speed: 8, burstSec: 0, maxBytes: 1e9, viewerIdleMs: 5000, minRate: slowRule, onEnd: (e) => (end = e) }).getReader()
      for (let i = 0; i < 6 && !end; i++) {
        const r = await reader.read()
        if (r.done) break
        await wait(400) // 1 s of recording per 0.4 s: 2.5x against 8x signed (31 %)... then slower
        if (i >= 1) await wait(400) // 1 s per 0.8 s: 1.25x, under a quarter of 8x
      }
      await wait(1200)
      expect(end).toMatchObject({ reason: 'slow' })
      expect(src.cancelled()).toBe(true)
    })

    it('keeps a reader that takes what the pace gives (the pace, not the reader, is the slow side)', async () => {
      let end: PaceEnd | null = null
      const got = await readFor(paceFragmentedMp4(streamOf(makeFmp4({ fragments: 200, fragmentSec: 1, payloadBytes: 1000 })), { speed: 2, burstSec: 0, maxBytes: 1e9, viewerIdleMs: 5000, minRate: slowRule, onEnd: (e) => (end = e) }), 2000)
      expect(got).toBeGreaterThan(0)
      expect(end).toMatchObject({ reason: 'cancelled' }) // readFor cancelled it; the slow rule never fired
    })

    it('keeps a stream whose NVR is the slow side (the stream waits for the recording, not for the reader)', async () => {
      let end: PaceEnd | null = null
      const bytes = makeFmp4({ fragments: 40, fragmentSec: 1, payloadBytes: 1000 })
      const init = fmp4Init().length
      const step = (bytes.length - init) / 40
      let at = 0
      const slowNvr = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (at >= bytes.length) return c.close()
          const n = at === 0 ? init + step : step
          if (at > 0) await wait(300) // one second of recording per 0.3 s: 3.3x against 16x signed
          c.enqueue(bytes.subarray(at, at + n))
          at += n
        },
      })
      const got = await readFor(paceFragmentedMp4(slowNvr, { speed: 16, burstSec: 0, maxBytes: 1e9, viewerIdleMs: 5000, minRate: slowRule, onEnd: (e) => (end = e) }), 2500)
      expect(got).toBeGreaterThan(0)
      expect(end).toMatchObject({ reason: 'cancelled' })
    })

    it('the default rule: a quarter of the signed speed over 2 minutes', () => {
      expect(PACE_MIN_RATE).toEqual({ windowMs: 120_000, fraction: 0.25 })
      expect(PACE_MIN_CHARGE_SEC).toBe(60)
    })
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
