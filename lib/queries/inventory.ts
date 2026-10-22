import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

// Every function here uses the signed-in person's own client, so row-level security decides what comes back.
// Stores, cameras and devices that have been switched off are not part of what people look at, so they are left out.

/** Keeps a search word from changing the meaning of the filter. */
const cleanSearch = (q: string) => q.replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

export type StoreListItem = { id: string; code: string; name: string; city: string | null; zone: string | null; camera_count: number }

export async function listVisibleStores(supabase: Client, q?: string): Promise<StoreListItem[]> {
  const term = cleanSearch(q ?? '')
  // The camera counts come from store_status (switched-on cameras the person may see, per switched-on store). An embedded
  // cameras(count) would need every camera column, and the address column is not readable by signed-in people (P2-1, AC-10).
  const [rows, counts] = await Promise.all([
    fetchAll((from, to) => {
      let query = supabase.from('stores').select('id, code, name, city, zone').eq('is_active', true).order('code').order('id')
      if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%,city.ilike.%${term}%`)
      return query.range(from, to)
    }),
    fetchAll((from, to) => supabase.from('store_status').select('store_id, cameras_total').order('store_id').range(from, to)),
  ])
  const countOf = new Map(counts.map((c) => [c.store_id, c.cameras_total ?? 0]))
  return rows.map((s) => ({ id: s.id, code: s.code, name: s.name, city: s.city, zone: s.zone, camera_count: countOf.get(s.id) ?? 0 }))
}

/** A store with its cameras and devices, or null when it does not exist, is switched off or may not be seen. A read that fails throws. */
export async function getVisibleStore(supabase: Client, id: string) {
  const { data: store, error } = await supabase.from('stores').select('id, code, name, city, zone, state, address, is_active').eq('id', id).eq('is_active', true).maybeSingle()
  if (error) throw new Error('Could not read the store.')
  if (!store) return null
  const [rows, addresses, devices] = await Promise.all([
    fetchAll((from, to) => supabase.from('cameras').select('id, channel, name').eq('store_id', id).eq('is_active', true).order('channel').order('id').range(from, to)),
    // Camera addresses only for people with the IT view of this location (P2-1, AC-4/AC-10); for everyone else this is empty.
    fetchAll((from, to) => supabase.from('camera_endpoints').select('camera_id, camera_ip').eq('store_id', id).order('camera_id').range(from, to)),
    fetchAll((from, to) => supabase.from('devices').select('id, type, name, ip, tcp_port').eq('store_id', id).eq('enabled', true).order('name').order('id').range(from, to)),
  ])
  const ipOf = new Map(addresses.map((a) => [a.camera_id, a.camera_ip]))
  const cameras = rows.map((c) => ({ ...c, camera_ip: ipOf.get(c.id) ?? null }))
  return { ...store, cameras, devices, showsAddresses: addresses.length > 0 }
}

export async function listVisibleDevices(supabase: Client, type?: string) {
  return fetchAll((from, to) => {
    let query = supabase.from('devices').select('id, store_id, type, name, ip, tcp_port, enabled, stores(code, name)').eq('enabled', true).order('name').order('id')
    if (type) query = query.eq('type', type as Database['public']['Enums']['device_type'])
    return query.range(from, to)
  })
}
