// P4-L2 review round 1 (owner ruling on I-1: playback-only people must not be able to dump recordings; I-2: a reader that stops gives
// its place back). The fast playback stream is released no faster than its SIGNED speed times real time, by the recording's own
// timestamps: a fragmented MP4 is ftyp + moov (the track's timescale in mdhd) and then moof + mdat fragments, each moof carrying the
// fragment's start (tfdt). Fragment k is released when   wall seconds since the first fragment >= (start_k - start_0 - burst) / speed.
// It is a property of the stream layer, so it holds for every remux adapter (ffmpeg, which also gets -readrate; the development
// pass-through; the fake one of the tests). A body that is not a fragmented MP4 is never passed on unpaced: it ends with an error.
//
//   16x: 16 s of recording per wall second → an hour of recording takes 3.75 minutes (plus nothing: the burst only moves the start).
//
// Also: a byte cap per stream, and a viewer-idle end — the consumer (the person's connection) has not asked for more for `viewerIdleMs`
// (a paused or hidden player, or a reader that stopped): the stream ends cleanly and the upstream (NVR transfer, remux) is cancelled.

// Release 1 clean-ups (P4-L2 re-review):
//   N-2  a stream that released any recording is charged at least PACE_MIN_CHARGE_SEC (one fragment's length is only known from the
//        next one, so a one-fragment stream used to cost nothing); the released time is a running maximum of the fragments' times.
//   N-3  a reader far slower than the signed speed gives its place back: over PACE_MIN_RATE.windowMs, if the reader took less than
//        PACE_MIN_RATE.fraction of speed x wall time AND the stream spent most of that time waiting for the reader (not for the NVR),
//        the stream ends ('slow'). A one-fragment-every-50-s reader no longer holds a viewer place for the whole clip.
//   N-6  after the init segment only moof + mdat fragments carry time; other boxes (styp, sidx, free, …) are allowed only small
//        (MAX_TIMELESS_BYTES) and at most MAX_TIMELESS_IN_A_ROW between two fragments, so nothing big ever goes out unpaced.

const MAX_UNIT_BYTES = 64 * 1024 * 1024
const MAX_INIT_BYTES = 4 * 1024 * 1024
const MAX_TIMELESS_BYTES = 64 * 1024
const MAX_TIMELESS_IN_A_ROW = 4
/** The least a stream that released any recording is charged, in seconds of recording (N-2). */
export const PACE_MIN_CHARGE_SEC = 60
/** The slow-reader rule (N-3): under a quarter of the signed speed over 2 minutes, while the stream waits for the reader. */
export const PACE_MIN_RATE = { windowMs: 120_000, fraction: 0.25 }

export type PaceEndReason = 'complete' | 'idle' | 'slow' | 'bytes' | 'cancelled' | 'format' | 'failed'
/** How a paced stream ended: why, the recording seconds released (from the fragments' own times) and the bytes sent. */
export type PaceEnd = { reason: PaceEndReason; mediaSec: number; bytes: number }

export type PaceOptions = {
  /** The signed speed (2, 4, 8 or 16). */
  speed: number
  /** Recording seconds that may go out ahead of speed x real time (the player's start and look-ahead). */
  burstSec: number
  /** The most bytes one stream may carry. */
  maxBytes: number
  /** End the stream when the consumer has not asked for more for this long. */
  viewerIdleMs: number
  /** Called once when the stream is over, whatever the reason. */
  onEnd?: (end: PaceEnd) => void
  /** Transforms each released chunk at its stream offset (framing); default: as it is. */
  frame?: (bytes: Uint8Array, offset: number) => Uint8Array
  /** The slow-reader rule (default PACE_MIN_RATE). */
  minRate?: { windowMs: number; fraction: number }
  /** The least charge of a stream that released recording (default PACE_MIN_CHARGE_SEC). */
  minChargeSec?: number
}

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const typeAt = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

type Box = { type: string; start: number; body: number; end: number }
/** The box header at `at` (its end may lie beyond the bytes held), null when not even the header is there, 'bad' when it is not a box. */
function header(b: Uint8Array, at: number): Box | null | 'bad' {
  if (at + 8 > b.length) return null
  let size = u32(b, at)
  let head = 8
  if (size === 1) {
    if (at + 16 > b.length) return null
    if (u32(b, at + 8) !== 0) return 'bad'
    size = u32(b, at + 12)
    head = 16
  }
  if (size < head) return 'bad' // size 0 ("to the end") is not used by a live fragmented MP4
  return { type: typeAt(b, at + 4), start: at, body: at + head, end: at + size }
}
function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  for (let at = from; at < to; ) {
    const h = header(b, at)
    if (h === null || h === 'bad' || h.end > to) break
    out.push(h)
    at = h.end
  }
  return out
}
const find = (b: Uint8Array, box: Box, path: string[]): Box | null => {
  let cur: Box | null = box
  for (const type of path) {
    cur = cur ? (children(b, cur.body, cur.end).find((c) => c.type === type) ?? null) : null
  }
  return cur
}
/** The timescale of the first track (moov/trak/mdia/mdhd), or null. */
function timescaleOf(b: Uint8Array, moov: Box): number | null {
  const mdhd = find(b, moov, ['trak', 'mdia', 'mdhd'])
  if (!mdhd || mdhd.end - mdhd.body < 24) return null
  const v = b[mdhd.body]
  const at = mdhd.body + (v === 1 ? 20 : 12)
  if (at + 4 > mdhd.end) return null
  const ts = u32(b, at)
  return ts > 0 ? ts : null
}
/** The fragment's start in timescale units (moof/traf/tfdt), or null. */
function tfdtOf(b: Uint8Array, moof: Box): number | null {
  const tfdt = find(b, moof, ['traf', 'tfdt'])
  if (!tfdt || tfdt.end - tfdt.body < 8) return null
  const v = b[tfdt.body]
  if (v === 1) {
    if (tfdt.end - tfdt.body < 12) return null
    return u32(b, tfdt.body + 4) * 2 ** 32 + u32(b, tfdt.body + 8)
  }
  return u32(b, tfdt.body + 4)
}

/** The paced stream (see the top of this file). Cancelling it cancels `source`. */
export function paceFragmentedMp4(source: ReadableStream<Uint8Array>, o: PaceOptions): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let held = new Uint8Array(0)
  let initDone = false
  let timescale = 0
  let firstTfdt: number | null = null
  let lastMediaSec = 0 // the latest recording time released (a running maximum, N-2)
  let fragmentSec = 0 // the last gap between two fragments: the released recording ends about one gap after the last start
  let releasedAny = false
  let timeless = 0 // boxes without time since the last fragment (N-6)
  let startedAt = 0
  let sent = 0
  let ended = false
  let upstreamDone = false
  let lastAsk = Date.now()
  let asking = false
  let readerWaitMs = 0 // wall time the stream had nothing asked of it (it was waiting for the reader), ended gaps only (N-3)
  let sleepTimer: ReturnType<typeof setTimeout> | undefined
  let wakeSleep: (() => void) | null = null
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const minRate = o.minRate ?? PACE_MIN_RATE
  const minCharge = o.minChargeSec ?? PACE_MIN_CHARGE_SEC
  const samples: { t: number; media: number; wait: number }[] = []

  const finish = (reason: PaceEndReason, how: 'close' | 'error' | 'none') => {
    if (ended) return
    ended = true
    clearInterval(idleTimer)
    clearTimeout(sleepTimer)
    wakeSleep?.()
    if (!upstreamDone) void reader.cancel().catch(() => {})
    try {
      if (how === 'close') controller?.close()
      else if (how === 'error') controller?.error(new Error('The recording could not be played.'))
    } catch {
      // the consumer has gone
    }
    const released = releasedAny ? Math.max(minCharge, Math.round(lastMediaSec + fragmentSec)) : 0
    o.onEnd?.({ reason, mediaSec: sent === 0 ? 0 : released, bytes: sent })
  }
  /** N-3: over the last window, did the reader take less than its share while the stream mostly waited for it? */
  const tooSlow = (now: number): boolean => {
    const wait = readerWaitMs + (asking ? 0 : now - lastAsk)
    samples.push({ t: now, media: lastMediaSec, wait })
    while (samples.length > 1 && samples[1].t <= now - minRate.windowMs) samples.shift()
    const from = samples[0]
    const span = now - from.t
    if (startedAt === 0 || from.t < startedAt || span < minRate.windowMs) return false
    const taken = lastMediaSec - from.media
    return taken < minRate.fraction * o.speed * (span / 1000) && wait - from.wait > span / 2
  }
  // Review I-2: nobody asked for more for viewerIdleMs while there is more to give → the viewer has stopped; end cleanly.
  const idleTimer = setInterval(() => {
    if (ended) return
    const now = Date.now()
    if (!asking && now - lastAsk >= o.viewerIdleMs) finish('idle', 'close')
    else if (tooSlow(now)) finish('slow', 'close')
  }, Math.max(50, Math.min(5000, Math.floor(o.viewerIdleMs / 4), Math.floor(minRate.windowMs / 8))))
  ;(idleTimer as { unref?: () => void }).unref?.()

  const append = (chunk: Uint8Array) => {
    const joined = new Uint8Array(held.length + chunk.length)
    joined.set(held)
    joined.set(chunk, held.length)
    held = joined
  }
  /** The next complete unit to release (init, a fragment = moof + mdat, or another top-level box), 'more', or 'bad'. */
  const nextUnit = (): { bytes: Uint8Array; mediaSec: number | null } | 'more' | 'bad' => {
    if (!initDone) {
      for (let at = 0; ; ) {
        const h = header(held, at)
        if (h === 'bad') return 'bad'
        if (h === null || h.end > held.length) return held.length > MAX_INIT_BYTES ? 'bad' : 'more'
        if (at === 0 && h.type !== 'ftyp' && h.type !== 'styp') return 'bad'
        if (h.type === 'moof' || h.type === 'mdat') return 'bad'
        if (h.type === 'moov') {
          const ts = timescaleOf(held, h)
          if (ts === null) return 'bad'
          timescale = ts
          initDone = true
          return { bytes: held.subarray(0, h.end), mediaSec: null }
        }
        at = h.end
      }
    }
    const h = header(held, 0)
    if (h === 'bad') return 'bad'
    if (h === null) return 'more'
    if (h.end - h.start > MAX_UNIT_BYTES) return 'bad'
    if (h.end > held.length) return 'more'
    if (h.type !== 'moof') {
      // styp, sidx, free, …: no time of their own, so only small ones and only a few in a row (release 1, N-6).
      if (h.type === 'mdat' || h.end - h.start > MAX_TIMELESS_BYTES || timeless >= MAX_TIMELESS_IN_A_ROW) return 'bad'
      return { bytes: held.subarray(0, h.end), mediaSec: null }
    }
    const t = tfdtOf(held, h)
    if (t === null) return 'bad'
    const m = header(held, h.end)
    if (m === 'bad') return 'bad'
    if (m === null || m.end > held.length) return m !== null && m.end - h.start > MAX_UNIT_BYTES ? 'bad' : 'more'
    if (m.type !== 'mdat') return 'bad'
    if (firstTfdt === null) firstTfdt = t
    return { bytes: held.subarray(0, m.end), mediaSec: (t - firstTfdt) / timescale }
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wakeSleep = resolve
      sleepTimer = setTimeout(resolve, ms)
    })

  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      async pull(c) {
        if (ended) return
        readerWaitMs += Date.now() - lastAsk
        asking = true
        try {
          for (;;) {
            const unit = nextUnit()
            if (unit === 'bad') return finish('format', 'error')
            if (unit === 'more') {
              if (upstreamDone) return held.length === 0 && initDone ? finish('complete', 'close') : finish('format', 'error')
              let r: ReadableStreamReadResult<Uint8Array>
              try {
                r = await reader.read()
              } catch {
                return finish('failed', 'error')
              }
              if (ended) return
              if (r.done) upstreamDone = true
              else append(r.value)
              continue
            }
            if (unit.mediaSec !== null) {
              if (startedAt === 0) startedAt = Date.now()
              const dueMs = ((unit.mediaSec - o.burstSec) / o.speed) * 1000 - (Date.now() - startedAt)
              if (dueMs > 0) await sleep(dueMs)
              if (ended) return
            }
            if (sent + unit.bytes.length > o.maxBytes) return finish('bytes', 'close')
            const out = o.frame ? o.frame(unit.bytes, sent) : unit.bytes.slice()
            held = held.slice(unit.bytes.length)
            sent += out.length
            if (unit.mediaSec !== null) {
              if (unit.mediaSec > lastMediaSec) {
                fragmentSec = unit.mediaSec - lastMediaSec
                lastMediaSec = unit.mediaSec
              }
              releasedAny = true
              timeless = 0
            } else if (initDone && sent > out.length) timeless++
            c.enqueue(out)
            return
          }
        } finally {
          asking = false
          lastAsk = Date.now()
        }
      },
      cancel() {
        finish('cancelled', 'none')
      },
    },
    { highWaterMark: 0 },
  )
}
