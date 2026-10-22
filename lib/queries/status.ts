import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

export type Status = 'up' | 'down' | 'unknown'
export type StoreStatusRow = {
  store_id: string
  cameras_total: number
  cameras_live: number
  cameras_down: number
  cameras_unknown: number
  nvr_status: Status | null
  nvr_down_since: string | null
  nvr_checked_at: string | null
}
export type StateRow = { target_id: string; status: Status; down_since: string | null; last_checked_at: string | null; last_up_at: string | null; error: string | null }
export type Dashboard = {
  cameras: { total: number; live: number; down: number; unknown: number }
  stores: { total: number; nvrDown: { id: string; code: string; name: string; since: string | null }[]; noLiveCamera: number }
  devices: Record<string, { total: number; up: number; down: number; unknown: number }>
  recentOutages: { id: string; kind: 'camera' | 'device' | 'nvr'; label: string; store: string | null; startedAt: string; endedAt: string | null }[]
}

/** The words the screens use. */
export function statusLabel(s: Status | null | undefined): 'Live' | 'Offline' | 'Not checked yet' {
  return s === 'up' ? 'Live' : s === 'down' ? 'Offline' : 'Not checked yet'
}

/** An uptime percentage as the screens show it: one decimal, no trailing ".0", or "No data". */
export function formatUptime(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'No data'
  return `${Number(pct.toFixed(1))}%`
}

// Cameras are checked every 5 minutes and the NVR every minute; these allow a few missed rounds before anything is called stale.
const CAMERA_STALE_MS = 15 * 60_000
const NVR_STALE_MS = 5 * 60_000

/**
 * True when the NVR answers but none of the store's cameras has a recent result. The worker sends no camera results while the NVR
 * refuses its login, so this is how that shows. It is a hint, not proof: a store that was only just added looks the same for a few minutes.
 */
export function nvrLoginProblem(a: { nvr: StateRow | undefined; cameraIds: string[]; cameraStates: Map<string, StateRow>; now: Date }): boolean {
  const { nvr, cameraIds, cameraStates, now } = a
  if (!nvr || nvr.status !== 'up' || cameraIds.length === 0) return false
  const fresh = (iso: string | null, maxAgeMs: number) => !!iso && now.getTime() - new Date(iso).getTime() <= maxAgeMs
  if (!fresh(nvr.last_checked_at, NVR_STALE_MS)) return false
  return !cameraIds.some((id) => fresh(cameraStates.get(id)?.last_checked_at ?? null, CAMERA_STALE_MS))
}

// Everything below reads with the signed-in person's own client, so row-level security decides what is counted and listed.

export async function listStoreStatus(supabase: Client): Promise<Map<string, StoreStatusRow>> {
  const rows = await fetchAll((from, to) => supabase.from('store_status').select('*').order('store_id').range(from, to))
  return new Map(rows.filter((r) => r.store_id).map((r) => [r.store_id as string, r as unknown as StoreStatusRow]))
}

export async function getStates(supabase: Client, type: 'camera' | 'device' | 'nvr', ids: string[]): Promise<Map<string, StateRow>> {
  const out = new Map<string, StateRow>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('check_state')
      .select('target_id, status, down_since, last_checked_at, last_up_at, error')
      .eq('target_type', type)
      .in('target_id', ids.slice(i, i + 100))
    if (error) throw new Error('Could not read the status.')
    for (const r of data ?? []) out.set(r.target_id, r as StateRow)
  }
  return out
}

type OutageRow = { id: string; target_type: string; target_id: string; started_at: string; ended_at: string | null; cause: string | null }
type Recent = Dashboard['recentOutages'][number]

const RECENT_COUNT = 10
const OUTAGE_PAGE = 100
const OUTAGE_MAX_PAGES = 5

/**
 * The newest outages, newest first. A camera that is down only because its NVR is down is not listed again while that NVR outage is
 * still open, because the NVR outage already says so; once the NVR is back, a camera outage it caused is listed on its own.
 * Reads page by page so that a store with many grouped cameras cannot crowd out everything else.
 */
async function recentOutages(supabase: Client, storeById: Map<string, { id: string; code: string; name: string }>): Promise<Recent[]> {
  const openNvr = new Set(
    (await fetchAll((from, to) => supabase.from('outages').select('target_id').eq('target_type', 'nvr').is('ended_at', null).order('target_id').order('id').range(from, to))).map((o) => o.target_id),
  )
  const deviceStore = new Map<string, { name: string; store_id: string | null }>()
  const collected: { o: OutageRow; camera?: { name: string; store_id: string } }[] = []

  for (let page = 0; page < OUTAGE_MAX_PAGES && collected.length < RECENT_COUNT; page++) {
    const { data, error } = await supabase
      .from('outages')
      .select('id, target_type, target_id, started_at, ended_at, cause')
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * OUTAGE_PAGE, (page + 1) * OUTAGE_PAGE - 1)
    if (error) throw new Error('Could not read the outages.')
    const rows = (data ?? []) as OutageRow[]

    const cameraIds = rows.filter((o) => o.target_type === 'camera').map((o) => o.target_id)
    const cameras = new Map<string, { name: string; store_id: string }>()
    for (let i = 0; i < cameraIds.length; i += 100) {
      const res = await supabase.from('cameras').select('id, name, store_id').in('id', cameraIds.slice(i, i + 100))
      if (res.error) throw new Error('Could not read the cameras.')
      for (const c of res.data ?? []) cameras.set(c.id, c)
    }
    for (const o of rows) {
      if (collected.length >= RECENT_COUNT) break
      if (o.target_type === 'camera') {
        const camera = cameras.get(o.target_id)
        if (o.cause === 'nvr_down' && camera && openNvr.has(camera.store_id)) continue
        collected.push({ o, camera })
      } else collected.push({ o })
    }
    if (rows.length < OUTAGE_PAGE) break
  }

  const deviceIds = collected.filter((c) => c.o.target_type === 'device').map((c) => c.o.target_id)
  if (deviceIds.length) {
    const res = await supabase.from('devices').select('id, name, store_id').in('id', deviceIds)
    if (res.error) throw new Error('Could not read the devices.')
    for (const d of res.data ?? []) deviceStore.set(d.id, d)
  }

  return collected.map(({ o, camera }): Recent => {
    const base = { id: o.id, startedAt: o.started_at, endedAt: o.ended_at }
    if (o.target_type === 'camera') return { ...base, kind: 'camera', label: camera?.name ?? 'Camera', store: camera ? (storeById.get(camera.store_id)?.code ?? null) : null }
    if (o.target_type === 'device') {
      const d = deviceStore.get(o.target_id)
      return { ...base, kind: 'device', label: d?.name ?? 'Device', store: d?.store_id ? (storeById.get(d.store_id)?.code ?? null) : null }
    }
    const s = storeById.get(o.target_id)
    return { ...base, kind: 'nvr', label: s?.name ?? 'NVR', store: s?.code ?? null }
  })
}

export async function getDashboard(supabase: Client): Promise<Dashboard> {
  const [statuses, stores, devices, deviceStates] = await Promise.all([
    listStoreStatus(supabase),
    fetchAll((from, to) => supabase.from('stores').select('id, code, name').order('code').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('devices').select('id, type, name, store_id').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('check_state').select('target_id, status').eq('target_type', 'device').order('target_id').range(from, to)),
  ])

  const cameras = { total: 0, live: 0, down: 0, unknown: 0 }
  let noLiveCamera = 0
  for (const s of statuses.values()) {
    cameras.total += s.cameras_total
    cameras.live += s.cameras_live
    cameras.down += s.cameras_down
    cameras.unknown += s.cameras_unknown
    if (s.cameras_total > 0 && s.cameras_live === 0 && s.cameras_unknown === 0) noLiveCamera++
  }
  const storeById = new Map(stores.map((s) => [s.id, s]))
  const nvrDown = [...statuses.values()]
    .filter((s) => s.nvr_status === 'down')
    .map((s) => ({ id: s.store_id, code: storeById.get(s.store_id)?.code ?? '', name: storeById.get(s.store_id)?.name ?? '', since: s.nvr_down_since }))
    .sort((a, b) => a.code.localeCompare(b.code))

  const stateOf = new Map(deviceStates.map((d) => [d.target_id, d.status as Status]))
  const deviceCounts: Dashboard['devices'] = {}
  for (const d of devices) {
    const c = (deviceCounts[d.type] ??= { total: 0, up: 0, down: 0, unknown: 0 })
    const st = stateOf.get(d.id) ?? 'unknown'
    c.total++
    c[st]++
  }

  return { cameras, stores: { total: stores.length, nvrDown, noLiveCamera }, devices: deviceCounts, recentOutages: await recentOutages(supabase, storeById) }
}
