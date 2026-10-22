import { randomUUID } from 'node:crypto'
import { addAudit } from '@/lib/admin/audit'
import type { Actor, Result } from '@/lib/admin/types'
import { inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { discoverAllRecorders, type BulkDiscoveryItem } from '@/lib/monitor/discovery'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { processSingleton } from '@/lib/process-singleton'
import { fetchAll } from '@/lib/supabase/fetch-all'

// "Find cameras for all locations" (P2-5c-2 brief item 2). One run asks every NVR of the organisation for its channel list through the
// SHARED discovery core (lib/monitor/discovery.ts discoverAllRecorders → the same per-NVR discovery as the "Find cameras" button):
//   - read-only towards the NVRs (one ISAPI channel list per NVR, one attempt, never a write);
//   - at most DISCOVER_ALL_CONCURRENCY NVRs at a time (default 4, 1 to 8);
//   - switched-off NVRs and NVRs of switched-off locations are skipped without any contact or password read (re-review N-3);
//   - the web server's ONE login back-off applies (lib/monitor/login-backoff.ts, review I-3): an NVR that refused the login a short
//     while ago is not asked again; there is no second back-off here;
//   - identities follow the discovery rules (I-1/I-2/I-3, N-1/N-2): a camera never gets a second identity; what cannot be placed goes
//     to the reconciliation list (discovery_findings) for a person.
// The run happens after the button's answer (the Server Action hands it to Next's `after`). Its progress lives in this web process
// (one table per process, like the login back-off): a restart forgets the progress view, never the results (each NVR's discovery is
// saved in its own transaction as it finishes). One run at a time per organisation.

export const MSG_RUN_ACTIVE = 'Cameras are already being looked for on all NVRs. Wait until that search has finished.'
export const MSG_RUN_NOT_FOUND = 'That search was not found (the server may have restarted). Start a new one.'

/** How many NVRs are asked at once: DISCOVER_ALL_CONCURRENCY, default 4, at least 1 and at most 8. */
export function discoverAllConcurrency(env: Record<string, string | undefined> = process.env): number {
  const t = (env.DISCOVER_ALL_CONCURRENCY ?? '').trim()
  if (!/^\d+$/.test(t)) return 4
  return Math.min(8, Math.max(1, Number(t)))
}

export type RunItem = {
  recorderId: string; locationId: string; code: string; nvrName: string
  outcome: 'done' | 'failed' | 'skipped'
  /** The plain reason of a failure or a skip. */
  message: string | null
  cameras: number; created: number; updated: number; mapped: number; moved: number
  /** Items for the reconciliation list (renames are done and only reported). */
  toReconcile: number
}
export type RunSummary = { asked: number; done: number; failed: number; skipped: number; cameras: number; created: number; mapped: number; moved: number; toReconcile: number }
export type RunView = {
  id: string; startedAt: string; finishedAt: string | null; total: number; done: number; concurrency: number
  /** Filled when the run has finished. */
  items: RunItem[]
  summary: RunSummary
  error: string | null
}
type Run = RunView & { orgId: string; startedBy: string }

const EMPTY: RunSummary = { asked: 0, done: 0, failed: 0, skipped: 0, cameras: 0, created: 0, mapped: 0, moved: 0, toReconcile: 0 }
const runs = processSingleton('inventory.discoverAllRuns', () => new Map<string, Run>())
const KEEP_MS = 6 * 3600_000

function forget(now: number) {
  for (const [id, r] of runs) if (r.finishedAt && now - Date.parse(r.finishedAt) > KEEP_MS) runs.delete(id)
}

export function itemOf(i: BulkDiscoveryItem): RunItem {
  const base = { recorderId: i.recorderId, locationId: i.locationId, code: i.code, nvrName: i.name }
  if (i.ok) {
    const r = i.result
    return { ...base, outcome: 'done', message: null, cameras: r.cameras, created: r.created, updated: r.updated, mapped: r.mapped, moved: r.moved, toReconcile: r.reconciliation.filter((x) => x.kind !== 'renamed').length }
  }
  return { ...base, outcome: i.skipped ? 'skipped' : 'failed', message: i.error, cameras: 0, created: 0, updated: 0, mapped: 0, moved: 0, toReconcile: 0 }
}

export function summarise(items: readonly RunItem[]): RunSummary {
  const s = { ...EMPTY }
  for (const i of items) {
    if (i.outcome === 'skipped') s.skipped++
    else {
      s.asked++
      if (i.outcome === 'done') s.done++
      else s.failed++
    }
    s.cameras += i.cameras
    s.created += i.created
    s.mapped += i.mapped
    s.moved += i.moved
    s.toReconcile += i.toReconcile
  }
  return s
}

const view = (r: Run): RunView => ({
  id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, total: r.total, done: r.done, concurrency: r.concurrency, items: r.items.map((i) => ({ ...i })),
  summary: { ...r.summary }, error: r.error,
})

type Deps = {
  nvr?: Probes['nvr']
  go2rtc?: InventoryClients['go2rtc']
  concurrency?: number
  /** Where the run goes once the answer is sent (Next's `after` in the Server Action); default: started at once, not awaited. */
  schedule?: (work: () => Promise<unknown>) => void
}

/** Starts a run for the caller's organisation and returns at once with its id and the number of NVRs it will go through. */
export async function startDiscoverAll(clients: InventoryClients, actor: Actor, deps: Deps = {}): Promise<Result<{ runId: string; total: number }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  forget(Date.now())
  if ([...runs.values()].some((r) => r.orgId === actor.orgId && r.finishedAt === null)) return { ok: false, error: MSG_RUN_ACTIVE }
  const { count, error } = await clients.admin.from('recorders').select('id, assets!recorders_asset_fk!inner(archived_at), locations!recorders_location_fk!inner(archived_at)', { count: 'exact', head: true })
    .eq('org_id', actor.orgId).is('assets.archived_at', null).is('locations.archived_at', null)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'startDiscoverAll', fallback: 'Could not read the NVRs.' }) }
  const concurrency = Math.min(8, Math.max(1, Math.floor(deps.concurrency ?? discoverAllConcurrency())))
  const run: Run = {
    id: randomUUID(), orgId: actor.orgId, startedBy: actor.id, startedAt: new Date().toISOString(), finishedAt: null, total: count ?? 0, done: 0, concurrency,
    items: [], summary: { ...EMPTY }, error: null,
  }
  runs.set(run.id, run)
  await addAudit(clients.admin, { orgId: actor.orgId, actorId: actor.id, action: 'discover_all_started', entityType: 'organization', entityId: actor.orgId, detail: { recorders: run.total, concurrency } })
  const work = async () => {
    try {
      const r = await discoverAllRecorders(clients, actor, {
        concurrency,
        deps: { nvr: deps.nvr ?? realProbes.nvr, ...(deps.go2rtc ? { go2rtc: deps.go2rtc } : {}) },
        onProgress: (done, total) => {
          run.done = done
          run.total = total
        },
      })
      if (!r.ok) run.error = r.error
      else {
        run.items = r.items.map(itemOf)
        run.summary = summarise(run.items)
        run.total = run.items.length
        run.done = run.items.length
      }
    } catch (e) {
      run.error = sanitizeError(e, { route: 'discoverAll', fallback: 'The search stopped. What was found until then is saved.' })
    } finally {
      run.finishedAt = new Date().toISOString()
      await addAudit(clients.admin, { orgId: actor.orgId, actorId: actor.id, action: 'discover_all_finished', entityType: 'organization', entityId: actor.orgId, detail: { ...run.summary, failed_to_run: run.error !== null } })
        .catch((e) => sanitizeError(e, { route: 'discoverAll.audit' }))
    }
  }
  ;(deps.schedule ?? ((w) => void w()))(work)
  return { ok: true, runId: run.id, total: run.total }
}

/** The progress (and, once finished, the per-NVR results) of a run of the caller's organisation. */
export async function discoverAllStatus(clients: InventoryClients, actor: Actor, runId: string): Promise<Result<{ run: RunView }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const run = typeof runId === 'string' ? runs.get(runId) : undefined
  if (!run || run.orgId !== actor.orgId) return { ok: false, error: MSG_RUN_NOT_FOUND }
  return { ok: true, run: view(run) }
}

/**
 * What a run would go through (for the page, after requireAdministration): NVRs of live locations, how many are switched off, how many
 * are at a switched-off location. Service role, organisation-scoped.
 */
export async function discoverAllCounts(admin: InventoryClients['admin'], orgId: string): Promise<{ recorders: number; switchedOff: number; locationOff: number; concurrency: number }> {
  const data = await fetchAll((f, t) => admin.from('recorders')
    .select('id, monitoring_enabled, assets!recorders_asset_fk!inner(enabled, archived_at), locations!recorders_location_fk!inner(is_active, archived_at)')
    .eq('org_id', orgId).is('assets.archived_at', null).is('locations.archived_at', null).order('id').range(f, t))
  const rows = data as unknown as { monitoring_enabled: boolean; assets: { enabled: boolean }; locations: { is_active: boolean } }[]
  const off = (r: (typeof rows)[number]) => !r.monitoring_enabled || !r.assets.enabled
  return {
    recorders: rows.length,
    switchedOff: rows.filter(off).length,
    locationOff: rows.filter((r) => !off(r) && !r.locations.is_active).length,
    concurrency: discoverAllConcurrency(),
  }
}

/** The latest run of the caller's organisation (for the page after a reload), or null. The caller has passed requireAdministration. */
export function latestDiscoverAll(orgId: string): RunView | null {
  const mine = [...runs.values()].filter((r) => r.orgId === orgId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return mine[0] ? view(mine[0]) : null
}
