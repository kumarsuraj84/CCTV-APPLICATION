import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { camerasFor } from '@/lib/auth/resource'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { getVisibleGroup } from '@/lib/queries/groups'
import { getStates, isStale, type Status } from '@/lib/queries/status'

type Client = SupabaseClient<Database>

// What the live wall and the playback lists show: the cameras of one store, one group or a single camera that the person may use with
// ONE capability (P2-2): the live wall uses cctv.live, the playback screen cctv.playback. Rows are read with the person's own client
// (row security: any CCTV capability shows camera metadata), then narrowed by the database's cameras_with_capability, so a playback-only
// person gets no camera to watch live and a live-only person none to play back. Each camera also says whether the other screen is open
// to the person, so that links and buttons appear only where they work. Switched-off cameras and stores are left out.

const MALFORMED_ID = '22P02'

export type ScopeCapability = 'cctv.live' | 'cctv.playback'
export type LiveCamera = { id: string; name: string; storeCode: string; channel: number; status: Status | null; stale: boolean; canLive: boolean; canPlayback: boolean }
export type LiveScope = { kind: 'store' | 'group' | 'camera'; title: string; description: string; cameras: LiveCamera[] }

type Raw = { id: string; name: string; channel: number; storeCode: string }

/** Keeps the cameras usable with `cap`, adds whether live and playback are open, and each camera's last known status. */
async function narrow(supabase: Client, cameras: Raw[], cap: ScopeCapability, now: Date): Promise<LiveCamera[]> {
  const ids = cameras.map((c) => c.id)
  const [live, playback] = await Promise.all([camerasFor(supabase, 'cctv.live', ids), camerasFor(supabase, 'cctv.playback', ids)])
  if (!live.ok || !playback.ok) throw new Error('Could not check access to the cameras.')
  const canLive = new Set(live.ids)
  const canPlayback = new Set(playback.ids)
  const usable = cameras.filter((c) => (cap === 'cctv.live' ? canLive : canPlayback).has(c.id.toLowerCase()))
  const states = await getStates(supabase, 'camera', usable.map((c) => c.id))
  return usable.map((c) => {
    const s = states.get(c.id)
    const id = c.id.toLowerCase()
    return { ...c, status: s?.status ?? null, stale: s?.status === 'up' && isStale(s.last_checked_at, now), canLive: canLive.has(id), canPlayback: canPlayback.has(id) }
  })
}

const countText = (n: number) => `${n} ${n === 1 ? 'camera' : 'cameras'}`

export async function getLiveScope(
  supabase: Client,
  q: { store?: string; group?: string; camera?: string },
  cap: ScopeCapability,
  now: Date = new Date(),
): Promise<LiveScope | null> {
  if (q.group) {
    const g = await getVisibleGroup(supabase, q.group)
    if (!g) return null
    const cameras = await narrow(supabase, g.cameras.map((c) => ({ id: c.id, name: c.name, channel: c.channel, storeCode: c.store_code })), cap, now)
    return { kind: 'group', title: g.name, description: `Camera group · ${countText(cameras.length)} you can use here`, cameras }
  }
  if (q.store) {
    const { data: store, error } = await supabase.from('locations').select('id, code, name').eq('id', q.store).eq('is_active', true).maybeSingle()
    if (error) {
      if (error.code === MALFORMED_ID) return null
      throw new Error('Could not read the store.')
    }
    if (!store) return null
    const rows = await fetchAll((from, to) => supabase.from('cameras').select('id, name, channel').eq('location_id', store.id).eq('is_active', true).order('channel').order('id').range(from, to))
    const cameras = await narrow(supabase, rows.map((c) => ({ id: c.id, name: c.name, channel: c.channel, storeCode: store.code })), cap, now)
    return { kind: 'store', title: `${store.code} · ${store.name}`, description: `Store · ${countText(cameras.length)}`, cameras }
  }
  if (q.camera) {
    const { data, error } = await supabase
      .from('cameras')
      .select('id, name, channel, stores:locations!inner(code, name, is_active)')
      .eq('id', q.camera)
      .eq('is_active', true)
      .eq('stores.is_active', true)
      .maybeSingle()
    if (error) {
      if (error.code === MALFORMED_ID) return null
      throw new Error('Could not read the camera.')
    }
    if (!data) return null
    const store = data.stores as unknown as { code: string; name: string }
    const cameras = await narrow(supabase, [{ id: data.id, name: data.name, channel: data.channel, storeCode: store.code }], cap, now)
    // A camera the person may not use with this capability is "not found", the same as one that does not exist.
    if (cameras.length === 0) return null
    return { kind: 'camera', title: data.name, description: `Camera · ${store.code} · ${store.name}`, cameras }
  }
  return null
}
