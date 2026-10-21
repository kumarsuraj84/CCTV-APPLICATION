import { isIP } from 'node:net'

export const isValidIp = (v: string) => isIP(v.trim()) !== 0

/** An empty value gives the fallback; a whole number from 1 to 65535 gives that number; anything else gives null. */
export function parsePort(value: string, fallback: number | null): number | null {
  const t = value.trim()
  if (t === '') return fallback
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 65535 ? n : null
}
