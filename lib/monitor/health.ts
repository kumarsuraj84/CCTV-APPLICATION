import type { SupabaseClient } from '@supabase/supabase-js'
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
  if (error || !data) throw new Error('Could not read the worker state.')
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
