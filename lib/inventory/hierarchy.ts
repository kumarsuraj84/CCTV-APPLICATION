import { addAudit } from '@/lib/admin/audit'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { normaliseCode } from '@/lib/inventory/forms'
import { sanitizeError } from '@/lib/observability/sanitize-error'

// Regions and clusters (P2-5c-1 brief items 1 and 7; ruling C-1: Organization → Region → Cluster → Location → NVR → Camera, a strict
// tree; region and cluster OPTIONAL forever — "No cluster" / "No region" are real choices, never an "Unassigned" bucket).
// Moving a location between clusters or a cluster between regions changes access AT ONCE for everybody holding a cluster or region
// grant (the scopes expand when access is evaluated). The preview (preview_hierarchy_change) shows who gains and who loses what
// before the move; the move (inventory_move_location / inventory_move_cluster) bumps the access version of the affected people — the
// signal the session registry of P2-4 uses to re-check open video (P2-4 is not built yet) — and is audited with them.

export const MSG_CODE = 'Enter a code: letters, numbers and dashes, up to 50.'
const MSG_NAME = 'Enter a name (up to 200 characters).'
const duplicate = (what: 'region' | 'cluster') => `That code is already used by another ${what}.`

function cleanName(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : ''
  return t.length >= 1 && t.length <= 200 ? t : null
}

/** Creates a region, or renames one (its code and name; the id, grants and history stay). */
export async function saveRegion(clients: InventoryClients, actor: Actor, input: { id?: string | null; code: string; name: string }): Promise<Result<{ id: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const code = normaliseCode(input?.code)
  if (!code) return { ok: false, error: MSG_CODE }
  const name = cleanName(input?.name)
  if (!name) return { ok: false, error: MSG_NAME }
  const id = input?.id ? cleanId(input.id) : null
  if (input?.id && !id) return { ok: false, error: 'Region not found.' }
  const q = id
    ? clients.admin.from('regions').update({ code, name }).eq('id', id).eq('org_id', actor.orgId).is('archived_at', null).select('id')
    : clients.admin.from('regions').insert({ org_id: actor.orgId, code, name }).select('id')
  const { data, error } = await q
  if (error?.code === '23505') return { ok: false, error: duplicate('region') }
  if (error) return { ok: false, error: sanitizeError(error, { route: 'saveRegion', fallback: 'Could not save the region.' }) }
  if (!data?.length) return { ok: false, error: 'Region not found.' }
  await addAudit(clients.admin, { orgId: actor.orgId, actorId: actor.id, action: id ? 'region_updated' : 'region_created', entityType: 'region', entityId: data[0].id, detail: { code, name } })
  return { ok: true, id: data[0].id }
}

/**
 * Creates a cluster (optionally in a region), or renames one. Moving an EXISTING cluster to another region goes through moveNode, so
 * the administrator sees the effect on access first; a new cluster has no locations yet, so its region can be set directly.
 */
export async function saveCluster(clients: InventoryClients, actor: Actor, input: { id?: string | null; code: string; name: string; regionId?: string | null }): Promise<Result<{ id: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const code = normaliseCode(input?.code)
  if (!code) return { ok: false, error: MSG_CODE }
  const name = cleanName(input?.name)
  if (!name) return { ok: false, error: MSG_NAME }
  const id = input?.id ? cleanId(input.id) : null
  if (input?.id && !id) return { ok: false, error: 'Cluster not found.' }
  let regionId: string | null = null
  if (!id && input?.regionId) {
    regionId = cleanId(input.regionId)
    const { data: region } = regionId
      ? await clients.admin.from('regions').select('id').eq('id', regionId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
      : { data: null }
    if (!region) return { ok: false, error: 'Region not found.' }
  }
  const q = id
    ? clients.admin.from('clusters').update({ code, name }).eq('id', id).eq('org_id', actor.orgId).is('archived_at', null).select('id')
    : clients.admin.from('clusters').insert({ org_id: actor.orgId, code, name, region_id: regionId }).select('id')
  const { data, error } = await q
  if (error?.code === '23505') return { ok: false, error: duplicate('cluster') }
  if (error) return { ok: false, error: sanitizeError(error, { route: 'saveCluster', fallback: 'Could not save the cluster.' }) }
  if (!data?.length) return { ok: false, error: 'Cluster not found.' }
  await addAudit(clients.admin, { orgId: actor.orgId, actorId: actor.id, action: id ? 'cluster_updated' : 'cluster_created', entityType: 'cluster', entityId: data[0].id, detail: { code, name, region_id: regionId } })
  return { ok: true, id: data[0].id }
}

export type MoveInput = { kind: 'location' | 'cluster'; id: string; to: string | null }
export type MovePreview = {
  /** Locations the move concerns (one for a location; the cluster's locations for a cluster). */
  locations: number
  affected: number
  /** Per person and CCTV right: cameras of the moved locations they see now and would see after the move. */
  people: { userId: string; name: string; capability: string; before: number; after: number }[]
}

const notFound = (kind: MoveInput['kind']) => (kind === 'location' ? 'Location not found.' : 'Cluster not found.')
const targetNotFound = (kind: MoveInput['kind']) => (kind === 'location' ? 'Cluster not found.' : 'Region not found.')

/** Checks the node and its new parent (or none) belong to the organisation and are not archived. */
async function checkMove(admin: AdminClient, actor: Actor, input: MoveInput): Promise<Result<{ id: string; to: string | null }>> {
  if (input?.kind !== 'location' && input?.kind !== 'cluster') return { ok: false, error: 'Not found.' }
  const id = cleanId(input.id)
  if (!id) return { ok: false, error: notFound(input.kind) }
  const table = input.kind === 'location' ? 'locations' : 'clusters'
  const { data: node } = await admin.from(table).select('id').eq('id', id).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle()
  if (!node) return { ok: false, error: notFound(input.kind) }
  let to: string | null = null
  if (input.to) {
    to = cleanId(input.to)
    const parent = input.kind === 'location' ? 'clusters' : 'regions'
    const { data: target } = to ? await admin.from(parent).select('id').eq('id', to).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle() : { data: null }
    if (!target) return { ok: false, error: targetNotFound(input.kind) }
  }
  return { ok: true, id, to }
}

/** Who would gain or lose which cameras if this location / cluster moved (writes nothing). */
export async function previewMove(clients: InventoryClients, actor: Actor, input: MoveInput): Promise<Result<MovePreview>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const checked = await checkMove(clients.admin, actor, input)
  if (!checked.ok) return checked
  const { data, error } = await clients.admin.rpc('preview_hierarchy_change', { p_org: actor.orgId, p_kind: input.kind, p_id: checked.id, p_new_parent: checked.to as string })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'previewMove', fallback: 'Could not work out the effect on access.' }) }
  const out = data as { people: { user_id: string; capability: string; before: number; after: number }[]; affected_count: number; locations: number }
  const ids = [...new Set((out.people ?? []).map((p) => p.user_id))]
  const { data: people } = ids.length ? await clients.admin.from('profiles').select('id, full_name, email').eq('org_id', actor.orgId).in('id', ids) : { data: [] }
  const name = new Map((people ?? []).map((p) => [p.id, p.full_name || p.email]))
  return {
    ok: true, locations: Number(out.locations), affected: Number(out.affected_count),
    people: (out.people ?? []).map((p) => ({ userId: p.user_id, name: name.get(p.user_id) ?? 'Unknown person', capability: p.capability, before: Number(p.before), after: Number(p.after) })),
  }
}

/** Moves a location to another cluster (or none), or a cluster to another region (or none). Takes effect at once; audited. */
export async function moveNode(clients: InventoryClients, actor: Actor, input: MoveInput): Promise<Result<{ from: string | null; to: string | null }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const checked = await checkMove(clients.admin, actor, input)
  if (!checked.ok) return checked
  const { data, error } = input.kind === 'location'
    ? await clients.admin.rpc('inventory_move_location', { p_org: actor.orgId, p_location: checked.id, p_cluster: checked.to as string, p_actor: actor.id })
    : await clients.admin.rpc('inventory_move_cluster', { p_org: actor.orgId, p_cluster: checked.id, p_region: checked.to as string, p_actor: actor.id })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: /cluster not found|region not found/.test(error.message) ? targetNotFound(input.kind) : notFound(input.kind) }
    return { ok: false, error: sanitizeError(error, { route: 'moveNode', fallback: 'Could not move it.' }) }
  }
  const r = data as { from: string | null; to: string | null }
  return { ok: true, from: r.from ?? null, to: r.to ?? null }
}

export type ProposalRow = {
  locationId: string; code: string; zone: string | null; state: string | null
  proposedClusterCode: string | null; proposedRegionCode: string | null; existingClusterId: string | null; existingRegionId: string | null
}

/**
 * Zone → cluster, state → region proposals for the locations that have no cluster yet (inventory_propose_hierarchy). Nothing is
 * applied here: the administrator confirms row by row (applyProposals).
 */
export async function hierarchyProposals(clients: InventoryClients, actor: Actor): Promise<Result<{ rows: ProposalRow[] }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const { data, error } = await clients.admin.rpc('inventory_propose_hierarchy', { p_org: actor.orgId })
  if (error) return { ok: false, error: sanitizeError(error, { route: 'hierarchyProposals', fallback: 'Could not read the proposals.' }) }
  return {
    ok: true,
    rows: (data ?? []).map((r) => ({
      locationId: r.location_id, code: r.code, zone: r.zone, state: r.state, proposedClusterCode: r.proposed_cluster_code, proposedRegionCode: r.proposed_region_code,
      existingClusterId: r.existing_cluster_id, existingRegionId: r.existing_region_id,
    })),
  }
}

export type ProposalChoice = { locationId: string; clusterCode: string | null; regionCode: string | null }

/**
 * Applies the rows the administrator ticked (after previewProposals): the region (by code) and the cluster (by code; a new one in the
 * proposed region) are found or created, and the location is moved into the cluster with the same effects as any move (immediate,
 * access versions, audit) — all in one database transaction (inventory_apply_proposals). Untouched rows stay.
 */
export async function applyProposals(clients: InventoryClients, actor: Actor, items: ProposalChoice[]): Promise<Result<{ moved: number; regionsCreated: number; clustersCreated: number }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const parsed = cleanChoices(items)
  if (!parsed.ok) return parsed
  const { clean } = parsed
  const admin = clients.admin
  // Review M-1: one transaction in the database (all or nothing), with the same effects as any move.
  const { data, error } = await admin.rpc('inventory_apply_proposals', {
    p_org: actor.orgId, p_items: clean.map((c) => ({ location_id: c.locationId, cluster_code: c.cluster, region_code: c.region })), p_actor: actor.id,
  })
  if (error) {
    if (error.code === 'P0002') return { ok: false, error: 'Location not found.' }
    return { ok: false, error: sanitizeError(error, { route: 'applyProposals', fallback: 'Could not apply the proposals. Nothing was changed.' }) }
  }
  const r = data as { moved: number; regions_created: number; clusters_created: number }
  return { ok: true, moved: Number(r.moved), regionsCreated: Number(r.regions_created), clustersCreated: Number(r.clusters_created) }
}

export type ProposalPreview = {
  /** People whose CCTV access changes, per person and right: cameras of the ticked locations now → after. */
  affected: number
  people: MovePreview['people']
  newClusters: string[]
  newRegions: string[]
  /** An existing cluster sits in another region than the one proposed: it keeps its own region (nothing is moved between regions). */
  regionMismatches: { clusterCode: string; proposedRegion: string | null; actualRegion: string | null }[]
}

/**
 * Before applying ticked proposals (review M-1): who gains or loses which cameras (existing clusters: preview_hierarchy_change; a new
 * cluster in an existing region: that region's CCTV grant holders gain the location), which clusters and regions would be created, and
 * where an existing cluster is in another region than proposed. Writes nothing.
 */
export async function previewProposals(clients: InventoryClients, actor: Actor, items: ProposalChoice[]): Promise<Result<ProposalPreview>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const parsed = cleanChoices(items)
  if (!parsed.ok) return parsed
  const admin = clients.admin
  const ids = parsed.clean.map((c) => c.locationId)
  const { data: locs } = await admin.from('locations').select('id').eq('org_id', actor.orgId).is('archived_at', null).in('id', ids)
  if ((locs ?? []).length !== new Set(ids).size) return { ok: false, error: 'Location not found.' }
  const [{ data: clusters }, { data: regions }] = await Promise.all([
    admin.from('clusters').select('id, code, region_id').eq('org_id', actor.orgId).is('archived_at', null),
    admin.from('regions').select('id, code').eq('org_id', actor.orgId).is('archived_at', null),
  ])
  const clusterByCode = new Map((clusters ?? []).map((c) => [c.code, c]))
  const regionByCode = new Map((regions ?? []).map((r) => [r.code, r]))
  const regionCode = new Map((regions ?? []).map((r) => [r.id, r.code]))
  const totals = new Map<string, { userId: string; capability: string; before: number; after: number }>()
  const add = (userId: string, capability: string, before: number, after: number) => {
    const k = `${userId}|${capability}`
    const t = totals.get(k) ?? { userId, capability, before: 0, after: 0 }
    t.before += before
    t.after += after
    totals.set(k, t)
  }
  const newClusters = new Set<string>()
  const newRegions = new Set<string>()
  const mismatches = new Map<string, ProposalPreview['regionMismatches'][number]>()
  for (const c of parsed.clean) {
    const existing = clusterByCode.get(c.cluster)
    if (c.region && !regionByCode.has(c.region)) newRegions.add(c.region)
    if (existing) {
      const actual = existing.region_id ? regionCode.get(existing.region_id) ?? null : null
      if (c.region && actual !== c.region) mismatches.set(c.cluster, { clusterCode: c.cluster, proposedRegion: c.region, actualRegion: actual })
      const { data, error } = await admin.rpc('preview_hierarchy_change', { p_org: actor.orgId, p_kind: 'location', p_id: c.locationId, p_new_parent: existing.id })
      if (error) return { ok: false, error: sanitizeError(error, { route: 'previewProposals', fallback: 'Could not work out the effect on access.' }) }
      for (const p of (data as { people: { user_id: string; capability: string; before: number; after: number }[] }).people ?? []) add(p.user_id, p.capability, Number(p.before), Number(p.after))
      continue
    }
    newClusters.add(c.cluster)
    const region = c.region ? regionByCode.get(c.region) : undefined
    if (!region) continue
    // A new cluster in an existing region: that region's CCTV grant holders gain the whole location.
    const { data: holders } = await admin.from('access_grants').select('user_id, capability').eq('org_id', actor.orgId).eq('scope_kind', 'region').eq('scope_id', region.id)
      .in('capability', ['cctv.live', 'cctv.playback', 'cctv.export']).is('revoked_at', null)
    const { data: cams } = await admin.from('cameras').select('id').eq('org_id', actor.orgId).eq('location_id', c.locationId).is('archived_at', null)
    const camIds = new Set((cams ?? []).map((x) => x.id))
    for (const h of new Map((holders ?? []).map((x) => [`${x.user_id}|${x.capability}`, x])).values()) {
      const { data: seen } = await admin.rpc('report_effective_camera_ids', { p_user: h.user_id, p_cap: h.capability })
      const before = ((seen as string[] | null) ?? []).filter((id) => camIds.has(id)).length
      add(h.user_id, h.capability, before, camIds.size)
    }
  }
  const people = [...totals.values()].filter((t) => t.before !== t.after)
  const { data: names } = people.length ? await admin.from('profiles').select('id, full_name, email').eq('org_id', actor.orgId).in('id', [...new Set(people.map((p) => p.userId))]) : { data: [] }
  const name = new Map((names ?? []).map((p) => [p.id, p.full_name || p.email]))
  return {
    ok: true, affected: new Set(people.map((p) => p.userId)).size,
    people: people.map((p) => ({ userId: p.userId, name: name.get(p.userId) ?? 'Unknown person', capability: p.capability, before: p.before, after: p.after })),
    newClusters: [...newClusters], newRegions: [...newRegions], regionMismatches: [...mismatches.values()],
  }
}

function cleanChoices(items: ProposalChoice[]): { ok: true; clean: { locationId: string; cluster: string; region: string | null }[] } | { ok: false; error: string } {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'Tick at least one location to apply.' }
  if (items.length > 1000) return { ok: false, error: 'Apply at most 1000 locations at a time.' }
  const clean: { locationId: string; cluster: string; region: string | null }[] = []
  for (const i of items) {
    const locationId = cleanId(i?.locationId)
    const cluster = normaliseCode(i?.clusterCode)
    const region = i?.regionCode ? normaliseCode(i.regionCode) : null
    if (!locationId) return { ok: false, error: 'Location not found.' }
    if (!cluster || (i?.regionCode && !region)) return { ok: false, error: MSG_CODE }
    clean.push({ locationId, cluster, region })
  }
  return { ok: true, clean }
}
