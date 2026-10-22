// P4-L2: just enough of the MP4 box format for the browser player (Media Source Extensions). A fragmented MP4 begins with `ftyp` and
// `moov` (the "initialisation segment"), then `moof` + `mdat` fragments. The player must name the video codec before it can play, and it is
// written inside moov: avcC (H.264) or hvcC (H.265) in the sample description. Nothing here trusts the bytes: every length is checked
// against what is there, and anything unexpected is "not known" (null), never a guess. No browser and no server code: tested on its own.

const TOP_LEVEL = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'free', 'skip', 'sidx', 'emsg', 'prft', 'uuid', 'mfra'])
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
const VIDEO_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1'])
/** A visual sample entry's own fields after its 8-byte header and before its child boxes (ISO 14496-12: 6 reserved + 2 index + 70). */
const VISUAL_ENTRY_FIELDS = 78
const MAX_DEPTH = 8
/** ftyp and moov of a camera recording are a few kilobytes; anything claiming more than this is not one. */
const MAX_INIT_BOX = 4 * 1024 * 1024

type Box = { type: string; start: number; body: number; end: number }

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const typeAt = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

/**
 * The header of the box at `at` (its type and where it ends, which may be beyond `limit` when it has not fully arrived), 'more' when not
 * even the header is there, or null when it cannot be a box.
 */
function headerAt(b: Uint8Array, at: number, limit: number): Box | 'more' | null {
  if (at + 8 > limit) return 'more'
  let size = u32(b, at)
  let header = 8
  if (size === 1) {
    if (at + 16 > limit) return 'more'
    if (u32(b, at + 8) !== 0) return null // over 4 GB: never in an initialisation segment
    size = u32(b, at + 12)
    header = 16
  } else if (size === 0) size = limit - at // to the end
  if (size < header) return null
  return { type: typeAt(b, at + 4), start: at, body: at + header, end: at + size }
}

/** A box that has fully arrived inside `limit`, else 'more' or null as headerAt. */
function boxAt(b: Uint8Array, at: number, limit: number): Box | 'more' | null {
  const h = headerAt(b, at, limit)
  if (h === 'more' || h === null) return h
  return h.end > limit ? 'more' : h
}

/**
 * The length of the initialisation segment (ftyp + moov) once both have fully arrived: `{ ok: true, end }`. `{ ok: false, more: true }`
 * while it is still arriving; `{ ok: false, more: false }` when the bytes are not a fragmented MP4 (they do not start like one, or a
 * fragment comes before moov).
 */
export function initSegment(bytes: Uint8Array): { ok: true; end: number } | { ok: false; more: boolean } {
  let at = 0
  let sawStart = false
  while (at < bytes.length) {
    const box = headerAt(bytes, at, bytes.length)
    if (box === 'more') return { ok: false, more: true }
    if (box === null || !TOP_LEVEL.has(box.type)) return { ok: false, more: false }
    if (!sawStart && box.type !== 'ftyp' && box.type !== 'styp') return { ok: false, more: false }
    sawStart = true
    if (box.type === 'moof' || box.type === 'mdat') return { ok: false, more: false }
    if (box.end - box.start > MAX_INIT_BOX) return { ok: false, more: false }
    if (box.end > bytes.length) return { ok: false, more: true }
    if (box.type === 'moov') return { ok: true, end: box.end }
    at = box.end
  }
  return { ok: false, more: true }
}

function children(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = []
  let at = from
  while (at < to) {
    const box = boxAt(b, at, to)
    if (box === 'more' || box === null) break
    out.push(box)
    at = box.end
  }
  return out
}

function findVideoEntry(b: Uint8Array, box: Box, depth: number): { entry: Box; config: Box } | null {
  if (depth > MAX_DEPTH) return null
  if (box.type === 'stsd') {
    // A full box (4 bytes of version and flags) and an entry count, then the sample entries.
    for (const entry of children(b, box.body + 8, box.end)) {
      if (!VIDEO_ENTRIES.has(entry.type)) continue
      const wanted = entry.type.startsWith('avc') ? 'avcC' : 'hvcC'
      const config = children(b, entry.body + VISUAL_ENTRY_FIELDS, entry.end).find((c) => c.type === wanted)
      if (config) return { entry, config }
    }
    return null
  }
  if (!CONTAINERS.has(box.type)) return null
  for (const child of children(b, box.body, box.end)) {
    const found = child.type === 'stsd' || CONTAINERS.has(child.type) ? findVideoEntry(b, child, depth + 1) : null
    if (found) return found
  }
  return null
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

function reverseBits32(n: number): number {
  let r = 0
  for (let i = 0; i < 32; i++) r = ((r << 1) | ((n >>> i) & 1)) >>> 0
  return r
}

/**
 * The video codec of an initialisation segment as the player names it: `avc1.PPCCLL` (H.264, from avcC) or
 * `hvc1.<profile>.<compatibility>.<tier><level>.<constraints>` (H.265, from hvcC, ISO 14496-15 annex E); null when it is neither.
 */
export function videoCodecOf(init: Uint8Array): { family: 'h264' | 'h265'; codec: string } | null {
  const top = children(init, 0, init.length)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) return null
  const found = findVideoEntry(init, moov, 0)
  if (!found) return null
  const { entry, config } = found
  const c = config.body
  if (entry.type.startsWith('avc')) {
    if (config.end - c < 4) return null
    return { family: 'h264', codec: `${entry.type}.${hex2(init[c + 1])}${hex2(init[c + 2])}${hex2(init[c + 3])}` }
  }
  if (config.end - c < 13) return null
  const p = init[c + 1]
  const space = ['', 'A', 'B', 'C'][p >> 6]
  const tier = p & 0x20 ? 'H' : 'L'
  const profile = p & 0x1f
  const compat = reverseBits32(u32(init, c + 2)).toString(16)
  const constraints = Array.from(init.subarray(c + 6, c + 12))
  while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop()
  const level = init[c + 12]
  const tail = constraints.map((n) => n.toString(16).toUpperCase()).join('.')
  return { family: 'h265', codec: `${entry.type}.${space}${profile}.${compat}.${tier}${level}${tail ? `.${tail}` : ''}` }
}

/** The type the player is asked to accept. */
export const mimeFor = (codec: string): string => `video/mp4; codecs="${codec}"`
