// P4-L2 review round 1 (I-1, optional item, done because it is small): the fast playback body is FRAMED so that bytes saved from the
// answer (for example with curl) are not a playable MP4 file. This is OBFUSCATION, not encryption: the key is the 32-byte signature of
// the person's own fast token, which the page holds anyway, and the method is in this file. It raises the bar from "save the answer" to
// "write code"; the real bounds are the pace, the byte cap and the budget (lib/streams/pace.ts, lib/streams/fast.ts).
// No Web Crypto (a plain-http address of the server has none), no Node API: used by the server and the page alike.

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64urlBytes(text: string): Uint8Array {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of text) {
    const v = B64URL.indexOf(ch)
    if (v < 0) throw new Error('not base64url')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

/** The framing key of a fast token: its 32-byte signature. Throws for anything that is not `<payload>.<32-byte signature>`. */
export function framingKey(token: string): Uint8Array {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 2 || parts[1].length === 0) throw new Error('no key in this token')
  const key = base64urlBytes(parts[1])
  if (key.length !== 32) throw new Error('no key in this token')
  return key
}

/** `bytes` XOR the key stream at stream position `offset` (the same call frames and unframes). Returns a new array. */
export function xorFrame(bytes: Uint8Array, key: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const p = offset + i
    out[i] = bytes[i] ^ key[p & 31] ^ ((p >>> 5) & 0xff)
  }
  return out
}
