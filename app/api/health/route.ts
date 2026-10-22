import { getWorkerHealth } from '@/lib/monitor/health'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

// Public: says whether the app, the database and the worker are alive. No counts, names, addresses or error details.
export async function GET() {
  let db = false
  let worker: { ok: boolean; heartbeatAgeSec: number | null } = { ok: false, heartbeatAgeSec: null }
  try {
    worker = await getWorkerHealth(createAdminClient())
    db = true
  } catch {
    db = false
  }
  return Response.json({ status: db && worker.ok ? 'ok' : 'degraded', db, worker })
}
