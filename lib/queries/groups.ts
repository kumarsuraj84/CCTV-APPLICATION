import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Capabilities, Capability } from '@/lib/auth/capabilities'
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
  // P2-5c-1 review I-7: the counts come from the database in one call (static and dynamic members, counted once, working cameras the
  // reader may see — and with `only`, may use with that capability, the cameras_with_capability rules), never member rows in the page.
  const counts = new Map<string, number>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.rpc('group_member_counts', only ? { p_cap: only.capability } : {}).order('group_id').range(from, from + 999)
    if (error) throw new Error('Could not count the cameras of the groups.')
    for (const r of (data ?? []) as { group_id: string; cameras: number }[]) counts.set(r.group_id, Number(r.cameras))
    if ((data ?? []).length < 1000) break
  }
  return groups.map((g) => ({ id: g.id, name: g.name, created_by: g.created_by, camera_count: counts.get(g.id) ?? 0 }))
}

/** Dynamic members (P2-5c-1) as the database resolves them for the reader: never wider than what they may see. */
async function ruleMembers(supabase: Client, groupId: string | null): Promise<{ group_id: string; camera_id: string }[]> {
  const out: { group_id: string; camera_id: string }[] = []
  for (let from = 0; ; from += 1000) {
    // Review M-5: a stable order, so pages never repeat or skip rows.
    const { data, error } = await supabase.rpc('group_rule_members', groupId ? { p_group: groupId } : {}).order('group_id').order('camera_id').range(from, from + 999)
    if (error) {
      if (error.code === MALFORMED_ID) return []
      throw new Error('Could not read the group.')
    }
    out.push(...((data ?? []) as { group_id: string; camera_id: string }[]))
    if ((data ?? []).length < 1000) return out
  }
}

type CameraRow = { id: string; channel: number; name: string; store_id: string; stores: { id: string; code: string; name: string } }

/** Working cameras (active, at an active location) among these ids, read through the person's own client. */
async function camerasOf(supabase: Client, ids: string[]): Promise<Map<string, CameraRow>> {
  const out = new Map<string, CameraRow>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('cameras').select('id, channel, name, store_id:location_id, stores:locations!inner(id, code, name, is_active)')
      .in('id', ids.slice(i, i + 200)).eq('is_active', true).eq('stores.is_active', true)
    if (error) throw new Error('Could not read the cameras.')
    for (const c of (data ?? []) as unknown as CameraRow[]) out.set(c.id, c)
  }
  return out
}

/** `from_rule`: the camera is in the group only through a dynamic rule (P2-5c-1); it cannot be removed one by one. */
export type GroupCamera = { id: string; channel: number; name: string; store_id: string; store_code: string; store_name: string; from_rule?: true }
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
      .select('camera_id, cameras!inner(id, channel, name, stores:locations!inner(id, code, name))')
      .eq('group_id', id)
      .eq('cameras.is_active', true)
      .eq('cameras.stores.is_active', true)
      .order('camera_id')
      .range(from, to),
  )) as unknown as ItemRow[]
  const byId = new Map<string, GroupCamera>(rows.map((r) => [r.cameras.id, { id: r.cameras.id, channel: r.cameras.channel, name: r.cameras.name, store_id: r.cameras.stores.id, store_code: r.cameras.stores.code, store_name: r.cameras.stores.name }]))
  // P2-5c-1: members added by the group's dynamic rules (intersected with the reader's own access by the database).
  const dynamic = await ruleMembers(supabase, id)
  const extra = await camerasOf(supabase, dynamic.map((d) => d.camera_id).filter((c) => !byId.has(c)))
  for (const c of extra.values()) byId.set(c.id, { id: c.id, channel: c.channel, name: c.name, store_id: c.stores.id, store_code: c.stores.code, store_name: c.stores.name, from_rule: true })
  const cameras = [...byId.values()].sort((a, b) => a.store_code.localeCompare(b.store_code) || a.channel - b.channel || a.id.localeCompare(b.id))
  return { ...group, cameras }
}

export type StoreCameraChoice = { id: string; channel: number; name: string; in_group: boolean }

/** The visible, working cameras of one store, for choosing what to add; null when the store is not one the person may see (or is switched off). */
export async function listStoreCamerasForGroups(supabase: Client, storeId: string, groupId: string): Promise<StoreCameraChoice[] | null> {
  const { data: store, error } = await supabase.from('locations').select('id').eq('id', storeId).eq('is_active', true).maybeSingle()
  if (error) {
    if (error.code === MALFORMED_ID) return null
    throw new Error('Could not read the location.')
  }
  if (!store) return null
  const [cameras, inGroup] = await Promise.all([
    fetchAll((from, to) => supabase.from('cameras').select('id, channel, name').eq('location_id', storeId).eq('is_active', true).order('channel').order('id').range(from, to)),
    supabase.from('camera_group_items').select('camera_id').eq('group_id', groupId).limit(5000),
  ])
  if (inGroup.error && inGroup.error.code !== MALFORMED_ID) throw new Error('Could not read the group.')
  const present = new Set((inGroup.data ?? []).map((r) => r.camera_id))
  return cameras.map((c) => ({ id: c.id, channel: c.channel, name: c.name, in_group: present.has(c.id) }))
}
