import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/observability/logger'
import { maskSecrets } from '@/lib/observability/mask'
import type { Database } from '@/types/database'

export type WorkerHealth = { ok: boolean; heartbeatAgeSec: number | null }
export type WorkerStatus = WorkerHealth & {
  requestedAt: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
  running: boolean
  progressDone: number
  progressTotal: number
}

type Admin = SupabaseClient<Database>

/** The worker beats every 5 seconds; no beat for 30 seconds means it is not running. */
const MAX_AGE_SEC = 30

async function readState(admin: Admin) {
  const { data, error } = await admin.from('worker_state').select('*').eq('id', 1).single()
  if (error || !data) throw new Error(`Could not read the worker state${error ? ': ' + error.message : '.'}`)
  return data
}

const age = (heartbeat: string | null, now: Date) => (heartbeat ? Math.max(0, Math.round((now.getTime() - new Date(heartbeat).getTime()) / 1000)) : null)

export async function getWorkerHealth(admin: Admin, now = new Date(), maxAgeSec = MAX_AGE_SEC): Promise<WorkerHealth> {
  const s = await readState(admin)
  const heartbeatAgeSec = age(s.last_heartbeat, now)
  return { ok: heartbeatAgeSec !== null && heartbeatAgeSec < maxAgeSec, heartbeatAgeSec }
}

export async function getWorkerStatus(admin: Admin, now = new Date()): Promise<WorkerStatus> {
  const s = await readState(admin)
  const heartbeatAgeSec = age(s.last_heartbeat, now)
  return {
    ok: heartbeatAgeSec !== null && heartbeatAgeSec < MAX_AGE_SEC,
    heartbeatAgeSec,
    requestedAt: s.check_requested_at,
    runStartedAt: s.run_started_at,
    runFinishedAt: s.run_finished_at,
    running: !!s.run_started_at && (!s.run_finished_at || new Date(s.run_finished_at) < new Date(s.run_started_at)),
    progressDone: s.progress_done,
    progressTotal: s.progress_total,
  }
}

export type PublicHealth = { status: 'ok' | 'degraded'; db: boolean; worker: WorkerHealth }

/**
 * What the public health page says. Never throws and never carries the reason for a problem (that goes to the log, with secrets removed):
 * the answer is only whether the database and the worker are alive.
 */
export async function readPublicHealth(makeAdmin: () => Admin): Promise<PublicHealth> {
  try {
    const worker = await getWorkerHealth(makeAdmin())
    if (!worker.ok) logDegraded({ reason: 'The worker heartbeat is missing or too old.', heartbeatAgeSec: worker.heartbeatAgeSec })
    return { status: worker.ok ? 'ok' : 'degraded', db: true, worker }
  } catch (e) {
    logDegraded({ reason: 'The database could not be read.', detail: maskSecrets(e instanceof Error ? e.message : String(e)) })
    return { status: 'degraded', db: false, worker: { ok: false, heartbeatAgeSec: null } }
  }
}

/** A problem that lasts would otherwise be logged on every request; once a minute is enough. */
const DEGRADED_LOG_EVERY_MS = 60_000
let lastDegradedLog = Number.NEGATIVE_INFINITY
function logDegraded(fields: Record<string, unknown>): void {
  const now = Date.now()
  if (now - lastDegradedLog < DEGRADED_LOG_EVERY_MS) return
  lastDegradedLog = now
  logger.warn({ event: 'health_degraded', ...fields })
}

/** Remembers the answer of load() for ttlMs, and shares one call among requests that arrive meanwhile. A failed load is not remembered. */
export function cachedFor<T>(ttlMs: number, load: () => Promise<T>, nowMs: () => number = () => Date.now()): () => Promise<T> {
  let entry: { at: number; value: Promise<T> } | undefined
  return () => {
    const now = nowMs()
    if (entry && now - entry.at < ttlMs) return entry.value
    const value = load()
    const mine = { at: now, value }
    entry = mine
    value.catch(() => {
      if (entry === mine) entry = undefined
    })
    return value
  }
}
