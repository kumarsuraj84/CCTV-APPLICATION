// The logic of scripts/gen-secrets.mjs (P2-6), kept apart so it can be tested without touching a real .env file. Nothing here prints.
import { randomBytes } from 'node:crypto'
import { SERVICE_KEY_ENV, SERVICE_ROLES, signServiceJwt } from './service-jwt.mjs'

/** Random secrets, one per purpose of lib/secrets.ts (43 characters of base64url = 256 bits). */
export const RANDOM_SECRETS = [
  'CRON_SECRET', 'WORKER_SECRET', 'STREAM_TOKEN_SECRET', 'SYSTEM_LOG_INGEST_SECRET', 'ACCESS_PREVIEW_SECRET',
  'MERGE_CONFIRM_SECRET', 'VERIFIED_USER_SECRET', 'GO2RTC_API_PASSWORD', 'SIGNER_SECRET', 'AGENT_INGEST_SECRET', 'AUDIT_CHECKPOINT_SECRET',
]
/** Plain settings that are not secret but go with them. */
export const PLAIN_DEFAULTS = { GO2RTC_API_USERNAME: 'drishti' }
/** The per-service database keys (JWTs signed with the project's JWT secret). */
export const SERVICE_KEYS = SERVICE_ROLES.map((r) => SERVICE_KEY_ENV[r])
export const ALL_KEYS = [...RANDOM_SECRETS, ...Object.keys(PLAIN_DEFAULTS), ...SERVICE_KEYS]

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/** The keys an env file already sets to a non-empty value. */
export function presentKeys(text) {
  const out = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (m && m[2].trim().replace(/^["']|["']$/g, '') !== '') out.add(m[1])
  }
  return out
}

/**
 * What to write: for each managed key, "add" (missing), "keep" (present, not rotated) or "rotate" (present and asked to rotate).
 * `rotate`: true (every generated key, never the plain settings) or a set of names.
 */
export function plan(text, o = {}) {
  const present = presentKeys(text)
  const wanted = new Set(o.only ?? ALL_KEYS)
  const rotating = (k) => (o.rotate === true ? !(k in PLAIN_DEFAULTS) : o.rotate instanceof Set && o.rotate.has(k))
  return ALL_KEYS.filter((k) => wanted.has(k)).map((k) => ({ key: k, action: !present.has(k) ? 'add' : rotating(k) ? 'rotate' : 'keep' }))
}

/** A new value for one key. `jwtSecret` is needed for the service keys only. */
export function valueFor(key, o = {}) {
  if (RANDOM_SECRETS.includes(key)) return randomBytes(32).toString('base64url')
  if (key in PLAIN_DEFAULTS) return PLAIN_DEFAULTS[key]
  const role = SERVICE_ROLES.find((r) => SERVICE_KEY_ENV[r] === key)
  if (!role) throw new Error(`Unknown key ${key}.`)
  if (typeof o.jwtSecret !== 'string' || o.jwtSecret.length < 32) throw new Error('The project JWT secret is needed for the service keys.')
  return signServiceJwt(o.jwtSecret, role, { lifetimeSec: o.lifetimeSec })
}

/**
 * The new file text: lines of rotated keys are replaced in place, added keys are appended under one comment line, everything else
 * (other keys, comments, blank lines, line order) stays exactly as it was.
 */
export function render(text, steps, values) {
  const lines = String(text ?? '').split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const rotate = new Map(steps.filter((s) => s.action === 'rotate').map((s) => [s.key, values[s.key]]))
  const out = lines.map((raw) => {
    const m = LINE.exec(raw)
    return m && rotate.has(m[1]) ? `${m[1]}=${rotate.get(m[1])}` : raw
  })
  const added = steps.filter((s) => s.action === 'add')
  if (added.length > 0) {
    out.push('# Added by scripts/gen-secrets.mjs (P2-6). Keep this file private; rotation: docs/drishti/runbooks/secret-rotation.md')
    for (const s of added) out.push(`${s.key}=${values[s.key]}`)
  }
  return out.join('\n') + '\n'
}
