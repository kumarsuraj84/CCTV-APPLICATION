import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { WorkerLease } from '@/lib/monitor/lease'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { WorkerSupervisor } from '@/lib/monitor/supervisor'
import { runHousekeeping, scheduleHousekeeping } from '@/lib/monitor/housekeeping'
import { logger } from '@/lib/observability/logger'
import { refusalMessage, startupProblems, watchKeyExpiry } from '@/lib/startup-checks'
import { createServiceClient, serviceKeyFor } from '@/lib/supabase/service-clients'

/** How long a stop request waits for the checks in progress before the process exits anyway. */
const SHUTDOWN_WAIT_MS = 15_000

// The monitoring worker: a long-running process next to the web app. Run it with `npm run worker`.
async function main() {
  // A forgotten rejection must not stop monitoring; it is logged and the loops carry on.
  process.on('unhandledRejection', (e) => logger.error({ event: 'worker_unhandled_rejection', error: e }))

  const started: { supervisor?: WorkerSupervisor } = {}
  let stopping = false
  // SIGBREAK is what Ctrl+Break and closing the console send on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      if (stopping) {
        logger.warn({ event: 'worker_forced_stop', signal })
        process.exit(130) // a second request to stop: leave at once; 130 is the usual code for being stopped by Ctrl+C
      }
      stopping = true
      // P2-7: the checks in progress finish (their writes still fenced with a valid token), then the lease is handed back so that
      // another worker can take it at once.
      void (started.supervisor ? started.supervisor.stop(SHUTDOWN_WAIT_MS) : Promise.resolve(true)).then((drained) => {
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
  // Release 1 (P2-6 re-review N-4): a key that ends while the worker runs is announced every day, not only at the start.
  watchKeyExpiry('worker', { log: (message) => logger.warn({ event: 'worker_key_expiry', message }) })
  const key = serviceKeyFor('monitor_worker')
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !key.ok) {
    logger.error({ event: 'worker_config_missing', message: key.ok ? 'NEXT_PUBLIC_SUPABASE_URL is required' : key.error })
    process.exit(1)
  }
  const cfg = loadMonitorConfig()
  const admin = createServiceClient('monitor_worker')

  // P2-7 (D-8, docs/drishti/worker-lease.md): only the worker holding the lease 'monitor' works. Two workers started together: exactly
  // one gets it, the other waits in standby and takes over when the first stops or stops renewing (20 s). Every write carries the lease's
  // fencing token and the database refuses it once the lease is no longer this worker's. The lease name is not configurable yet: shards
  // ('monitor:shard-<n>') need the targets split between them first.
  const lease = new WorkerLease({
    rpc: (fn, args) => admin.rpc(fn as never, args as never) as unknown as PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>,
    holderInfo: { host: hostname(), pid: process.pid },
  })
  const supervisor = new WorkerSupervisor({
    lease,
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
    log: (e) => (e.event === 'worker_start_failed' || e.event === 'worker_shutdown_failed' ? logger.error(e) : logger.warn(e)),
    makeRunner: (fence) => new MonitorRunner({ db: new SupabaseMonitorDb(admin, { fence }), probes: realProbes, cfg, clock: () => new Date() }),
    onActive: (token) =>
      // The fencing token is logged as "epoch": it is no secret, and the logger hides every field whose name contains "token".
      logger.info({ event: 'worker_started', lease: lease.name, epoch: token, deviceCheckSec: cfg.deviceCheckSec, cameraCheckSec: cfg.cameraCheckSec, failThreshold: cfg.failThreshold }),
  })
  started.supervisor = supervisor
  if (stopping) return
  // P2-6: housekeeping under the worker's role (ended rate-limit windows, old media sessions, old credential-read log rows). P2-7: only
  // while this worker holds the lease (the prunes are harmless twice, but a worker in standby does no work at all).
  // P5.4: each run is recorded in the database (housekeeping_runs) and shown on the Health page ("clean-up of unused video sessions").
  scheduleHousekeeping({
    isActive: () => supervisor.isActive(),
    run: () => runHousekeeping({ rpc: (name, args) => admin.rpc(name as never, args as never) }, (e) => (e.event === 'housekeeping_failed' ? logger.warn(e) : logger.info(e))),
  })
  await supervisor.run()
}

main().catch((e) => {
  logger.error({ event: 'worker_crashed', error: e })
  process.exit(1)
})
