import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_LEASE_NAME } from '@/lib/monitor/lease'
import { logger } from '@/lib/observability/logger'
import { maskSecrets } from '@/lib/observability/mask'
import type { Database } from '@/types/database'

export type WorkerHealth = { ok: boolean; heartbeatAgeSec: number | null }
export type WorkerStatus = WorkerHealth & {
  requestedAt: string | null
  runStartedAt: string | null
  runFinishedAt: string | null
  /** When the last scheduled devices-and-NVR round, and the last scheduled cameras round, finished. */
  lastDevicesRoundAt: string | null
  lastCamerasRoundAt: string | null
  running: boolean
  progressDone: number
  progressTotal: number
  /** P2-7: the worker's lease ('monitor'): who holds it, with which token, and how long ago it was renewed. null = never taken / unreadable. */
  lease: WorkerLeaseStatus | null
  /**
   * P2-7 review round 1 (I-1): how far the worker's clock was ahead of the database's at the last heartbeat (seconds; negative =
   * behind; null = not known). Result times are the worker's; more than 30 s off is a warning (the database dates results that are
   * more than 30 s in the future at its own time, and a clock behind makes results look old).
   */
  clockSkewSec: number | null
  clockSkewWarning: boolean
}

/**
 * The lease as the database holds it (P2-7, docs/drishti/worker-lease.md). `held` and the ages are worked out with this server's clock
 * for display only; who may write is decided by the database alone.
 */
export type WorkerLeaseStatus = {
  name: string
  holder: string
  token: number
  held: boolean
  acquiredAt: string
  renewedAt: string
  leaseUntil: string
  /** Seconds since the holder last renewed it (the lease age shown to people). */
  renewedAgeSec: number
  holderInfo: Record<string, unknown>
}

type Admin = SupabaseClient<Database>

/** The worker beats every 5 seconds; no beat for 30 seconds means it is not running. */
const MAX_AGE_SEC = 30
/** The same 30 s as the worker's own warning and the database's limit for results dated in the future (P2-7 review I-1). */
const CLOCK_SKEW_WARN_SEC = 30

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

/** The lease `name` (default the worker's 'monitor'), or null when nobody ever took it. Throws when it cannot be read. */
export async function getWorkerLease(admin: Admin, name = DEFAULT_LEASE_NAME, now = new Date()): Promise<WorkerLeaseStatus | null> {
  const { data, error } = await admin
    .from('worker_leases')
    .select('name, holder, fencing_token, lease_until, acquired_at, renewed_at, released_at, holder_info')
    .eq('name', name)
    .maybeSingle()
  if (error) throw new Error(`Could not read the worker lease: ${error.message}`)
  if (!data) return null
  return {
    name: data.name,
    holder: data.holder,
    token: Number(data.fencing_token),
    held: !data.released_at && new Date(data.lease_until).getTime() > now.getTime(),
    acquiredAt: data.acquired_at,
    renewedAt: data.renewed_at,
    leaseUntil: data.lease_until,
    renewedAgeSec: age(data.renewed_at, now) ?? 0,
    holderInfo: data.holder_info && typeof data.holder_info === 'object' && !Array.isArray(data.holder_info) ? (data.holder_info as Record<string, unknown>) : {},
  }
}

export async function getWorkerStatus(admin: Admin, now = new Date()): Promise<WorkerStatus> {
  const s = await readState(admin)
  // The lease is extra information: a failure to read it never hides the rest of the status.
  const lease = await getWorkerLease(admin, DEFAULT_LEASE_NAME, now).catch((e: unknown) => {
    logger.warn({ event: 'worker_lease_read_failed', error: e })
    return null
  })
  const heartbeatAgeSec = age(s.last_heartbeat, now)
  // heartbeat_db_at (migration 20261021000039) is read from the row as it comes; types/database.ts is regenerated separately.
  const dbBeat = (s as unknown as { heartbeat_db_at?: string | null }).heartbeat_db_at
  const clockSkewSec = s.last_heartbeat && dbBeat ? Math.round((Date.parse(s.last_heartbeat) - Date.parse(dbBeat)) / 1000) : null
  return {
    clockSkewSec,
    clockSkewWarning: clockSkewSec !== null && Math.abs(clockSkewSec) > CLOCK_SKEW_WARN_SEC,
    ok: heartbeatAgeSec !== null && heartbeatAgeSec < MAX_AGE_SEC,
    heartbeatAgeSec,
    requestedAt: s.check_requested_at,
    runStartedAt: s.run_started_at,
    runFinishedAt: s.run_finished_at,
    lastDevicesRoundAt: s.last_devices_round_at,
    lastCamerasRoundAt: s.last_cameras_round_at,
    running: !!s.run_started_at && (!s.run_finished_at || new Date(s.run_finished_at) < new Date(s.run_started_at)),
    progressDone: s.progress_done,
    progressTotal: s.progress_total,
    lease,
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
