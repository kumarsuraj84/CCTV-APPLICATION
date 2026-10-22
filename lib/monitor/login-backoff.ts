import { createHash } from 'node:crypto'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import { processSingleton } from '@/lib/process-singleton'

// The login back-off of the web server (ruling R9; P2-5c-1 review I-3). After an NVR refuses a login, every path of the web server that
// would log in to it again — the connection test, "Find cameras" for one NVR or a location, and "find cameras for all" (all of them
// through lib/monitor/discovery.ts or lib/inventory/recorder-admin.ts) — leaves that NVR alone until the window is over or its saved
// login changes. One table per process (processSingleton), keyed by recorder id, holding a hash of the login (address, web port, user
// name, password), never the password. The worker keeps its own table (lib/monitor/checks.ts, another process).
//
// Fix round 2 (A-N3): a new login ends that wait, so saving one wrong password after another would still ask the NVR each time and could
// lock its account (Hikvision locks after 5–7 failures). So the web server also counts refused logins per NVR, whatever the login: after
// LOGIN_REFUSALS_ALLOWED within LOGIN_REFUSAL_WINDOW_SEC it does not ask that NVR again, with any password, until the oldest of them
// leaves the window.

export const MSG_LOGIN_BACKOFF = 'The NVR refused this login a short while ago. To protect its account it is not asked again for a while; check the saved user name and password.'
export const LOGIN_REFUSALS_ALLOWED = 3
export const LOGIN_REFUSAL_WINDOW_SEC = 1800
export const MSG_LOGIN_PAUSED =
  'This NVR refused 3 logins in the last 30 minutes. To keep its account from being locked it is not asked again for a while, even with a new password. Check the user name and password on the NVR itself, then try again later.'

type Entry = { until: number; login: string }
const table = processSingleton('nvr.webLoginBackoff', () => new Map<string, Entry>())
/** Times of refused logins per NVR (any login), newest last; only those inside the window are kept. */
const refusals = processSingleton('nvr.webLoginRefusals', () => new Map<string, number[]>())

/** Identifies a saved login without keeping any of it readable. */
export const loginFingerprint = (host: string, port: number, username: string, password: string): string =>
  createHash('sha256').update(`${host}|${port}|${username}:${password}`).digest('hex')

function recentRefusals(recorderId: string, now: number): number[] {
  const kept = (refusals.get(recorderId) ?? []).filter((t) => now - t < LOGIN_REFUSAL_WINDOW_SEC * 1000)
  if (kept.length) refusals.set(recorderId, kept)
  else refusals.delete(recorderId)
  return kept
}

/** Why this NVR must not be asked with this login now (a plain sentence), or null. An ended window, or one for another login, is forgotten. */
export function loginBlock(recorderId: string, login: string, now: number = Date.now()): string | null {
  if (recentRefusals(recorderId, now).length >= LOGIN_REFUSALS_ALLOWED) return MSG_LOGIN_PAUSED
  const e = table.get(recorderId)
  if (!e) return null
  if (now >= e.until || e.login !== login) {
    table.delete(recorderId)
    return null
  }
  return MSG_LOGIN_BACKOFF
}

/** True while this NVR must not be asked with this login (see loginBlock). */
export function inLoginBackoff(recorderId: string, login: string, now: number = Date.now()): boolean {
  return loginBlock(recorderId, login, now) !== null
}

/** A refused login (ISAPI "auth" or "forbidden") starts the window for this NVR and login, and counts towards the NVR's limit. */
export function noteLoginResult(recorderId: string, login: string, error: unknown, now: number = Date.now(), seconds?: number): void {
  if (error instanceof NvrError && (error.kind === 'auth' || error.kind === 'forbidden')) {
    table.set(recorderId, { until: now + (seconds ?? loadMonitorConfig().nvrLoginBackoffSec) * 1000, login })
    refusals.set(recorderId, [...recentRefusals(recorderId, now), now])
  }
}
