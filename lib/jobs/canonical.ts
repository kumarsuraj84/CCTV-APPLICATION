// Canonical JSON for payload hashing (P7-0).
//
// One value always gives one text, so the SHA-256 of that text identifies an execution payload:
// - object keys are sorted by UTF-16 code units (as in RFC 8785), after NFC normalisation;
// - strings (keys and values) are NFC-normalised; lone surrogates are refused;
// - numbers must be finite; -0 becomes 0; integers at or beyond 2^53 are refused (send them as strings);
//   other numbers use the shortest round-trip form of ECMAScript (Number#toString);
// - an object property whose value is undefined is left out (the same as an absent property);
//   undefined anywhere else, bigint, functions, symbols, dates, maps, sets, class instances, sparse arrays
//   and cycles are refused, so nothing is silently guessed.
// `parseJsonStrict` reads JSON text with the same rules and also refuses duplicate keys, which JSON.parse
// silently resolves by keeping the last one.
import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type CanonicalJsonErrorCode =
  | 'non_finite_number'
  | 'unsafe_integer'
  | 'unsupported_type'
  | 'sparse_array'
  | 'cycle'
  | 'duplicate_key'
  | 'invalid_unicode'
  | 'too_deep'
  | 'invalid_json'

export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode
  constructor(code: CanonicalJsonErrorCode, message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
    this.code = code
  }
}

/** Deepest nesting accepted; a payload deeper than this is a mistake or an attack. */
export const MAX_DEPTH = 64

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

function normaliseString(s: string, where: string): string {
  if (LONE_SURROGATE.test(s)) throw new CanonicalJsonError('invalid_unicode', `${where}: a string holds a lone surrogate`)
  return s.normalize('NFC')
}

function checkNumber(n: number, where: string): number {
  if (!Number.isFinite(n)) throw new CanonicalJsonError('non_finite_number', `${where}: NaN and infinities are not allowed`)
  if (Math.abs(n) >= 2 ** 53) throw new CanonicalJsonError('unsafe_integer', `${where}: integers at or beyond 2^53 must be sent as strings`)
  return Object.is(n, -0) ? 0 : n
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function write(value: unknown, path: string, depth: number, stack: Set<object>): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError('too_deep', `${path}: nested deeper than ${MAX_DEPTH}`)
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return String(checkNumber(value, path))
    case 'string':
      return JSON.stringify(normaliseString(value, path))
    case 'object':
      break
    default:
      throw new CanonicalJsonError('unsupported_type', `${path}: ${typeof value} values are not JSON`)
  }
  const obj = value as object
  if (stack.has(obj)) throw new CanonicalJsonError('cycle', `${path}: the value refers to itself`)
  stack.add(obj)
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = []
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new CanonicalJsonError('sparse_array', `${path}[${i}]: arrays must not have holes`)
        const item: unknown = obj[i]
        if (item === undefined) throw new CanonicalJsonError('unsupported_type', `${path}[${i}]: undefined is not JSON`)
        parts.push(write(item, `${path}[${i}]`, depth + 1, stack))
      }
      return `[${parts.join(',')}]`
    }
    if (!isPlainObject(obj)) throw new CanonicalJsonError('unsupported_type', `${path}: only plain objects are allowed (got ${obj.constructor?.name ?? 'object'})`)
    const entries: [string, unknown][] = []
    const seen = new Set<string>()
    for (const rawKey of Object.keys(obj)) {
      const v: unknown = (obj as Record<string, unknown>)[rawKey]
      if (v === undefined) continue
      const key = normaliseString(rawKey, `${path} key`)
      if (seen.has(key)) throw new CanonicalJsonError('duplicate_key', `${path}: the key "${key}" appears twice after normalisation`)
      seen.add(key)
      entries.push([key, v])
    }
    entries.sort((a, b) => compareKeys(a[0], b[0]))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, `${path}.${k}`, depth + 1, stack)}`).join(',')}}`
  } finally {
    stack.delete(obj)
  }
}

/** The canonical JSON text of a value. Throws CanonicalJsonError for anything that is not plain JSON. */
export function canonicalize(value: unknown): string {
  return write(value, '$', 0, new Set())
}

/** True when the value is plain JSON that canonicalize accepts. */
export function isCanonicalizable(value: unknown): boolean {
  try {
    canonicalize(value)
    return true
  } catch {
    return false
  }
}

/** Hex SHA-256 of the UTF-8 bytes of a text. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------------------------------
// Strict JSON reader.

class Reader {
  private i = 0
  constructor(private readonly s: string) {}

  fail(msg: string): never {
    throw new CanonicalJsonError('invalid_json', `invalid JSON at ${this.i}: ${msg}`)
  }

  ws(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i])) this.i++
  }

  end(): void {
    this.ws()
    if (this.i !== this.s.length) this.fail('unexpected text after the value')
  }

  value(depth: number): JsonValue {
    if (depth > MAX_DEPTH) throw new CanonicalJsonError('too_deep', `nested deeper than ${MAX_DEPTH}`)
    this.ws()
    const c = this.s[this.i]
    if (c === '{') return this.object(depth)
    if (c === '[') return this.array(depth)
    if (c === '"') return this.string()
    if (c === '-' || (c >= '0' && c <= '9')) return this.number()
    if (this.s.startsWith('true', this.i)) { this.i += 4; return true }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return false }
    if (this.s.startsWith('null', this.i)) { this.i += 4; return null }
    return this.fail('expected a value')
  }

  object(depth: number): JsonObject {
    this.i++ // {
    const entries: [string, JsonValue][] = []
    const seen = new Set<string>()
    this.ws()
    if (this.s[this.i] === '}') { this.i++; return {} }
    for (;;) {
      this.ws()
      if (this.s[this.i] !== '"') this.fail('expected a key')
      const key = this.string()
      if (seen.has(key)) throw new CanonicalJsonError('duplicate_key', `the key "${key}" appears twice`)
      seen.add(key)
      this.ws()
      if (this.s[this.i] !== ':') this.fail('expected ":"')
      this.i++
      entries.push([key, this.value(depth + 1)])
      this.ws()
      if (this.s[this.i] === ',') { this.i++; continue }
      if (this.s[this.i] === '}') { this.i++; break }
      this.fail('expected "," or "}"')
    }
    // Object.fromEntries defines own properties, so a "__proto__" key stays an ordinary key.
    return Object.fromEntries(entries)
  }

  array(depth: number): JsonValue[] {
    this.i++ // [
    const out: JsonValue[] = []
    this.ws()
    if (this.s[this.i] === ']') { this.i++; return out }
    for (;;) {
      out.push(this.value(depth + 1))
      this.ws()
      if (this.s[this.i] === ',') { this.i++; continue }
      if (this.s[this.i] === ']') { this.i++; break }
      this.fail('expected "," or "]"')
    }
    return out
  }

  string(): string {
    this.i++ // "
    let out = ''
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated string')
      const c = this.s[this.i]
      if (c === '"') { this.i++; break }
      if (c < ' ') this.fail('control character in a string')
      if (c !== '\\') { out += c; this.i++; continue }
      const e = this.s[this.i + 1]
      this.i += 2
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (e !== undefined && e in simple) { out += simple[e]; continue }
      if (e === 'u') {
        const hex = this.s.slice(this.i, this.i + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape')
        out += String.fromCharCode(parseInt(hex, 16))
        this.i += 4
        continue
      }
      this.fail('bad escape')
    }
    return normaliseString(out, 'string')
  }

  number(): number {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i))
    if (!m) return this.fail('bad number')
    this.i += m[0].length
    const n = Number(m[0])
    if (!m[2] && !m[3] && !Number.isSafeInteger(n) && !Object.is(n, -0)) {
      throw new CanonicalJsonError('unsafe_integer', `the integer ${m[0]} cannot be represented exactly; send it as a string`)
    }
    return checkNumber(n, 'number')
  }
}

/** Parses JSON text, refusing duplicate keys, lone surrogates, unsafe integers and anything JSON.parse would accept loosely. */
export function parseJsonStrict(text: string): JsonValue {
  const r = new Reader(text)
  const v = r.value(0)
  r.end()
  return v
}
