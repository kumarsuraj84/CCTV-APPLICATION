import { isIP } from 'node:net'

// Hikvision ISAPI answers are small XML documents. They are read with a linear scan (no XML dependency, and no regular
// expression that can go quadratic on hostile input such as a megabyte of unclosed tags).
export type NvrChannel = { channel: number; name: string; ip: string | null }

const MAX_CHANNEL = 4096
const MAX_NAME = 80

// ASCII-only lower-casing keeps every index aligned with the original text (toLowerCase can change the length).
const ascii = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
const isNameChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_.:-]/.test(c)

/** Inner text of the closed `<tag>` elements, in order (at most `limit`). Linear in the size of the text. */
function elements(xml: string, tag: string, limit = Infinity): string[] {
  const lower = ascii(xml)
  const open = `<${ascii(tag)}`
  const close = `</${ascii(tag)}>`
  const out: string[] = []
  let pos = 0
  while (out.length < limit) {
    const at = lower.indexOf(open, pos)
    if (at < 0) break
    pos = at + open.length
    if (isNameChar(lower[pos])) continue // a longer tag name that merely starts the same, e.g. <InputProxyChannelStatusList>
    const gt = lower.indexOf('>', pos)
    if (gt < 0) break // no tag end anywhere after this point
    if (lower[gt - 1] === '/') {
      pos = gt + 1
      continue
    }
    const end = lower.indexOf(close, gt + 1)
    if (end < 0) break // no closing tag anywhere after this point
    out.push(xml.slice(gt + 1, end))
    pos = end + close.length
  }
  return out
}

const firstElement = (block: string, tag: string): string | null => elements(block, tag, 1)[0] ?? null

const ENTITY = /&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(lt|gt|quot|apos|amp));/gi
const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

function unescapeEntities(s: string): string {
  return s.replace(ENTITY, (whole, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named.toLowerCase()]
    const cp = hex !== undefined ? parseInt(hex, 16) : Number(dec)
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole
  })
}

/** Element text: CDATA sections unwrapped as they are, everything else with entities decoded once, then trimmed. */
function text(raw: string | null): string | null {
  if (raw === null) return null
  let out = ''
  let pos = 0
  for (;;) {
    const at = raw.indexOf('<![CDATA[', pos)
    const end = at < 0 ? -1 : raw.indexOf(']]>', at + 9)
    if (at < 0 || end < 0) {
      out += unescapeEntities(raw.slice(pos))
      break
    }
    out += unescapeEntities(raw.slice(pos, at)) + raw.slice(at + 9, end)
    pos = end + 3
  }
  return out.trim()
}

/** A whole number from 1 to 4096, or null. */
function channelNumber(raw: string | null): number | null {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= MAX_CHANNEL ? n : null
}

function channelName(raw: string | null, channel: number): string {
  // Only the start of a very long name matters; cut before spreading into characters.
  const name = [...(text(raw) ?? '').slice(0, MAX_NAME * 2)].slice(0, MAX_NAME).join('').trim()
  return name || `Camera ${channel}`
}

/** channel number -> online (first entry for a channel wins). Empty when the answer is not a status list. */
export function parseChannelStatus(xml: string): Map<number, boolean> {
  const out = new Map<number, boolean>()
  for (const block of elements(xml, 'InputProxyChannelStatus')) {
    const id = channelNumber(text(firstElement(block, 'id')))
    const online = text(firstElement(block, 'online'))
    if (id !== null && online !== null && !out.has(id)) out.set(id, online.toLowerCase() === 'true')
  }
  return out
}

function parseList(xml: string, tag: string, withIp: boolean): NvrChannel[] {
  const out: NvrChannel[] = []
  const seen = new Set<number>()
  for (const block of elements(xml, tag)) {
    const id = channelNumber(text(firstElement(block, 'id')))
    if (id === null || seen.has(id)) continue
    seen.add(id)
    const ip = withIp ? text(firstElement(block, 'ipAddress')) : null
    out.push({ channel: id, name: channelName(firstElement(block, 'name'), id), ip: ip !== null && isIP(ip) !== 0 ? ip : null })
  }
  return out
}

export const parseChannels = (xml: string): NvrChannel[] => parseList(xml, 'InputProxyChannel', true)

export const parseVideoInputChannels = (xml: string): NvrChannel[] => parseList(xml, 'VideoInputChannel', false)
