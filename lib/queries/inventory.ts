import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

// Every function here uses the signed-in person's own client, so row-level security decides what comes back.

/** Keeps a search word from changing the meaning of the filter. */
const cleanSearch = (q: string) => q.replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

export type StoreListItem = { id: string; code: string; name: string; city: string | null; zone: string | null; camera_count: number }

export async function listVisibleStores(supabase: Client, q?: string): Promise<StoreListItem[]> {
  const term = cleanSearch(q ?? '')
  const rows = await fetchAll((from, to) => {
    let query = supabase.from('stores').select('id, code, name, city, zone, cameras(count)').order('code').order('id')
    if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%,city.ilike.%${term}%`)
    return query.range(from, to)
  })
  return rows.map((s) => ({
    id: s.id, code: s.code, name: s.name, city: s.city, zone: s.zone,
    camera_count: (s.cameras as unknown as { count: number }[])[0]?.count ?? 0,
  }))
}

export async function getVisibleStore(supabase: Client, id: string) {
  const { data: store } = await supabase.from('stores').select('id, code, name, city, zone, state, address, is_active').eq('id', id).maybeSingle()
  if (!store) return null
  const [cameras, devices] = await Promise.all([
    supabase.from('cameras').select('id, channel, name, camera_ip').eq('store_id', id).order('channel'),
    supabase.from('devices').select('id, type, name, ip, tcp_port').eq('store_id', id).order('name'),
  ])
  return { ...store, cameras: cameras.data ?? [], devices: devices.data ?? [] }
}

export async function listVisibleDevices(supabase: Client, type?: string) {
  return fetchAll((from, to) => {
    let query = supabase.from('devices').select('id, store_id, type, name, ip, tcp_port, enabled, stores(code, name)').order('name').order('id')
    if (type) query = query.eq('type', type as Database['public']['Enums']['device_type'])
    return query.range(from, to)
  })
}

export async function homeCounts(supabase: Client): Promise<{ stores: number; cameras: number; devices: Record<string, number> }> {
  const [stores, cameras, devices] = await Promise.all([
    supabase.from('stores').select('id', { count: 'exact', head: true }),
    supabase.from('cameras').select('id', { count: 'exact', head: true }),
    fetchAll((from, to) => supabase.from('devices').select('id, type').order('id').range(from, to)),
  ])
  const byType: Record<string, number> = {}
  for (const d of devices) byType[d.type] = (byType[d.type] ?? 0) + 1
  return { stores: stores.count ?? 0, cameras: cameras.count ?? 0, devices: byType }
}
