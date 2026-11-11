import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { fetchAll } from '@/lib/supabase/fetch-all'

// Final fix X (release 1 review C I-4; rulings NB-3, NB-4): the monitoring rollout and the NVR login problems, for administrators.
//
// - setMonitoringRollout: switches monitoring on or off for every NVR of the organisation, a region, a cluster or a location in one
//   step (recorder_set_monitoring_bulk: each NVR through recorder_set_monitoring, audited, plus one summary row). A switched-off NVR
//   is contacted by nothing (worker, discovery, live, playback). The pilot procedure (docs/drishti/runbooks/monitoring-rollout.md):
//   everything off before the first start, then one location, then its cluster, then the rest by region.
// - tryNvrLoginAgain: an administrator ends the login back-off of one NVR after fixing its password on the NVR itself (nvr_login_try_again;
//   the 3-refusals-in-30-minutes pause still holds).
// - loadNvrLoginProblems / loadRolloutOverview: what the Monitoring screens show (service role, scoped to the person's organisation,
//   after the caller's own check).

export type RolloutScope = 'organization' | 'region' | 'cluster' | 'location'
export const ROLLOUT_SCOPES: readonly RolloutScope[] = ['organization', 'region', 'cluster', 'location']
export const MSG_ROLLOUT_NOT_FOUND = 'That region, cluster or location was not found.'
export const MSG_ROLLOUT_REASON = 'Give a reason (at least three characters).'
export const MSG_NVR_NOT_FOUND = 'NVR not found.'

export async function setMonitoringRollout(
  clients: InventoryClients, actor: Actor, input: { scope: string; scopeId?: string | null; enabled: boolean; reason: string },
): Promise<Result<{ matched: number; changed: number }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const scope = ROLLOUT_SCOPES.includes(input?.scope as RolloutScope) ? (input.scope as RolloutScope) : null
  if (!scope) return { ok: false, error: 'Choose the organisation, a region, a cluster or a location.' }
  const id = scope === 'organization' ? null : cleanId(input?.scopeId)
  if (scope !== 'organization' && !id) return { ok: false, error: MSG_ROLLOUT_NOT_FOUND }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 3 || reason.length > 500) return { ok: false, error: MSG_ROLLOUT_REASON }
  const { data, error } = await clients.admin.rpc('recorder_set_monitoring_bulk', {
    p_org: actor.orgId, p_scope: scope, p_scope_id: id as string, p_enabled: input.enabled === true, p_reason: reason, p_actor: actor.id,
  })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: MSG_ROLLOUT_NOT_FOUND }
    if (error.code === '42501') return { ok: false, error: 'Only a super administrator, or an administrator with inventory rights for the whole organisation, may do this.' }
    return { ok: false, error: sanitizeError(error, { route: 'setMonitoringRollout', fallback: 'Could not change the monitoring.' }) }
  }
  const r = data as { matched: number; changed: number }
  return { ok: true, matched: r.matched, changed: r.changed }
}

export async function tryNvrLoginAgain(clients: InventoryClients, actor: Actor, recorderId: string): Promise<Result<object>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(recorderId)
  if (!id) return { ok: false, error: MSG_NVR_NOT_FOUND }
  const { error } = await clients.admin.rpc('nvr_login_try_again', { p_org: actor.orgId, p_recorder: id, p_actor: actor.id })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: MSG_NVR_NOT_FOUND }
    if (error.code === '42501') return { ok: false, error: 'Only a super administrator, or an administrator with inventory rights for the whole organisation, may do this.' }
    return { ok: false, error: sanitizeError(error, { route: 'tryNvrLoginAgain', fallback: 'Could not end the wait for this NVR.' }) }
  }
  return { ok: true }
}

export type NvrLoginProblem = {
  recorderId: string; nvrName: string; locationId: string; locationCode: string; locationName: string
  /** refused: in its window; paused: 3 refusals in 30 minutes; waiting: its window is over, the next check tries once. */
  state: 'refused' | 'paused' | 'waiting'
  until: string | null; level: number; lastRefusedAt: string | null; lastPath: string | null
}

type LoginRow = { recorder_id: string; outcome: string | null; level: number; refused_until: string | null; last_refused_at: string | null; last_refused_path: string | null; refusals: string[] }

/** NVRs of the organisation whose current login stands refused (or that are paused), newest refusal first. */
export async function loadNvrLoginProblems(admin: AdminClient, orgId: string, now: Date = new Date()): Promise<NvrLoginProblem[]> {
  const rows = (await fetchAll((from, to) =>
    admin.from('nvr_login_state').select('recorder_id, outcome, level, refused_until, last_refused_at, last_refused_path, refusals')
      .eq('org_id', orgId).not('last_refused_at', 'is', null).order('recorder_id').range(from, to),
  )) as unknown as LoginRow[]
  const windowStart = now.getTime() - 1_800_000
  const flagged = rows.filter((r) => r.outcome === 'refused' || r.refusals.filter((t) => Date.parse(t) > windowStart).length >= 3)
  if (flagged.length === 0) return []
  const recs = await fetchAll((from, to) =>
    admin.from('recorders').select('id, location_id, assets!recorders_asset_fk!inner(name, archived_at), locations!recorders_location_fk!inner(code, name, archived_at)')
      .eq('org_id', orgId).in('id', flagged.map((r) => r.recorder_id)).is('assets.archived_at', null).order('id').range(from, to),
  )
  const byId = new Map((recs as unknown as { id: string; location_id: string; assets: { name: string }; locations: { code: string; name: string } }[]).map((r) => [r.id, r]))
  return flagged
    .filter((r) => byId.has(r.recorder_id))
    .map((r): NvrLoginProblem => {
      const rec = byId.get(r.recorder_id)!
      const recent = r.refusals.map((t) => Date.parse(t)).filter((t) => t > windowStart).sort((a, b) => a - b)
      const paused = recent.length >= 3
      const inWindow = r.refused_until !== null && Date.parse(r.refused_until) > now.getTime()
      return {
        recorderId: r.recorder_id, nvrName: rec.assets.name, locationId: rec.location_id, locationCode: rec.locations.code, locationName: rec.locations.name,
        state: paused ? 'paused' : inWindow ? 'refused' : 'waiting',
        until: paused ? new Date(recent[recent.length - 3] + 1_800_000).toISOString() : inWindow ? r.refused_until : null,
        level: r.level, lastRefusedAt: r.last_refused_at, lastPath: r.last_refused_path,
      }
    })
    .sort((a, b) => (b.lastRefusedAt ?? '').localeCompare(a.lastRefusedAt ?? ''))
}

export type RolloutNode = { id: string; code: string; name: string; on: number; off: number }
export type RolloutOverview = {
  totals: { on: number; off: number }
  regions: RolloutNode[]; clusters: (RolloutNode & { regionId: string | null })[]; locations: (RolloutNode & { clusterId: string | null })[]
}

/** How many NVRs are monitored (on) or switched off, per region, cluster and location of the organisation (live ones only). */
export async function loadRolloutOverview(admin: AdminClient, orgId: string): Promise<RolloutOverview> {
  const [regions, clusters, locations, recorders] = await Promise.all([
    fetchAll((from, to) => admin.from('regions').select('id, code, name').eq('org_id', orgId).is('archived_at', null).order('code').range(from, to)),
    fetchAll((from, to) => admin.from('clusters').select('id, code, name, region_id').eq('org_id', orgId).is('archived_at', null).order('code').range(from, to)),
    fetchAll((from, to) => admin.from('locations').select('id, code, name, cluster_id').eq('org_id', orgId).is('archived_at', null).order('code').range(from, to)),
    fetchAll((from, to) => admin.from('recorders').select('id, location_id, monitoring_enabled, assets!recorders_asset_fk!inner(archived_at)').eq('org_id', orgId).is('assets.archived_at', null).order('id').range(from, to)),
  ])
  const perLocation = new Map<string, { on: number; off: number }>()
  for (const r of recorders as unknown as { location_id: string; monitoring_enabled: boolean }[]) {
    const c = perLocation.get(r.location_id) ?? { on: 0, off: 0 }
    if (r.monitoring_enabled) c.on++
    else c.off++
    perLocation.set(r.location_id, c)
  }
  const locs = locations.map((l) => ({ id: l.id, code: l.code, name: l.name, clusterId: l.cluster_id, ...(perLocation.get(l.id) ?? { on: 0, off: 0 }) }))
  const sum = (list: { on: number; off: number }[]) => list.reduce((t, x) => ({ on: t.on + x.on, off: t.off + x.off }), { on: 0, off: 0 })
  const cls = clusters.map((c) => ({ id: c.id, code: c.code, name: c.name, regionId: c.region_id, ...sum(locs.filter((l) => l.clusterId === c.id)) }))
  const regs = regions.map((g) => ({ id: g.id, code: g.code, name: g.name, ...sum(cls.filter((c) => c.regionId === g.id)) }))
  return { totals: sum(locs), regions: regs, clusters: cls, locations: locs }
}
