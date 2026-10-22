import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

// P3-0 (directive: "Verify the background is truly transparent"; tracker BR-3, BR-4): the shipped logo files are decoded here, not trusted.
// A minimal PNG reader: IHDR, IDAT (inflated and unfiltered), 8-bit RGBA or grey+alpha, no interlacing (what the brand files use).

type Png = { width: number; height: number; colorType: number; bitDepth: number; interlace: number; alphaAt: (x: number, y: number) => number }

function readPng(file: string): Png {
  const buf = readFileSync(file)
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file} is a PNG`).toBe(true)
  let offset = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat: Buffer[] = []
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : 0
  const bpp = channels * (bitDepth / 8)
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(stride * height)
  if (channels > 0 && interlace === 0) {
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? pixels[y * stride + i - bpp] : 0
        const b = y > 0 ? pixels[(y - 1) * stride + i] : 0
        const c = i >= bpp && y > 0 ? pixels[(y - 1) * stride + i - bpp] : 0
        let p: number
        if (filter === 0) p = 0
        else if (filter === 1) p = a
        else if (filter === 2) p = b
        else if (filter === 3) p = (a + b) >> 1
        else {
          const est = a + b - c
          const pa = Math.abs(est - a), pb = Math.abs(est - b), pc = Math.abs(est - c)
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        pixels[y * stride + i] = (line[i] + p) & 0xff
      }
    }
  }
  return {
    width, height, colorType, bitDepth, interlace,
    // The most significant byte of the alpha sample.
    alphaAt: (x, y) => pixels[y * stride + x * bpp + (channels - 1) * (bitDepth / 8)],
  }
}

const ROOT = path.resolve(__dirname, '../..')
const BRAND_FILES = [
  ['citykart-drishti-logo.png', 1851, 849],
  ['citykart-drishti-logo-925.png', 925, 0],
  ['citykart-drishti-logo-462.png', 462, 0],
  ['citykart-drishti-mark-32.png', 32, 32],
  ['citykart-drishti-mark-64.png', 64, 64],
  ['citykart-drishti-mark-180.png', 180, 180],
  ['citykart-drishti-mark-256.png', 256, 256],
  ['citykart-drishti-mark-512.png', 512, 512],
] as const

describe('brand image files', () => {
  it.each(BRAND_FILES)('%s has an alpha channel and transparent corners', (name, width, height) => {
    const png = readPng(path.join(ROOT, 'public', 'brand', name))
    expect([4, 6], 'colour type with alpha').toContain(png.colorType)
    expect(png.interlace).toBe(0)
    expect(png.width).toBe(width)
    if (height) expect(png.height).toBe(height)
    const w = png.width - 1, h = png.height - 1
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) expect(png.alphaAt(x, y), `alpha at ${x},${y}`).toBe(0)
  })

  it('the web sizes of the full logo keep the original 1851:849 shape', () => {
    for (const name of ['citykart-drishti-logo-925.png', 'citykart-drishti-logo-462.png']) {
      const png = readPng(path.join(ROOT, 'public', 'brand', name))
      expect(Math.abs(png.width / png.height - 1851 / 849), name).toBeLessThan(0.01)
    }
  })

  it('the full logo really has artwork (not an empty transparent file)', () => {
    const png = readPng(path.join(ROOT, 'public', 'brand', 'citykart-drishti-logo.png'))
    let opaque = 0
    for (let y = 0; y < png.height; y += 7) for (let x = 0; x < png.width; x += 7) if (png.alphaAt(x, y) > 200) opaque++
    expect(opaque).toBeGreaterThan(1000)
  })
})
