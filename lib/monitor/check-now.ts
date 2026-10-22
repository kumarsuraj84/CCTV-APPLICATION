import { addAudit } from '@/lib/admin/audit'
import { canRunChecks } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { sanitizeError } from '@/lib/observability/sanitize-error'

/** The worker beats every 5 seconds; no beat for 30 seconds means it is not running (the same rule as lib/monitor/health.ts). */
const WORKER_ALIVE_SEC = 30

/**
 * Asks the worker to check everything now. The worker picks the request up within a few seconds.
 *
 * Only operators, administrators and platform owners may ask; this is checked first. While a running worker already has a request waiting,
 * or is in the middle of a run, a new request is not recorded (`alreadyOnTheWay`): it would only start the same work twice. When the worker
 * is not running a new request is always recorded, because an old waiting request would otherwise hide that someone asked again.
 * The checker is one for the whole system, so the request is not about one organisation; the audit entry names the organisation of the asker.
 */
export async function requestCheckNow(admin: AdminClient, actor: Actor): Promise<Result<{ alreadyOnTheWay?: true }>> {
  if (!canRunChecks(actor.role)) return { ok: false, error: 'You are not allowed to start a check.' }
  const fail = (error: unknown) => ({
    ok: false as const,
    error: sanitizeError(error, { route: 'requestCheckNow', fallback: 'Could not ask for a check. Please try again.' }),
  })

  const { data: s, error: readError } = await admin
    .from('worker_state')
    .select('last_heartbeat, check_requested_at, run_started_at, run_finished_at')
    .eq('id', 1)
    .single()
  if (readError || !s) return fail(readError)

  const alive = !!s.last_heartbeat && Date.now() - new Date(s.last_heartbeat).getTime() < WORKER_ALIVE_SEC * 1000
  const t = (v: string | null) => (v ? new Date(v).getTime() : null)
  const asked = t(s.check_requested_at)
  const started = t(s.run_started_at)
  const finished = t(s.run_finished_at)
  const waiting = asked !== null && (started === null || asked > started)
  const running = started !== null && (finished === null || finished < started)
  if (alive && (waiting || running)) return { ok: true, alreadyOnTheWay: true }

  const { error } = await admin.from('worker_state').update({ check_requested_at: new Date().toISOString() }).eq('id', 1)
  if (error) return fail(error)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'check_requested' })
  return { ok: true }
}
