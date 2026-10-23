// P4-L2 review I-1: a synthetic fragmented MP4 (ftyp, moov with an avc1 track and its timescale, then moof+mdat fragments whose tfdt gives
// each fragment's start in recording time), so the pacing of the stream layer can be tested without ffmpeg or video.

const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const u64 = (n: number) => Buffer.concat([u32(Math.floor(n / 2 ** 32)), u32(n >>> 0)])
export const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload)
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}

/** ftyp + moov (one avc1 track, timescale `timescale`, mdhd version 0). */
export function fmp4Init(timescale = 1000): Buffer {
  const mdhd = box('mdhd', Buffer.alloc(4), u32(0), u32(0), u32(timescale), u32(0), Buffer.alloc(4))
  const avcC = box('avcC', Buffer.from([1, 0x4d, 0x40, 0x1e]))
  const stsd = box('stsd', Buffer.alloc(4), u32(1), box('avc1', Buffer.alloc(78), avcC))
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), u32(512)),
    box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', mdhd, box('minf', box('stbl', stsd))))),
  ])
}

/** One fragment starting at `startSec` of recording (tfdt version 1), with `payloadBytes` of mdat. */
export function fmp4Fragment(startSec: number, payloadBytes: number, timescale = 1000): Buffer {
  const tfdt = box('tfdt', Buffer.from([1, 0, 0, 0]), u64(Math.round(startSec * timescale)))
  return Buffer.concat([box('moof', box('mfhd', Buffer.alloc(8)), box('traf', box('tfhd', Buffer.alloc(8)), tfdt)), box('mdat', Buffer.alloc(payloadBytes, 0x5a))])
}

/** A whole recording: init plus `fragments` fragments of `fragmentSec` each (starting at `firstSec`). */
export function makeFmp4(o: { fragments: number; fragmentSec?: number; payloadBytes?: number; timescale?: number; firstSec?: number }): Buffer {
  const ts = o.timescale ?? 1000
  const parts = [fmp4Init(ts)]
  for (let i = 0; i < o.fragments; i++) parts.push(fmp4Fragment((o.firstSec ?? 0) + i * (o.fragmentSec ?? 1), o.payloadBytes ?? 1000, ts))
  return Buffer.concat(parts)
}

/** A web stream of the bytes in chunks of `chunk` bytes, all available at once (an NVR that sends as fast as it can). */
export function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> & { cancelled: () => boolean } {
  let at = 0
  let cancelled = false
  const s = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close()
      c.enqueue(bytes.slice(at, at + chunk))
      at += chunk
    },
    cancel() {
      cancelled = true
    },
  })
  return Object.assign(s, { cancelled: () => cancelled })
}
