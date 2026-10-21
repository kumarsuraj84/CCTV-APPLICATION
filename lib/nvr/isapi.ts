// Hikvision ISAPI answers are small XML documents; reading them with patterns keeps this free of an XML dependency.
export type NvrChannel = { channel: number; name: string; ip: string | null }

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const first = (block: string, tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)?.[1]?.trim() ?? null

/** channel number -> online. Empty when the answer is not a status list. */
export function parseChannelStatus(xml: string): Map<number, boolean> {
  const out = new Map<number, boolean>()
  for (const m of xml.matchAll(/<InputProxyChannelStatus\b[^>]*>([\s\S]*?)<\/InputProxyChannelStatus>/gi)) {
    const id = first(m[1], 'id')
    const online = first(m[1], 'online')
    if (id !== null && /^\d+$/.test(id) && online !== null) out.set(Number(id), online.toLowerCase() === 'true')
  }
  return out
}

export function parseChannels(xml: string): NvrChannel[] {
  const out: NvrChannel[] = []
  for (const m of xml.matchAll(/<InputProxyChannel\b[^>]*>([\s\S]*?)<\/InputProxyChannel>/gi)) {
    const id = first(m[1], 'id')
    if (id === null || !/^\d+$/.test(id)) continue
    out.push({ channel: Number(id), name: unescapeXml(first(m[1], 'name') ?? `Camera ${id}`), ip: first(m[1], 'ipAddress') })
  }
  return out
}

export function parseVideoInputChannels(xml: string): NvrChannel[] {
  const out: NvrChannel[] = []
  for (const m of xml.matchAll(/<VideoInputChannel\b[^>]*>([\s\S]*?)<\/VideoInputChannel>/gi)) {
    const id = first(m[1], 'id')
    if (id === null || !/^\d+$/.test(id)) continue
    out.push({ channel: Number(id), name: unescapeXml(first(m[1], 'name') ?? `Camera ${id}`), ip: null })
  }
  return out
}
