import type { SupabaseClient } from '@supabase/supabase-js'
import { mapLimit } from '@/lib/async/pool'
import type { Database, Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { isNvrKnownDown } from '@/lib/monitor/nvr-state'
import type { CheckResult, DeviceJob, MonitorDb, NvrJob, StoreJob, WorkerRequest } from '@/lib/monitor/types'

type Admin = SupabaseClient<Database>

const ID_CHUNK = 100
const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

const TARGET_TYPES = new Set(['camera', 'device', 'nvr'])
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

/** MonitorDb on the service-role client. NVR passwords are read from the vault one store at a time and only held in memory. */
export class SupabaseMonitorDb implements MonitorDb {
  private orgId: string | undefined

  constructor(private admin: Admin, opts: SupabaseMonitorDbOptions = {}) {
    this.orgId = opts.orgId
  }

  loadDevices(): Promise<DeviceJob[]> {
    return fetchAll((from, to) => {
      let q = this.admin.from('devices').select('id, org_id, ip, tcp_port').eq('enabled', true).order('id')
      if (this.orgId) q = q.eq('org_id', this.orgId)
      return q.range(from, to)
    })
  }

  loadNvrs(): Promise<NvrJob[]> {
    return fetchAll((from, to) => {
      let q = this.admin.from('stores').select('id, org_id, nvr_ip, rtsp_port').eq('is_active', true).order('id')
      if (this.orgId) q = q.eq('org_id', this.orgId)
      return q.range(from, to)
    }).then((rows) => rows.map((r) => ({ id: r.id, org_id: r.org_id, ip: r.nvr_ip, rtsp_port: r.rtsp_port })))
  }

  async loadStoreJobs(storeIds?: string[], staleBefore?: Date): Promise<StoreJob[]> {
    const parts: (string[] | undefined)[] = storeIds ? chunks([...new Set(storeIds)], ID_CHUNK) : [undefined]
    const stores = []
    const cameras = []
    for (const part of parts) {
      stores.push(
        ...(await fetchAll((from, to) => {
          let q = this.admin.from('stores').select('id, org_id, code, nvr_ip, rtsp_port, http_port, nvr_username').eq('is_active', true).order('id')
          if (this.orgId) q = q.eq('org_id', this.orgId)
          if (part) q = q.in('id', part)
          return q.range(from, to)
        })),
      )
      cameras.push(
        ...(await fetchAll((from, to) => {
          let q = this.admin.from('cameras').select('id, store_id, channel, camera_ip').eq('is_active', true).order('store_id').order('channel')
          if (this.orgId) q = q.eq('org_id', this.orgId)
          if (part) q = q.in('store_id', part)
          return q.range(from, to)
        })),
      )
    }
    if (stores.length === 0) return []
    const wanted = new Set(stores.map((s) => s.id))
    const states = await fetchAll((from, to) => {
      let q = this.admin.from('check_state').select('target_id, status, last_checked_at').eq('target_type', 'nvr').order('target_id')
      if (this.orgId) q = q.eq('org_id', this.orgId)
      return q.range(from, to)
    })
    const nvrState = new Map(states.map((s) => [s.target_id, { status: s.status as 'up' | 'down' | 'unknown', checkedAt: s.last_checked_at }]))
    const byStore = new Map<string, StoreJob['cameras']>()
    for (const c of cameras) {
      if (!wanted.has(c.store_id)) continue
      const row = { id: c.id, channel: c.channel, camera_ip: c.camera_ip }
      const list = byStore.get(c.store_id)
      if (list) list.push(row)
      else byStore.set(c.store_id, [row])
    }
    const jobs = await mapLimit(stores, 10, async (s): Promise<StoreJob | null> => {
      const state = nvrState.get(s.id)
      const cameras = byStore.get(s.id) ?? []
      // The one place that decides whether the NVR is known to be down: the checks use the answer as it is.
      const knownDown = isNvrKnownDown(state?.status, state?.checkedAt, staleBefore)
      const job = (password: string): StoreJob => ({
        id: s.id, org_id: s.org_id, code: s.code, ip: s.nvr_ip, rtsp_port: s.rtsp_port, http_port: s.http_port,
        username: s.nvr_username, password, nvr_status: state?.status ?? 'unknown', nvr_checked_at: state?.checkedAt ?? null, knownDown, cameras,
      })
      // Nothing needs the password when there are no cameras, or when the NVR is known to be down (its cameras are then marked down without logging in).
      if (cameras.length === 0 || knownDown) return job('')
      const { data, error } = await this.admin.rpc('nvr_read_credential', { p_store: s.id })
      if (error) {
        // Not being able to read the password says nothing about the cameras: leave this store out of this round instead of reporting a false outage.
        logger.error({ event: 'nvr_credential_read_failed', store: s.code, errorCode: error.code })
        return null
      }
      return job(data ?? '')
    })
    return jobs.filter((j): j is StoreJob => j !== null)
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
