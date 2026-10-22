import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { anotherWorkerIsRunning } from '@/lib/monitor/guard'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { logger } from '@/lib/observability/logger'
import { createAdminClient } from '@/lib/supabase/admin'

/** How long a stop request waits for the checks in progress before the process exits anyway. */
const SHUTDOWN_WAIT_MS = 15_000

// The monitoring worker: a long-running process next to the web app. Run it with `npm run worker`.
async function main() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local') // development; in production the service sets the environment
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logger.error({ event: 'worker_config_missing', message: 'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required' })
    process.exit(1)
  }
  const cfg = loadMonitorConfig()
  const admin = createAdminClient()

  // Only one worker may run against a database. Refuse to start next to a live one.
  const another = await anotherWorkerIsRunning({
    readHeartbeat: async () => {
      const { data, error } = await admin.from('worker_state').select('last_heartbeat').eq('id', 1).single()
      if (error) throw new Error(`reading the heartbeat failed: ${error.message}`)
      return data.last_heartbeat ? new Date(data.last_heartbeat) : null
    },
    now: () => new Date(),
    sleep: (ms) => sleep(ms),
    pollSec: cfg.pollSec,
  })
  if (another) {
    logger.error({ event: 'worker_already_running', message: 'Another worker is already beating on this database. Stop it first, then start this one.' })
    process.exit(1)
  }

  const runner = new MonitorRunner({ db: new SupabaseMonitorDb(admin), probes: realProbes, cfg, clock: () => new Date() })
  await runner.start()
  logger.info({ event: 'worker_started', deviceCheckSec: cfg.deviceCheckSec, cameraCheckSec: cfg.cameraCheckSec, failThreshold: cfg.failThreshold })

  let stopping = false
  // SIGBREAK is what Ctrl+Break and closing the console send on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      void runner.shutdown(SHUTDOWN_WAIT_MS).then((drained) => {
        logger.info({ event: 'worker_stopped', signal, finishedCurrentChecks: drained })
        process.exit(0)
      })
    })
  }
  // A forgotten rejection must not stop monitoring; it is logged and the loops carry on.
  process.on('unhandledRejection', (e) => logger.error({ event: 'worker_unhandled_rejection', error: e }))
}

main().catch((e) => {
  logger.error({ event: 'worker_crashed', error: e })
  process.exit(1)
})
