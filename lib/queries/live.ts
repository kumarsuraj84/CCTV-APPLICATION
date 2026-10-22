import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { camerasFor } from '@/lib/auth/resource'
import { cameraState, type CameraState } from '@/lib/live/rollups'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { getVisibleGroup } from '@/lib/queries/groups'
import { getStates, isStale, type Status } from '@/lib/queries/status'

type Client = SupabaseClient<Database>

// What the live wall and the playback lists show: the cameras of one region, cluster, location, NVR, group or a single camera that the
// person may use with ONE capability (P2-2): the live wall uses cctv.live, the playback screen cctv.playback. Rows are read with the
// person's own client (row security: any CCTV capability shows camera metadata; regions and clusters only when their names may be seen;
// an NVR only with the recorder-level IT view), then narrowed by the database's cameras_with_capability, so a playback-only person gets
// no camera to watch live and a live-only person none to play back. Each camera also says whether the other screen is open to the
// person, so that links and buttons appear only where they work, and its honest state (P4-L1: "Recorder not reachable" is not
// "Offline"). Switched-off and archived cameras, locations, clusters and regions are left out. A place the person may not use is "not
// found" (null), exactly like one that does not exist.

const MALFORMED_ID = '22P02'
const PIECE = 100

export type ScopeCapability = 'cctv.live' | 'cctv.playback'
export type LiveCamera = {
  id: string; name: string; storeCode: string; locationId: string; channel: number
  status: Status | null; stale: boolean; state: CameraState; canLive: boolean; canPlayback: boolean
}
export type LiveScopeKind = 'region' | 'cluster' | 'store' | 'nvr' | 'group' | 'camera'
/** `multiLocation`: the cameras are in more than one location (a tour then goes location by location). */
export type LiveScope = { kind: LiveScopeKind; title: string; description: string; cameras: LiveCamera[]; multiLocation: boolean }
export type LiveQuery = { store?: string; group?: string; camera?: string; region?: string; cluster?: string; nvr?: string }

type Raw = { id: string; name: string; channel: number; storeCode: string; locationId: string }
type Named = { id: string; code: string; name: string }

/** One order on every wall: location code, channel, name (two NVRs of one location both have a channel 1), id. */
export function sortCameras<T extends { storeCode: string; channel: number; name: string; id: string }>(list: T[]): T[] {
  return list.sort((a, b) => a.storeCode.localeCompare(b.storeCode) || a.channel - b.channel || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Keeps the cameras usable with `cap`, adds whether live and playback are open, and each camera's last known status. */
async function narrow(supabase: Client, cameras: Raw[], cap: ScopeCapability, now: Date): Promise<LiveCamera[]> {
  const ids = cameras.map((c) => c.id)
  const [live, playback] = await Promise.all([camerasFor(supabase, 'cctv.live', ids), camerasFor(supabase, 'cctv.playback', ids)])
  if (!live.ok || !playback.ok) throw new Error('Could not check access to the cameras.')
  const canLive = new Set(live.ids)
  const canPlayback = new Set(playback.ids)
  const usable = cameras.filter((c) => (cap === 'cctv.live' ? canLive : canPlayback).has(c.id.toLowerCase()))
  const states = await getStates(supabase, 'camera', usable.map((c) => c.id))
  return sortCameras(usable.map((c) => {
    const s = states.get(c.id)
    const id = c.id.toLowerCase()
    const stale = s?.status === 'up' && isStale(s.last_checked_at, now)
    return { ...c, status: s?.status ?? null, stale, state: cameraState({ status: s?.status ?? null, stale, reason: s?.error ?? null }), canLive: canLive.has(id), canPlayback: canPlayback.has(id) }
  }))
}

const countText = (n: number) => `${n} ${n === 1 ? 'camera' : 'cameras'}`
const placesText = (cameras: LiveCamera[]) => {
  const n = new Set(cameras.map((c) => c.locationId)).size
  return `${countText(cameras.length)} in ${n} ${n === 1 ? 'location' : 'locations'}`
}
const scope = (kind: LiveScopeKind, title: string, description: string, cameras: LiveCamera[]): LiveScope =>
  ({ kind, title, description, cameras, multiLocation: new Set(cameras.map((c) => c.locationId)).size > 1 })

/** A row by id through the person's own client; null when it does not exist, may not be seen, or the id is not an id. */
async function one<T>(q: PromiseLike<{ data: unknown; error: { code?: string } | null }>, what: string): Promise<T | null> {
  const { data, error } = await q
  if (error) {
    if (error.code === MALFORMED_ID) return null
    throw new Error(`Could not read the ${what}.`)
  }
  return (data as T | null) ?? null
}

/** The working locations of these clusters the person may see (row security), by id. */
async function locationsOfClusters(supabase: Client, clusterIds: string[]): Promise<Map<string, { id: string; code: string }>> {
  const out = new Map<string, { id: string; code: string }>()
  for (let i = 0; i < clusterIds.length; i += PIECE) {
    const rows = await fetchAll((from, to) => supabase.from('locations').select('id, code').in('cluster_id', clusterIds.slice(i, i + PIECE)).eq('is_active', true).order('id').range(from, to))
    for (const r of rows) out.set(r.id, r)
  }
  return out
}

/** The working cameras of these locations the person may see (row security). */
async function camerasOfLocations(supabase: Client, locations: Map<string, { id: string; code: string }>): Promise<Raw[]> {
  const ids = [...locations.keys()]
  const out: Raw[] = []
  for (let i = 0; i < ids.length; i += PIECE) {
    const rows = await fetchAll((from, to) => supabase.from('cameras').select('id, name, channel, location_id').in('location_id', ids.slice(i, i + PIECE)).eq('is_active', true).order('id').range(from, to))
    for (const c of rows) out.push({ id: c.id, name: c.name, channel: c.channel, locationId: c.location_id, storeCode: locations.get(c.location_id)?.code ?? '' })
  }
  return out
}

/** The working cameras with these ids the person may see, with their location (which must be working too). */
async function camerasByIds(supabase: Client, ids: string[]): Promise<Raw[]> {
  const out: Raw[] = []
  for (let i = 0; i < ids.length; i += PIECE) {
    const { data, error } = await supabase.from('cameras').select('id, name, channel, location_id, place:locations!inner(code, is_active)')
      .in('id', ids.slice(i, i + PIECE)).eq('is_active', true).eq('place.is_active', true)
    if (error) throw new Error('Could not read the cameras.')
    for (const c of (data ?? []) as unknown as { id: string; name: string; channel: number; location_id: string; place: { code: string } }[]) {
      out.push({ id: c.id, name: c.name, channel: c.channel, locationId: c.location_id, storeCode: c.place.code })
    }
  }
  return out
}

export async function getLiveScope(supabase: Client, q: LiveQuery, cap: ScopeCapability, now: Date = new Date()): Promise<LiveScope | null> {
  if (q.group) {
    const g = await getVisibleGroup(supabase, q.group)
    if (!g) return null
    // Row security already left out a group without any member the person may see (a dynamic group never widens access).
    const cameras = await narrow(supabase, g.cameras.map((c) => ({ id: c.id, name: c.name, channel: c.channel, storeCode: c.store_code, locationId: c.store_id })), cap, now)
    return scope('group', g.name, `Camera group · ${placesText(cameras)} you can use here`, cameras)
  }
  if (q.region) {
    const region = await one<Named>(supabase.from('regions').select('id, code, name').eq('id', q.region).is('archived_at', null).maybeSingle(), 'region')
    if (!region) return null
    const clusters = await fetchAll((from, to) => supabase.from('clusters').select('id').eq('region_id', region.id).is('archived_at', null).order('id').range(from, to))
    const cameras = await narrow(supabase, await camerasOfLocations(supabase, await locationsOfClusters(supabase, clusters.map((c) => c.id))), cap, now)
    return scope('region', `${region.code} · ${region.name}`, `Region · ${placesText(cameras)}`, cameras)
  }
  if (q.cluster) {
    const cluster = await one<Named>(supabase.from('clusters').select('id, code, name').eq('id', q.cluster).is('archived_at', null).maybeSingle(), 'cluster')
    if (!cluster) return null
    const cameras = await narrow(supabase, await camerasOfLocations(supabase, await locationsOfClusters(supabase, [cluster.id])), cap, now)
    return scope('cluster', `${cluster.code} · ${cluster.name}`, `Cluster · ${placesText(cameras)}`, cameras)
  }
  if (q.nvr) {
    // The NVR row, its name and its mappings are readable with the recorder-level IT view only (AC-4): for everybody else the NVR does
    // not exist. Its cameras are the ones whose ACTIVE mapping is on it (P2-5b).
    const rec = await one<{ recorder_id: string | null; location_id: string | null; name: string | null }>(
      supabase.from('recorder_status').select('recorder_id, location_id, name').eq('recorder_id', q.nvr).maybeSingle(), 'NVR')
    if (!rec?.recorder_id || !rec.location_id) return null
    const recorderId = rec.recorder_id
    const [location, maps] = await Promise.all([
      one<{ id: string; code: string; name: string }>(supabase.from('locations').select('id, code, name').eq('id', rec.location_id).eq('is_active', true).maybeSingle(), 'location'),
      fetchAll((from, to) => supabase.from('camera_channel_mappings').select('camera_id').eq('recorder_id', recorderId).is('valid_to', null).order('camera_id').range(from, to)),
    ])
    if (!location) return null
    const cameras = await narrow(supabase, await camerasByIds(supabase, maps.map((m) => m.camera_id)), cap, now)
    return scope('nvr', `${location.code} · ${rec.name ?? 'NVR'}`, `NVR at ${location.name} · ${countText(cameras.length)}`, cameras)
  }
  if (q.store) {
    const store = await one<Named>(supabase.from('locations').select('id, code, name').eq('id', q.store).eq('is_active', true).maybeSingle(), 'location')
    if (!store) return null
    const rows = await fetchAll((from, to) => supabase.from('cameras').select('id, name, channel').eq('location_id', store.id).eq('is_active', true).order('channel').order('id').range(from, to))
    const cameras = await narrow(supabase, rows.map((c) => ({ id: c.id, name: c.name, channel: c.channel, storeCode: store.code, locationId: store.id })), cap, now)
    return scope('store', `${store.code} · ${store.name}`, `Location · ${countText(cameras.length)}`, cameras)
  }
  if (q.camera) {
    const data = await one<{ id: string; name: string; channel: number; location_id: string; stores: unknown }>(supabase
      .from('cameras')
      .select('id, name, channel, location_id, stores:locations!inner(code, name, is_active)')
      .eq('id', q.camera)
      .eq('is_active', true)
      .eq('stores.is_active', true)
      .maybeSingle(), 'camera')
    if (!data) return null
    const store = data.stores as unknown as { code: string; name: string }
    const cameras = await narrow(supabase, [{ id: data.id, name: data.name, channel: data.channel, storeCode: store.code, locationId: data.location_id }], cap, now)
    // A camera the person may not use with this capability is "not found", the same as one that does not exist.
    if (cameras.length === 0) return null
    return scope('camera', data.name, `Camera · ${store.code} · ${store.name}`, cameras)
  }
  return null
}
