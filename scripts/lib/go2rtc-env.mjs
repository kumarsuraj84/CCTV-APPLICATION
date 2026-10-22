// go2rtc's API login before the stack starts (P2-6 review round 1, I-2). go2rtc takes GO2RTC_API_USERNAME / GO2RTC_API_PASSWORD from
// its environment (deploy/go2rtc.yaml); with empty values it runs with NO login, and its stream list holds NVR sources with their
// passwords. So in production mode (scripts/lib/runtime-mode.mjs, the same switch as the app) both must be set, the password with 32+
// characters like the app's own check (lib/startup-checks.ts). Development: a warning only. Never returns or prints a value.
import { isProductionMode } from './runtime-mode.mjs'

const MIN_PASSWORD = 32

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ problems: string[]; warnings: string[] }}
 */
export function go2rtcEnvProblems(env) {
  const user = (env.GO2RTC_API_USERNAME ?? '').trim()
  const password = (env.GO2RTC_API_PASSWORD ?? '').trim()
  const findings = []
  if (!user || !password) findings.push('GO2RTC_API_USERNAME and GO2RTC_API_PASSWORD must both be set (go2rtc would run without a login).')
  else if (password.length < MIN_PASSWORD) findings.push(`GO2RTC_API_PASSWORD must have at least ${MIN_PASSWORD} characters.`)
  if (findings.length === 0) return { problems: [], warnings: [] }
  if (isProductionMode(env)) return { problems: findings, warnings: [] }
  return { problems: [], warnings: findings.map((f) => `Development: ${f.replace('(go2rtc would run without a login)', '(go2rtc runs without a login)')}`) }
}
