// Redaction for event details and verification diffs (P7-0). Events never contain secrets: secret-looking
// keys and values are replaced, and lease tokens are stored only as a short fingerprint.
import { sha256Hex, type JsonObject, type JsonValue } from './canonical'

export const REDACTED = '[redacted]'

const SECRET_KEY = /(password|passphrase|passwd|secret|token|psk|credential|private_?key|api_?key)/i
/** References and fingerprints name a secret without containing it. */
const SAFE_SUFFIX = /(_ref|_fingerprint|_id)$/i
const SECRET_VALUE = [/^\s*bearer\s+\S/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !SAFE_SUFFIX.test(key)
}

function redactValue(v: JsonValue): JsonValue {
  if (typeof v === 'string') return SECRET_VALUE.some((re) => re.test(v)) ? REDACTED : v
  if (Array.isArray(v)) return v.map(redactValue)
  if (v !== null && typeof v === 'object') {
    const out: JsonObject = {}
    for (const [k, inner] of Object.entries(v)) out[k] = isSecretKey(k) ? REDACTED : redactValue(inner)
    return out
  }
  return v
}

/** A redacted deep copy. */
export function redactDetails(details: JsonObject): JsonObject {
  return redactValue(details) as JsonObject
}

/** Short fingerprint of a token for logs and events; the token itself is never written. */
export function tokenFingerprint(token: string): string {
  return sha256Hex(`lease-fingerprint\n${token}`).slice(0, 12)
}
