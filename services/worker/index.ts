import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitForSoleWorker } from '@/lib/monitor/guard'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { HOUSEKEEPING_EVERY_MS, runHousekeeping } from '@/lib/monitor/housekeeping'
import { logger } from '@/lib/observability/logger'
import { refusalMessage, startupProblems } from '@/lib/startup-checks'
import { createServiceClient, serviceKeyFor } from '@/lib/supabase/service-clients'

/** How long a stop request waits for the checks in progress before the process exits anyway. */
const SHUTDOWN_WAIT_MS = 15_000

// The monitoring worker: a long-running process next to the web app. Run it with `npm run worker`.
async function main() {
  // A forgotten rejection must not stop monitoring; it is logged and the loops carry on.
  process.on('unhandledRejection', (e) => logger.error({ event: 'worker_unhandled_rejection', error: e }))

  const stop = new AbortController()
  const started: { runner?: MonitorRunner } = {}
  let stopping = false
  // SIGBREAK is what Ctrl+Break and closing the console send on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      if (stopping) {
        logger.warn({ event: 'worker_forced_stop', signal })
        process.exit(130) // a second request to stop: leave at once; 130 is the usual code for being stopped by Ctrl+C
      }
      stopping = true
      stop.abort() // ends the wait at start-up, if that is where the worker is
      void (started.runner ? started.runner.shutdown(SHUTDOWN_WAIT_MS) : Promise.resolve(true)).then((drained) => {
        logger.info({ event: 'worker_stopped', signal, finishedCurrentChecks: drained })
        process.exit(0)
      })
    })
  }

  if (existsSync('.env.local')) process.loadEnvFile('.env.local') // development; in production the service sets the environment
  // P2-6 (D-14): the worker's own database role (monitor_worker, key SUPABASE_MONITOR_WORKER_KEY). Development without the key falls
  // back to the service key with a warning; production does not start without it.
  // P2-6 review round 1 (I-1, M-4): production mode (DRISHTI_ENV=production; tsx sets no NODE_ENV) refuses to start without the
  // worker's own key, with the old service key in its environment, or with an ended key.
  const startup = startupProblems('worker')
  for (const w of startup.warnings) logger.warn({ event: 'worker_startup_warning', message: w })
  if (startup.problems.length > 0) {
    logger.error({ event: 'worker_config_refused', message: refusalMessage('worker', startup.problems) })
    process.exit(1)
  }
  const key = serviceKeyFor('monitor_worker')
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !key.ok) {
    logger.error({ event: 'worker_config_missing', message: key.ok ? 'NEXT_PUBLIC_SUPABASE_URL is required' : key.error })
    process.exit(1)
  }
  const cfg = loadMonitorConfig()
  const admin = createServiceClient('monitor_worker')

  // Only one worker may run against a database. Refuse to start next to a live one; wait patiently if the database cannot be read.
  const guard = await waitForSoleWorker(
    {
      readHeartbeat: async () => {
        const { data, error } = await admin.from('worker_state').select('last_heartbeat').eq('id', 1).single()
        if (error) throw new Error(`reading the heartbeat failed: ${error.message}`)
        return data.last_heartbeat ? new Date(data.last_heartbeat) : null
      },
      now: () => new Date(),
      sleep: (ms, signal) => sleep(ms, undefined, { signal }),
      pollSec: cfg.pollSec,
    },
    {
      retryMs: cfg.pollSec * 1000,
      signal: stop.signal,
      onError: (e) => logger.error({ event: 'worker_waiting_for_database', message: 'Could not check for another worker; trying again.', error: e }),
    },
  )
  if (guard === 'aborted') return // the stop handler ends the process
  if (guard === 'taken') {
    logger.error({ event: 'worker_already_running', message: 'Another worker is already beating on this database. Stop it first, then start this one.' })
    process.exit(1)
  }

  const runner = new MonitorRunner({ db: new SupabaseMonitorDb(admin), probes: realProbes, cfg, clock: () => new Date() })
  started.runner = runner
  // "Started" is logged once the database has accepted the worker (the start-up gap is recorded), not before.
  await runner.start({
    onReady: () => logger.info({ event: 'worker_started', deviceCheckSec: cfg.deviceCheckSec, cameraCheckSec: cfg.cameraCheckSec, failThreshold: cfg.failThreshold }),
  })
  // P2-6: housekeeping under the worker's role (ended rate-limit windows, old media sessions, old credential-read log rows).
  const tidy = () => void runHousekeeping({ rpc: (name, args) => admin.rpc(name as never, args as never) }, (e) => (e.event === 'housekeeping_failed' ? logger.warn(e) : logger.info(e)))
  tidy()
  setInterval(tidy, HOUSEKEEPING_EVERY_MS).unref()
}

main().catch((e) => {
  logger.error({ event: 'worker_crashed', error: e })
  process.exit(1)
})
