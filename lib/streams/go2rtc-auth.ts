import { getSecret } from '@/lib/secrets'

// go2rtc's API credentials (P2-6, D-13). go2rtc 1.9.9 protects its API with `api.username` / `api.password` (Basic auth; deploy/go2rtc.yaml
// reads GO2RTC_API_USERNAME and GO2RTC_API_PASSWORD from its environment). The web app (registration, pruning) and the gateway (the
// video sockets and the player scripts) send the same two. This is server → loopback only: an accepted exception to ruling R6 (no Basic
// auth towards NVRs), recorded in docs/drishti/adr-service-roles.md and the runbook. Verified on 1.9.9 (temporary container,
// 2026-10-22): without the credentials /api/streams answers 401; with both unset go2rtc runs without them (so nothing breaks before the
// keys are added on both sides).

export type Go2rtcAuth = { username: string; password: string }

/** Both from the environment, or null (a user name alone is no credential). The password is a secret purpose (go2rtc_api, 32+ characters). */
export function go2rtcApiAuth(env: Record<string, string | undefined> = process.env): Go2rtcAuth | null {
  const username = env.GO2RTC_API_USERNAME?.trim()
  const password = getSecret('go2rtc_api', env)
  if (!username || username.includes(':') || !password) return null
  return { username, password }
}

export const basicAuthHeader = (a: Go2rtcAuth): string => `Basic ${Buffer.from(`${a.username}:${a.password}`, 'utf8').toString('base64')}`

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * Review round 1 (I-2, M-12): does go2rtc itself ask for its login? One unauthenticated GET /api/streams must be refused (401). Used at
 * start-up in production by the gateway and the web app: it proves the container was recreated with the login (a go2rtc that answers
 * without it would hand its stream list — NVR sources with passwords — to anything on this computer). Never sends a credential.
 */
export async function probeGo2rtcLogin(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<{ ok: true } | { ok: false; error: string }> {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return { ok: false, error: 'The video server address (GO2RTC_URL) is not valid.' }
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname)) return { ok: false, error: 'The video server address (GO2RTC_URL) must be on this computer.' }
  let res: Response
  try {
    res = await fetchImpl(`${u.origin}/api/streams`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { ok: false, error: 'The video server (go2rtc) could not be reached to check that it asks for its login.' }
  }
  await res.body?.cancel().catch(() => {})
  if (res.status === 401) return { ok: true }
  return { ok: false, error: 'The video server (go2rtc) answers without its login: recreate it with GO2RTC_API_USERNAME and GO2RTC_API_PASSWORD (npm run stack:up).' }
}
