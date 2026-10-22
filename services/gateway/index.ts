import { existsSync } from 'node:fs'
import { createGateway, normalizeOrigin } from '@/lib/streams/gateway'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'

// The video gateway: a small process next to the web app. Run it with `npm run gateway`. It is the only video endpoint a browser
// reaches (port 3213); go2rtc itself listens on this machine only.
function main() {
  process.on('unhandledRejection', (e) => logger.error({ event: 'gateway_unhandled_rejection', error: e }))

  if (existsSync('.env.local')) process.loadEnvFile('.env.local') // development; in production the service sets the environment

  const secret = getSecret('stream_token')
  if (!secret) {
    logger.error({ event: 'gateway_config_missing', message: 'STREAM_TOKEN_SECRET is required (at least 16 characters). Live video stays off until it is set.' })
    process.exit(1)
  }
  const go2rtcUrl = process.env.GO2RTC_URL?.trim() || 'http://127.0.0.1:1984'
  const portText = process.env.GATEWAY_PORT?.trim() || '3213'
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

  let gateway: ReturnType<typeof createGateway>
  try {
    gateway = createGateway({ go2rtcUrl, secret, allowedOrigins: valid, log: (e) => logger.info(e) })
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
  gateway.listen(port, '0.0.0.0', () => logger.info({ event: 'gateway_started', port, allowedOrigins: valid.length }))
}

main()
