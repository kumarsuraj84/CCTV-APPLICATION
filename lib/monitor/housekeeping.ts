// Worker housekeeping (P2-6; D-11 shared rate limiter, D-3 media sessions, D-14 credential-read log): every ten minutes the worker,
// under its own database role (monitor_worker), removes ended rate-limit windows, old media session rows and credential-read log rows
// older than the retention. Each task is independent: one failure is logged (its code only) and never stops the others or the worker.

export const HOUSEKEEPING_EVERY_MS = 10 * 60_000

type Rpc = (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>
type Log = (entry: Record<string, unknown>) => void

const TASKS = ['rate_limit_prune', 'media_sessions_prune', 'vault_reads_prune'] as const
export type HousekeepingResult = Record<(typeof TASKS)[number], number | null>

/** Runs the three prune functions once. Never throws; `null` = that task failed. */
export async function runHousekeeping(db: { rpc: Rpc }, log: Log): Promise<HousekeepingResult> {
  const out = {} as HousekeepingResult
  for (const task of TASKS) {
    try {
      const { data, error } = await db.rpc(task, {})
      if (error) {
        log({ event: 'housekeeping_failed', task, errorCode: error.code ?? 'error' })
        out[task] = null
      } else out[task] = typeof data === 'number' ? data : 0
    } catch (e) {
      log({ event: 'housekeeping_failed', task, errorCode: e instanceof Error ? e.name : 'error' })
      out[task] = null
    }
  }
  log({ event: 'housekeeping_done', removed: out })
  return out
}

/**
 * P5.4: the worker's schedule of the clean-up (P2-4: unused media session rows pile up until media_sessions_prune runs; each run is
 * now recorded in housekeeping_runs and shown on the Health page). First 30 s after the start, then every 10 minutes; a tick does
 * nothing while the worker is in standby (`isActive` false) or while the previous run is still busy. Returns stop().
 */
export function scheduleHousekeeping(o: { isActive: () => boolean; run: () => Promise<unknown>; firstAfterMs?: number; everyMs?: number }): () => void {
  let busy = false
  const tick = () => {
    if (busy || !o.isActive()) return
    busy = true
    void o.run().catch(() => undefined).finally(() => {
      busy = false
    })
  }
  const first = setTimeout(tick, o.firstAfterMs ?? 30_000)
  const every = setInterval(tick, o.everyMs ?? HOUSEKEEPING_EVERY_MS)
  first.unref?.()
  every.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
