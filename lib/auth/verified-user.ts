// proxy.ts verifies the session once per request and forwards who the user is. That forwarded value must never be forgeable:
//   - the proxy deletes any client-supplied copy of these headers, and
//   - the value it sets is signed with a server-only key, so a copy that did not come from the proxy fails verification.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const VERIFIED_USER_HEADER = 'x-verified-user-id'
export const VERIFIED_USER_SIG_HEADER = 'x-verified-user-sig'

// The signing key is the server's own service key (never the cron secret). Without it nothing is signed.
const key = (): string | null => process.env.SUPABASE_SERVICE_ROLE_KEY || null
const mac = (k: string, userId: string) => createHmac('sha256', k).update(`verified-user:${userId}`).digest('hex')

/** Signature for a verified user id ('' = verified as signed out). Null when no server key is configured. */
export function signVerifiedUser(userId: string): string | null {
  const k = key()
  return k ? mac(k, userId) : null
}

/**
 * What the proxy vouched for on this request:
 *   string    - the verified user id
 *   null      - verified as signed out
 *   undefined - nothing trustworthy: the caller must check the session itself
 */
export function readVerifiedUserId(h: { get(name: string): string | null }): string | null | undefined {
  const id = h.get(VERIFIED_USER_HEADER)
  const sig = h.get(VERIFIED_USER_SIG_HEADER)
  const k = key()
  if (id === null || sig === null || !k) return undefined
  const expected = Buffer.from(mac(k, id))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  return id === '' ? null : id
}
