import type { AdminClient } from '@/lib/admin/types'
import { mappingHistory } from '@/lib/inventory/mapping'
import { isMonitored } from '@/lib/inventory/recorders'
import { fetchAll } from '@/lib/supabase/fetch-all'

// Reads of the P2-5c-1 administration pages. Service role ONLY after the page's requireAdministration('admin.inventory'), always scoped
// to the administrator's organisation. Never a password or a vault id: recorders give "a password is saved" (secret_id present) only.

export type RegionRow = { id: string; code: string; name: string; archived_at: string | null; clusters: number }
export type ClusterRow = { id: string; code: string; name: string; region_id: string | null; archived_at: string | null; locations: number }

export async function regionsAndClusters(admin: AdminClient, orgId: string) {
  const [regions, clusters, locations] = await Promise.all([
    fetchAll((from, to) => admin.from('regions').select('id, code, name, archived_at').eq('org_id', orgId).order('code').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('clusters').select('id, code, name, region_id, archived_at').eq('org_id', orgId).order('code').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('locations').select('id, cluster_id').eq('org_id', orgId).is('archived_at', null).order('id').range(from, to)),
  ])
  const perCluster = new Map<string, number>()
  for (const l of locations) if (l.cluster_id) perCluster.set(l.cluster_id, (perCluster.get(l.cluster_id) ?? 0) + 1)
  const perRegion = new Map<string, number>()
  for (const c of clusters) if (c.region_id && !c.archived_at) perRegion.set(c.region_id, (perRegion.get(c.region_id) ?? 0) + 1)
  return {
    regions: regions.map((r) => ({ ...r, clusters: perRegion.get(r.id) ?? 0 })) as RegionRow[],
    clusters: clusters.map((c) => ({ ...c, locations: perCluster.get(c.id) ?? 0 })) as ClusterRow[],
    unclustered: locations.filter((l) => !l.cluster_id).length,
  }
}

export type LocationListRow = {
  id: string; code: string; name: string; kind: string; city: string | null; is_active: boolean; archived_at: string | null; cluster_id: string | null
  recorders: number; cameras: number
}

export async function locationList(admin: AdminClient, orgId: string, o: { archived: boolean }) {
  const [locations, recorders, cameras] = await Promise.all([
    fetchAll((from, to) => {
      const q = admin.from('locations').select('id, code, name, kind, city, is_active, archived_at, cluster_id').eq('org_id', orgId)
      return (o.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)).order('code').order('id').range(from, to)
    }),
    fetchAll((from, to) => admin.from('recorders').select('id, location_id, assets!recorders_asset_fk!inner(archived_at)').eq('org_id', orgId).is('assets.archived_at', null).order('id').range(from, to)),
    fetchAll((from, to) => admin.from('cameras').select('id, location_id').eq('org_id', orgId).is('archived_at', null).order('id').range(from, to)),
  ])
  const nvr = new Map<string, number>()
  for (const r of recorders) nvr.set(r.location_id, (nvr.get(r.location_id) ?? 0) + 1)
  const cam = new Map<string, number>()
  for (const c of cameras) cam.set(c.location_id, (cam.get(c.location_id) ?? 0) + 1)
  return locations.map((l) => ({ ...l, recorders: nvr.get(l.id) ?? 0, cameras: cam.get(l.id) ?? 0 })) as LocationListRow[]
}

export type RecorderSummary = {
  id: string; name: string; host: string | null; http_port: number; rtsp_port: number; username: string | null; expected_channels: number
  clock_offset_sec: number | null; password_saved: boolean; monitoring_enabled: boolean; monitored: boolean; monitoring_disabled_reason: string | null
  archived_at: string | null; cameras: number
}

const RECORDER_COLUMNS =
  'id, location_id, http_port, rtsp_port, username, expected_channels, clock_offset_sec, secret_id, monitoring_enabled, monitoring_disabled_reason, assets!recorders_asset_fk!inner(name, ip, enabled, archived_at)'
type RecorderDbRow = {
  id: string; location_id: string; http_port: number; rtsp_port: number; username: string | null; expected_channels: number; clock_offset_sec: number | null
  secret_id: string | null; monitoring_enabled: boolean; monitoring_disabled_reason: string | null; assets: { name: string; ip: string | null; enabled: boolean; archived_at: string | null }
}
const toSummary = (r: RecorderDbRow, cameras: number): RecorderSummary => ({
  id: r.id, name: r.assets.name, host: r.assets.ip, http_port: r.http_port, rtsp_port: r.rtsp_port, username: r.username, expected_channels: r.expected_channels,
  clock_offset_sec: r.clock_offset_sec, password_saved: r.secret_id !== null, monitoring_enabled: r.monitoring_enabled, monitored: isMonitored(r),
  monitoring_disabled_reason: r.monitoring_disabled_reason, archived_at: r.assets.archived_at, cameras,
})

/** One location with its NVRs (archived ones too, for restore), network definition and parent cluster. Null when not of the org. */
export async function locationDetail(admin: AdminClient, orgId: string, id: string) {
  const { data: loc } = await admin.from('locations').select('id, code, name, kind, city, address, zone, state, is_active, archived_at, cluster_id').eq('id', id).eq('org_id', orgId).maybeSingle()
  if (!loc) return null
  const [recs, cams, net] = await Promise.all([
    admin.from('recorders').select(RECORDER_COLUMNS).eq('org_id', orgId).eq('location_id', id).order('created_at').order('id'),
    fetchAll((from, to) => admin.from('cameras').select('id, recorder_id').eq('org_id', orgId).eq('location_id', id).is('archived_at', null).order('id').range(from, to)),
    admin.from('network_definitions').select('management_cidr, gateway, dns, management_vlan, vlan_map, discovery_ranges, sdwan_context').eq('org_id', orgId).eq('location_id', id).maybeSingle(),
  ])
  const perRec = new Map<string, number>()
  for (const c of cams) if (c.recorder_id) perRec.set(c.recorder_id, (perRec.get(c.recorder_id) ?? 0) + 1)
  return {
    location: loc,
    recorders: ((recs.data ?? []) as unknown as RecorderDbRow[]).map((r) => toSummary(r, perRec.get(r.id) ?? 0)),
    unmappedCameras: cams.filter((c) => !c.recorder_id).length,
    network: net.data ? {
      management_cidr: String(net.data.management_cidr), gateway: net.data.gateway ? String(net.data.gateway) : null, dns: (net.data.dns ?? []).map(String),
      management_vlan: net.data.management_vlan, vlan_map: (net.data.vlan_map ?? {}) as Record<string, number>, discovery_ranges: (net.data.discovery_ranges ?? []).map(String),
      sdwan_context: net.data.sdwan_context,
    } : null,
  }
}

/** One NVR of a location (archived too) with its cameras, their mapping history, and the cameras of the location (for merge). */
export async function recorderDetail(admin: AdminClient, orgId: string, locationId: string, recorderId: string) {
  const { data } = await admin.from('recorders').select(RECORDER_COLUMNS).eq('org_id', orgId).eq('location_id', locationId).eq('id', recorderId).maybeSingle()
  if (!data) return null
  const rec = data as unknown as RecorderDbRow
  const [allRecs, cams] = await Promise.all([
    admin.from('recorders').select('id, assets!recorders_asset_fk!inner(name, archived_at)').eq('org_id', orgId).eq('location_id', locationId).is('assets.archived_at', null).order('created_at').order('id'),
    fetchAll((from, to) => admin.from('cameras').select('id, name, channel, recorder_id').eq('org_id', orgId).eq('location_id', locationId).is('archived_at', null).order('channel').order('id').range(from, to)),
  ])
  const recorders = ((allRecs.data ?? []) as unknown as { id: string; assets: { name: string } }[]).map((r) => ({ id: r.id, name: r.assets.name }))
  const name = new Map(recorders.map((r) => [r.id, r.name]))
  const mine = cams.filter((c) => c.recorder_id === recorderId)
  const history = await Promise.all(mine.map((c) => mappingHistory(admin, orgId, c.id)))
  return {
    recorder: toSummary(rec, mine.length),
    recorders,
    cameras: mine.map((c, i) => ({ id: c.id, name: c.name, channel: c.channel, recorderId: c.recorder_id, history: history[i] })),
    unmapped: cams.filter((c) => !c.recorder_id).map((c) => ({ id: c.id, name: c.name, channel: null as number | null, recorderId: null as string | null, history: [] })),
    mergeCandidates: cams.map((c) => ({ id: c.id, label: `${c.name} (${c.recorder_id ? `${name.get(c.recorder_id) ?? 'NVR'}, channel ${c.channel}` : 'not linked'})` })),
  }
}

/** Merge candidates for the reconciliation list: per finding camera, the other cameras of its location (any NVR). */
export async function camerasByLocation(admin: AdminClient, orgId: string, locationIds: string[]) {
  const out = new Map<string, { id: string; label: string }[]>()
  const unique = [...new Set(locationIds)]
  for (let i = 0; i < unique.length; i += 100) {
    const rows = await fetchAll((from, to) => admin.from('cameras').select('id, name, channel, location_id, recorder_id').eq('org_id', orgId).in('location_id', unique.slice(i, i + 100)).is('archived_at', null).order('id').range(from, to))
    const recIds = [...new Set(rows.map((r) => r.recorder_id).filter((x): x is string => !!x))]
    const { data: names } = recIds.length ? await admin.from('assets').select('id, name').eq('org_id', orgId).in('id', recIds) : { data: [] }
    const recName = new Map((names ?? []).map((n) => [n.id, n.name]))
    for (const r of rows) {
      const list = out.get(r.location_id) ?? []
      list.push({ id: r.id, label: `${r.name} (${r.recorder_id ? `${recName.get(r.recorder_id) ?? 'NVR'}, channel ${r.channel}` : 'not linked'})` })
      out.set(r.location_id, list)
    }
  }
  return out
}

export type AssetListRow = {
  id: string; name: string; type: string; location_id: string | null; ip: string | null; vendor: string | null; model: string | null; firmware: string | null
  serial: string | null; criticality: string | null; lifecycle_state: string; enabled: boolean; archived_at: string | null
}

export async function assetList(admin: AdminClient, orgId: string, o: { archived: boolean }) {
  return (await fetchAll((from, to) => {
    const q = admin.from('assets').select('id, name, type, location_id, ip, vendor, model, firmware, serial, criticality, lifecycle_state, enabled, archived_at')
      .eq('org_id', orgId).eq('is_recorder', false)
    return (o.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)).order('name').order('id').range(from, to)
  })) as AssetListRow[]
}

export async function assetDetail(admin: AdminClient, orgId: string, id: string) {
  const { data: asset } = await admin.from('assets')
    .select('id, name, type, location_id, ip, tcp_port, serial, mac, vendor, model, firmware, role, owner, criticality, lifecycle_state, warranty_until, management_mode, notes, enabled, address_space_id, archived_at, is_recorder')
    .eq('id', id).eq('org_id', orgId).maybeSingle()
  if (!asset || asset.is_recorder) return null
  const [deps, endpoints, spaces, others] = await Promise.all([
    admin.from('asset_dependencies').select('id, parent_asset_id, kind').eq('org_id', orgId).eq('child_asset_id', id).order('created_at'),
    admin.from('asset_endpoints').select('id, address_space_id, host, port, purpose, retired_at').eq('org_id', orgId).eq('asset_id', id).order('created_at'),
    admin.from('address_spaces').select('id, name, kind, location_id').eq('org_id', orgId).order('name'),
    fetchAll((from, to) => admin.from('assets').select('id, name, location_id').eq('org_id', orgId).is('archived_at', null).neq('id', id).order('name').order('id').range(from, to)),
  ])
  const assetName = new Map(others.map((a) => [a.id, a.name]))
  const spaceName = new Map((spaces.data ?? []).map((s) => [s.id, s.name]))
  return {
    asset,
    dependencies: (deps.data ?? []).map((d) => ({ id: d.id, parentId: d.parent_asset_id, parentName: assetName.get(d.parent_asset_id) ?? 'Archived asset', kind: d.kind })),
    endpoints: (endpoints.data ?? []).map((e) => ({ id: e.id, spaceName: spaceName.get(e.address_space_id) ?? 'Address space', host: e.host, port: e.port, purpose: e.purpose, retiredAt: e.retired_at })),
    // An asset's own location's address space, or the shared ones (a location_nat space of another location is refused by the database).
    spaces: (spaces.data ?? []).filter((s) => s.kind !== 'location_nat' || s.location_id === asset.location_id).map((s) => ({ id: s.id, name: s.name })),
    others,
  }
}
