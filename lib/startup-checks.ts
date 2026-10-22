import { isProductionMode } from '@/lib/runtime-mode'
import { getSecret, secretEnvName, type SecretPurpose } from '@/lib/secrets'
import { connectRefusal } from '@/lib/security/targets'
import { SERVICE_KEY_ENV, serviceKeyFor, type ServiceRole } from '@/lib/supabase/service-clients'

// Start-up checks of the three processes (P2-6 review round 1: I-1, I-2, M-4, M-16). Every process calls startupProblems() before it
// serves anything — the web app from instrumentation.ts, the worker and the gateway from services/*/index.ts. In production mode
// (lib/runtime-mode.ts) any problem stops the process with the plain message; in development the same findings are warnings only (the
// fallback to the service key stays, with its warning). Never returns or mentions a key or secret value.

export type ProcessName = 'web' | 'worker' | 'gateway'
type Env = Record<string, string | undefined>

const ROLES: Record<ProcessName, ServiceRole[]> = { web: ['app_web', 'media_service'], worker: ['monitor_worker'], gateway: ['video_gateway'] }
const SECRETS: Record<ProcessName, SecretPurpose[]> = { web: ['stream_token', 'access_preview', 'merge_confirm', 'verified_user'], worker: [], gateway: ['stream_token'] }
const GO2RTC: Record<ProcessName, boolean> = { web: true, worker: false, gateway: true }
/** A key that ends within this many days is announced at every start. */
export const KEY_WARN_DAYS = 30

function claims(jwt: string): { exp?: number } | null {
  const part = jwt.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number }
  } catch {
    return null
  }
}

export function startupProblems(proc: ProcessName, env: Env = process.env, now: number = Date.now()): { problems: string[]; warnings: string[] } {
  const production = isProductionMode(env)
  const problems: string[] = []
  const warnings: string[] = []
  const add = (text: string) => (production ? problems : warnings).push(text)

  for (const role of ROLES[proc]) {
    const name = SERVICE_KEY_ENV[role]
    const k = serviceKeyFor(role, env)
    if (!k.ok) {
      add(k.error)
      continue
    }
    if (k.fallback) {
      add(`${name} is not set: this process uses the full service key.`)
      continue
    }
    const exp = claims(k.key)?.exp
    if (typeof exp === 'number') {
      const daysLeft = Math.floor((exp * 1000 - now) / 86_400_000)
      if (exp * 1000 <= now) add(`${name} has ended (it is older than its one-year lifetime): make a new one with node scripts/gen-secrets.mjs --rotate=${name}.`)
      else if (daysLeft < KEY_WARN_DAYS) warnings.push(`${name} ends in ${daysLeft} days: rotate it (node scripts/gen-secrets.mjs --rotate=${name}) and restart.`)
    }
  }

  // The full service key belongs to the web app (GoTrue's admin API) and the scripts only (ADR, review Release-1 ruling).
  if (production && proc !== 'web' && env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    problems.push(`SUPABASE_SERVICE_ROLE_KEY must not be in the ${proc}'s environment in production (give each process its own env file).`)
  }

  for (const purpose of SECRETS[proc]) {
    if (!getSecret(purpose, env)) add(`${secretEnvName(purpose)} is not set (or too short).`)
  }

  if (GO2RTC[proc]) {
    const user = env.GO2RTC_API_USERNAME?.trim()
    const pass = env.GO2RTC_API_PASSWORD?.trim()
    if (!user || !pass || !getSecret('go2rtc_api', env)) {
      add('GO2RTC_API_USERNAME and GO2RTC_API_PASSWORD (32 characters or more) are required: go2rtc\'s API must ask for its login.')
    }
  }

  if (production) {
    const entries = (env.OUTBOUND_TARGET_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    for (const entry of entries) {
      const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(entry)
      if (!m || connectRefusal(m[1], env)) {
        problems.push('OUTBOUND_TARGET_ALLOWLIST lists an address that cannot be used in production (this computer, link-local, metadata or another special address).')
        break
      }
    }
    if (env.DEMO_VIDEO?.trim()) problems.push('DEMO_VIDEO must not be set in production.')
  }
  return { problems, warnings }
}

/** The plain line a process logs when it refuses to start. */
export const refusalMessage = (proc: ProcessName, problems: string[]) =>
  `The ${proc === 'web' ? 'web app' : proc} does not start in production mode (DRISHTI_ENV=production or NODE_ENV=production): ${problems.join(' ')}`
