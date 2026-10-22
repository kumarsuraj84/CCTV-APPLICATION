import { existsSync } from 'node:fs'
import { createGateway, normalizeOrigin } from '@/lib/streams/gateway'
import { gatewayBindHost } from '@/lib/web/tls'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import { isProductionMode } from '@/lib/runtime-mode'
import { refusalMessage, startupProblems } from '@/lib/startup-checks'
import { go2rtcApiAuth, probeGo2rtcLogin } from '@/lib/streams/go2rtc-auth'
import { createRestRegistry } from '@/lib/streams/registry'
import { requireServiceKey, serviceKeyFor } from '@/lib/supabase/service-clients'

// The video gateway: a small process next to the web app. Run it with `npm run gateway`. It is the only video endpoint a browser
// reaches (port 3412); go2rtc itself listens on this machine only.
async function main() {
  process.on('unhandledRejection', (e) => logger.error({ event: 'gateway_unhandled_rejection', error: e }))

  if (existsSync('.env.local')) process.loadEnvFile('.env.local') // development; in production the service sets the environment

  // P2-6 review round 1 (I-1, I-2, M-4): production mode (DRISHTI_ENV=production; tsx sets no NODE_ENV) refuses to start without the
  // gateway's own key, with the old service key in its environment, without go2rtc's API login, or with an ended key.
  const startup = startupProblems('gateway')
  for (const w of startup.warnings) logger.warn({ event: 'gateway_startup_warning', message: w })
  if (startup.problems.length > 0) {
    logger.error({ event: 'gateway_config_refused', message: refusalMessage('gateway', startup.problems) })
    process.exit(1)
  }

  const secret = getSecret('stream_token')
  if (!secret) {
    logger.error({ event: 'gateway_config_missing', message: 'STREAM_TOKEN_SECRET is required (at least 16 characters). Live video stays off until it is set.' })
    process.exit(1)
  }
  const go2rtcUrl = process.env.GO2RTC_URL?.trim() || 'http://127.0.0.1:1984'
  const portText = process.env.GATEWAY_PORT?.trim() || '3412'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    logger.error({ event: 'gateway_config_invalid', message: 'GATEWAY_PORT must be a number from 1 to 65535.' })
    process.exit(1)
  }
  const origins = (process.env.GATEWAY_ALLOWED_ORIGINS?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const valid = origins.filter((o) => normalizeOrigin(o) !== null)
  if (valid.length === 0 || valid.length !== origins.length) {
    logger.error({
      event: 'gateway_config_invalid',
      message: 'GATEWAY_ALLOWED_ORIGINS (or NEXT_PUBLIC_APP_URL) must list the web app address(es), such as http://localhost:3212, separated by commas.',
    })
    process.exit(1)
  }

  // P2-4 (D-3): the media session registry. Every socket's session is opened there and every open socket is re-checked every 15 s;
  // without it nothing can be verified, so the gateway does not start. P2-6 (D-14): the gateway's own database role video_gateway
  // (key SUPABASE_VIDEO_GATEWAY_KEY), which may call media_session_open, media_sessions_still_valid and media_session_close and nothing
  // else — no table, no other function. Development without the key falls back to the service key with a warning; production refuses.
  // The key comes from the environment only and goes only into request headers (never logged).
  const registryUrl = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || ''
  const key = serviceKeyFor('video_gateway')
  if (!registryUrl || !key.ok) {
    logger.error({
      event: 'gateway_config_missing',
      message: !registryUrl
        ? 'SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is required: the gateway checks every video connection in the database. Live video stays off until it is set.'
        : `${key.ok ? '' : key.error} The gateway checks every video connection in the database; live video stays off until it is set.`,
    })
    process.exit(1)
  }
  let registry: ReturnType<typeof createRestRegistry>
  try {
    registry = createRestRegistry({ url: registryUrl, serviceKey: requireServiceKey('video_gateway') })
  } catch (e) {
    logger.error({ event: 'gateway_config_invalid', message: e instanceof Error ? e.message : 'The database address is not valid.' })
    process.exit(1)
  }

  // Review round 1 (I-2, M-12): in production go2rtc itself must refuse a request without its login (a container never recreated
  // with the login would hand its stream list, with NVR passwords, to anything on this computer).
  if (isProductionMode()) {
    const probe = await probeGo2rtcLogin(go2rtcUrl)
    if (!probe.ok) {
      logger.error({ event: 'gateway_config_refused', message: refusalMessage('gateway', [probe.error]) })
      process.exit(1)
    }
  }

  let gateway: ReturnType<typeof createGateway>
  try {
    // P2-6 (D-13): go2rtc's API credentials (GO2RTC_API_USERNAME / GO2RTC_API_PASSWORD); required in production (startup check above).
    gateway = createGateway({ go2rtcUrl, go2rtcAuth: go2rtcApiAuth(), secret, allowedOrigins: valid, registry, log: (e) => logger.info(e) })
  } catch (e) {
    logger.error({ event: 'gateway_config_invalid', message: e instanceof Error ? e.message : 'The gateway could not be set up.' })
    process.exit(1)
  }

  let stopping = false
  // SIGBREAK is what Ctrl+Break and closing the console send on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(130) // a second request to stop: leave at once
      stopping = true
      void gateway.shutdown().then(() => {
        logger.info({ event: 'gateway_stopped', signal })
        process.exit(0)
      })
    })
  }

  gateway.on('error', (e) => {
    logger.error({ event: 'gateway_listen_failed', error: e })
    process.exit(1)
  })
  // P3-1 (runbook-tls.md): GATEWAY_HOST=127.0.0.1 behind the one https address (Caddy); every address otherwise, as before.
  const host = gatewayBindHost()
  gateway.listen(port, host, () => logger.info({ event: 'gateway_started', port, host, allowedOrigins: valid.length }))
}

main().catch((e) => {
  logger.error({ event: 'gateway_crashed', error: e })
  process.exit(1)
})
