import { createHmac, timingSafeEqual } from 'node:crypto'
import { isProductionMode } from '@/lib/runtime-mode'
import { getSecret } from '@/lib/secrets'

// The idle-timeout record (P3-1 brief item 7): one small cookie, signed and bound to the sign-in session, that says when this session
// last made a request and which idle limit applies to it. proxy.ts reads and renews it. Signed so it cannot be moved forward by hand;
// bound to the session id so a copy is worthless for another sign-in. A missing record never extends a session (lib/auth/session-policy.ts).
//
// The key is derived from the verified-user secret (VERIFIED_USER_SECRET, P2-6) with its own label, so no new secret is needed; in
// development without it the service key stands in, exactly as for the verified-user header.

export const ACTIVITY_COOKIE = 'drishti-activity'
export type Activity = { sid: string; seen: number; idle: number }

const SID = /^[A-Za-z0-9-]{1,64}$/

export function activityKey(env: Record<string, string | undefined> = process.env): string | null {
  // The one production switch of P2-6 review round 1 (lib/runtime-mode.ts): no fallback key in production.
  return getSecret('verified_user', env) ?? (isProductionMode(env) ? null : env.SUPABASE_SERVICE_ROLE_KEY || null)
}

const mac = (key: string, body: string) => createHmac('sha256', key).update(`session-activity:${body}`).digest('base64url')

export function encodeActivity(a: Activity, key: string): string {
  const body = `v1.${a.sid}.${Math.floor(a.seen)}.${Math.floor(a.idle)}`
  return `${body}.${mac(key, body)}`
}

export function decodeActivity(value: string | undefined, key: string): Activity | null {
  const parts = (value ?? '').split('.')
  if (parts.length !== 5 || parts[0] !== 'v1' || !SID.test(parts[1]) || !/^\d{1,12}$/.test(parts[2]) || !/^\d{1,5}$/.test(parts[3])) return null
  const body = parts.slice(0, 4).join('.')
  const want = Buffer.from(mac(key, body))
  const got = Buffer.from(parts[4])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return { sid: parts[1], seen: Number(parts[2]), idle: Number(parts[3]) }
}
