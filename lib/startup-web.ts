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
  /** P5.4 fix round 2 (re-review N-2): test_fixtures_enabled(), whether this database was seeded for tests. */
  testFixturesOn: () => Promise<boolean>
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
  const before = problems.length
  let unreachable = 0
  try {
    const n = await deps.unlockedOrganizations()
    if (n > 0) {
      problems.push(`${n} ${n === 1 ? 'organisation has' : 'organisations have'} not locked the service key out of NVR logins (security_settings.service_role_credential_reads = false; docs/drishti/runbooks/secret-rotation.md section 5).`)
    }
  } catch {
    unreachable++
    problems.push('The lock of the service key on NVR logins could not be checked (is the database reachable with SUPABASE_APP_WEB_KEY?).')
  }
  // P5.4 fix round 2 (re-review N-2): the test helpers and the fixtures header work only while the switch is on (supabase/seed.sql).
  try {
    if (await deps.testFixturesOn()) {
      problems.push('The test fixture switch is on in this database (public.test_fixture_switch): it was seeded for tests (supabase/seed.sql), which a production database must never be. As the database owner: UPDATE public.test_fixture_switch SET honoured = false; then find out how the seed was applied (docs/drishti/runbooks/windows-services.md section 4).')
    }
  } catch {
    unreachable++
    problems.push('The test fixture switch could not be checked (test_fixtures_enabled(); is the database at migration 20261021000046 and reachable with SUPABASE_APP_WEB_KEY?).')
  }
  // Final review C-I13: neither database question was answered: the database is not there (yet). One plain line instead of two.
  if (unreachable === 2) {
    problems.splice(before, problems.length - before,
      'The database does not answer (NEXT_PUBLIC_SUPABASE_URL). After a restart of the server it may not have started yet: Docker Desktop starts only when somebody signs in, so it does not bring the database back by itself (docs/drishti/runbooks/windows-services.md section 1). The web app is started again with a growing pause until the database answers.')
  }
  return problems
}
