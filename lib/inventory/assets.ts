import { addAudit } from '@/lib/admin/audit'
import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { cleanId, inventoryAdmin, type InventoryClients } from '@/lib/inventory/admin-gate'
import {
  ASSET_TYPES, CRITICALITIES, DEPENDENCY_KINDS, ENDPOINT_PURPOSES, isHostOrIp, isIp, LIFECYCLE_STATES, optionalText, parseDay, parseWhole, type AssetType,
} from '@/lib/inventory/forms'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import type { Database } from '@/types/database'

// The asset inventory (P2-5c-1 brief item 4): IT assets with stable identity beyond their address — serial, MAC, vendor, model,
// firmware, role, owner, criticality, lifecycle, warranty, management mode — their parent dependencies (network / power / recording;
// a loop is refused, DR005) and their endpoints per address space (the management address follows the asset's own address; extra
// SNMP / other endpoints are added and retired here). NVRs are recorders and are changed on their location's NVR page. Archive and
// restore go through lib/inventory/archive.ts.

const MSG_ASSET_NOT_FOUND = 'Asset not found.'
const MSG_IS_NVR = 'This is an NVR. Change it on its location’s NVR page.'

export type AssetInput = {
  id?: string | null; name: string; type: string; locationId?: string | null; ip?: string | null; tcpPort?: string | number | null
  serial?: string | null; mac?: string | null; vendor?: string | null; model?: string | null; firmware?: string | null; role?: string | null
  owner?: string | null; criticality?: string | null; lifecycleState?: string | null; warrantyUntil?: string | null; managementMode?: string | null
  notes?: string | null; enabled?: boolean; addressSpaceId?: string | null
}

const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i
const NVR_ASSET_TYPE: Database['public']['Enums']['device_type'] = 'nvr' as const

async function assetRow(admin: AdminClient, orgId: string, id: string | null) {
  if (!id) return null
  const { data } = await admin.from('assets').select('id, is_recorder, location_id').eq('id', id).eq('org_id', orgId).is('archived_at', null).maybeSingle()
  return data
}

export async function saveAsset(clients: InventoryClients, actor: Actor, input: AssetInput): Promise<Result<{ assetId: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const admin = clients.admin
  const id = input?.id ? cleanId(input.id) : null
  if (input?.id) {
    const row = await assetRow(admin, actor.orgId, id)
    if (!row) return { ok: false, error: MSG_ASSET_NOT_FOUND }
    if (row.is_recorder) return { ok: false, error: MSG_IS_NVR }
  }
  // The asset type of an NVR (not a monitoring target kind): NVRs are recorders of a location, added on its page.
  if (String(input?.type) === NVR_ASSET_TYPE) return { ok: false, error: 'Add an NVR on its location’s page, not here.' }
  if (!(ASSET_TYPES as readonly string[]).includes(String(input?.type))) return { ok: false, error: 'Choose the type of asset.' }
  const name = optionalText(input?.name, 200)
  if (!name) return { ok: false, error: 'Enter the asset name (up to 200 characters).' }
  const ip = String(input?.ip ?? '').trim() || null
  if (ip && !isIp(ip)) return { ok: false, error: 'Enter the address as an IP address, or leave it empty.' }
  const port = parseWhole(input?.tcpPort, 1, 65535, null)
  if (port === undefined) return { ok: false, error: 'A port must be a whole number from 1 to 65535.' }
  const mac = String(input?.mac ?? '').trim() || null
  if (mac && !MAC.test(mac)) return { ok: false, error: 'Enter the MAC address like aa:bb:cc:dd:ee:ff.' }
  const criticality = String(input?.criticality ?? '').trim() || null
  if (criticality && !(CRITICALITIES as readonly string[]).includes(criticality)) return { ok: false, error: 'Choose how critical the asset is.' }
  const lifecycle = String(input?.lifecycleState ?? '').trim() || 'active'
  if (!(LIFECYCLE_STATES as readonly string[]).includes(lifecycle)) return { ok: false, error: 'Choose the lifecycle state.' }
  const warranty = parseDay(input?.warrantyUntil)
  if (warranty === undefined) return { ok: false, error: 'Enter the warranty end as a date.' }
  const text = {
    serial: optionalText(input?.serial, 200), vendor: optionalText(input?.vendor, 100), model: optionalText(input?.model, 100), firmware: optionalText(input?.firmware, 100),
    role: optionalText(input?.role, 100), owner: optionalText(input?.owner, 200), management_mode: optionalText(input?.managementMode, 100), notes: optionalText(input?.notes, 500),
  }
  if (Object.values(text).some((v) => v === undefined)) return { ok: false, error: 'One of the fields is too long.' }
  let locationId: string | null = null
  if (input?.locationId) {
    locationId = cleanId(input.locationId)
    const { data: loc } = locationId ? await admin.from('locations').select('id').eq('id', locationId).eq('org_id', actor.orgId).is('archived_at', null).maybeSingle() : { data: null }
    if (!loc) return { ok: false, error: 'Location not found.' }
  }
  let spaceId: string | null = null
  if (input?.addressSpaceId) {
    spaceId = cleanId(input.addressSpaceId)
    const { data: space } = spaceId ? await admin.from('address_spaces').select('id').eq('id', spaceId).eq('org_id', actor.orgId).maybeSingle() : { data: null }
    if (!space) return { ok: false, error: 'Address space not found.' }
  }
  const row = {
    name, type: input.type as AssetType as Database['public']['Enums']['device_type'], location_id: locationId, ip, tcp_port: port ?? null, mac: mac ? mac.toLowerCase() : null,
    criticality, lifecycle_state: lifecycle, warranty_until: warranty, enabled: input?.enabled !== false, address_space_id: spaceId,
    serial: text.serial ?? null, vendor: text.vendor ?? null, model: text.model ?? null, firmware: text.firmware ?? null, role: text.role ?? null,
    owner: text.owner ?? null, management_mode: text.management_mode ?? null, notes: text.notes ?? null,
  }
  const res = id
    ? await admin.from('assets').update(row).eq('id', id).eq('org_id', actor.orgId).is('archived_at', null).select('id')
    : await admin.from('assets').insert({ ...row, org_id: actor.orgId }).select('id')
  if (res.error) {
    if (res.error.code === '23505') return { ok: false, error: 'This address is already used by another asset in that address space.' }
    if (res.error.code === '23514') return { ok: false, error: 'That address space belongs to another location.' }
    return { ok: false, error: sanitizeError(res.error, { route: 'saveAsset', fallback: 'Could not save the asset.' }) }
  }
  if (!res.data?.length) return { ok: false, error: MSG_ASSET_NOT_FOUND }
  const assetId = res.data[0].id
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: id ? 'asset_updated' : 'asset_created', entityType: 'asset', entityId: assetId, detail: { type: input.type } })
  return { ok: true, assetId }
}

/** child depends on parent (network, power or recording). A loop — also through other assets — is refused. */
export async function addDependency(clients: InventoryClients, actor: Actor, input: { childId: string; parentId: string; kind: string }): Promise<Result<{ id: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const child = cleanId(input?.childId)
  const parent = cleanId(input?.parentId)
  if (!(DEPENDENCY_KINDS as readonly string[]).includes(String(input?.kind))) return { ok: false, error: 'Choose what the asset depends on it for.' }
  const admin = clients.admin
  const [c, p] = await Promise.all([assetRow(admin, actor.orgId, child), assetRow(admin, actor.orgId, parent)])
  if (!c || !p || !child || !parent) return { ok: false, error: MSG_ASSET_NOT_FOUND }
  if (child === parent) return { ok: false, error: 'An asset cannot depend on itself.' }
  const { data, error } = await admin.from('asset_dependencies').insert({ org_id: actor.orgId, child_asset_id: child, parent_asset_id: parent, kind: input.kind }).select('id').single()
  if (error?.code === 'DR005') return { ok: false, error: 'That would make a loop: the chosen asset already depends on this one (directly or through other assets).' }
  if (error?.code === '23505') return { ok: false, error: 'This dependency is already recorded.' }
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'addDependency', fallback: 'Could not save the dependency.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'asset_dependency_added', entityType: 'asset', entityId: child, detail: { parent, kind: input.kind } })
  return { ok: true, id: data.id }
}

export async function removeDependency(clients: InventoryClients, actor: Actor, dependencyId: string): Promise<Result<object>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(dependencyId)
  if (!id) return { ok: false, error: 'Dependency not found.' }
  const { data, error } = await clients.admin.from('asset_dependencies').delete().eq('id', id).eq('org_id', actor.orgId).select('id, child_asset_id, parent_asset_id, kind')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'removeDependency', fallback: 'Could not remove the dependency.' }) }
  if (!data?.length) return { ok: false, error: 'Dependency not found.' }
  await addAudit(clients.admin, { orgId: actor.orgId, actorId: actor.id, action: 'asset_dependency_removed', entityType: 'asset', entityId: data[0].child_asset_id, detail: { parent: data[0].parent_asset_id, kind: data[0].kind } })
  return { ok: true }
}

/** An extra endpoint (SNMP or other) of an asset in one address space. The management (and video) endpoints follow the asset itself. */
export async function addEndpoint(clients: InventoryClients, actor: Actor, assetId: string, input: { spaceId: string; host: string; port: string | number | null; purpose: string }): Promise<Result<{ id: string }>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const admin = clients.admin
  const id = cleanId(assetId)
  const row = await assetRow(admin, actor.orgId, id)
  if (!row || !id) return { ok: false, error: MSG_ASSET_NOT_FOUND }
  if (row.is_recorder) return { ok: false, error: MSG_IS_NVR }
  if (!(ENDPOINT_PURPOSES as readonly string[]).includes(String(input?.purpose))) return { ok: false, error: 'Choose what the address is for.' }
  const host = String(input?.host ?? '').trim()
  if (!isHostOrIp(host)) return { ok: false, error: 'Enter an IP address or a host name.' }
  const port = parseWhole(input?.port, 1, 65535, null)
  if (port === undefined) return { ok: false, error: 'A port must be a whole number from 1 to 65535.' }
  const space = cleanId(input?.spaceId)
  const { data: s } = space ? await admin.from('address_spaces').select('id').eq('id', space).eq('org_id', actor.orgId).maybeSingle() : { data: null }
  if (!s || !space) return { ok: false, error: 'Address space not found.' }
  const { data, error } = await admin.from('asset_endpoints').insert({ org_id: actor.orgId, asset_id: id, address_space_id: space, host, port, purpose: input.purpose }).select('id').single()
  if (error?.code === '23505') return { ok: false, error: 'This address is already used by another asset in that address space.' }
  if (error?.code === '23514') return { ok: false, error: 'That address space belongs to another location.' }
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'addEndpoint', fallback: 'Could not save the address.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'asset_endpoint_added', entityType: 'asset', entityId: id, detail: { purpose: input.purpose, space } })
  return { ok: true, id: data.id }
}

export async function retireEndpoint(clients: InventoryClients, actor: Actor, endpointId: string): Promise<Result<object>> {
  const may = await inventoryAdmin(clients.rls, actor)
  if (!may.ok) return may
  const id = cleanId(endpointId)
  if (!id) return { ok: false, error: 'Address not found.' }
  const admin = clients.admin
  const { data: e } = await admin.from('asset_endpoints').select('id, asset_id, purpose').eq('id', id).eq('org_id', actor.orgId).is('retired_at', null).maybeSingle()
  if (!e) return { ok: false, error: 'Address not found.' }
  if (e.purpose === 'management' || e.purpose === 'rtsp') return { ok: false, error: 'The management address changes with the asset’s own address.' }
  const { error } = await admin.from('asset_endpoints').update({ retired_at: new Date().toISOString() }).eq('id', id).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'retireEndpoint', fallback: 'Could not retire the address.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'asset_endpoint_retired', entityType: 'asset', entityId: e.asset_id, detail: { purpose: e.purpose } })
  return { ok: true }
}
