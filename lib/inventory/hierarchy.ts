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
 * Applies the rows the administrator ticked: the region (by code) and the cluster (by code, in that region) are found or created, and
 * the location is moved into the cluster with the same effects as any move (immediate, access versions, audit). Untouched rows stay.
 */
export async function applyProposals(clients: InventoryClients, actor: Actor, items: ProposalChoice[]): Promise<Result<{ moved: number; regionsCreated: number; clustersCreated: number }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'Tick at least one location to apply.' }
  if (items.length > 1000) return { ok: false, error: 'Apply at most 1000 locations at a time.' }
  const admin = clients.admin
  const clean: { locationId: string; cluster: string; region: string | null }[] = []
  for (const i of items) {
    const locationId = cleanId(i?.locationId)
    const cluster = normaliseCode(i?.clusterCode)
    const region = i?.regionCode ? normaliseCode(i.regionCode) : null
    if (!locationId) return { ok: false, error: 'Location not found.' }
    if (!cluster || (i?.regionCode && !region)) return { ok: false, error: MSG_CODE }
    clean.push({ locationId, cluster, region })
  }
  const ids = clean.map((c) => c.locationId)
  const { data: locs, error: locErr } = await admin.from('locations').select('id').eq('org_id', actor.orgId).is('archived_at', null).in('id', ids)
  if (locErr) return { ok: false, error: sanitizeError(locErr, { route: 'applyProposals', fallback: 'Could not read the locations.' }) }
  if ((locs ?? []).length !== new Set(ids).size) return { ok: false, error: 'Location not found.' }
  let regionsCreated = 0
  let clustersCreated = 0
  const regionIds = new Map<string, string>()
  const clusterIds = new Map<string, string>()
  try {
    for (const code of [...new Set(clean.map((c) => c.region).filter((x): x is string => !!x))]) {
      const { data: found } = await admin.from('regions').select('id').eq('org_id', actor.orgId).eq('code', code).is('archived_at', null).maybeSingle()
      if (found) regionIds.set(code, found.id)
      else {
        const { data, error } = await admin.from('regions').insert({ org_id: actor.orgId, code, name: code }).select('id').single()
        if (error || !data) throw error ?? new Error('region not saved')
        regionIds.set(code, data.id)
        regionsCreated++
      }
    }
    for (const c of clean) {
      if (clusterIds.has(c.cluster)) continue
      const { data: found } = await admin.from('clusters').select('id').eq('org_id', actor.orgId).eq('code', c.cluster).is('archived_at', null).maybeSingle()
      if (found) clusterIds.set(c.cluster, found.id)
      else {
        const { data, error } = await admin.from('clusters').insert({ org_id: actor.orgId, code: c.cluster, name: c.cluster, region_id: c.region ? regionIds.get(c.region)! : null }).select('id').single()
        if (error || !data) throw error ?? new Error('cluster not saved')
        clusterIds.set(c.cluster, data.id)
        clustersCreated++
      }
    }
    for (const c of clean) {
      const { error } = await admin.rpc('inventory_move_location', { p_org: actor.orgId, p_location: c.locationId, p_cluster: clusterIds.get(c.cluster)!, p_actor: actor.id })
      if (error) throw error
    }
  } catch (e) {
    return { ok: false, error: sanitizeError(e, { route: 'applyProposals', fallback: 'Could not apply all of the proposals. Reload the page to see what was applied.' }) }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'hierarchy_proposals_applied', entityType: 'organization', entityId: actor.orgId, detail: { moved: clean.length, regions_created: regionsCreated, clusters_created: clustersCreated } })
  return { ok: true, moved: clean.length, regionsCreated, clustersCreated }
}
