import { isProductionMode } from '@/lib/runtime-mode'
import { startupProblems } from '@/lib/startup-checks'
import { authUrlProblem } from '@/lib/web/tls'

// The web app's start-up check (P2-6 review round 1: M-16, M-3, I-2), run once by instrumentation.ts when the Node.js server starts.
// Production mode only: the static checks of lib/startup-checks.ts, then go2rtc must refuse a request without its login, then every
// active organisation must have locked the service key out of NVR logins (the web process holds the service key for GoTrue's admin
// API; the lock makes sure that key cannot read NVR passwords — runbook section 5). Never throws; returns the problems.

type Env = Record<string, string | undefined>
export type WebStartupDeps = {
  /** How many active organisations still allow NVR login reads with the service key (security_unlocked_organizations()). */
  unlockedOrganizations: () => Promise<number>
  probeGo2rtc: () => Promise<{ ok: true } | { ok: false; error: string }>
}

export async function webStartupProblems(env: Env, deps: WebStartupDeps): Promise<string[]> {
  if (!isProductionMode(env)) return []
  const { problems } = startupProblems('web', env)
  if (problems.length > 0) return problems
  // P3-1 review I-5: the auth server must not be reachable from outside (the app's sign-in and code limits would be bypassed).
  const auth = authUrlProblem(env)
  if (auth) problems.push(auth)
  const probe = await deps.probeGo2rtc().catch(() => ({ ok: false as const, error: 'The video server (go2rtc) could not be checked.' }))
  if (!probe.ok) problems.push(probe.error)
  try {
    const n = await deps.unlockedOrganizations()
    if (n > 0) {
      problems.push(`${n} ${n === 1 ? 'organisation has' : 'organisations have'} not locked the service key out of NVR logins (security_settings.service_role_credential_reads = false; docs/drishti/runbooks/secret-rotation.md section 5).`)
    }
  } catch {
    problems.push('The lock of the service key on NVR logins could not be checked (is the database reachable with SUPABASE_APP_WEB_KEY?).')
  }
  return problems
}
