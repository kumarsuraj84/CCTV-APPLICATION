import { timingSafeEqual } from 'node:crypto'

// Constant-time comparison for secrets. A plain === stops at the first different byte and can leak it through timing.
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
