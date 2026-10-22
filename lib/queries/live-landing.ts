import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Capabilities } from '@/lib/auth/capabilities'
import { camerasFor } from '@/lib/auth/resource'
import { cameraState, getRollups, type CameraCounts, type CameraState } from '@/lib/live/rollups'
import { buildLiveTree, filterTree, treeCounts, type LiveTree } from '@/lib/live/tree'
import { listVisibleGroups, type GroupListItem } from '@/lib/queries/groups'
import { getLiveScope, sortCameras } from '@/lib/queries/live'
import { getStates, isStale, type Status } from '@/lib/queries/status'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

// P4-L1 brief item 1: what the Live landing shows, read through the person's own client (row security decides every row) and the
// person's own roll-ups (status_rollups with cctv.live): the Region → Cluster → Location tree of the places with a camera they may watch
// live, the saved groups (static and dynamic) with the number of cameras they can watch in each, a search over location codes and names
// and camera names, and one opened location with its cameras — and its NVRs only for the IT view of them (ruling C-1: for everybody else
// a location simply shows all its cameras).

export type LandingCamera = { id: string; name: string; channel: number; locationId: string; locationCode: string; state: CameraState; canPlayback: boolean }
export type LandingRecorder = { id: string; name: string; status: Status | null; stale: boolean; cameraIds: string[] }
/** `recorders` is null without the IT view of any of the location's NVRs. */
export type LandingBranch = { location: { id: string; code: string; name: string }; cameras: LandingCamera[]; recorders: LandingRecorder[] | null }
export type LiveLanding = { tree: LiveTree; totals: CameraCounts; groups: GroupListItem[]; cameraMatches: LandingCamera[]; branch: LandingBranch | null; query: string }

export const MAX_CAMERA_MATCHES = 50
export const MIN_SEARCH = 2
const PIECE = 100

/** Keeps a search word from changing the meaning of the filter: LIKE's wildcards escaped; PostgREST reads "*" as one, so it goes too. */
export function cleanSearch(q: unknown): string {
  return (typeof q === 'string' ? q : '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

async function searchCameras(supabase: Client, q: string, now: Date): Promise<LandingCamera[]> {
  if (q.length < MIN_SEARCH) return []
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_')}%`
  const { data, error } = await supabase.from('cameras').select('id, name, channel, location_id, place:locations!inner(code, is_active)')
    .eq('is_active', true).eq('place.is_active', true).ilike('name', pattern).order('name').order('id').limit(200)
  if (error) throw new Error('Could not look for cameras.')
  const words = q.toLowerCase()
  const rows = ((data ?? []) as unknown as { id: string; name: string; channel: number; location_id: string; place: { code: string } }[])
    .filter((r) => r.name.toLowerCase().includes(words))
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const [live, playback, states] = await Promise.all([camerasFor(supabase, 'cctv.live', ids), camerasFor(supabase, 'cctv.playback', ids), getStates(supabase, 'camera', ids)])
  if (!live.ok || !playback.ok) throw new Error('Could not check access to the cameras.')
  const may = new Set(live.ids)
  const play = new Set(playback.ids)
  return rows.filter((r) => may.has(r.id.toLowerCase())).slice(0, MAX_CAMERA_MATCHES).map((r) => {
    const s = states.get(r.id)
    const stale = s?.status === 'up' && isStale(s.last_checked_at, now)
    return { id: r.id, name: r.name, channel: r.channel, locationId: r.location_id, locationCode: r.place.code, state: cameraState({ status: s?.status ?? null, stale, reason: s?.error ?? null }), canPlayback: play.has(r.id.toLowerCase()) }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.locationCode.localeCompare(b.locationCode) || a.id.localeCompare(b.id))
}

async function openBranch(supabase: Client, locationId: string, now: Date): Promise<LandingBranch | null> {
  const scope = await getLiveScope(supabase, { store: locationId }, 'cctv.live', now)
  if (!scope || scope.cameras.length === 0) return null
  const location = await supabase.from('locations').select('id, code, name').eq('id', locationId).maybeSingle()
  if (location.error || !location.data) return null
  const cameras: LandingCamera[] = sortCameras(scope.cameras.map((c) => ({ id: c.id, name: c.name, channel: c.channel, locationId: c.locationId, storeCode: c.storeCode, state: c.state, canPlayback: c.canPlayback })))
    .map(({ storeCode, ...c }) => ({ ...c, locationCode: storeCode }))
  // NVRs and which camera is on which: readable with the recorder-level IT view only (recorder_status, camera_channel_mappings).
  const recs = await fetchAll((from, to) => supabase.from('recorder_status').select('recorder_id, name, status, stale, monitoring_enabled').eq('location_id', locationId).order('recorder_id').range(from, to))
  if (recs.length === 0) return { location: location.data, cameras, recorders: null }
  const of = new Map<string, string>()
  const ids = cameras.map((c) => c.id)
  for (let i = 0; i < ids.length; i += PIECE) {
    const { data, error } = await supabase.from('camera_channel_mappings').select('camera_id, recorder_id').in('camera_id', ids.slice(i, i + PIECE)).is('valid_to', null)
    if (error) throw new Error('Could not read the cameras.')
    for (const m of data ?? []) of.set(m.camera_id, m.recorder_id)
  }
  const recorders = recs.filter((r) => r.recorder_id).map((r) => ({
    id: r.recorder_id as string,
    name: r.name ?? 'NVR',
    status: (r.monitoring_enabled === false ? 'off' : (r.status as Status | null)) ?? null,
    stale: !!r.stale && r.monitoring_enabled !== false,
    cameraIds: cameras.filter((c) => of.get(c.id) === r.recorder_id).map((c) => c.id),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { location: location.data, cameras, recorders }
}

export async function loadLiveLanding(supabase: Client, capabilities: Capabilities, o: { q?: string; open?: string }, now: Date = new Date()): Promise<LiveLanding> {
  const query = cleanSearch(o.q)
  const [regions, clusters, locations, rollups, groups, cameraMatches, branch] = await Promise.all([
    fetchAll((from, to) => supabase.from('regions').select('id, code, name').is('archived_at', null).order('code').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('clusters').select('id, code, name, region_id').is('archived_at', null).order('code').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('locations').select('id, code, name, city, cluster_id').eq('is_active', true).order('code').order('id').range(from, to)),
    getRollups(supabase, 'cctv.live'),
    listVisibleGroups(supabase, { capabilities, capability: 'cctv.live' }),
    searchCameras(supabase, query, now),
    o.open ? openBranch(supabase, o.open, now) : Promise.resolve(null),
  ])
  const tree = buildLiveTree({ regions, clusters, locations, rollups })
  return { tree: filterTree(tree, query), totals: treeCounts(tree), groups: groups.filter((g) => g.camera_count > 0), cameraMatches, branch, query }
}
