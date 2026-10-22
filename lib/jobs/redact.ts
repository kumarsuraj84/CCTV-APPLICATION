// Redaction for event details and verification diffs, and lease-token hashing (P7-0). Events never contain
// secrets: secret-looking keys and values are replaced, free text is scrubbed, messages are capped, and lease
// tokens are stored only as SHA-256 hashes (events carry a short fingerprint of the hash).
// This is a second line of defence: adapters must redact at source (lib/jobs/adapter.ts).
import { timingSafeEqual } from 'node:crypto'
import { sha256Hex, type JsonObject, type JsonValue } from './canonical'

export const REDACTED = '[redacted]'
/** Longest free-text message kept from a device or adapter. */
export const MAX_MESSAGE_LENGTH = 512

const SECRET_KEY = /(password|passphrase|passwd|secret|token|psk|pre_shared|wpa_key|community|credential|private_?key|api_?key|ssid.*key)/i
/** References and fingerprints name a secret without containing it. */
const SAFE_SUFFIX = /(_ref|_fingerprint|_id|_hash)$/i
const SECRET_VALUE = [/^\s*bearer\s+\S/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
const SECRET_IN_TEXT = /\b(password|passphrase|passwd|pwd|psk|secret|token|community|api_?key|wpa_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !SAFE_SUFFIX.test(key)
}

/** Scrubs "password=..." style fragments out of free text and caps its length. */
export function redactText(text: string, max = MAX_MESSAGE_LENGTH): string {
  if (SECRET_VALUE.some((re) => re.test(text))) return REDACTED
  const scrubbed = text.replace(SECRET_IN_TEXT, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed
}

function redactValue(v: JsonValue): JsonValue {
  if (typeof v === 'string') return redactText(v, 4096)
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

/** What the store keeps of a lease token. */
export function tokenHash(token: string): string {
  return sha256Hex(`drishti.lease-token\n${token}`)
}

/** Constant-time check of a presented token against a stored hash. */
export function tokenMatches(token: string, hash: string | null | undefined): boolean {
  if (!hash) return false
  const a = Buffer.from(tokenHash(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Short fingerprint for events and logs, computed from the stored hash. */
export function hashFingerprint(hash: string): string {
  return sha256Hex(`lease-fingerprint\n${hash}`).slice(0, 12)
}

/** Fingerprint of a raw token (same value as hashFingerprint(tokenHash(token))). */
export function tokenFingerprint(token: string): string {
  return hashFingerprint(tokenHash(token))
}
