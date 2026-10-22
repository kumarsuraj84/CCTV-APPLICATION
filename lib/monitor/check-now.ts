import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { auditAccess } from '@/lib/auth/access-audit'
import { coversSomeLocation } from '@/lib/auth/resource'
import { sanitizeError } from '@/lib/observability/sanitize-error'

/** `rls`: the person's own signed-in client (their capability is asked as them); `admin`: the worker state and the audit entry. */
export type CheckNowDeps = { admin: AdminClient; rls: AdminClient }
export const MSG_CHECK_NOT_ALLOWED = 'You are not allowed to start a check.'

/** The worker beats every 5 seconds; no beat for 30 seconds means it is not running (the same rule as lib/monitor/health.ts). */
const WORKER_ALIVE_SEC = 30

/** A request is refused for this long after a run finished, so that pressing the button again and again cannot keep the checker busy. */
export const COOLDOWN_MS = 30_000

/**
 * Asks the worker to check everything now. The worker picks the request up within a few seconds.
 *
 * Only people holding it.monitoring.operate for the organisation or for at least one whole location may ask (P2-2; asked as the person,
 * capability_store_ids; the role does not matter); this is checked first. The checker runs for everything, so the request reveals
 * nothing: each person still sees only the results their own grants show. While a running worker already has a request WAITING
 * (asked, and no run has begun since), a new request is not recorded (`alreadyOnTheWay`): it would only ask for the same thing twice.
 * A run that is merely RUNNING does not block a request: the worker repeats the check when it was asked after the run began, which is what
 * someone who has just fixed a password in the middle of a run needs. Within COOLDOWN_MS after a run finished a request is refused.
 * When the worker is not running a new request is recorded, because an old waiting request would otherwise hide that someone asked again.
 * The checker is one for the whole system, so the request is not about one organisation; the audit entry names the organisation of the asker.
 * `clock` is the time used for these decisions (tests pass their own). The request itself is stamped by the database (monitor_request_check),
 * never by the clock of the web server.
 */
export async function requestCheckNow(deps: CheckNowDeps, actor: Actor, clock: () => number = Date.now): Promise<Result<{ alreadyOnTheWay?: true }>> {
  const allowed = await coversSomeLocation(deps.rls, 'it.monitoring.operate')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (!allowed.allowed) return { ok: false, error: MSG_CHECK_NOT_ALLOWED }
  const admin = deps.admin
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

  // The request time is the database's clock. The run start and finish times are written by the worker with its own clock; the two are the
  // same clock in practice (both machines keep time in sync), so comparing them is harmless, but they are not guaranteed to be.
  const { error } = await admin.rpc('monitor_request_check')
  if (error) return fail(error)
  await auditAccess(admin, { orgId: actor.orgId, actorId: actor.id, action: 'check_requested', capability: 'it.monitoring.operate' })
  return { ok: true }
}
