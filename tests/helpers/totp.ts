import { createHmac } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Test helpers for the multi-factor tests (P3-1). The authenticator app is played by `totpCode` (RFC 6238: HMAC-SHA1, 30 s, 6 digits).
// The secrets exist only in the test process's memory and are never printed.
//
// TOTP must be switched on in the auth server: `supabase/config.toml` [auth.mfa.totp] does so from P3-1 on, after the local stack is
// restarted. Until then MFA_TEST_AUTH_URL may name a loopback auth server with TOTP on that shares the local database (P3-1 used a
// temporary one); auth requests of the test clients are then sent there, everything else to the local stack as usual.

export function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch)
    if (v < 0) throw new Error('not base32')
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** The code an authenticator app shows for `secret` (base32) at `atMs`, `step` windows later. */
export function totpCode(secret: string, atMs = Date.now(), step = 0): string {
  const counter = Math.floor(atMs / 1000 / 30) + step
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const o = h[h.length - 1] & 0xf
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1_000_000).padStart(6, '0')
}

const AUTH_URL = (process.env.MFA_TEST_AUTH_URL ?? '').replace(/\/+$/, '')
if (AUTH_URL && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(AUTH_URL)) throw new Error('MFA_TEST_AUTH_URL must be a loopback address.')

/** fetch for supabase-js: auth calls go to MFA_TEST_AUTH_URL when it is set. */
export const authFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`
  if (AUTH_URL && url.startsWith(base)) return fetch(AUTH_URL + url.slice(base.length), init)
  return fetch(input, init)
}

/** A signed-in client of `email` whose auth calls can reach a TOTP-enabled auth server. */
export async function mfaClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const c = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: authFetch },
  })
  const { error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed: ${error.message}`)
  return c
}

/** Whether the auth server the tests reach lets people enrol an authenticator app (checked with a throw-away enrolment). */
export async function totpEnabled(c: SupabaseClient<Database>): Promise<boolean> {
  const r = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: `probe-${Date.now()}` })
  if (r.error) return false
  await c.auth.mfa.unenroll({ factorId: r.data.id })
  return true
}
