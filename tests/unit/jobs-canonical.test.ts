import { describe, expect, it } from 'vitest'
import { canonicalize, CanonicalJsonError, parseJsonStrict, sha256Hex } from '@/lib/jobs/canonical'

function errorCode(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof CanonicalJsonError ? e.code : `other:${String(e)}`
  }
}

describe('canonicalize: stable output', () => {
  it('sorts object keys so key order never changes the text', () => {
    expect(canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}')
    expect(canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } }))
  })

  it('sorts keys by UTF-16 code units (upper case before lower case, digits first)', () => {
    expect(canonicalize({ b: 1, B: 2, '1': 3, a: 4 })).toBe('{"1":3,"B":2,"a":4,"b":1}')
  })

  it('keeps array order, also in nested arrays', () => {
    expect(canonicalize([3, 1, [2, [1, 0]], { b: [2, 1], a: [] }])).toBe('[3,1,[2,[1,0]],{"a":[],"b":[2,1]}]')
  })

  it('writes the plain JSON scalars', () => {
    expect(canonicalize(null)).toBe('null')
    expect(canonicalize(true)).toBe('true')
    expect(canonicalize(false)).toBe('false')
    expect(canonicalize('x')).toBe('"x"')
    expect(canonicalize({})).toBe('{}')
    expect(canonicalize([])).toBe('[]')
  })

  it('normalises -0 to 0', () => {
    expect(canonicalize(-0)).toBe('0')
    expect(canonicalize({ a: -0 })).toBe('{"a":0}')
  })

  it('normalises numbers to their shortest form', () => {
    expect(canonicalize(1.5)).toBe('1.5')
    expect(canonicalize(100)).toBe('100')
    expect(canonicalize(0.000001)).toBe('0.000001')
    expect(canonicalize(1e-7)).toBe('1e-7')
    expect(canonicalize(parseJsonStrict('1.0'))).toBe('1')
    expect(canonicalize(parseJsonStrict('1E2'))).toBe('100')
  })

  it('normalises unicode to NFC in values and keys', () => {
    const decomposed = 'Café' // e + combining acute
    const composed = 'Café'
    expect(canonicalize(decomposed)).toBe(canonicalize(composed))
    expect(canonicalize({ [decomposed]: 1 })).toBe(canonicalize({ [composed]: 1 }))
  })

  it('escapes control characters and quotes the way JSON does', () => {
    expect(canonicalize('a"b\\c\n\u0001')).toBe('"a\\"b\\\\c\\n\\u0001"')
  })

  it('leaves out object properties whose value is undefined (same as an absent property)', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('accepts objects without a prototype', () => {
    const o = Object.create(null) as Record<string, unknown>
    o.b = 1
    o.a = 2
    expect(canonicalize(o)).toBe('{"a":2,"b":1}')
  })

  it('keeps a "__proto__" key as an ordinary key', () => {
    const parsed = parseJsonStrict('{"__proto__":{"x":1},"a":1}')
    expect(canonicalize(parsed)).toBe('{"__proto__":{"x":1},"a":1}')
  })
})

describe('canonicalize: refused input', () => {
  it('refuses NaN and the infinities', () => {
    expect(errorCode(() => canonicalize(NaN))).toBe('non_finite_number')
    expect(errorCode(() => canonicalize({ a: Infinity }))).toBe('non_finite_number')
    expect(errorCode(() => canonicalize([-Infinity]))).toBe('non_finite_number')
  })

  it('refuses integers beyond the safe range: big numbers must be sent as strings', () => {
    expect(errorCode(() => canonicalize(2 ** 53))).toBe('unsafe_integer')
    expect(errorCode(() => canonicalize(-(2 ** 53)))).toBe('unsafe_integer')
    // Every double at or above 2^53 is an integer, so 1e21 is refused too.
    expect(errorCode(() => canonicalize(1e21))).toBe('unsafe_integer')
    expect(errorCode(() => parseJsonStrict('1e21'))).toBe('unsafe_integer')
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    expect(canonicalize({ serial: '123456789012345678901234567890' })).toBe('{"serial":"123456789012345678901234567890"}')
  })

  it('refuses bigint, functions, symbols and undefined at the top level or in arrays', () => {
    expect(errorCode(() => canonicalize(BigInt(5)))).toBe('unsupported_type')
    expect(errorCode(() => canonicalize(() => 1))).toBe('unsupported_type')
    expect(errorCode(() => canonicalize(Symbol('x')))).toBe('unsupported_type')
    expect(errorCode(() => canonicalize(undefined))).toBe('unsupported_type')
    expect(errorCode(() => canonicalize([1, undefined]))).toBe('unsupported_type')
  })

  it('refuses sparse arrays', () => {
    expect(errorCode(() => canonicalize([1, , 3]))).toBe('sparse_array')
  })

  it('refuses dates, maps, sets and class instances instead of guessing a form', () => {
    expect(errorCode(() => canonicalize(new Date(0)))).toBe('unsupported_type')
    expect(errorCode(() => canonicalize(new Map()))).toBe('unsupported_type')
    expect(errorCode(() => canonicalize(new Set()))).toBe('unsupported_type')
    class Thing { a = 1 }
    expect(errorCode(() => canonicalize(new Thing()))).toBe('unsupported_type')
  })

  it('refuses cycles', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(errorCode(() => canonicalize(a))).toBe('cycle')
  })

  it('accepts the same object twice when it is not a cycle', () => {
    const shared = { x: 1 }
    expect(canonicalize({ a: shared, b: [shared] })).toBe('{"a":{"x":1},"b":[{"x":1}]}')
  })

  it('refuses two keys that become equal after unicode normalisation', () => {
    expect(errorCode(() => canonicalize({ 'Café': 1, 'Café': 2 }))).toBe('duplicate_key')
  })

  it('refuses strings with a lone surrogate', () => {
    expect(errorCode(() => canonicalize('\ud800'))).toBe('invalid_unicode')
    expect(errorCode(() => canonicalize({ ['\udc00']: 1 }))).toBe('invalid_unicode')
  })

  it('refuses nesting deeper than the limit', () => {
    let v: unknown = 1
    for (let i = 0; i < 70; i++) v = [v]
    expect(errorCode(() => canonicalize(v))).toBe('too_deep')
  })
})

describe('parseJsonStrict', () => {
  it('parses ordinary JSON', () => {
    expect(parseJsonStrict(' {"a":[1,2,{"b":null}],"c":"x","d":true,"e":-1.5e3} ')).toEqual({ a: [1, 2, { b: null }], c: 'x', d: true, e: -1500 })
  })

  it('refuses duplicate keys (JSON.parse would silently keep the last)', () => {
    expect(errorCode(() => parseJsonStrict('{"a":1,"a":2}'))).toBe('duplicate_key')
    expect(errorCode(() => parseJsonStrict('{"x":{"a":1,"b":2,"a":3}}'))).toBe('duplicate_key')
  })

  it('refuses keys that are duplicates after unicode normalisation or escapes', () => {
    expect(errorCode(() => parseJsonStrict('{"a":1,"\\u0061":2}'))).toBe('duplicate_key')
    expect(errorCode(() => parseJsonStrict('{"Café":1,"Café":2}'))).toBe('duplicate_key')
  })

  it('refuses integers that cannot be represented exactly', () => {
    expect(errorCode(() => parseJsonStrict('12345678901234567890'))).toBe('unsafe_integer')
    expect(errorCode(() => parseJsonStrict('{"n":9007199254740993}'))).toBe('unsafe_integer')
    expect(parseJsonStrict('9007199254740991')).toBe(9007199254740991)
  })

  it('refuses lone surrogate escapes and accepts surrogate pairs', () => {
    expect(errorCode(() => parseJsonStrict('"\\ud800"'))).toBe('invalid_unicode')
    expect(errorCode(() => parseJsonStrict('"\\udc00x"'))).toBe('invalid_unicode')
    expect(parseJsonStrict('"\\ud83d\\ude00"')).toBe('\u{1f600}')
  })

  it('refuses malformed JSON', () => {
    for (const bad of ['', '{', '[1,]', '{"a":1,}', "{'a':1}", 'NaN', 'Infinity', '01', '1.', '.5', '"\t"', 'tru', '[1] 2', '{"a" 1}', '"\\x"', '-']) {
      expect(errorCode(() => parseJsonStrict(bad)), bad).toBe('invalid_json')
    }
  })

  it('treats -0 in the text as 0 after canonicalisation', () => {
    expect(canonicalize(parseJsonStrict('-0'))).toBe('0')
    expect(canonicalize(parseJsonStrict('-0.0'))).toBe('0')
  })

  it('round-trips: canonical text parses back to the same canonical text', () => {
    const v = { z: [1, 2.5, 'é', { y: null }], a: { c: true, b: false } }
    const once = canonicalize(v)
    expect(canonicalize(parseJsonStrict(once))).toBe(once)
  })
})

describe('sha256Hex', () => {
  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes the UTF-8 bytes of the text', () => {
    expect(sha256Hex('é')).not.toBe(sha256Hex('é'))
    expect(sha256Hex('é')).toHaveLength(64)
  })
})
