import { describe, expect, it } from 'vitest'
import { initSegment, mimeFor, videoCodecOf } from '@/lib/streams/mp4'

// P4-L2: the browser player (Media Source Extensions) must name the codec of the fragmented MP4 before it can play it. It reads it from the
// stream's own first part (ftyp + moov): avcC for H.264, hvcC for H.265. Synthetic boxes here; real ffmpeg output is checked by the
// skipped-with-reason real-ffmpeg test (ffmpeg is not installed on this PC).

const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload)
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}
const sampleEntry = (type: string, config: Buffer) => box(type, Buffer.alloc(78), config)
const stsd = (entry: Buffer) => box('stsd', Buffer.alloc(4), u32(1), entry)
const moov = (entry: Buffer) => box('moov', box('mvhd', Buffer.alloc(100)), box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('mdhd', Buffer.alloc(24)), box('minf', box('stbl', stsd(entry))))))
const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso5', 'latin1'))
const avcC = box('avcC', Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1]))
// hvcC: version 1, profile space 0, tier main, profile 1 (Main); compatibility flags 0x60000000; constraint 0x90 then zeros; level 93.
const hvcC = box('hvcC', Buffer.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93]))
const moof = box('moof', box('mfhd', Buffer.alloc(8)))

describe('initSegment', () => {
  it('is the length of ftyp + moov once both have fully arrived', () => {
    const init = Buffer.concat([ftyp, moov(sampleEntry('avc1', avcC))])
    expect(initSegment(Buffer.concat([init, moof]))).toEqual({ ok: true, end: init.length })
    expect(initSegment(init)).toEqual({ ok: true, end: init.length })
  })
  it('asks for more while moov is still arriving', () => {
    const init = Buffer.concat([ftyp, moov(sampleEntry('avc1', avcC))])
    expect(initSegment(init.subarray(0, init.length - 10))).toEqual({ ok: false, more: true })
    expect(initSegment(Buffer.alloc(0))).toEqual({ ok: false, more: true })
  })
  it('is not a recording when the stream does not begin like an MP4, or a fragment comes before moov', () => {
    expect(initSegment(Buffer.from('<html>not a video</html>'))).toEqual({ ok: false, more: false })
    expect(initSegment(Buffer.concat([ftyp, moof]))).toEqual({ ok: false, more: false })
    expect(initSegment(Buffer.concat([u32(4), Buffer.from('ftyp', 'latin1')]))).toEqual({ ok: false, more: false }) // a box smaller than its header
  })
})

describe('videoCodecOf', () => {
  it('H.264: avc1.PPCCLL from avcC', () => {
    expect(videoCodecOf(Buffer.concat([ftyp, moov(sampleEntry('avc1', avcC))]))).toEqual({ family: 'h264', codec: 'avc1.64001f' })
    expect(videoCodecOf(Buffer.concat([ftyp, moov(sampleEntry('avc3', avcC))]))).toEqual({ family: 'h264', codec: 'avc3.64001f' })
  })
  it('H.265: hvc1/hev1 with profile, compatibility, tier, level and constraints', () => {
    expect(videoCodecOf(Buffer.concat([ftyp, moov(sampleEntry('hvc1', hvcC))]))).toEqual({ family: 'h265', codec: 'hvc1.1.6.L93.90' })
    expect(videoCodecOf(Buffer.concat([ftyp, moov(sampleEntry('hev1', hvcC))]))?.codec).toBe('hev1.1.6.L93.90')
  })
  it('anything else is not known (null), never a guess', () => {
    expect(videoCodecOf(Buffer.concat([ftyp, moov(sampleEntry('mp4v', box('esds', Buffer.alloc(20))))]))).toBeNull()
    expect(videoCodecOf(Buffer.from('rubbish'))).toBeNull()
  })
  it('the type for the player names the codec', () => {
    expect(mimeFor('avc1.64001f')).toBe('video/mp4; codecs="avc1.64001f"')
  })
})
