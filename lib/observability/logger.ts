import { maskSecrets } from '@/lib/observability/mask'

type Level = 'info' | 'warn' | 'error'

// P2-6: also any field whose name ends in "key" (serviceKey, SUPABASE_APP_WEB_KEY, registryKey).
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|service[-_]?role|key$/i

/**
 * Copy of a value that is safe to log: secret-looking keys hidden, errors reduced to name and message, and (P2-6) every piece of text
 * masked (lib/observability/mask.ts: URL logins, Authorization values, JWTs, sb_ keys), whatever field it is in.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: maskSecrets(value.message) }
  if (typeof value === 'string') return maskSecrets(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  )
}

function emit(level: Level, fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...(redact(fields) as Record<string, unknown>) })
  if (level === 'error') console.error(line)
  else console.log(line)
}

export const logger = {
  info: (f: Record<string, unknown>) => emit('info', f),
  warn: (f: Record<string, unknown>) => emit('warn', f),
  error: (f: Record<string, unknown>) => emit('error', f),
}
