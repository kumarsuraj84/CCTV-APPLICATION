import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { getVisibleGroup } from '@/lib/queries/groups'
import { getStates, isStale, type Status } from '@/lib/queries/status'

type Client = SupabaseClient<Database>

// What the live wall shows: the cameras of one store, one group or a single camera, as the signed-in person's own client sees them
// (row-level security decides), with the monitoring status each camera has. Switched-off cameras and stores are left out.

const MALFORMED_ID = '22P02'

export type LiveCamera = { id: string; name: string; storeCode: string; channel: number; status: Status | null; stale: boolean }
export type LiveScope = { kind: 'store' | 'group' | 'camera'; title: string; description: string; cameras: LiveCamera[] }

type Raw = { id: string; name: string; channel: number; storeCode: string }

/** Adds each camera's last known status (Live / Offline / not checked yet; "stale" when a live result is old). */
export async function withStatus(supabase: Client, cameras: Raw[], now: Date = new Date()): Promise<LiveCamera[]> {
  const states = await getStates(supabase, 'camera', cameras.map((c) => c.id))
  return cameras.map((c) => {
    const s = states.get(c.id)
    return { ...c, status: s?.status ?? null, stale: s?.status === 'up' && isStale(s.last_checked_at, now) }
  })
}

const countText = (n: number) => `${n} ${n === 1 ? 'camera' : 'cameras'}`

export async function getLiveScope(supabase: Client, q: { store?: string; group?: string; camera?: string }, now: Date = new Date()): Promise<LiveScope | null> {
  if (q.group) {
    const g = await getVisibleGroup(supabase, q.group)
    if (!g) return null
    const cameras = await withStatus(supabase, g.cameras.map((c) => ({ id: c.id, name: c.name, channel: c.channel, storeCode: c.store_code })), now)
    return { kind: 'group', title: g.name, description: `Camera group · ${countText(cameras.length)} you can see`, cameras }
  }
  if (q.store) {
    const { data: store, error } = await supabase.from('stores').select('id, code, name').eq('id', q.store).eq('is_active', true).maybeSingle()
    if (error) {
      if (error.code === MALFORMED_ID) return null
      throw new Error('Could not read the store.')
    }
    if (!store) return null
    const rows = await fetchAll((from, to) => supabase.from('cameras').select('id, name, channel').eq('store_id', store.id).eq('is_active', true).order('channel').order('id').range(from, to))
    const cameras = await withStatus(supabase, rows.map((c) => ({ id: c.id, name: c.name, channel: c.channel, storeCode: store.code })), now)
    return { kind: 'store', title: `${store.code} · ${store.name}`, description: `Store · ${countText(cameras.length)}`, cameras }
  }
  if (q.camera) {
    const { data, error } = await supabase
      .from('cameras')
      .select('id, name, channel, stores!inner(code, name, is_active)')
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
    const cameras = await withStatus(supabase, [{ id: data.id, name: data.name, channel: data.channel, storeCode: store.code }], now)
    return { kind: 'camera', title: data.name, description: `Camera · ${store.code} · ${store.name}`, cameras }
  }
  return null
}
