import type { SupabaseClient } from '@supabase/supabase-js'
import { mapLimit } from '@/lib/async/pool'
import type { Database, Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { isLeaseLost, LEASE_REFUSED_SQLSTATE, LeaseLostError, type LeaseFence } from '@/lib/monitor/lease'
import { isNvrKnownDown } from '@/lib/monitor/nvr-state'
import { registerEndpoints } from '@/lib/security/targets'
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
    // A camera result must name its recorder with a UUID (review M-3; required since P2-6); the database then checks the camera's mapping.
    if (r.type === 'camera' && (typeof r.recorder !== 'string' || !UUID.test(r.recorder))) continue
    const element: { [key: string]: Json } = { type: r.type, id: r.id, ok: r.ok, at: r.at }
    if (r.type === 'camera' && typeof r.recorder === 'string') element.recorder = r.recorder.toLowerCase()
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
  /**
   * P2-7 (D-8): the lease epoch this data layer writes for (WorkerLease.fence()). Every write carries its lease name and token and is
   * checked by the database in the same transaction; without a valid token nothing is sent. Reads need no lease.
   */
  fence?: LeaseFence
}

type FenceArgs = { p_lease: string; p_fencing_token: number }
/** A worker clock further than this from the database clock is warned about (and the database dates results more than this ahead now()). */
export const CLOCK_SKEW_WARN_MS = 30_000
type RpcError = { code?: string; message: string } | null

/**
 * MonitorDb on the worker's database client (P2-6: the monitor_worker role, lib/supabase/service-clients.ts). NVR passwords are read
 * from the vault one recorder at a time (logged, never the value) and only held in memory. P2-7: every write is a fenced database
 * function (monitor_apply_results, monitor_heartbeat, monitor_record_gap, monitor_mark_round, monitor_run_started/progress/finished,
 * monitor_save_camera_ips); the worker's role can no longer write a table directly.
 */
export class SupabaseMonitorDb implements MonitorDb {
  private orgId: string | undefined
  private fence: LeaseFence | undefined
  /** The clock difference last warned about; null while in step. */
  private skewWarnedAt: number | null = null

  constructor(private admin: Admin, opts: SupabaseMonitorDbOptions = {}) {
    this.orgId = opts.orgId
    this.fence = opts.fence
  }

  /** The lease arguments of a write, or LeaseLostError when this worker holds no valid lease (then nothing is sent). */
  private fenced(): FenceArgs {
    const token = this.fence?.token() ?? null
    if (!this.fence || token === null) throw new LeaseLostError('This worker holds no valid lease, so nothing is written (another worker may hold it).')
    return { p_lease: this.fence.name, p_fencing_token: token }
  }

  /** A fenced write. A refusal by the fence ends this lease epoch (LeaseLostError); any other error keeps its old wording. */
  private async write(fn: string, args: Record<string, unknown>, what: string): Promise<unknown> {
    const fence = this.fenced()
    const { data, error } = (await this.admin.rpc(fn as never, { ...args, ...fence } as never)) as { data: unknown; error: RpcError }
    if (error?.code === LEASE_REFUSED_SQLSTATE) {
      this.fence?.lost('write_refused')
      throw new LeaseLostError(`The database refused the write (${fn}): ${error.message}`)
    }
    if (error) throw new Error(`${what} failed: ${error.message}`)
    return data
  }

  loadDevices(): Promise<DeviceJob[]> {
    // An NVR is a recorder asset; it is checked as a recorder, never a second time as a device.
    return fetchAll((from, to) => {
      let q = this.admin.from('assets').select('id, org_id, ip, tcp_port').eq('enabled', true).is('archived_at', null).eq('is_recorder', false)
        .not('ip', 'is', null).order('id')
      if (this.orgId) q = q.eq('org_id', this.orgId)
      return q.range(from, to)
    }).then((rows) => {
      // P2-6 (SO-4): a device read from the database is a registered endpoint (its port, or a ping when it has none).
      registerEndpoints(rows.map((r) => ({ host: r.ip, port: r.tcp_port })))
      return rows.map((r) => ({ id: r.id, org_id: r.org_id, ip: r.ip as string, tcp_port: r.tcp_port }))
    })
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
    // P2-6 (SO-4): a monitored NVR read from the database is a registered endpoint (its web and video ports).
    registerEndpoints(out.flatMap((r) => [{ host: r.assets.ip, port: r.http_port }, { host: r.assets.ip, port: r.rtsp_port }]))
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
      // The login of THIS recorder, through the one logged credential read keyed by recorder (P2-6: purpose `monitoring`, the worker's
      // own database role; it refuses a switched-off NVR).
      const { data, error } = await this.admin.rpc('recorder_credential_read', { p_recorder: r.id, p_purpose: 'monitoring' })
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
    await this.write('monitor_apply_results', { p_org: orgId, p_results: clean, p_threshold: threshold }, 'monitor_apply_results')
  }

  async saveCameraIps(orgId: string, rows: { cameraId: string; ip: string; recorderId: string }[]): Promise<void> {
    if (rows.length === 0) return
    // One fenced call. Only while the camera is still on the NVR that reported the address (a camera moved meanwhile keeps its new
    // NVR's address); the database also skips anything that is not a plain address. A failure is logged: addresses are a bonus.
    try {
      await this.write('monitor_save_camera_ips', { p_org: orgId, p_rows: rows.map((r) => ({ camera: r.cameraId, ip: r.ip, recorder: r.recorderId })) }, 'saving camera addresses')
    } catch (e) {
      if (isLeaseLost(e)) throw e
      logger.error({ event: 'camera_ip_save_failed', error: e })
    }
  }

  async touchHeartbeat(now: Date): Promise<void> {
    // Review round 1 (I-1): the database answers how far this worker's clock is from its own (milliseconds, + = worker ahead). Result
    // times come from the worker's clock, so a difference over 30 s is logged once (and once more when it is back in step); the worker
    // status shows it too (lib/monitor/health.ts).
    const skewMs = Number(await this.write('monitor_heartbeat', { p_at: now.toISOString() }, 'heartbeat'))
    if (!Number.isFinite(skewMs)) return
    const off = Math.abs(skewMs) > CLOCK_SKEW_WARN_MS
    if (off && this.skewWarnedAt === null) {
      this.skewWarnedAt = skewMs
      logger.warn({
        event: 'worker_clock_skew', aheadOfDatabaseSec: Math.round(skewMs / 1000),
        message: 'This computer\'s clock differs from the database\'s by more than 30 seconds. Results are dated with this clock; set the clock right (time sync).',
      })
    } else if (!off && this.skewWarnedAt !== null) {
      this.skewWarnedAt = null
      logger.info({ event: 'worker_clock_in_step', aheadOfDatabaseSec: Math.round(skewMs / 1000) })
    }
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
    await this.write('monitor_record_gap', { p_from: from.toISOString(), p_to: to.toISOString() }, 'recording the gap')
  }

  async markRound(kind: 'devices' | 'cameras', at: Date): Promise<void> {
    // The database calls the round of devices and NVRs 'assets' (the P2-5a word).
    await this.write('monitor_mark_round', { p_kind: kind === 'devices' ? 'assets' : 'cameras', p_at: at.toISOString() }, `saving the time of the ${kind} round`)
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
    await this.write('monitor_run_started', { p_at: at.toISOString(), p_total: total }, 'marking the run as started')
  }

  async markProgress(done: number, total: number): Promise<void> {
    await this.write('monitor_run_progress', { p_done: done, p_total: total }, 'saving the progress')
  }

  async markRunFinished(at: Date): Promise<void> {
    await this.write('monitor_run_finished', { p_at: at.toISOString() }, 'marking the run as finished')
  }
}
