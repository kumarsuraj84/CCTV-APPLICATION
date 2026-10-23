// P5.5 load tests: small numeric helpers (percentiles by nearest rank, rounding) and the machine description written into the results.
import os from 'node:os'

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[rank]
}

export const round = (n: number | null, digits = 1): number | null => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits)

export function summary(values: readonly number[], digits = 1) {
  return {
    n: values.length,
    p50: round(percentile(values, 50), digits),
    p95: round(percentile(values, 95), digits),
    p99: round(percentile(values, 99), digits),
    max: round(values.length ? Math.max(...values) : null, digits),
  }
}

export function machine() {
  const cpus = os.cpus()
  return {
    cpu: cpus[0]?.model.trim() ?? 'unknown', logicalCpus: cpus.length, ramGb: Math.round(os.totalmem() / 1073741824), freeRamGbAtStart: Math.round(os.freemem() / 1073741824),
    os: `${os.type()} ${os.release()}`, node: process.version,
  }
}

/** A mode from LOAD_MODE: "ci" (default, short) or "full" (the brief's 10-minute hold). */
export const loadMode = (): 'ci' | 'full' => (process.env.LOAD_MODE === 'full' ? 'full' : 'ci')
export const intEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}
