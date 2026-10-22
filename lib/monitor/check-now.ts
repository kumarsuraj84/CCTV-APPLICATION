import { addAudit } from '@/lib/admin/audit'
import { canRunChecks } from '@/lib/admin/roles'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { sanitizeError } from '@/lib/observability/sanitize-error'

/** The worker beats every 5 seconds; no beat for 30 seconds means it is not running (the same rule as lib/monitor/health.ts). */
const WORKER_ALIVE_SEC = 30

/** A request is refused for this long after a run finished, so that pressing the button again and again cannot keep the checker busy. */
export const COOLDOWN_MS = 30_000

/**
 * Asks the worker to check everything now. The worker picks the request up within a few seconds.
 *
 * Only operators, administrators and platform owners may ask; this is checked first. While a running worker already has a request WAITING
 * (asked, and no run has begun since), a new request is not recorded (`alreadyOnTheWay`): it would only ask for the same thing twice.
 * A run that is merely RUNNING does not block a request: the worker repeats the check when it was asked after the run began, which is what
 * someone who has just fixed a password in the middle of a run needs. Within COOLDOWN_MS after a run finished a request is refused.
 * When the worker is not running a new request is recorded, because an old waiting request would otherwise hide that someone asked again.
 * The checker is one for the whole system, so the request is not about one organisation; the audit entry names the organisation of the asker.
 * `clock` is the time used for these decisions (tests pass their own). The request itself is stamped by the database (monitor_request_check),
 * never by the clock of the web server.
 */
export async function requestCheckNow(admin: AdminClient, actor: Actor, clock: () => number = Date.now): Promise<Result<{ alreadyOnTheWay?: true }>> {
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

  const nowMs = clock()
  const alive = !!s.last_heartbeat && nowMs - new Date(s.last_heartbeat).getTime() < WORKER_ALIVE_SEC * 1000
  const t = (v: string | null) => (v ? new Date(v).getTime() : null)
  const asked = t(s.check_requested_at)
  const started = t(s.run_started_at)
  const finished = t(s.run_finished_at)
  const waiting = asked !== null && (started === null || asked > started)
  const justFinished = finished !== null && (started === null || finished >= started) && nowMs - finished < COOLDOWN_MS
  if (alive && waiting) return { ok: true, alreadyOnTheWay: true }
  if (justFinished) return { ok: false, error: 'A check just finished. Try again in a moment.' }

  // The database stamps the request with its own clock: the times it is compared with (run start and finish) come from there too.
  const { error } = await admin.rpc('monitor_request_check')
  if (error) return fail(error)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'check_requested' })
  return { ok: true }
}
