import { logger } from '@/lib/observability/logger'
import { isProductionMode } from '@/lib/runtime-mode'
import { refusalMessage, startupProblems, watchKeyExpiry } from '@/lib/startup-checks'
import { webStartupProblems } from '@/lib/startup-web'
import { securityStartupProblems } from '@/lib/security/production-checks'
import { probeGo2rtcLogin } from '@/lib/streams/go2rtc-auth'
import { fastPlaybackStartupNote } from '@/lib/streams/remux'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Called once from instrumentation.ts when the Node.js server starts (not during `next build`). Production mode: any problem is logged
 * as one plain line and the server stops (exit 1) before it serves a request. Development: the findings are warnings.
 */
export async function runWebStartupCheck(env: Record<string, string | undefined> = process.env): Promise<void> {
  // P4-L2 review I-1: fast playback is optional, so this is a warning, never a refusal: it needs ffmpeg 5.0 or newer (-readrate).
  void fastPlaybackStartupNote(env).then((note) => note && logger.warn({ event: 'fast_playback_unavailable', message: note }))
  // Release 1 (P2-6 re-review N-2, N-4): the warnings are logged in production too (a key that ends soon, no client address), and a
  // key that ends while the server runs is announced every day.
  for (const w of startupProblems('web', env).warnings) logger.warn({ event: 'web_startup_warning', message: w })
  watchKeyExpiry('web', { env, log: (message) => logger.warn({ event: 'web_key_expiry', message }) })
  if (!isProductionMode(env)) return
  const problems = await webStartupProblems(env, {
    unlockedOrganizations: async () => {
      const { data, error } = await createAdminClient().rpc('security_unlocked_organizations')
      if (error || !Array.isArray(data)) throw new Error('not readable')
      return data.length
    },
    probeGo2rtc: () => probeGo2rtcLogin(env.GO2RTC_URL?.trim() || 'http://127.0.0.1:1984'),
    testFixturesOn: async () => {
      const { data, error } = await createAdminClient().rpc('test_fixtures_enabled' as never)
      if (error || typeof data !== 'boolean') throw new Error('not readable')
      return data
    },
  })
  // Final fix Y (review A I-1, B I-1, B minor 3): two-step sign-in and the TLS / CSP settings (lib/security/production-checks.ts).
  const security = await securityStartupProblems(env, { mfaOverview: async () => { const { data, error } = await createAdminClient().rpc('security_mfa_overview'); if (error || !Array.isArray(data)) throw new Error('not readable'); return data } })
  for (const w of security.warnings) logger.warn({ event: 'web_startup_warning', message: w })
  problems.push(...security.problems)
  if (problems.length > 0) {
    logger.error({ event: 'web_config_refused', message: refusalMessage('web', problems) })
    process.exit(1)
  }
}
