import { addAudit } from '@/lib/admin/audit'
import type { Actor, Result } from '@/lib/admin/types'
import { normalizeZone } from '@/lib/import/regions'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import { isCidr, isIp, isLocationKind, normaliseCode, optionalText, parseList, parseVlan, type LocationKind } from '@/lib/inventory/forms'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import type { Json } from '@/types/database'

// Locations of any kind (P2-5c-1 brief item 1): store, head office, distribution centre, warehouse, other. A location has a stable
// CODE (e.g. JCL, unique among the organisation's non-archived locations) and an editable display name ("CODE - City" to start with);
// renaming keeps the id, grants, groups and history. Cluster and region are optional for ever (owner amendment to R-1). A location may
// have no NVR at all (a head office); its NVRs are managed per recorder (lib/inventory/recorder-admin.ts). Moving a location to another
// cluster goes through lib/inventory/hierarchy.ts (with its effect on access shown first); archiving through lib/inventory/archive.ts.

export const MSG_LOCATION_NOT_FOUND = 'Location not found.'

export type LocationInput = {
  id?: string | null; code?: string; kind: string; name: string; city?: string | null; address?: string | null; zone?: string | null; state?: string | null
  /** Only when the location is created (a later change is a move with its preview). */
  clusterId?: string | null
  isActive?: boolean
}

export async function saveLocation(clients: InventoryClients, actor: Actor, input: LocationInput): Promise<Result<{ locationId: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  if (!isLocationKind(input?.kind)) return { ok: false, error: 'Choose what kind of location this is.' }
  const kind: LocationKind = input.kind
  const name = optionalText(input?.name, 200)
  if (!name) return { ok: false, error: 'Enter the display name (up to 200 characters).' }
  const city = optionalText(input?.city, 200)
  const address = optionalText(input?.address, 500)
  const zone = optionalText(input?.zone, 200)
  const state = optionalText(input?.state, 200)
  if (city === undefined || address === undefined || zone === undefined || state === undefined) return { ok: false, error: 'One of the fields is too long.' }
  const fields = { kind, name, city, address, zone: normalizeZone(zone ?? ''), state: normalizeZone(state ?? ''), is_active: input?.isActive ?? true }
  const admin = clients.admin
  if (input?.id) {
    const id = cleanId(input.id)
    if (!id) return { ok: false, error: MSG_LOCATION_NOT_FOUND }
    const { data, error } = await admin.from('locations').update(fields).eq('id', id).eq('org_id', actor.orgId).is('archived_at', null).select('id')
    if (error) return { ok: false, error: sanitizeError(error, { route: 'saveLocation', fallback: 'Could not save the location.' }) }
    if (!data?.length) return { ok: false, error: MSG_LOCATION_NOT_FOUND }
    await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'location_updated', entityType: 'location', entityId: id, detail: { kind, name } })
    return { ok: true, locationId: id }
  }
  const code = normaliseCode(input?.code)
  if (!code) return { ok: false, error: 'Enter the location code: letters, numbers and dashes, up to 50 (for example JCL).' }
  let clusterId: string | null = null
  if (input?.clusterId) {
    clusterId = cleanId(input.clusterId)
    const { data: cluster } = clusterId ? await admin.from('clusters').select('id').eq('id', clusterId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle() : { data: null }
    if (!cluster) return { ok: false, error: 'Cluster not found.' }
  }
  const { data, error } = await admin.from('locations').insert({ org_id: actor.orgId, code, cluster_id: clusterId, ...fields }).select('id').single()
  if (error?.code === '23505') return { ok: false, error: 'That code is already used by another location.' }
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'saveLocation', fallback: 'Could not save the location.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'location_created', entityType: 'location', entityId: data.id, detail: { code, kind, cluster_id: clusterId } })
  return { ok: true, locationId: data.id }
}

export type NetworkInput = {
  managementCidr: string; gateway?: string; dns?: string; managementVlan?: string; vlanStaff?: string; vlanGuest?: string; vlanDevice?: string; vlanOther?: string
  discoveryRanges?: string; sdwanContext?: string
}

const MSG_CIDR = 'Enter the management network like 192.168.10.0/24.'

/**
 * Saves a location's network definition (management network, gateway, DNS, management VLAN, VLANs for staff / guest / devices / other,
 * discovery ranges inside the management network, SD-WAN notes). An empty management network removes the definition. The database
 * checks it again (network_definitions_check); its refusals are put in plain words.
 */
export async function saveNetworkDefinition(clients: InventoryClients, actor: Actor, locationId: string, input: NetworkInput): Promise<Result<{ removed?: true }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(locationId)
  const admin = clients.admin
  const { data: loc } = id ? await admin.from('locations').select('id').eq('id', id).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle() : { data: null }
  if (!loc || !id) return { ok: false, error: MSG_LOCATION_NOT_FOUND }
  const cidr = String(input?.managementCidr ?? '').trim()
  if (cidr === '') {
    const { error } = await admin.from('network_definitions').delete().eq('location_id', id).eq('org_id', actor.orgId)
    if (error) return { ok: false, error: sanitizeError(error, { route: 'saveNetworkDefinition', fallback: 'Could not remove the network definition.' }) }
    await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'network_definition_removed', entityType: 'location', entityId: id })
    return { ok: true, removed: true }
  }
  if (!isCidr(cidr)) return { ok: false, error: MSG_CIDR }
  const gateway = String(input?.gateway ?? '').trim() || null
  if (gateway && !isIp(gateway)) return { ok: false, error: 'Enter the gateway as an IP address.' }
  const dns = parseList(input?.dns)
  if (dns.some((d) => !isIp(d))) return { ok: false, error: 'Enter the DNS servers as IP addresses, separated by commas.' }
  const ranges = parseList(input?.discoveryRanges)
  if (ranges.some((r) => !isCidr(r))) return { ok: false, error: 'Enter each discovery range like 192.168.10.0/25.' }
  const vlans: Record<string, number> = {}
  let managementVlan: number | null = null
  for (const [key, raw] of [['management', input?.managementVlan], ['staff', input?.vlanStaff], ['guest', input?.vlanGuest], ['device', input?.vlanDevice], ['other', input?.vlanOther]] as const) {
    const v = parseVlan(raw)
    if (!v.ok) return { ok: false, error: v.error }
    if (v.value === null) continue
    if (key === 'management') managementVlan = v.value
    else vlans[key] = v.value
  }
  const sdwan = optionalText(input?.sdwanContext, 1000)
  if (sdwan === undefined) return { ok: false, error: 'Use 1000 characters or fewer for the SD-WAN notes.' }
  const row = {
    org_id: actor.orgId, location_id: id, management_cidr: cidr, gateway, dns, management_vlan: managementVlan, vlan_map: vlans as { [key: string]: Json },
    discovery_ranges: ranges, sdwan_context: sdwan,
  }
  const { error } = await admin.from('network_definitions').upsert(row, { onConflict: 'location_id' })
  if (error) {
    if (error.code === '22023' && /discovery range/.test(error.message)) return { ok: false, error: 'Every discovery range must be inside the management network.' }
    if (error.code === '22023' && /VLAN/i.test(error.message)) return { ok: false, error: 'VLAN numbers are whole numbers from 1 to 4094.' }
    if (error.code === '23514' && /gateway/.test(error.message)) return { ok: false, error: 'The gateway must be inside the management network.' }
    if (error.code === '22P02') return { ok: false, error: MSG_CIDR }
    return { ok: false, error: sanitizeError(error, { route: 'saveNetworkDefinition', fallback: 'Could not save the network definition.' }) }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'network_definition_saved', entityType: 'location', entityId: id, detail: { management_cidr: cidr } })
  return { ok: true }
}
