// WCAG 2.x contrast from the colour tokens in app/globals.css (P3-0; docs/design/drishti-tokens.md). Used by the field-visibility test
// and the token report. Colours are linear-light sRGB triples in 0..1 after gamut clamping, the same way browsers draw OKLCH values.

export type Rgb = [number, number, number]

/** The custom properties of the first `:root { … }` block (the light theme), comments removed. */
export function parseTokens(css: string): Map<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = clean.search(/:root\s*\{/)
  const tokens = new Map<string, string>()
  if (start < 0) return tokens
  const open = clean.indexOf('{', start)
  const close = clean.indexOf('}', open)
  for (const decl of clean.slice(open + 1, close).split(';')) {
    const m = decl.match(/^\s*--([A-Za-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/)
    if (m) tokens.set(m[1], m[2])
  }
  return tokens
}

const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const srgbEncode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
const clamp = (v: number) => Math.min(1, Math.max(0, v))

function oklchToSrgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin: Rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  // Browsers clamp out-of-gamut colours per channel in the encoded space.
  return lin.map((v) => clamp(srgbEncode(clamp(v)))) as Rgb
}

/** Resolve a token (following var() aliases) to an encoded sRGB triple in 0..1. Only opaque oklch() and #hex values are supported. */
export function resolveColor(tokens: Map<string, string>, name: string, depth = 0): Rgb {
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`Unknown colour token --${name}`)
  if (depth > 10) throw new Error(`Token --${name} refers to itself`)
  const alias = value.match(/^var\(--([A-Za-z0-9-]+)\)$/)
  if (alias) return resolveColor(tokens, alias[1], depth + 1)
  const ok = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/)
  if (ok) return oklchToSrgb(Number(ok[1]) / (ok[2] ? 100 : 1), Number(ok[3]), Number(ok[4]))
  const short = value.match(/^#([0-9a-fA-F]{3})$/)
  const hex = short ? [...short[1]].map((d) => d + d).join('') : value.match(/^#([0-9a-fA-F]{6})$/)?.[1]
  if (hex) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb
  throw new Error(`Token --${name} is not an opaque colour this check understands: ${value}`)
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbDecode(r) + 0.7152 * srgbDecode(g) + 0.0722 * srgbDecode(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const toHex = (rgb: Rgb): string => '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
