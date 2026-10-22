import type { SupabaseClient } from '@supabase/supabase-js'
import { mapLimit } from '@/lib/async/pool'
import type { Database, Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { isNvrKnownDown } from '@/lib/monitor/nvr-state'
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, RecorderJob, WorkerRequest } from '@/lib/monitor/types'

type Admin = SupabaseClient<Database>

const ID_CHUNK = 100
const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

// P2-5b: the NVR target is the recorder ('recorder', recorders.id). The old ('nvr', location id) kind is gone (contract migration).
const TARGET_TYPES = new Set(['camera', 'device', 'recorder'])

/**
 * A monitored recorder: monitoring switched on (owner addition), its asset enabled, not archived and with an address, its location
 * active and not archived. Anything else is never contacted (no TCP, ISAPI or RTSP) and writes no state.
 */
const RECORDER_COLUMNS =
  'id, org_id, location_id, http_port, rtsp_port, username, monitoring_enabled, assets!recorders_asset_fk!inner(name, ip, enabled, archived_at), locations!recorders_location_fk!inner(code, is_active, archived_at)'
type RecorderRead = {
  id: string; org_id: string; location_id: string; http_port: number; rtsp_port: number; username: string | null; monitoring_enabled: boolean
  assets: { name: string; ip: string | null; enabled: boolean; archived_at: string | null }
  locations: { code: string; is_active: boolean; archived_at: string | null }
}
type MappingRead = { recorder_id: string; channel: number; cameras: { id: string; camera_ip: string | null } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What monitor_apply_results is given. The function trusts its caller, so this is the last gate: every element carries all four of
 * type (a known one), id (a UUID: one bad id would otherwise fail the whole batch), ok and at (never null), and no target appears
 * twice in one batch (the last result for it wins).
 */
export function cleanResults(results: CheckResult[]): Json[] {
  const byTarget = new Map<string, Json>()
  for (const r of results) {
    const valid =
      r !== null && typeof r === 'object' && TARGET_TYPES.has(r.type) && typeof r.id === 'string' && UUID.test(r.id) &&
      typeof r.ok === 'boolean' && typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at))
    if (!valid) continue
    const element: { [key: string]: Json } = { type: r.type, id: r.id, ok: r.ok, at: r.at }
    if (typeof r.method === 'string') element.method = r.method
    if (typeof r.error === 'string') element.error = r.error
    if (r.cause === 'nvr_down') element.cause = r.cause
    byTarget.set(`${r.type}|${r.id}`, element)
  }
  if (byTarget.size !== results.length) logger.warn({ event: 'check_results_adjusted', given: results.length, sent: byTarget.size })
  return [...byTarget.values()]
}

export type SupabaseMonitorDbOptions = {
  /** Only look at this organisation (tests use it so that they never touch other data in the database). The worker leaves it out: it serves all. */
  orgId?: string
}

/** MonitorDb on the service-role client. NVR passwords are read from the vault one recorder at a time and only held in memory. */
export class SupabaseMonitorDb implements MonitorDb {
  private orgId: string | undefined

  constructor(private admin: Admin, opts: SupabaseMonitorDbOptions = {}) {
    this.orgId = opts.orgId
  }

  loadDevices(): Promise<DeviceJob[]> {
    // An NVR is a recorder asset; it is checked as a recorder, never a second time as a device.
    return fetchAll((from, to) => {
      let q = this.admin.from('assets').select('id, org_id, ip, tcp_port').eq('enabled', true).is('archived_at', null).eq('is_recorder', false)
        .not('ip', 'is', null).order('id')
      if (this.orgId) q = q.eq('org_id', this.orgId)
      return q.range(from, to)
    }).then((rows) => rows.map((r) => ({ id: r.id, org_id: r.org_id, ip: r.ip as string, tcp_port: r.tcp_port })))
  }

  /** The monitored recorders (see RECORDER_COLUMNS), optionally only these ids. Never one that is switched off, disabled or archived. */
  private async monitoredRecorders(ids?: string[]): Promise<RecorderRead[]> {
    const parts: (string[] | undefined)[] = ids ? chunks([...new Set(ids)], ID_CHUNK) : [undefined]
    const out: RecorderRead[] = []
    for (const part of parts) {
      if (part && part.length === 0) continue
      const rows = await fetchAll((from, to) => {
        let q = this.admin.from('recorders').select(RECORDER_COLUMNS)
          .eq('monitoring_enabled', true).eq('assets.enabled', true).is('assets.archived_at', null).not('assets.ip', 'is', null)
          .eq('locations.is_active', true).is('locations.archived_at', null).order('id')
        if (this.orgId) q = q.eq('org_id', this.orgId)
        if (part) q = q.in('id', part)
        return q.range(from, to)
      })
      out.push(...(rows as unknown as RecorderRead[]))
    }
    return out
  }

  async loadNvrs(): Promise<NvrJob[]> {
    return (await this.monitoredRecorders()).map((r) => ({ id: r.id, org_id: r.org_id, location_id: r.location_id, ip: r.assets.ip as string, rtsp_port: r.rtsp_port }))
  }

  async loadRecorderJobs(recorderIds?: string[], staleBefore?: Date): Promise<RecorderJob[]> {
    if (recorderIds && recorderIds.length === 0) return []
    const recorders = await this.monitoredRecorders(recorderIds)
    if (recorders.length === 0) return []
    const ids = recorders.map((r) => r.id)
    const cameras = new Map<string, RecorderJob['cameras']>()
    const state = new Map<string, { status: 'up' | 'down' | 'unknown'; checkedAt: string | null }>()
    for (const part of chunks(ids, ID_CHUNK)) {
      // The truth for "which camera is on which channel of which NVR" is the ACTIVE mapping (camera_channel_mappings, valid_to null). A
      // camera without one (just restored, or never mapped) is never probed: it stays "Not checked yet" until it is mapped (review M5).
      const mapped = await fetchAll((from, to) => {
        let q = this.admin.from('camera_channel_mappings')
          .select('recorder_id, channel, cameras!camera_channel_mappings_camera_fk!inner(id, camera_ip)')
          .is('valid_to', null).in('recorder_id', part).eq('cameras.is_active', true).is('cameras.archived_at', null)
        if (this.orgId) q = q.eq('org_id', this.orgId)
        return q.order('recorder_id').order('channel').range(from, to)
      })
      for (const m of mapped as unknown as MappingRead[]) {
        const row = { id: m.cameras.id, channel: m.channel, camera_ip: m.cameras.camera_ip }
        const list = cameras.get(m.recorder_id)
        if (list) list.push(row)
        else cameras.set(m.recorder_id, [row])
      }
      const states = await fetchAll((from, to) => {
        let q = this.admin.from('check_state').select('target_id, status, last_checked_at').eq('target_type', 'recorder').in('target_id', part)
        if (this.orgId) q = q.eq('org_id', this.orgId)
        return q.order('target_id').range(from, to)
      })
      for (const s of states) state.set(s.target_id, { status: s.status as 'up' | 'down' | 'unknown', checkedAt: s.last_checked_at })
    }
    const jobs = await mapLimit(recorders, 10, async (r): Promise<RecorderJob | null> => {
      const st = state.get(r.id)
      const own = cameras.get(r.id) ?? []
      // The one place that decides whether the NVR is known to be down: the checks use the answer as it is.
      const knownDown = isNvrKnownDown(st?.status, st?.checkedAt, staleBefore)
      const job = (password: string): RecorderJob => ({
        id: r.id, org_id: r.org_id, location_id: r.location_id, code: r.locations.code, name: r.assets.name,
        ip: r.assets.ip as string, rtsp_port: r.rtsp_port, http_port: r.http_port, username: r.username ?? '', password,
        nvr_status: st?.status ?? 'unknown', nvr_checked_at: st?.checkedAt ?? null, knownDown, cameras: own,
      })
      // Nothing needs the password when there are no cameras, or when the NVR is known to be down (its cameras are then marked down without logging in).
      if (own.length === 0 || knownDown) return job('')
      // The login of THIS recorder, through the one server function keyed by recorder (it refuses a switched-off NVR).
      const { data, error } = await this.admin.rpc('recorder_read_credential', { p_recorder: r.id })
      if (error) {
        // Not being able to read the password says nothing about the cameras: leave this recorder out of this round instead of reporting a false outage.
        logger.error({ event: 'nvr_credential_read_failed', location: r.locations.code, recorder: r.id, errorCode: error.code })
        return null
      }
      return job(typeof data === 'string' ? data : '')
    })
    return jobs.filter((j): j is RecorderJob => j !== null)
  }

  async applyResults(orgId: string, results: CheckResult[], threshold: number): Promise<void> {
    const clean = cleanResults(results)
    if (clean.length === 0) return
    const { error } = await this.admin.rpc('monitor_apply_results', { p_org: orgId, p_results: clean, p_threshold: threshold })
    if (error) throw new Error(`monitor_apply_results failed: ${error.message}`)
  }

  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string }[]): Promise<void> {
    for (const r of rows) {
      const { error } = await this.admin.from('cameras').update({ camera_ip: r.ip }).eq('id', r.cameraId).eq('org_id', orgId)
      if (error) logger.error({ event: 'camera_ip_save_failed', error })
    }
  }

  async touchHeartbeat(now: Date): Promise<void> {
    const { error } = await this.admin.from('worker_state').update({ last_heartbeat: now.toISOString() }).eq('id', 1)
    if (error) throw new Error(`heartbeat failed: ${error.message}`)
  }

  /** At start-up: if the last heartbeat is older than maxSilenceMs, the worker was not running in between. Remember that period. */
  async recordStartupGap(now: Date, maxSilenceMs: number): Promise<boolean> {
    const { data, error } = await this.admin.from('worker_state').select('last_heartbeat').eq('id', 1).single()
    if (error) throw new Error(`reading the heartbeat failed: ${error.message}`)
    let recorded = false
    const last = data.last_heartbeat ? new Date(data.last_heartbeat) : null
    if (last && now.getTime() - last.getTime() > maxSilenceMs) {
      // The heartbeat is left as it was if this fails, so the next start-up tries to record the same period again.
      await this.recordGap(last, now)
      recorded = true
    }
    await this.touchHeartbeat(now)
    return recorded
  }

  async recordGap(from: Date, to: Date): Promise<void> {
    const { error } = await this.admin.from('monitor_gaps').insert({ started_at: from.toISOString(), ended_at: to.toISOString() })
    if (error) throw new Error(`recording the gap failed: ${error.message}`)
  }

  async markRound(kind: 'devices' | 'cameras', at: Date): Promise<void> {
    const time = at.toISOString()
    const { error } = await this.admin
      .from('worker_state')
      .update(kind === 'devices' ? { last_devices_round_at: time } : { last_cameras_round_at: time })
      .eq('id', 1)
    if (error) throw new Error(`saving the time of the ${kind} round failed: ${error.message}`)
  }

  async readRequest(): Promise<WorkerRequest> {
    const { data, error } = await this.admin.from('worker_state').select('check_requested_at, run_started_at, run_finished_at').eq('id', 1).single()
    if (error) throw new Error(`reading the check request failed: ${error.message}`)
    return {
      requestedAt: data.check_requested_at ? new Date(data.check_requested_at) : null,
      runStartedAt: data.run_started_at ? new Date(data.run_started_at) : null,
      runFinishedAt: data.run_finished_at ? new Date(data.run_finished_at) : null,
    }
  }

  async markRunStarted(at: Date, total: number): Promise<void> {
    const { error } = await this.admin
      .from('worker_state')
      .update({ run_started_at: at.toISOString(), run_finished_at: null, progress_done: 0, progress_total: total })
      .eq('id', 1)
    if (error) throw new Error(`marking the run as started failed: ${error.message}`)
  }

  async markProgress(done: number, total: number): Promise<void> {
    const { error } = await this.admin.from('worker_state').update({ progress_done: done, progress_total: total }).eq('id', 1)
    if (error) throw new Error(`saving the progress failed: ${error.message}`)
  }

  async markRunFinished(at: Date): Promise<void> {
    const { error } = await this.admin.from('worker_state').update({ run_finished_at: at.toISOString() }).eq('id', 1)
    if (error) throw new Error(`marking the run as finished failed: ${error.message}`)
  }
}
