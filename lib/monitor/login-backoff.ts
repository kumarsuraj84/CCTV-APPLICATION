import { createHash } from 'node:crypto'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import { processSingleton } from '@/lib/process-singleton'

// The login back-off of the web server (ruling R9; P2-5c-1 review I-3). After an NVR refuses a login, every path of the web server that
// would log in to it again — the connection test, "Find cameras" for one NVR or a location, and "find cameras for all" (all of them
// through lib/monitor/discovery.ts or lib/inventory/recorder-admin.ts) — leaves that NVR alone until the window is over or its saved
// login changes, so a wrong password can never lock the NVR's account from the screens. One table per process (processSingleton), keyed
// by recorder id, holding a hash of the login (address, web port, user name, password), never the password. The worker keeps its own
// table (lib/monitor/checks.ts, another process); each side makes at most one attempt per window.

export const MSG_LOGIN_BACKOFF = 'The NVR refused this login a short while ago. To protect its account it is not asked again for a while; check the saved user name and password.'

type Entry = { until: number; login: string }
const table = processSingleton('nvr.webLoginBackoff', () => new Map<string, Entry>())

/** Identifies a saved login without keeping any of it readable. */
export const loginFingerprint = (host: string, port: number, username: string, password: string): string =>
  createHash('sha256').update(`${host}|${port}|${username}:${password}`).digest('hex')

/** True while this NVR must not be asked with this login. An ended window, or one for another login, is forgotten. */
export function inLoginBackoff(recorderId: string, login: string, now: number = Date.now()): boolean {
  const e = table.get(recorderId)
  if (!e) return false
  if (now >= e.until || e.login !== login) {
    table.delete(recorderId)
    return false
  }
  return true
}

/** A refused login (ISAPI "auth" or "forbidden") starts the window for this NVR and login. */
export function noteLoginResult(recorderId: string, login: string, error: unknown, now: number = Date.now(), seconds?: number): void {
  if (error instanceof NvrError && (error.kind === 'auth' || error.kind === 'forbidden')) {
    table.set(recorderId, { until: now + (seconds ?? loadMonitorConfig().nvrLoginBackoffSec) * 1000, login })
  }
}
