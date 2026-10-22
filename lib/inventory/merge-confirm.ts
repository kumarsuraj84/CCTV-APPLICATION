import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { processSingleton } from '@/lib/process-singleton'

// P2-5c-1 fix round 2 (A-N1): a merge is done only for the exact pair of cameras the person was shown. The preview hands out a
// confirmation, an HMAC (key of this server process, never sent anywhere) of the person, the organisation, the camera to keep, the
// duplicate and an end time; the merge action refuses any other pair, another person's confirmation, or one older than 10 minutes.
// After a server restart the person simply presses the merge button again.

export const MERGE_CONFIRM_TTL_MS = 10 * 60_000
export const MSG_MERGE_CONFIRM_AGAIN =
  'The cameras chosen now are not the ones you confirmed, or the question is more than 10 minutes old. Press the merge button again and check the cameras it names.'

const key = processSingleton('inventory.mergeConfirmKey', () => randomBytes(32))
type Pair = { actorId: string; orgId: string; keepId: string; duplicateId: string }
const mac = (p: Pair, until: number) =>
  createHmac('sha256', key).update(JSON.stringify(['drishti-merge-confirm-v1', p.actorId, p.orgId, p.keepId, p.duplicateId, until])).digest('base64url')

/** The confirmation for this person and this pair, valid for 10 minutes. */
export function mergeConfirmation(p: Pair, now: number = Date.now()): string {
  const until = now + MERGE_CONFIRM_TTL_MS
  return `${until}.${mac(p, until)}`
}

/** True only for a confirmation made for this person and exactly this pair, not yet ended. */
export function checkMergeConfirmation(token: unknown, p: Pair, now: number = Date.now()): boolean {
  if (typeof token !== 'string' || token.length > 200) return false
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token)
  if (!m) return false
  const until = Number(m[1])
  if (!(until > now) || until - now > MERGE_CONFIRM_TTL_MS) return false
  const want = Buffer.from(mac(p, until))
  const got = Buffer.from(m[2])
  return want.length === got.length && timingSafeEqual(want, got)
}
