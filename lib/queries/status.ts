import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { mapLimit } from '@/lib/async/pool'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

/**
 * 'off' (owner addition, P2-5a): monitoring of the camera's NVR is switched off — never contacted, shown as "Switched off", not offline.
 * 'unreachable' (P4-L1 review I-3, MC-4): a CAMERA that is down only because its NVR cannot be reached (the checker's method nvr_down,
 * its reason "Recorder not reachable.") — "Recorder not reachable" on every screen, never offline. Only getStates gives it, for cameras;
 * the worker still writes such a camera 'down'.
 */
export type Status = 'up' | 'down' | 'unknown' | 'off' | 'unreachable'
export type StoreStatusRow = {
  store_id: string
  /** The location's recorders the person has the IT view of (0 for everyone else), how many are down, and how many are switched off. */
  recorders_total?: number
  recorders_down?: number
  recorders_monitoring_off?: number
  /** Cameras on a switched-off NVR (not counted as unknown). */
  cameras_monitoring_off?: number
  cameras_total: number
  /** Live and checked recently. */
  cameras_live: number
  /** Down for a reason of their own (P4-L1 review I-3: no longer the cameras of an NVR that cannot be reached). */
  cameras_down: number
  /** Down only because their NVR cannot be reached: "Recorder not reachable" (migration 20261021000040). */
  cameras_recorder_unreachable?: number
  cameras_unknown: number
  /** Were live, but have not been checked for longer than STALE_AFTER_MINUTES. */
  cameras_stale: number
  nvr_status: Status | null
  nvr_down_since: string | null
  nvr_checked_at: string | null
  /** The NVR was live, but has not been checked for longer than STALE_AFTER_MINUTES. */
  nvr_stale: boolean
}
export type StateRow = { target_id: string; status: Status; down_since: string | null; last_checked_at: string | null; last_up_at: string | null; error: string | null }
type KindCounts = { total: number; up: number; down: number; unknown: number; stale: number }
export type Dashboard = {
  /** live excludes stale; live, down, unknown, stale and unreachable (recorder not reachable, P4-L1 MC-4) add up to total less the cameras whose monitoring is off. */
  cameras: { total: number; live: number; down: number; unknown: number; stale: number; unreachable: number }
  /**
   * P2-5b: `nvrDown` lists every NVR (recorder) that is down — one entry per recorder, with its location — and `nvrStale` counts the
   * recorders that were live but have not been checked lately. Recorders are IT information: both are empty without the IT view.
   */
  stores: { total: number; nvrDown: { id: string; locationId: string; code: string; name: string; recorder: string; since: string | null }[]; nvrStale: number }
  devices: Record<string, KindCounts>
  /** `cause`: 'nvr_down' for a camera outage caused by its NVR (shown as "Recorder not reachable", P4-L1 review I-3). */
  recentOutages: { id: string; kind: 'camera' | 'device' | 'recorder'; label: string; store: string | null; startedAt: string; endedAt: string | null; cause: string | null }[]
  /** True when the list may be missing problems because reading stopped at its cap (many outages hidden under NVR outages). */
  recentOutagesLimited: boolean
}

/**
 * A "Live" result older than this many minutes is shown as "Not checked lately" and is not counted as live anywhere.
 * Mirrors monitor_stale_after_minutes() in the database (a test keeps the two equal).
 */
export const STALE_AFTER_MINUTES = 20

/** True when the last check is older than STALE_AFTER_MINUTES. A missing or unreadable time counts as stale. */
export function isStale(lastCheckedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastCheckedAt) return true
  const t = Date.parse(lastCheckedAt)
  if (Number.isNaN(t)) return true
  return now.getTime() - t > STALE_AFTER_MINUTES * 60_000
}

export type StatusWord = 'Live' | 'Offline' | 'Not checked yet' | 'Not checked lately' | 'Switched off' | 'Recorder not reachable'

/**
 * The words the screens use. `stale` only matters for a live result: it is then "Not checked lately".
 * "Not checked yet" still means never checked; offline stays offline however old the result is; "Switched off" is an NVR (or a
 * camera on it) whose monitoring an administrator switched off.
 */
export function statusLabel(s: Status | null | undefined, stale = false): StatusWord {
  if (s === 'off') return 'Switched off'
  if (s === 'unreachable') return 'Recorder not reachable'
  if (s === 'up') return stale ? 'Not checked lately' : 'Live'
  return s === 'down' ? 'Offline' : 'Not checked yet'
}

/**
 * P4-L1 review I-3: what an outage row says. A camera outage caused by its NVR (cause nvr_down) is "Recorder not reachable", any other
 * open outage "Offline"; an outage that ended is "Live" again.
 */
export function outageLabel(o: { kind: 'camera' | 'device' | 'recorder'; cause: string | null; endedAt: string | null }): StatusWord {
  if (o.endedAt) return 'Live'
  return o.kind === 'camera' && o.cause === 'nvr_down' ? 'Recorder not reachable' : 'Offline'
}

/** An uptime percentage as the screens show it: one decimal rounded down, so 100% means exactly 100; "No data" when there is none. */
export function formatUptime(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return 'No data'
  if (pct >= 100) return '100%'
  return `${Math.floor(pct * 10 + 1e-9) / 10}%`
}

// ── Why a camera is offline, for whom (P2-2 ruling on review note 4) ─────────
// Camera status is camera availability, so everybody who may see the camera sees that it is offline and why in camera terms. The
// checker's own words name recorder internals (refused logins, saved addresses and passwords, login methods), which are IT information:
// they are shown only to people with the IT view of the camera's location. Everybody else sees "Recorder not reachable." when the
// camera's NVR is down (the text lib/monitor/checks.ts writes with cause nvr_down), otherwise "The camera is not responding.".
export const MSG_RECORDER_NOT_REACHABLE = 'Recorder not reachable.'
export const MSG_CAMERA_NOT_RESPONDING = 'The camera is not responding.'
/** The text lib/monitor/checks.ts stores for a camera whose NVR is known to be down. */
export const NVR_DOWN_CAMERA_ERROR = 'The NVR is not reachable.'

/**
 * The database already makes this decision (status_reasons, migration 20261021000014: the checker's text is not readable without the
 * IT view); this is the same rule once more on the page, so a reason can never be shown in recorder terms without the IT view.
 */
export function cameraReason(error: string | null | undefined, o: { itView: boolean }): string | null {
  if (!error) return null
  if (o.itView) return error
  if (error === MSG_RECORDER_NOT_REACHABLE || error === NVR_DOWN_CAMERA_ERROR) return MSG_RECORDER_NOT_REACHABLE
  return MSG_CAMERA_NOT_RESPONDING
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

const STATUS_COLUMNS = 'store_id:location_id, cameras_total, cameras_live, cameras_down, cameras_recorder_unreachable, cameras_unknown, cameras_stale, nvr_status, nvr_down_since, nvr_checked_at, nvr_stale, recorders_total, recorders_down, recorders_monitoring_off, cameras_monitoring_off'

export async function listStoreStatus(supabase: Client): Promise<Map<string, StoreStatusRow>> {
  // P2-5a: location_status (was store_status); the nvr_* figures are the worst of the location's recorders (seam D5-9).
  const rows = await fetchAll((from, to) => supabase.from('location_status').select(STATUS_COLUMNS).order('location_id').range(from, to))
  return new Map(rows.filter((r) => r.store_id).map((r) => [r.store_id as string, r as unknown as StoreStatusRow]))
}

/**
 * The status of targets the person may see: cameras, devices or recorders (NVRs, by recorder id; only people with the IT view of the
 * recorder see them at all). A camera or NVR whose monitoring is switched off comes back as status 'off'.
 */
export async function getStates(supabase: Client, type: 'camera' | 'device' | 'recorder', ids: string[]): Promise<Map<string, StateRow>> {
  const out = new Map<string, StateRow>()
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
  const pages = await mapLimit(chunks, 4, async (chunk) => {
    // The checker's own words are not readable by signed-in people (P2-2 fix I-1): the reason of an offline target comes from
    // status_reasons, which gives the checker's text only with the IT view and camera-terms reasons otherwise.
    const { data, error } = await supabase
      .from('check_state')
      .select('target_id, status, down_since, last_checked_at, last_up_at')
      .eq('target_type', type)
      .in('target_id', chunk)
    if (error) throw new Error('Could not read the status.')
    const rows = ((data ?? []) as Omit<StateRow, 'error'>[]).map((r): StateRow => ({ ...r, error: null }))
    const down = rows.filter((r) => r.status === 'down').map((r) => r.target_id)
    if (down.length > 0) {
      const reasons = await supabase.rpc('status_reasons', { p_type: type, p_ids: down })
      if (reasons.error) throw new Error('Could not read the status.')
      const by = new Map((reasons.data ?? []).map((x) => [x.target_id, x.reason]))
      for (const r of rows) {
        r.error = by.get(r.target_id) ?? null
        // P4-L1 review I-3: one rule on every screen — a camera down only because its NVR cannot be reached is not offline.
        if (type === 'camera' && r.status === 'down' && (r.error === MSG_RECORDER_NOT_REACHABLE || r.error === NVR_DOWN_CAMERA_ERROR)) r.status = 'unreachable'
      }
    }
    return rows
  })
  for (const page of pages) for (const r of page) out.set(r.target_id, r)
  // Monitoring switched off (owner addition): never contacted, so "Switched off" rather than "Not checked yet" or a stale state.
  const off = new Set<string>()
  if (type === 'camera' && ids.length > 0) {
    for (const chunk of chunks) {
      const { data, error } = await supabase.rpc('cameras_monitoring_off', { p_ids: chunk })
      if (error) throw new Error('Could not read the status.')
      for (const id of (data as unknown as string[] | null) ?? []) off.add(String(id))
    }
  } else if (type === 'recorder' && ids.length > 0) {
    // recorder_status.monitoring_enabled is "monitored": switched on AND the NVR asset enabled (review M4).
    const { data, error } = await supabase.from('recorder_status').select('recorder_id').in('recorder_id', ids).eq('monitoring_enabled', false)
    if (error) throw new Error('Could not read the status.')
    for (const r of data ?? []) if (r.recorder_id) off.add(r.recorder_id)
  }
  for (const id of off) out.set(id, { target_id: id, status: 'off', down_since: null, last_checked_at: null, last_up_at: null, error: null })
  return out
}

type OutageRow = { id: string; target_type: string; target_id: string; started_at: string; ended_at: string | null; cause: string | null; created_at: string }
type Recent = Dashboard['recentOutages'][number]

const RECENT_COUNT = 10
const OUTAGE_PAGE = 100
const OUTAGE_MAX_PAGES = 5

export type DashboardOptions = { outagePageSize?: number; outageMaxPages?: number }

/**
 * The newest outages, newest first, for recorders, cameras and devices that are switched on. A camera outage is hidden (the NVR outage
 * already says it) only when all of these hold: it is still open, caused by the NVR being down, the open outage of THE CAMERA'S OWN
 * RECORDER (its active mapping; P2-5b) is still open, and it was recorded at or after that NVR outage was recorded. Recorded, not
 * started: the time an outage started is the time of the first failure, which a slow camera round can place just before the NVR's own
 * first failure. Anything else, such as an outage that ended, one left over from an earlier NVR outage, or a camera of ANOTHER NVR of
 * the same location, is listed on its own.
 * Reads page by page so that a recorder with many grouped cameras cannot crowd out everything else. `limited` is true when the reading
 * stopped at its cap with fewer than the wanted number of rows, so that an empty list may only mean "not found yet".
 */
async function recentOutages(
  supabase: Client,
  storeById: Map<string, { id: string; code: string; name: string }>,
  recorderById: Map<string, { location_id: string; name: string }>,
  opts: DashboardOptions = {},
): Promise<{ list: Recent[]; limited: boolean }> {
  const pageSize = opts.outagePageSize ?? OUTAGE_PAGE
  const maxPages = opts.outageMaxPages ?? OUTAGE_MAX_PAGES
  // NVR outages are recorder outages ('recorder', recorder id); recorders (and the camera-to-recorder mappings) are visible to the IT
  // view of the recorder only, so for everybody else nothing is grouped and no recorder outage is listed.
  const openNvr = new Map<string, string>()
  for (const o of await fetchAll((from, to) => supabase.from('outages').select('target_id, created_at').eq('target_type', 'recorder').is('ended_at', null).order('target_id').order('id').range(from, to))) {
    if (recorderById.has(o.target_id)) openNvr.set(o.target_id, o.created_at)
  }
  const groupedUnderNvr = (o: OutageRow, recorderId: string | undefined): boolean => {
    if (o.cause !== 'nvr_down' || o.ended_at !== null || !recorderId) return false
    const nvrRecorded = openNvr.get(recorderId)
    return nvrRecorded !== undefined && new Date(o.created_at).getTime() >= new Date(nvrRecorded).getTime()
  }
  let exhausted = false
  const collected: { o: OutageRow; camera?: { name: string; store_id: string }; device?: { name: string; store_id: string | null }; recorder?: { location_id: string; name: string } }[] = []

  for (let page = 0; page < maxPages && collected.length < RECENT_COUNT; page++) {
    const { data, error } = await supabase
      .from('outages')
      .select('id, target_type, target_id, started_at, ended_at, cause, created_at')
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1)
    if (error) throw new Error('Could not read the outages.')
    const rows = (data ?? []) as OutageRow[]

    // Only things that are switched on are listed: an outage of a store, camera or device that was switched off is history, not a problem.
    const cameras = new Map<string, { name: string; store_id: string }>()
    const recorderOfCamera = new Map<string, string>()
    const cameraIds = rows.filter((o) => o.target_type === 'camera').map((o) => o.target_id)
    for (let i = 0; i < cameraIds.length; i += 100) {
      const part = cameraIds.slice(i, i + 100)
      const res = await supabase.from('cameras').select('id, name, store_id:location_id').eq('is_active', true).in('id', part)
      if (res.error) throw new Error('Could not read the cameras.')
      for (const c of res.data ?? []) cameras.set(c.id, c)
      if (openNvr.size > 0) {
        // The camera's own recorder: its active mapping (readable with the IT view of that recorder only).
        const maps = await supabase.from('camera_channel_mappings').select('camera_id, recorder_id').in('camera_id', part).is('valid_to', null)
        if (maps.error) throw new Error('Could not read the cameras.')
        for (const m of maps.data ?? []) recorderOfCamera.set(m.camera_id, m.recorder_id)
      }
    }
    const devices = new Map<string, { name: string; store_id: string | null }>()
    const deviceIds = rows.filter((o) => o.target_type === 'device').map((o) => o.target_id)
    for (let i = 0; i < deviceIds.length; i += 100) {
      // An NVR that was a device before it became a recorder: its old device history is not a device problem (5a carry-forward).
      const res = await supabase.from('assets').select('id, name, store_id:location_id').eq('enabled', true).eq('is_recorder', false).in('id', deviceIds.slice(i, i + 100))
      if (res.error) throw new Error('Could not read the devices.')
      for (const d of res.data ?? []) devices.set(d.id, d)
    }
    for (const o of rows) {
      if (collected.length >= RECENT_COUNT) break
      if (o.target_type === 'camera') {
        const camera = cameras.get(o.target_id)
        if (!camera || !storeById.has(camera.store_id)) continue
        if (groupedUnderNvr(o, recorderOfCamera.get(o.target_id))) continue
        collected.push({ o, camera })
      } else if (o.target_type === 'device') {
        const device = devices.get(o.target_id)
        if (!device) continue
        collected.push({ o, device })
      } else if (o.target_type === 'recorder') {
        const recorder = recorderById.get(o.target_id)
        if (!recorder || !storeById.has(recorder.location_id)) continue
        collected.push({ o, recorder })
      }
    }
    if (rows.length < pageSize) {
      exhausted = true
      break
    }
  }

  const list = collected.map(({ o, camera, device, recorder }): Recent => {
    const base = { id: o.id, startedAt: o.started_at, endedAt: o.ended_at, cause: o.cause }
    if (camera) return { ...base, kind: 'camera', label: camera.name, store: storeById.get(camera.store_id)?.code ?? null }
    if (device) return { ...base, kind: 'device', label: device.name, store: device.store_id ? (storeById.get(device.store_id)?.code ?? null) : null }
    return { ...base, kind: 'recorder', label: recorder?.name ?? 'NVR', store: recorder ? (storeById.get(recorder.location_id)?.code ?? null) : null }
  })
  return { list, limited: !exhausted && collected.length < RECENT_COUNT }
}

export async function getDashboard(supabase: Client, opts: DashboardOptions = {}, now: Date = new Date()): Promise<Dashboard> {
  // Only locations, recorders and devices that are switched on are counted (location_status and recorder_status leave out the rest).
  const [statuses, stores, devices, deviceStates, recorders] = await Promise.all([
    listStoreStatus(supabase),
    fetchAll((from, to) => supabase.from('locations').select('id, code, name').eq('is_active', true).order('code').order('id').range(from, to)),
    // The NVRs are recorders (counted as NVRs), not devices.
    fetchAll((from, to) => supabase.from('assets').select('id, type, name, store_id:location_id').eq('enabled', true).eq('is_recorder', false).order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('check_state').select('target_id, status, last_checked_at').eq('target_type', 'device').order('target_id').range(from, to)),
    // P2-5b: every recorder the person has the IT view of, with its own state (none for everybody else).
    fetchAll((from, to) => supabase.from('recorder_status').select('recorder_id, location_id, name, status, down_since, stale, monitoring_enabled').order('recorder_id').range(from, to)),
  ])

  const cameras = { total: 0, live: 0, down: 0, unknown: 0, stale: 0, unreachable: 0 }
  for (const s of statuses.values()) {
    cameras.total += s.cameras_total
    cameras.live += s.cameras_live
    cameras.down += s.cameras_down
    cameras.unreachable += s.cameras_recorder_unreachable ?? 0
    cameras.unknown += s.cameras_unknown
    cameras.stale += s.cameras_stale
  }
  const storeById = new Map(stores.map((s) => [s.id, s]))
  const visibleRecorders = recorders.filter((r) => r.recorder_id && r.location_id && storeById.has(r.location_id))
  const recorderById = new Map(visibleRecorders.map((r) => [r.recorder_id as string, { location_id: r.location_id as string, name: r.name ?? 'NVR' }]))
  const nvrStale = visibleRecorders.filter((r) => r.monitoring_enabled && r.stale).length
  const nvrDown = visibleRecorders
    .filter((r) => r.monitoring_enabled && r.status === 'down')
    .map((r) => {
      const s = storeById.get(r.location_id as string)
      return { id: r.recorder_id as string, locationId: r.location_id as string, code: s?.code ?? '', name: s?.name ?? '', recorder: r.name ?? 'NVR', since: r.down_since }
    })
    .sort((a, b) => a.code.localeCompare(b.code) || a.recorder.localeCompare(b.recorder) || a.id.localeCompare(b.id))

  const stateOf = new Map(deviceStates.map((d) => [d.target_id, { status: d.status as Status, lastCheckedAt: d.last_checked_at }]))
  const deviceCounts: Dashboard['devices'] = {}
  for (const d of devices) {
    const c = (deviceCounts[d.type] ??= { total: 0, up: 0, down: 0, unknown: 0, stale: 0 })
    const st = stateOf.get(d.id)
    c.total++
    if (st?.status === 'up' && isStale(st.lastCheckedAt, now)) c.stale++
    else if (st?.status === 'up' || st?.status === 'down') c[st.status]++
    else c.unknown++
  }

  const recent = await recentOutages(supabase, storeById, recorderById, opts)
  return { cameras, stores: { total: stores.length, nvrDown, nvrStale }, devices: deviceCounts, recentOutages: recent.list, recentOutagesLimited: recent.limited }
}
