import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { holds, type Capabilities, type Capability } from '@/lib/auth/capabilities'
import { listVisibleStores, type StoreListItem } from '@/lib/queries/inventory'

type Client = SupabaseClient<Database>

// Index lists per capability (P2-2): which stores to offer on the Live and Playback screens, with how many cameras the person may use
// there. A display decision from the request's summary (lib/auth/capabilities.ts); rows still come through the person's own client, and
// opening anything is checked again by the database. A store covered whole (organisation or location grant) counts all its working
// cameras; otherwise only the person's granted cameras that are working are counted.

const PIECE = 100

export async function storesForCapability(supabase: Client, caps: Capabilities, cap: Capability): Promise<StoreListItem[]> {
  const scope = caps.grants[cap]
  if (!holds(caps, cap) || !scope) return []
  const stores = await listVisibleStores(supabase)
  if (scope.organization) return stores.filter((s) => s.camera_count > 0)
  const whole = new Set(scope.locations)
  const perStore = new Map<string, number>()
  for (let i = 0; i < scope.cameras.length; i += PIECE) {
    const { data, error } = await supabase.from('cameras').select('id, store_id').in('id', scope.cameras.slice(i, i + PIECE)).eq('is_active', true)
    if (error) throw new Error('Could not read the cameras.')
    for (const c of data ?? []) if (!whole.has(c.store_id)) perStore.set(c.store_id, (perStore.get(c.store_id) ?? 0) + 1)
  }
  return stores
    .map((s) => (whole.has(s.id) ? s : { ...s, camera_count: perStore.get(s.id) ?? 0 }))
    .filter((s) => (whole.has(s.id) || perStore.has(s.id)) && s.camera_count > 0)
}
