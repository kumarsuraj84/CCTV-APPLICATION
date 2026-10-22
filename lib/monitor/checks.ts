import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { mapLimit } from '@/lib/async/pool'
import { describeNvrError, NvrError } from '@/lib/nvr/client'
import { logger } from '@/lib/observability/logger'
import { isValidHost, isValidPort } from '@/lib/probes'
import type { CheckResult, MonitorConfig, MonitorDb, Probes, RecorderJob } from '@/lib/monitor/types'

export type Deps = { db: MonitorDb; probes: Probes; cfg: MonitorConfig; clock: () => Date }

type WithOrg = CheckResult & { org: string }

const CHUNK = 200

const BAD_DEVICE = 'The address or port saved for this device is not valid.'
// P2-5b: the address is the recorder's own (a location may have several NVRs).
const BAD_NVR = 'The address saved for this NVR is not valid.'

/**
 * Runs `fn` after every earlier call with the same key (on the same database) has finished. monitor_apply_results trusts its caller:
 * a result older than the stored one would overwrite newer state, so two runs over the same targets must never overlap.
 * A failing call does not hold up the next one.
 */
const lanes = new WeakMap<object, Map<string, Promise<void>>>()
function serialised<T>(owner: object, key: string, fn: () => Promise<T>): Promise<T> {
  let map = lanes.get(owner)
  if (!map) lanes.set(owner, (map = new Map()))
  const lane = map
  const run = (lane.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  lane.set(key, tail)
  void tail.then(() => {
    if (lane.get(key) === tail) lane.delete(key)
  })
  return run
}

/** Sends the results to the database, one organisation at a time, at most CHUNK per call, one result per target. A failing call is logged and the rest go on. */
async function applyGrouped(deps: Deps, results: WithOrg[], threshold: number): Promise<void> {
  const unique = new Map<string, WithOrg>()
  for (const r of results) unique.set(`${r.org}|${r.type}|${r.id}`, r)
  const byOrg = new Map<string, CheckResult[]>()
  for (const { org, ...r } of unique.values()) {
    const list = byOrg.get(org)
    if (list) list.push(r)
    else byOrg.set(org, [r])
  }
  for (const [org, list] of byOrg) {
    for (let i = 0; i < list.length; i += CHUNK) {
      try {
        await deps.db.applyResults(org, list.slice(i, i + CHUNK), threshold)
      } catch (e) {
        logger.error({ event: 'apply_results_failed', org, error: e })
      }
    }
  }
}

const present = <T>(x: T | null): x is T => x !== null

/** Servers, attendance machines, footfall counters and other devices: a TCP connect, or a ping when there is no port. */
export function checkDevices(deps: Deps): Promise<number> {
  return serialised(deps.db, 'devices', async () => {
    const began = deps.clock()
    let devices
    try {
      devices = await deps.db.loadDevices()
    } catch (e) {
      logger.error({ event: 'devices_load_failed', error: e })
      return 0
    }
    const results = await mapLimit(devices, deps.cfg.deviceConcurrency, async (d): Promise<WithOrg | null> => {
      try {
        const port = d.tcp_port
        const method = port === null ? 'icmp' : 'tcp'
        if (!isValidHost(d.ip) || (port !== null && !isValidPort(port))) {
          return { org: d.org_id, type: 'device', id: d.id, ok: false, at: deps.clock().toISOString(), method, error: BAD_DEVICE }
        }
        const r = port === null ? await deps.probes.icmp(d.ip) : await deps.probes.tcp(d.ip, port, deps.cfg.tcpTimeoutMs)
        return { org: d.org_id, type: 'device', id: d.id, ok: r.ok, at: deps.clock().toISOString(), method, error: r.error }
      } catch (e) {
        // A bug in a probe says nothing about the device: record nothing rather than a false outage.
        logger.error({ event: 'device_check_failed', device: d.id, error: e })
        return null
      }
    })
    await applyGrouped(deps, results.filter(present), deps.cfg.failThreshold)
    logRound(deps, 'devices', began, devices.length)
    return devices.length
  })
}

/** Every NVR (recorder) itself: can its video port be reached? One result per recorder: ('recorder', recorder id). */
export function checkNvrs(deps: Deps): Promise<number> {
  return serialised(deps.db, 'nvrs', async () => {
    const began = deps.clock()
    let nvrs
    try {
      nvrs = await deps.db.loadNvrs()
    } catch (e) {
      logger.error({ event: 'nvrs_load_failed', error: e })
      return 0
    }
    const results = await mapLimit(nvrs, deps.cfg.deviceConcurrency, async (n): Promise<WithOrg | null> => {
      try {
        if (!isValidHost(n.ip) || !isValidPort(n.rtsp_port)) {
          return { org: n.org_id, type: 'recorder', id: n.id, ok: false, at: deps.clock().toISOString(), method: 'tcp', error: BAD_NVR }
        }
        const r = await deps.probes.tcp(n.ip, n.rtsp_port, deps.cfg.tcpTimeoutMs)
        return { org: n.org_id, type: 'recorder', id: n.id, ok: r.ok, at: deps.clock().toISOString(), method: 'tcp', error: r.error }
      } catch (e) {
        logger.error({ event: 'nvr_check_failed', recorder: n.id, error: e })
        return null
      }
    })
    await applyGrouped(deps, results.filter(present), deps.cfg.failThreshold)
    logRound(deps, 'nvrs', began, nvrs.length)
    return nvrs.length
  })
}

/**
 * Plain wording for why a camera failed, from what its RTSP check answered (0 = nothing), whether the recorder listed the camera's channel
 * (only when it gave a list at all) and why the NVR could not be asked.
 */
function cameraProblem(code: number | undefined, unlisted: boolean, nvrProblem: string | undefined): string {
  // The RTSP check goes through the recorder, so a refused login is the recorder's, not proof about one camera.
  if (code === 401) return 'The recorder refused the login.'
  if (unlisted) return 'The recorder does not list this camera.'
  if (code !== undefined && code !== 0) return 'The camera gave an answer this app does not expect.'
  return nvrProblem ?? 'The camera did not answer.'
}

/** How long an NVR "down" stays believable: three device-check intervals. The data layer applies it (see isNvrKnownDown). */
export const nvrStateMaxAgeMs = (cfg: MonitorConfig): number => 3 * cfg.deviceCheckSec * 1000

/** Logs how many targets a round covered and how long it took (never anything about the targets themselves). */
function logRound(deps: Deps, kind: 'devices' | 'nvrs' | 'cameras', began: Date, count: number): void {
  logger.info({ event: 'round_finished', kind, count, durationMs: Math.max(0, deps.clock().getTime() - began.getTime()) })
}

/**
 * Back-off after a refused NVR login (ruling R9, per recorder since P2-5b). A recorder that keeps getting a wrong password locks the
 * account, so after an ISAPI "auth" or "forbidden" answer that recorder is not asked again (no ISAPI, no RTSP) until the window is over or
 * its saved login changes; other NVRs of the same location go on as normal. Kept in memory only, per database object, keyed by recorder id,
 * and holds a hash of the login, never the password.
 */
type Backoff = { until: number; login: string }
const backoffs = new WeakMap<object, Map<string, Backoff>>()
const backoffOf = (db: object): Map<string, Backoff> => {
  let m = backoffs.get(db)
  if (!m) backoffs.set(db, (m = new Map()))
  return m
}
/** Identifies the saved login (address, port, user name, password) without keeping any of it readable. */
const loginFingerprint = (s: RecorderJob): string => createHash('sha256').update(`${s.ip}|${s.http_port}|${s.username}:${s.password}`).digest('hex')

/** How many recorders are being left alone right now (for tests). */
export const loginBackoffCount = (db: object): number => backoffOf(db).size

/** True while this recorder must not be asked. An ended back-off, or one for a login that has since changed, is removed. */
function inBackoff(deps: Deps, s: RecorderJob): boolean {
  const map = backoffOf(deps.db)
  const entry = map.get(s.id)
  if (!entry) return false
  if (deps.clock().getTime() >= entry.until || entry.login !== loginFingerprint(s)) {
    map.delete(s.id)
    return false
  }
  return true
}

/** Forgets the back-off of every recorder whose window is over, also for recorders that are never checked again. */
function pruneBackoffs(deps: Deps): void {
  const map = backoffOf(deps.db)
  const now = deps.clock().getTime()
  for (const [id, entry] of map) if (now >= entry.until) map.delete(id)
}

/** A camera address the NVR reports is kept only when it is a plain IP address. */
const plainIp = (ip: string | null): ip is string => typeof ip === 'string' && isIP(ip) !== 0 && !ip.includes('%')

async function runRecorderCameras(deps: Deps, s: RecorderJob): Promise<void> {
  if (s.cameras.length === 0) return
  const at = deps.clock().toISOString()

  // A recorder already known to be down: ITS cameras (only the ones mapped to it) are down for the same reason, at once, with nothing
  // else to ask. Cameras of the location's other NVRs are their own jobs and are not touched.
  if (s.knownDown) {
    await deps.db.applyResults(
      s.org_id,
      s.cameras.map((c): CheckResult => ({ type: 'camera', id: c.id, recorder: s.id, ok: false, at, method: 'nvr_down', error: 'The NVR is not reachable.', cause: 'nvr_down' })),
      1,
    )
    return
  }

  // An address that cannot be used is a failed check with a plain message, never a probe aimed at something odd.
  if (!isValidHost(s.ip) || !isValidPort(s.http_port) || !isValidPort(s.rtsp_port)) {
    await deps.db.applyResults(
      s.org_id,
      s.cameras.map((c): CheckResult => ({ type: 'camera', id: c.id, recorder: s.id, ok: false, at, method: 'none', error: BAD_NVR })),
      deps.cfg.failThreshold,
    )
    return
  }

  // Left alone after a refused login: nothing is sent to this NVR and nothing is recorded for its cameras.
  if (inBackoff(deps, s)) return

  const online = new Map<number, boolean>()
  const rtspCode = new Map<number, number>()
  const skipped = new Set<number>()
  const addresses = new Map<number, string>()
  let method = 'rtsp'
  let nvrProblem: string | undefined
  // A wrong or missing NVR password: a refused login says nothing about the cameras (see below).
  let loginProblem = s.password === ''
  let refused = false
  // The channels the recorder says it has, when it said (from either of its answers). Empty = not known.
  const listed = new Set<number>()
  const nvr = deps.probes.nvr({ host: s.ip, port: s.http_port, username: s.username, password: s.password }, { timeoutMs: deps.cfg.nvrTimeoutMs })
  if (loginProblem) {
    nvrProblem = 'The NVR has no saved password.' // nothing to log in with, so the NVR is not even asked
  } else {
    // The camera list is worth asking for after a good status answer, or after one that could not be read. Not after a timeout or an
    // unreachable recorder: the second question would only wait as long as the first.
    let askForChannels = true
    try {
      for (const [ch, on] of await nvr.channelStatus()) {
        online.set(ch, on)
        listed.add(ch)
      }
      method = 'isapi'
    } catch (e) {
      nvrProblem = describeNvrError(e)
      if (e instanceof NvrError && (e.kind === 'auth' || e.kind === 'forbidden')) loginProblem = refused = true
      if (e instanceof NvrError && (e.kind === 'timeout' || e.kind === 'unreachable')) askForChannels = false
    }
    if (!loginProblem && askForChannels) {
      try {
        for (const c of await nvr.channels()) {
          listed.add(c.channel)
          if (plainIp(c.ip)) addresses.set(c.channel, c.ip)
        }
      } catch {
        // Camera addresses are a bonus here; names and channels come from discovery.
      }
    }
  }
  // The web login worked, so a refused video login below is about that camera alone. Without it, a refused video login is a login problem.
  const verified = method === 'isapi'
  const unconfirmed = s.cameras.filter((c) => online.get(c.channel) !== true)
  if (unconfirmed.length > 0) {
    // After the first refused video login no other camera is tried: every try with a wrong password counts against the recorder's account.
    let stopRtsp = false
    let sawRefusal = false
    let loginProven = false
    // The camera is asked through the NVR (its video port, the camera's channel), never at an address the NVR reported.
    const probe = async (c: RecorderJob['cameras'][number]): Promise<void> => {
      if (stopRtsp) {
        skipped.add(c.channel)
        return
      }
      try {
        const { code } = await deps.probes.rtsp({ host: s.ip, port: s.rtsp_port, username: s.username, password: s.password, channel: c.channel })
        if (code === 401 && loginProblem) {
          // The web login was already refused (or there is no password): this says nothing about the camera. No result, no false down, no false up.
          stopRtsp = true
          skipped.add(c.channel)
          return
        }
        if (code === 401 && !verified && !loginProven) {
          // Nothing has proven the login yet, and the recorder refused it: stop trying other cameras. Whether this is a login problem is
          // decided below, once every answer is in: any answer that is not a refusal proves the login works.
          sawRefusal = true
          stopRtsp = true
          skipped.add(c.channel)
          return
        }
        // Any answer from a camera other than "nothing" or "refused" shows the saved login is accepted. A refusal after that is that camera's own.
        if (code !== 0 && code !== 401) loginProven = true
        rtspCode.set(c.channel, code)
        online.set(c.channel, code === 200)
      } catch (e) {
        skipped.add(c.channel)
        logger.error({ event: 'camera_rtsp_failed', location: s.code, recorder: s.id, channel: c.channel, error: e })
      }
    }
    // Without a working web login the first camera goes alone, so that a refused login is seen before the others are sent.
    const [first, ...rest] = unconfirmed
    if (verified) await mapLimit(unconfirmed, deps.cfg.rtspPerRecorder, probe)
    else {
      await probe(first)
      await mapLimit(rest, deps.cfg.rtspPerRecorder, probe)
    }
    method = method === 'isapi' ? 'isapi+rtsp' : 'rtsp'
    // A refusal with no proof anywhere in this round that the login works is the first sign of a wrong password: start the back-off.
    if (sawRefusal && !loginProven) {
      loginProblem = true
      if (s.password !== '') refused = true
    }
  }

  if (refused) {
    // One line when the back-off starts, not one per round.
    backoffOf(deps.db).set(s.id, { until: deps.clock().getTime() + deps.cfg.nvrLoginBackoffSec * 1000, login: loginFingerprint(s) })
    logger.warn({ event: 'nvr_login_problem', location: s.code, recorder: s.id, message: `NVR login problem at location ${s.code} (NVR ${s.name}); it will not be asked again for ${deps.cfg.nvrLoginBackoffSec} seconds` })
  } else if (loginProblem) {
    logger.warn({ event: 'nvr_login_problem', location: s.code, recorder: s.id, message: `NVR login problem at location ${s.code} (NVR ${s.name}): no saved password` })
  }

  const results = s.cameras
    .filter((c) => !skipped.has(c.channel))
    .map((c): CheckResult => {
      const ok = online.get(c.channel) === true
      const unlisted = listed.size > 0 && !listed.has(c.channel)
      return { type: 'camera', id: c.id, recorder: s.id, ok, at, method, error: ok ? undefined : cameraProblem(rtspCode.get(c.channel), unlisted, nvrProblem) }
    })
  if (results.length > 0) await deps.db.applyResults(s.org_id, results, deps.cfg.failThreshold)

  const changed = s.cameras.filter((c) => addresses.has(c.channel) && addresses.get(c.channel) !== c.camera_ip)
  if (changed.length > 0) await deps.db.saveCameraIps(s.org_id, changed.map((c) => ({ cameraId: c.id, ip: addresses.get(c.channel)!, recorderId: s.id })))
}

/** All cameras of one recorder. Asks the NVR first; cameras it does not report online get an RTSP check. Never throws. */
export function checkRecorderCameras(deps: Deps, s: RecorderJob): Promise<void> {
  // One lane per recorder: two runs over the same recorder never overlap (two NVRs of one location run side by side).
  return serialised(deps.db, `recorder:${s.id}`, async () => {
    try {
      await runRecorderCameras(deps, s)
    } catch (e) {
      // One broken recorder must never stop the others.
      logger.error({ event: 'recorder_check_failed', location: s.code, recorder: s.id, error: e })
    }
  })
}

/** Every recorder's cameras (or only the recorders asked for), with progress per recorder. Never throws. */
export async function checkCameras(deps: Deps, onProgress?: (done: number, total: number) => void, recorderIds?: string[]): Promise<number> {
  let jobs: RecorderJob[]
  const began = deps.clock()
  try {
    jobs = await deps.db.loadRecorderJobs(recorderIds, new Date(began.getTime() - nvrStateMaxAgeMs(deps.cfg)))
  } catch (e) {
    logger.error({ event: 'recorders_load_failed', error: e })
    return 0
  }
  pruneBackoffs(deps)
  let done = 0
  await mapLimit(jobs, deps.cfg.recorderConcurrency, async (s) => {
    await checkRecorderCameras(deps, s)
    try {
      onProgress?.(++done, jobs.length)
    } catch (e) {
      logger.error({ event: 'progress_callback_failed', error: e })
    }
  })
  logRound(deps, 'cameras', began, jobs.length)
  return jobs.length
}
