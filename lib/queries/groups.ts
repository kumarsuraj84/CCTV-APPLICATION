import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { coversCamera, type Capabilities, type Capability } from '@/lib/auth/capabilities'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

// Every function here uses the signed-in person's own client, so row-level security decides what comes back: a group appears only
// if they may see one of its cameras (or made it), and its cameras are only the ones they may see.
// Cameras that are switched off, or that belong to a switched-off store, are not part of what people look at.

const MALFORMED_ID = '22P02'

export type GroupListItem = { id: string; name: string; created_by: string | null; camera_count: number }

/**
 * The groups the person may see, each with the number of working cameras in it they may see. With `only`, the count is of the cameras
 * open to the person for that capability (the live index counts cameras they may watch live; a display decision from the request's
 * summary, P2-2: opening the wall checks each camera again in the database).
 */
export async function listVisibleGroups(supabase: Client, only?: { capabilities: Capabilities; capability: Capability }): Promise<GroupListItem[]> {
  const groups = await fetchAll((from, to) => supabase.from('camera_groups').select('id, name, created_by').order('name').order('id').range(from, to))
  if (groups.length === 0) return []
  const items = (await fetchAll((from, to) =>
    supabase
      .from('camera_group_items')
      .select('group_id, camera_id, cameras!inner(store_id, is_active, stores!inner(is_active))')
      .eq('cameras.is_active', true)
      .eq('cameras.stores.is_active', true)
      .order('group_id')
      .order('camera_id')
      .range(from, to),
  )) as unknown as { group_id: string; camera_id: string; cameras: { store_id: string } }[]
  const counts = new Map<string, number>()
  for (const i of items) {
    if (only && !coversCamera(only.capabilities, only.capability, { id: i.camera_id, store_id: i.cameras.store_id })) continue
    counts.set(i.group_id, (counts.get(i.group_id) ?? 0) + 1)
  }
  return groups.map((g) => ({ id: g.id, name: g.name, created_by: g.created_by, camera_count: counts.get(g.id) ?? 0 }))
}

export type GroupCamera = { id: string; channel: number; name: string; store_id: string; store_code: string; store_name: string }
export type GroupDetail = { id: string; name: string; created_by: string | null; cameras: GroupCamera[] }

type ItemRow = { camera_id: string; cameras: { id: string; channel: number; name: string; stores: { id: string; code: string; name: string } } }

/** One group with its cameras (store code, then channel), or null when it does not exist or may not be seen. A read that fails throws. */
export async function getVisibleGroup(supabase: Client, id: string): Promise<GroupDetail | null> {
  const { data: group, error } = await supabase.from('camera_groups').select('id, name, created_by').eq('id', id).maybeSingle()
  if (error) {
    if (error.code === MALFORMED_ID) return null
    throw new Error('Could not read the group.')
  }
  if (!group) return null
  const rows = (await fetchAll((from, to) =>
    supabase
      .from('camera_group_items')
      .select('camera_id, cameras!inner(id, channel, name, stores!inner(id, code, name))')
      .eq('group_id', id)
      .eq('cameras.is_active', true)
      .eq('cameras.stores.is_active', true)
      .order('camera_id')
      .range(from, to),
  )) as unknown as ItemRow[]
  const cameras = rows
    .map((r) => ({ id: r.cameras.id, channel: r.cameras.channel, name: r.cameras.name, store_id: r.cameras.stores.id, store_code: r.cameras.stores.code, store_name: r.cameras.stores.name }))
    .sort((a, b) => a.store_code.localeCompare(b.store_code) || a.channel - b.channel || a.id.localeCompare(b.id))
  return { ...group, cameras }
}

export type StoreCameraChoice = { id: string; channel: number; name: string; in_group: boolean }

/** The visible, working cameras of one store, for choosing what to add; null when the store is not one the person may see (or is switched off). */
export async function listStoreCamerasForGroups(supabase: Client, storeId: string, groupId: string): Promise<StoreCameraChoice[] | null> {
  const { data: store, error } = await supabase.from('stores').select('id').eq('id', storeId).eq('is_active', true).maybeSingle()
  if (error) {
    if (error.code === MALFORMED_ID) return null
    throw new Error('Could not read the store.')
  }
  if (!store) return null
  const [cameras, inGroup] = await Promise.all([
    fetchAll((from, to) => supabase.from('cameras').select('id, channel, name').eq('store_id', storeId).eq('is_active', true).order('channel').order('id').range(from, to)),
    supabase.from('camera_group_items').select('camera_id').eq('group_id', groupId).limit(5000),
  ])
  if (inGroup.error && inGroup.error.code !== MALFORMED_ID) throw new Error('Could not read the group.')
  const present = new Set((inGroup.data ?? []).map((r) => r.camera_id))
  return cameras.map((c) => ({ id: c.id, channel: c.channel, name: c.name, in_group: present.has(c.id) }))
}
