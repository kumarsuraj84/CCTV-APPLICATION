import { isIP } from 'node:net'
import { mapLimit } from '@/lib/async/pool'
import { isLeaseLost } from '@/lib/monitor/lease'
import { describeNvrError, NvrError } from '@/lib/nvr/client'
import { outcomeOfNvrError as outcomeOfLoginError, outcomeOfRtspCode } from '@/lib/nvr/login-guard'
import { classifyLoginAnswer, type LoginGate, type LoginOutcome } from '@/lib/nvr/login-policy'
import { logger } from '@/lib/observability/logger'
import { isValidHost, isValidPort } from '@/lib/probes'
import type { CheckResult, MonitorConfig, MonitorDb, Probes, RecorderJob } from '@/lib/monitor/types'

/**
 * signal (P2-7): aborted when the worker's lease is lost. A check in progress then probes no further target and sends nothing (every
 * write would be refused by the fence anyway; this stops the work itself). rollout (final fix X, NB-4): the staggered start's allowance
 * of never-proven NVRs per camera round; one per runner (a new runner starts again at MONITOR_NEW_RECORDERS_PER_ROUND).
 */
export type Deps = { db: MonitorDb; probes: Probes; cfg: MonitorConfig; clock: () => Date; signal?: AbortSignal; rollout?: { allowance: number } }

const mayLogIn = (g: LoginGate): boolean => g.decision === 'go' || (g.decision === 'probe' && g.claimed)

const halted = (deps: Deps): boolean => deps.signal?.aborted === true

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
      if (halted(deps)) return
      try {
        await deps.db.applyResults(org, list.slice(i, i + CHUNK), threshold)
      } catch (e) {
        // P2-7: without the lease nothing more can be saved; the loss is logged once by the lease (lease_lost).
        if (isLeaseLost(e)) return
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
      if (halted(deps)) return null
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
      if (halted(deps)) return null
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
    // Review C M-6: an NVR is called down after RECORDER_FAIL_THRESHOLD (3) failed connects in a row, so a short SD-WAN blip does not
    // open an NVR outage and one "Recorder not reachable" for each of its cameras.
    await applyGrouped(deps, results.filter(present), deps.cfg.recorderFailThreshold ?? deps.cfg.failThreshold)
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
 * The NVR login back-off (ruling R9; final fix X, release 1 review C I-1/I-3, ruling NB-1): the SHARED login state of the data layer (in
 * the database for the real worker: nvr_login_state, the same one the web server and the gateway use; rules in lib/nvr/login-policy.ts).
 * So it survives a restart and a new lease epoch, it escalates (15 minutes doubling to 6 hours), a refused ISAPI login is never followed
 * by an RTSP login, an NVR without a saved password is never contacted, and "forbidden" (403 after the login was accepted) is not a
 * refused login. Only the hash of the saved login is ever compared, never the password.
 */
type Gate = LoginGate | undefined
/** The login state could not be read: treated like "someone else is trying" (nothing is sent). */
const NOT_READ: LoginGate = { decision: 'wait', version: null, until: null, baselined: false, level: 0, claimed: false }

/** A camera address the NVR reports is kept only when it is a plain IP address. */
const plainIp = (ip: string | null): ip is string => typeof ip === 'string' && isIP(ip) !== 0 && !ip.includes('%')

/** Needs a login at all (the others are settled without contacting the NVR's web or video login). */
const needsLogin = (s: RecorderJob) => s.cameras.length > 0 && !s.knownDown && isValidHost(s.ip) && isValidPort(s.http_port) && isValidPort(s.rtsp_port)

const backoffCfg = (deps: Deps) => ({ baseSec: deps.cfg.nvrLoginBackoffSec, maxSec: deps.cfg.nvrLoginBackoffMaxSec ?? Math.max(21_600, deps.cfg.nvrLoginBackoffSec) })

async function runRecorderCameras(deps: Deps, s: RecorderJob, gate: Gate, deferred: boolean): Promise<LoginOutcome | null> {
  if (s.cameras.length === 0 || halted(deps)) return null
  const at = deps.clock().toISOString()

  // A recorder already known to be down: ITS cameras (only the ones mapped to it) are down for the same reason, at once, with nothing
  // else to ask. Cameras of the location's other NVRs are their own jobs and are not touched.
  if (s.knownDown) {
    await deps.db.applyResults(
      s.org_id,
      s.cameras.map((c): CheckResult => ({ type: 'camera', id: c.id, recorder: s.id, ok: false, at, method: 'nvr_down', error: 'The NVR is not reachable.', cause: 'nvr_down' })),
      1,
    )
    return null
  }

  // An address that cannot be used is a failed check with a plain message, never a probe aimed at something odd.
  if (!isValidHost(s.ip) || !isValidPort(s.http_port) || !isValidPort(s.rtsp_port)) {
    await deps.db.applyResults(
      s.org_id,
      s.cameras.map((c): CheckResult => ({ type: 'camera', id: c.id, recorder: s.id, ok: false, at, method: 'none', error: BAD_NVR })),
      deps.cfg.failThreshold,
    )
    return null
  }

  // The staggered start (NB-4): a never-proven NVR beyond this round's allowance waits for a later round. Nothing is sent or recorded.
  if (deferred) return null
  // The shared login state (NB-1). Not readable: nothing is sent (fail closed). No saved password: never contacted (review I-1 item 5).
  // Refused (in its window), paused (3 refusals in 30 minutes) or another caller trying right now: nothing is sent, nothing recorded.
  if (!gate) return null
  if (gate.decision === 'no_password') {
    logger.warn({ event: 'nvr_no_password', location: s.code, recorder: s.id, message: `NVR ${s.name} at location ${s.code} has no saved password, so it is not contacted` })
    return null
  }
  if (!mayLogIn(gate) && gate.decision !== 'probe') return null
  // Round 2 (review M-2): the state read at the start of the round can be minutes old; it is read again right before the login (and
  // the ONE attempt is taken when nobody knows whether the login works: the web server may be trying right now).
  let g: LoginGate
  try {
    const fresh = (await deps.db.loginGate([s.id], { claim: true, now: deps.clock().getTime() })).get(s.id)
    if (!fresh) return null
    g = fresh
  } catch (e) {
    logger.error({ event: 'nvr_login_state_unreadable', recorder: s.id, error: e })
    return null
  }
  if (!mayLogIn(g) || g.version === null) return null
  const version = g.version
  let settled: LoginOutcome | null = null
  const settle = async (outcome: LoginOutcome) => {
    if (settled !== null || (outcome === 'unknown' && !g.claimed)) return
    settled = outcome
    try {
      await deps.db.reportLogin(s.id, version, outcome, deps.clock().getTime(), backoffCfg(deps))
    } catch (e) {
      logger.error({ event: 'nvr_login_report_failed', recorder: s.id, error: e })
    }
  }
  const refusedNow = async (how: 'web' | 'video') => {
    await settle('refused')
    // One line when an NVR refuses its login (the shared state then keeps everyone away; the Monitoring page lists it).
    logger.warn({ event: 'nvr_login_refused', location: s.code, recorder: s.id, how, message: `NVR login refused at location ${s.code} (NVR ${s.name}); it is left alone for a while, every path` })
  }

  let password: string | null
  try {
    password = await deps.db.readPassword(s.id, version)
  } catch (e) {
    logger.error({ event: 'nvr_credential_read_failed', location: s.code, recorder: s.id, error: e })
    password = null
  }
  if (!password) {
    await settle('unknown')
    return null
  }

  const online = new Map<number, boolean>()
  const rtspCode = new Map<number, number>()
  const skipped = new Set<number>()
  const addresses = new Map<number, string>()
  let method = 'rtsp'
  let nvrProblem: string | undefined
  // The channels the recorder says it has, when it said (from either of its answers). Empty = not known.
  const listed = new Set<number>()
  const nvr = deps.probes.nvr({ host: s.ip, port: s.http_port, username: s.username, password }, { timeoutMs: deps.cfg.nvrTimeoutMs })
  // The camera list is worth asking for after a good status answer, or after one that could not be read. Not after a timeout or an
  // unreachable recorder (the second question would only wait as long as the first), nor after "forbidden" (the user may not read it).
  let askForChannels = true
  // Round 2 (review I-2; NB-8): what an answer says about the login comes from the ONE classifier the web paths use too: only an answer
  // after the password was sent proves (or refuses) anything.
  let webProven = false
  let webAccepted = false
  try {
    for (const [ch, on] of await nvr.channelStatus()) {
      online.set(ch, on)
      listed.add(ch)
    }
    method = 'isapi'
    webProven = classifyLoginAnswer({ status: 'success', credentialsSent: nvr.loginProven ? nvr.loginProven() : true }) === 'ok'
    if (webProven) await settle('ok')
  } catch (e) {
    nvrProblem = describeNvrError(e)
    const outcome = outcomeOfLoginError(e)
    if (outcome === 'refused') {
      // Review I-1: a refused web login is never followed by a video login with the same password. No results (no false outages).
      await refusedNow('web')
      return 'refused'
    }
    // Review I-3: "forbidden" after the login means the user name and password were accepted and only this request is not allowed (a
    // viewer account): not a refused login. The cameras are then checked by RTSP one at a time, so a refused VIDEO login still stops at
    // one; the login counts as proven only when the video does not refuse it.
    if (e instanceof NvrError && e.kind === 'forbidden' && outcome === 'ok') webAccepted = true
    if (e instanceof NvrError && (e.kind === 'timeout' || e.kind === 'unreachable' || e.kind === 'forbidden')) askForChannels = false
  }
  if (askForChannels) {
    try {
      for (const c of await nvr.channels()) {
        listed.add(c.channel)
        if (plainIp(c.ip)) addresses.set(c.channel, c.ip)
      }
    } catch {
      // Camera addresses are a bonus here; names and channels come from discovery.
    }
  }
  // The web login was proven, so a refused video login below is about that camera alone. Without that proof, a refused video login is a
  // login problem.
  const verified = webProven
  const unconfirmed = s.cameras.filter((c) => online.get(c.channel) !== true)
  let cannotLogIn = false
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
        const { code, authSent } = await deps.probes.rtsp({ host: s.ip, port: s.rtsp_port, username: s.username, password, channel: c.channel })
        if (code === 401 && authSent === false) {
          // Round 2 (review M-4): a 401 to a request that carried no login (no Digest offered, a password a header cannot carry): nobody's
          // password was refused, and no camera can be checked this way. Nothing is recorded; the attempt is given back.
          cannotLogIn = true
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
        // Any answer from a camera other than "nothing" or "refused" after the password was sent shows the saved login is accepted. A refusal
        // after that is that camera's own.
        if (outcomeOfRtspCode(code, authSent) === 'ok') loginProven = true
        rtspCode.set(c.channel, code)
        online.set(c.channel, code === 200)
      } catch (e) {
        skipped.add(c.channel)
        logger.error({ event: 'camera_rtsp_failed', location: s.code, recorder: s.id, channel: c.channel, error: e })
      }
    }
    // Without a proven login the cameras go one at a time until one answer proves it (final fix X; round 2, review M-3: also after silent
    // cameras, so a wrong password costs at most ONE refused video login per NVR and round); then the rest side by side.
    if (verified) await mapLimit(unconfirmed, deps.cfg.rtspPerRecorder, probe)
    else {
      let next = 0
      while (next < unconfirmed.length && !loginProven && !stopRtsp) await probe(unconfirmed[next++])
      await mapLimit(unconfirmed.slice(next), deps.cfg.rtspPerRecorder, probe)
    }
    method = method === 'isapi' ? 'isapi+rtsp' : 'rtsp'
    // A refusal with no proof anywhere in this round that the login works is a wrong password: the shared back-off, and no results
    // (a refused login says nothing about the cameras: no false down, no false up).
    if (sawRefusal && !loginProven) {
      await refusedNow('video')
      return 'refused'
    }
    if (loginProven) await settle('ok')
  }
  if (webAccepted && !cannotLogIn) await settle('ok')
  // Nothing proved or refused the login (no answer at all): the one attempt is given back.
  await settle('unknown')

  if (halted(deps)) return settled // the lease was lost while this NVR was being asked: nothing is sent
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
  return settled
}

/** The login state of these jobs (no attempt taken); undefined for all when it cannot be read (then none of them is contacted). */
async function peekLogins(deps: Deps, jobs: RecorderJob[]): Promise<Map<string, LoginGate> | undefined> {
  const ids = jobs.filter(needsLogin).map((j) => j.id)
  if (ids.length === 0) return new Map()
  try {
    return await deps.db.loginGate(ids, { claim: false, now: deps.clock().getTime() })
  } catch (e) {
    logger.error({ event: 'nvr_login_state_unreadable', error: e, message: 'The NVR login state could not be read; no NVR login is tried this round.' })
    return undefined
  }
}

/**
 * All cameras of one recorder. Asks the NVR first; cameras it does not report online get an RTSP check. Never throws. `gate`: its login
 * state when the caller read it for a whole round (else it is read here); `deferred`: not this round (the staggered start).
 */
export function checkRecorderCameras(deps: Deps, s: RecorderJob, o: { gate?: LoginGate; deferred?: boolean } = {}): Promise<LoginOutcome | null> {
  // One lane per recorder: two runs over the same recorder never overlap (two NVRs of one location run side by side).
  return serialised(deps.db, `recorder:${s.id}`, async () => {
    try {
      const gate = o.gate ?? (needsLogin(s) ? (await peekLogins(deps, [s]))?.get(s.id) : undefined)
      return await runRecorderCameras(deps, s, gate, o.deferred === true)
    } catch (e) {
      // One broken recorder must never stop the others. A lost lease (P2-7) is logged once by the lease itself.
      if (!isLeaseLost(e)) logger.error({ event: 'recorder_check_failed', location: s.code, recorder: s.id, error: e })
      return null
    }
  })
}

/**
 * Every recorder's cameras (or only the recorders asked for), with progress per recorder. Never throws. Final fix X (review C I-4,
 * ruling NB-4): the staggered start — NVRs whose login was never proven ("not baselined") are contacted at most `allowance` per round
 * (MONITOR_NEW_RECORDERS_PER_ROUND, default 10), in id order; the allowance doubles with the newcomers that succeed (never below the
 * setting) and lives in deps.rollout (one per runner). NVRs proven before are checked every round as usual.
 */
export async function checkCameras(deps: Deps, onProgress?: (done: number, total: number) => void, recorderIds?: string[]): Promise<number> {
  let jobs: RecorderJob[]
  const began = deps.clock()
  try {
    jobs = await deps.db.loadRecorderJobs(recorderIds, new Date(began.getTime() - nvrStateMaxAgeMs(deps.cfg)))
  } catch (e) {
    logger.error({ event: 'recorders_load_failed', error: e })
    return 0
  }
  const gates = await peekLogins(deps, jobs)
  const base = deps.cfg.newRecordersPerRound ?? 10
  const rollout = deps.rollout ?? { allowance: base }
  const newcomers = jobs.filter((j) => needsLogin(j) && gates?.get(j.id)?.decision === 'probe' && gates.get(j.id)?.baselined === false).map((j) => j.id).sort()
  const allowed = new Set(newcomers.slice(0, Math.max(base, rollout.allowance)))
  const waiting = new Set(newcomers.filter((id) => !allowed.has(id)))
  let succeeded = 0
  let done = 0
  await mapLimit(jobs, deps.cfg.recorderConcurrency, async (s) => {
    if (halted(deps)) return
    const deferred = waiting.has(s.id)
    // A job that needs a login but whose state could not be read is left alone (fail closed): an empty gate means "not contacted".
    const outcome = await checkRecorderCameras(deps, s, { gate: needsLogin(s) ? (gates?.get(s.id) ?? NOT_READ) : undefined, deferred })
    if (allowed.has(s.id) && outcome === 'ok') succeeded++
    try {
      onProgress?.(++done, jobs.length)
    } catch (e) {
      logger.error({ event: 'progress_callback_failed', error: e })
    }
  })
  // Doubling while they succeed, never below the setting, never above what there is to do.
  if (allowed.size > 0) rollout.allowance = Math.min(2000, Math.max(base, 2 * succeeded))
  if (waiting.size > 0) {
    logger.info({ event: 'rollout_deferred', contacted: allowed.size, waiting: waiting.size, message: `${waiting.size} NVRs not yet contacted wait for a later round (at most ${allowed.size} new NVRs this round)` })
  }
  logRound(deps, 'cameras', began, jobs.length)
  return jobs.length
}
