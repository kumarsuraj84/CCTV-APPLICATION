import { describe, expect, it, vi } from 'vitest'
import { startFastStream, type FastStreamEnv, type MediaSourceLike, type SourceBufferLike, type VideoLike } from '@/lib/streams/fast-client'
import { framingKey, xorFrame } from '@/lib/streams/framing'
import { FAST_STREAM_PATH, FAST_TOKEN_HEADER, MSG_BROWSER_CANNOT_PLAY, MSG_DOWNSHIFTED, MSG_H265 } from '@/lib/streams/speed'

// P4-L2 (decision D-L1): the browser side of fast playback. The picture is fetched with the token in a header (never in an address a
// person could open or save), read chunk by chunk and handed to Media Source Extensions; the video element plays a blob: picture, never
// the server's address. Fakes for MediaSource, SourceBuffer and the video element: node has none of them.

const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload)
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}
const init = (entry = 'avc1', config = box('avcC', Buffer.from([1, 0x4d, 0x40, 0x1e]))) =>
  Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), u32(0)),
    box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', Buffer.alloc(4), u32(1), box(entry, Buffer.alloc(78), config))))))),
  ])
const fragment = (n: number) => box('moof', Buffer.alloc(16 + n))

class FakeSourceBuffer extends EventTarget implements SourceBufferLike {
  updating = false
  appended: Uint8Array[] = []
  removed: [number, number][] = []
  constructor(private readonly media: FakeVideo, private readonly secondsPerAppend: number) {
    super()
  }
  get buffered() {
    return this.media.buffered
  }
  appendBuffer(b: Uint8Array) {
    this.updating = true
    this.appended.push(b)
    setTimeout(() => {
      this.media.bufferedEnd += this.secondsPerAppend
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    }, 0)
  }
  remove(start: number, end: number) {
    this.updating = true
    this.removed.push([start, end])
    setTimeout(() => {
      this.media.bufferedStart = end
      this.updating = false
      this.dispatchEvent(new Event('updateend'))
    }, 0)
  }
}
class FakeMediaSource extends EventTarget implements MediaSourceLike {
  readyState: 'closed' | 'open' | 'ended' = 'closed'
  buffers: FakeSourceBuffer[] = []
  mimes: string[] = []
  ended = 0
  constructor(private readonly media: FakeVideo, private readonly secondsPerAppend: number) {
    super()
  }
  addSourceBuffer(mime: string) {
    this.mimes.push(mime)
    const b = new FakeSourceBuffer(this.media, this.secondsPerAppend)
    this.buffers.push(b)
    return b
  }
  endOfStream() {
    this.ended++
    this.readyState = 'ended'
  }
}
class FakeVideo extends EventTarget implements VideoLike {
  src = ''
  currentTime = 0
  playbackRate = 1
  defaultPlaybackRate = 1
  muted = false
  error: { code: number } | null = null
  plays = 0
  bufferedStart = 0
  bufferedEnd = 0
  removed: string[] = []
  get buffered() {
    return { length: this.bufferedEnd > this.bufferedStart ? 1 : 0, start: () => this.bufferedStart, end: () => this.bufferedEnd }
  }
  play() {
    this.plays++
    return Promise.resolve()
  }
  pause() {}
  removeAttribute(n: string) {
    this.removed.push(n)
    if (n === 'src') this.src = ''
  }
  load() {}
}

function rig(o: { chunks: Buffer[]; status?: number; json?: unknown; supported?: (t: string) => boolean; secondsPerAppend?: number; holdOpen?: boolean; headers?: Record<string, string> } = { chunks: [] }) {
  const video = new FakeVideo()
  const sources: FakeMediaSource[] = []
  const calls: { url: string; init: RequestInit }[] = []
  let signal: AbortSignal | undefined
  let cancelled = false
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    signal = init.signal ?? undefined
    if (o.json !== undefined) return new Response(JSON.stringify(o.json), { status: o.status ?? 404, headers: { 'Content-Type': 'application/json' } })
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < o.chunks.length) c.enqueue(new Uint8Array(o.chunks[i++]))
        else if (!o.holdOpen) c.close()
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(body, { status: 200, headers: o.headers })
  })
  const MS = class extends FakeMediaSource {
    constructor() {
      super(video, o.secondsPerAppend ?? 1)
      sources.push(this)
      setTimeout(() => {
        this.readyState = 'open'
        this.dispatchEvent(new Event('sourceopen'))
      }, 0)
    }
    static isTypeSupported(t: string) {
      return o.supported ? o.supported(t) : true
    }
  }
  const revoked: string[] = []
  const env: FastStreamEnv = {
    fetch: fetchImpl as unknown as typeof fetch,
    MediaSource: MS as unknown as FastStreamEnv['MediaSource'],
    createObjectURL: () => 'blob:fast-1',
    revokeObjectURL: (u) => revoked.push(u),
    now: () => Date.now(),
  }
  const events = { states: [] as string[], errors: [] as string[], speeds: [] as [number, string][], progress: [] as number[] }
  const callbacks = {
    onState: (s: string) => events.states.push(s),
    onError: (m: string) => events.errors.push(m),
    onSpeed: (s: number, why: string) => events.speeds.push([s, why]),
    onProgress: (sec: number) => events.progress.push(sec),
  }
  return { video, sources, calls, fetchImpl, env, events, callbacks, revoked, signal: () => signal, cancelled: () => cancelled }
}
const settle = async (ms = 30) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms / 5))
}

describe('startFastStream', () => {
  it('fetches the stream path with the token in a header, same-origin and uncached; the token is never part of an address', async () => {
    const r = rig({ chunks: [init(), fragment(10)] })
    const s = startFastStream({ token: 'tok.en', speed: 4, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].url).toBe(FAST_STREAM_PATH)
    expect(r.calls[0].url).not.toContain('tok.en')
    expect(new Headers(r.calls[0].init.headers).get(FAST_TOKEN_HEADER)).toBe('tok.en')
    expect(r.calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    // the video element plays a blob: picture made in this page, not the server's address
    expect(r.video.src).toBe('blob:fast-1')
    s.stop()
  })

  it('hands every chunk to the player in order with the codec read from the stream, plays at the chosen speed and ends the stream', async () => {
    const chunks = [init(), fragment(10), fragment(20), fragment(30)]
    const r = rig({ chunks })
    const s = startFastStream({ token: 't', speed: 8, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle(80)
    const ms = r.sources[0]
    expect(ms.mimes).toEqual(['video/mp4; codecs="avc1.4d401e"'])
    expect(Buffer.concat(ms.buffers[0].appended.map((b) => Buffer.from(b)))).toEqual(Buffer.concat(chunks))
    expect(ms.ended).toBe(1)
    expect(r.video.playbackRate).toBe(8)
    expect(r.video.muted).toBe(true)
    expect(r.video.plays).toBeGreaterThan(0)
    s.stop()
  })

  it('review I-1: a framed body (X-Stream-Framing: x32) is unframed with the key from the token before the player gets it', async () => {
    const token = 'eyJ4IjoxfQ.' + Buffer.alloc(32, 9).toString('base64url')
    const key = framingKey(token)
    const plain = [init(), fragment(10), fragment(20)]
    let offset = 0
    const framed = plain.map((c) => {
      const f = Buffer.from(xorFrame(c, key, offset))
      offset += c.length
      return f
    })
    const r = rig({ chunks: framed, headers: { 'X-Stream-Framing': 'x32' } })
    const s = startFastStream({ token, speed: 4, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle(80)
    expect(r.events.errors).toEqual([])
    expect(Buffer.concat(r.sources[0].buffers[0].appended.map((b) => Buffer.from(b)))).toEqual(Buffer.concat(plain))
    s.stop()
  })

  it('a refusal from the server (JSON before any video) is shown in its own plain words and nothing is played', async () => {
    const r = rig({ chunks: [], json: { error: 'There is no recording at that time.' }, status: 404 })
    startFastStream({ token: 't', speed: 2, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    expect(r.events.errors).toEqual(['There is no recording at that time.'])
    expect(r.events.states.at(-1)).toBe('failed')
    expect(r.sources[0].buffers).toHaveLength(0)
    expect(r.video.plays).toBe(0)
  })

  it('an H.265 recording this browser cannot play says so (conversion is a later release) and stops reading at once', async () => {
    const hevc = init('hvc1', box('hvcC', Buffer.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93])))
    const r = rig({ chunks: [hevc, fragment(10)], supported: (t) => !t.includes('hvc1'), holdOpen: true })
    startFastStream({ token: 't', speed: 2, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    expect(r.events.errors).toEqual([MSG_H265])
    expect(r.signal()?.aborted).toBe(true)
  })

  it('something that is not a fragmented MP4 is the plain "cannot play" message', async () => {
    const r = rig({ chunks: [Buffer.from('<html>no</html>')] })
    startFastStream({ token: 't', speed: 2, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    expect(r.events.errors).toEqual([MSG_BROWSER_CANNOT_PLAY])
  })

  it('waits for enough recording before it starts (buffer gating): about two seconds of watching at the speed', async () => {
    // 16x needs 30 s of recording; each chunk here is 1 s: after 3 fragments it must not have started while the stream is still open.
    const r = rig({ chunks: [init(), fragment(1), fragment(1), fragment(1)], holdOpen: true })
    const s = startFastStream({ token: 't', speed: 16, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle(60)
    expect(r.video.plays).toBe(0)
    s.stop()
    const r2 = rig({ chunks: [init(), fragment(1), fragment(1), fragment(1)], holdOpen: true, secondsPerAppend: 10 })
    const s2 = startFastStream({ token: 't', speed: 16, video: r2.video, env: r2.env, callbacks: r2.callbacks })
    await settle(60)
    expect(r2.video.plays).toBeGreaterThan(0)
    s2.stop()
  })

  it('three stalls within 40 seconds step the speed down one level and say so (auto-downshift)', async () => {
    const r = rig({ chunks: [init(), fragment(1)], secondsPerAppend: 40 })
    const s = startFastStream({ token: 't', speed: 8, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    r.video.dispatchEvent(new Event('playing'))
    // Fix round 1 (seen in the browser check): a stall counts only when the recording ran out (little buffered ahead): here the viewer
    // has played up to the end of what arrived.
    r.video.currentTime = r.video.bufferedEnd - 1
    for (let i = 0; i < 3; i++) r.video.dispatchEvent(new Event('waiting'))
    expect(r.video.playbackRate).toBe(4)
    expect(r.events.speeds).toEqual([[4, MSG_DOWNSHIFTED(8, 4)]])
    s.stop()
  })

  it('a "waiting" while plenty is buffered (the browser decoding, not the recording arriving late) never steps the speed down', async () => {
    const r = rig({ chunks: [init(), fragment(1)], secondsPerAppend: 40 })
    const s = startFastStream({ token: 't', speed: 16, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    r.video.dispatchEvent(new Event('playing'))
    for (let i = 0; i < 5; i++) r.video.dispatchEvent(new Event('waiting'))
    expect(r.video.playbackRate).toBe(16)
    expect(r.events.speeds).toEqual([])
    s.stop()
  })

  it('stop() ends the request, lets go of the picture and frees the blob address; nothing is called afterwards', async () => {
    const r = rig({ chunks: [init(), fragment(1)], holdOpen: true })
    const s = startFastStream({ token: 't', speed: 2, video: r.video, env: r.env, callbacks: r.callbacks })
    await settle()
    s.stop()
    expect(r.signal()?.aborted).toBe(true)
    expect(r.revoked).toEqual(['blob:fast-1'])
    expect(r.video.removed).toContain('src')
    const before = r.events.states.length
    r.video.dispatchEvent(new Event('ended'))
    expect(r.events.states.length).toBe(before)
  })

  it('does not run ahead without limit: reading pauses while far more is buffered than will be watched soon (back-pressure)', async () => {
    const many = [init(), ...Array.from({ length: 20 }, () => fragment(1))]
    const r = rig({ chunks: many, secondsPerAppend: 100 })
    const s = startFastStream({ token: 't', speed: 2, video: r.video, env: r.env, callbacks: r.callbacks, maxAheadSec: 300 })
    await settle(100)
    const appended = r.sources[0].buffers[0].appended.length
    expect(appended).toBeLessThan(many.length)
    r.video.currentTime = 1500 // the viewer has watched on
    r.video.dispatchEvent(new Event('timeupdate'))
    await settle(100)
    expect(r.sources[0].buffers[0].appended.length).toBeGreaterThan(appended)
    s.stop()
  })
})
