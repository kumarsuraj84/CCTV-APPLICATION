import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseTokens, resolveColor } from '@/lib/design/contrast'

// P3-0 (owner complaint: fields hard or impossible to see; docs/design/ASSET-MANAGEMENT-DESIGN-REFERENCE.md §6): the WCAG ratios are
// computed from the token values in app/globals.css, so a later edit that makes a field edge, the focus ring or a placeholder faint fails.

const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8')
const tokens = parseTokens(css)
const ratio = (fg: string, bg: string) => contrastRatio(resolveColor(tokens, fg), resolveColor(tokens, bg))

// Every surface a field, a focus ring or text can sit on.
const SURFACES = ['field', 'card', 'background', 'muted', 'popover', 'sidebar', 'field-readonly']

const PAIRS: { what: string; fg: string; on: string[]; min: number }[] = [
  { what: 'field edge at rest', fg: 'field-border', on: SURFACES, min: 3 },
  { what: 'shadcn border-input (same as the field edge)', fg: 'input', on: SURFACES, min: 3 },
  { what: 'field edge on hover', fg: 'field-border-hover', on: SURFACES, min: 3 },
  { what: 'focus ring', fg: 'ring', on: SURFACES, min: 3 },
  { what: 'error edge', fg: 'destructive', on: ['field', 'card', 'muted'], min: 3 },
  { what: 'checkbox and radio (accent colour)', fg: 'primary', on: ['field', 'card', 'muted'], min: 3 },
  { what: 'placeholder', fg: 'field-placeholder', on: ['field', 'field-readonly'], min: 4.5 },
  { what: 'placeholder in components (muted text)', fg: 'muted-foreground', on: ['field', 'field-readonly'], min: 4.5 },
  { what: 'typed text', fg: 'foreground', on: ['field', 'field-readonly', 'card', 'background', 'muted'], min: 4.5 },
  { what: 'labels and secondary text', fg: 'muted-foreground', on: ['card', 'background', 'muted', 'sidebar'], min: 4.5 },
  { what: 'disabled field text', fg: 'field-disabled-foreground', on: ['field-disabled'], min: 4.5 },
  { what: 'error text', fg: 'destructive', on: ['card', 'field', 'background'], min: 4.5 },
  { what: 'error text (strong)', fg: 'destructive-strong', on: ['card', 'muted', 'destructive-soft'], min: 4.5 },
  { what: 'primary button text', fg: 'primary-foreground', on: ['primary'], min: 4.5 },
  { what: 'active navigation text', fg: 'sidebar-accent-foreground', on: ['sidebar-accent'], min: 4.5 },
]

describe('field visibility tokens', () => {
  it('every token the checks need is defined', () => {
    for (const p of PAIRS) for (const name of [p.fg, ...p.on]) expect(tokens.has(name), name).toBe(true)
  })

  for (const p of PAIRS) {
    it(`${p.what}: --${p.fg} is at least ${p.min}:1`, () => {
      for (const on of p.on) expect(ratio(p.fg, on), `--${p.fg} on --${on}`).toBeGreaterThanOrEqual(p.min)
    })
  }

  it('the disabled field is still told apart from the page (edge kept)', () => {
    expect(ratio('field-border', 'field-disabled')).toBeGreaterThanOrEqual(3)
  })
})

describe('contrast helper', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5)
    expect(contrastRatio([1, 1, 1], [1, 1, 1])).toBeCloseTo(1, 5)
    // #767676 on white is the well-known 4.54:1.
    const grey = 0x76 / 255
    expect(contrastRatio([grey, grey, grey], [1, 1, 1])).toBeCloseTo(4.54, 2)
  })

  it('converts OKLCH as browsers do (white, black and the reference navy)', () => {
    const t = parseTokens(':root { --w: oklch(1 0 0); --k: oklch(0 0 0); --navy: oklch(0.32 0.085 258); --alias: var(--navy); --hex: #14325D; }')
    expect(resolveColor(t, 'w').map((v) => Math.round(v * 255))).toEqual([255, 255, 255])
    expect(resolveColor(t, 'k').map((v) => Math.round(v * 255))).toEqual([0, 0, 0])
    const navy = resolveColor(t, 'alias').map((v) => Math.round(v * 255))
    const hex = resolveColor(t, 'hex').map((v) => Math.round(v * 255))
    navy.forEach((v, i) => expect(Math.abs(v - hex[i])).toBeLessThanOrEqual(2))
  })

  it('reads only the first :root block and ignores comments', () => {
    const t = parseTokens('/* --x: #000; */ :root { --x: #fff; /* note */ --y: #000 } :root[data-x] { --x: #123 }')
    expect(resolveColor(t, 'x')).toEqual([1, 1, 1])
    expect(resolveColor(t, 'y')).toEqual([0, 0, 0])
  })
})
