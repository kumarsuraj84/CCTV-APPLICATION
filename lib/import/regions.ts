// Zone and state labels come from many hands ("JH" and "Jharkhand", "ASSAM" and "Assam"). One spelling per place keeps filters and grants working.
const ALIASES: Record<string, string> = {
  jh: 'Jharkhand',
  jharkhand: 'Jharkhand',
  assam: 'Assam',
}

export function normalizeRegion(value: string | null | undefined): string | null {
  const t = (value ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return null
  const hit = ALIASES[t.toLowerCase()]
  if (hit) return hit
  if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase()
  return t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}
