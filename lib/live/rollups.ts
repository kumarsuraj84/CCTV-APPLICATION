import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { MSG_RECORDER_NOT_REACHABLE, NVR_DOWN_CAMERA_ERROR, type Status } from '@/lib/queries/status'

// P4-L1 brief item 1: roll-up counts per region, cluster and location come from ONE database function, status_rollups (migration
// 20261021000038), evaluated as the signed-in person with the masking of status_reasons: camera figures for the cameras they may see,
// NVR figures only with the IT view of those NVRs (null otherwise, so nothing about NVRs reaches a CCTV-only viewer). Everything
// below is arithmetic and wording on those rows; nothing here decides what anybody may see.

type Client = SupabaseClient<Database>

export type CameraCounts = { total: number; live: number; stale: number; offline: number; recorderUnreachable: number; notChecked: number; off: number }
export type RecorderCounts = { total: number; up: number; down: number; notChecked: number; stale: number; off: number }
export type RollupLevel = 'region' | 'cluster' | 'location'
/** `recorders` is null when the viewer has the IT view of no NVR in the node (always for a CCTV-only viewer). */
export type RollupRow = { level: RollupLevel; id: string; cameras: CameraCounts; recorders: RecorderCounts | null }

type DbRow = Database['public']['Functions']['status_rollups']['Returns'][number]
/** A named region or cluster with its roll-up (the Home dashboard's cards). */
export type RollupCard = { id: string; code: string; name: string; counts: CameraCounts; recorders: RecorderCounts | null }

/** LG-7: the Live landing, its walls and the roll-ups refresh their status every 60 s while the tab is visible (the video does not). */
export const LIVE_STATUS_REFRESH_MS = 60_000

export const ZERO_CAMERAS: CameraCounts = Object.freeze({ total: 0, live: 0, stale: 0, offline: 0, recorderUnreachable: 0, notChecked: 0, off: 0 })

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0)

export function toRollup(r: Pick<DbRow, keyof DbRow> | Record<string, unknown>): RollupRow {
  const x = r as Record<string, unknown>
  const cameras: CameraCounts = {
    total: n(x.cameras_total), live: n(x.cameras_live), stale: n(x.cameras_stale), offline: n(x.cameras_offline),
    recorderUnreachable: n(x.cameras_recorder_unreachable), notChecked: n(x.cameras_not_checked), off: n(x.cameras_off),
  }
  const recorders: RecorderCounts | null = x.recorders_total === null || x.recorders_total === undefined ? null : {
    total: n(x.recorders_total), up: n(x.recorders_up), down: n(x.recorders_down), notChecked: n(x.recorders_not_checked), stale: n(x.recorders_stale), off: n(x.recorders_off),
  }
  return { level: x.level as RollupLevel, id: String(x.node_id), cameras, recorders }
}

/** The rows keyed `level:id`. */
export function indexRollups(rows: readonly (DbRow | Record<string, unknown>)[]): Map<string, RollupRow> {
  return new Map(rows.map((r) => {
    const x = toRollup(r)
    return [`${x.level}:${x.id}`, x]
  }))
}

/**
 * The person's roll-ups. `cap` narrows the camera figures to the cameras usable with that CCTV capability and leaves out rows without
 * one (the Live tree uses cctv.live); without it, any CCTV right counts (the Home dashboard). A read that fails throws.
 */
export async function getRollups(supabase: Client, cap?: 'cctv.live' | 'cctv.playback' | null): Promise<RollupRow[]> {
  const { data, error } = await supabase.rpc('status_rollups', cap ? { p_cap: cap } : {})
  if (error) throw new Error('Could not read the status.')
  return (data ?? []).map((r) => toRollup(r))
}

export function sumCameras(rows: readonly Pick<RollupRow, 'cameras'>[]): CameraCounts {
  const out = { ...ZERO_CAMERAS }
  for (const r of rows) for (const k of Object.keys(out) as (keyof CameraCounts)[]) out[k] += r.cameras[k]
  return out
}

/** Null when no row has NVR figures (the viewer has no IT view there). */
export function sumRecorders(rows: readonly Pick<RollupRow, 'recorders'>[]): RecorderCounts | null {
  const known = rows.map((r) => r.recorders).filter((r): r is RecorderCounts => r !== null)
  if (known.length === 0) return null
  const out: RecorderCounts = { total: 0, up: 0, down: 0, notChecked: 0, stale: 0, off: 0 }
  for (const r of known) for (const k of Object.keys(out) as (keyof RecorderCounts)[]) out[k] += r[k]
  return out
}

/** The state a node's dot shows (always next to words): the most important thing first. */
export type NodeState = 'offline' | 'unreachable' | 'not_checked' | 'live' | 'off' | 'empty'
export function nodeState(c: CameraCounts): NodeState {
  if (c.total === 0) return 'empty'
  if (c.offline > 0) return 'offline'
  if (c.recorderUnreachable > 0) return 'unreachable'
  if (c.notChecked + c.stale > 0) return 'not_checked'
  if (c.live > 0) return 'live'
  return 'off'
}

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** "4 cameras: 1 live, 1 offline, 2 recorder not reachable" — camera words only (never NVR detail). */
export function countsText(c: CameraCounts): string {
  if (c.total === 0) return 'No cameras'
  const parts = [`${c.live} live`]
  if (c.offline) parts.push(`${c.offline} offline`)
  if (c.recorderUnreachable) parts.push(`${c.recorderUnreachable} recorder not reachable`)
  if (c.notChecked + c.stale) parts.push(`${c.notChecked + c.stale} not checked`)
  if (c.off) parts.push(`${c.off} switched off`)
  return `${plural(c.total, 'camera', 'cameras')}: ${parts.join(', ')}`
}

/** "2 NVRs: 1 down" — only for the IT view (null in, null out). */
export function recorderText(r: RecorderCounts | null): string | null {
  if (!r) return null
  const parts: string[] = []
  if (r.down) parts.push(`${r.down} down`)
  if (r.notChecked + r.stale) parts.push(`${r.notChecked + r.stale} not checked`)
  if (r.off) parts.push(`${r.off} switched off`)
  return `${plural(r.total, 'NVR', 'NVRs')}: ${parts.length ? parts.join(', ') : 'all up'}`
}

/**
 * One camera's honest state. A camera that is down because its NVR is not reachable (the reason in camera terms, or the checker's own
 * words for the IT view) is "Recorder not reachable" — unknown, not a confirmed camera failure. "Switched off" is an NVR whose
 * monitoring an administrator switched off (maintenance): never contacted.
 */
export type CameraState = 'live' | 'offline' | 'unreachable' | 'not_checked' | 'stale' | 'off'
export const CAMERA_STATE_LABEL: Record<CameraState, string> = {
  live: 'Live', offline: 'Offline', unreachable: 'Recorder not reachable', not_checked: 'Not checked yet', stale: 'Not checked lately', off: 'Switched off',
}
export function cameraState(s: { status: Status | null | undefined; stale: boolean; reason: string | null | undefined }): CameraState {
  if (s.status === 'off') return 'off'
  if (s.status === 'up') return s.stale ? 'stale' : 'live'
  if (s.status === 'down') return s.reason === MSG_RECORDER_NOT_REACHABLE || s.reason === NVR_DOWN_CAMERA_ERROR ? 'unreachable' : 'offline'
  return 'not_checked'
}
