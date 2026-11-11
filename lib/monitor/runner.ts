import { logger } from '@/lib/observability/logger'
import { checkCameras, checkDevices, checkNvrs, type Deps } from '@/lib/monitor/checks'
import { DistinctFailures } from '@/lib/monitor/failure-log'
import { isLeaseLost } from '@/lib/monitor/lease'
import type { MonitorDb } from '@/lib/monitor/types'

const MAX_SILENCE_MS = 30_000

/** Beats are 5 seconds apart. A longer silence between two good beats means the worker was not working, and it is recorded as a gap. */
export const DEFAULT_BEAT_GAP_MS = MAX_SILENCE_MS

/** How long a "check now" waits for one cycle (an earlier scheduled one, or its own) before it gives up on it. */
export const DEFAULT_CYCLE_WATCHDOG_MS = 10 * 60_000

type Kind = 'devices' | 'nvrs' | 'cameras'

/** The calls whose failure the checks log and swallow. The runner counts them, so that a run is never reported clean when its database work failed. */
const COUNTED: ReadonlySet<string | symbol> = new Set(['loadDevices', 'loadNvrs', 'loadRecorderJobs', 'applyResults', 'loginGate'])

/**
 * The checks never throw: a database error is logged and the round carries on. That is right for a schedule, but a "check now" must not say
 * "done" after a round that could not read or save. This wrapper passes every call through and counts the failures of the calls above.
 * Methods are looked up at call time, so a replaced method is still seen.
 */
function counting(db: MonitorDb, onFailure: () => void): MonitorDb {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (!COUNTED.has(prop)) return (value as (...a: unknown[]) => unknown).bind(target)
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => unknown).apply(target, args)
        } catch (e) {
          onFailure()
          throw e
        }
      }
    },
  })
}

/** Runs the checks on their schedules, answers "check now" requests and keeps the heartbeat. */
export class MonitorRunner {
  private timers = new Set<NodeJS.Timeout>()
  private inflight = new Set<Promise<void>>()
  private running: Partial<Record<Kind, Promise<void>>> = {}
  private stopped = false
  private fullBusy = false
  /** A run has been marked started in the database and not yet marked finished. */
  private runOpen = false
  /** The last run could not read, save or finish its cycles; it is run once more, not before retryNotBefore. */
  private retryPending = false
  private retryNotBefore = 0
  private dbFailures = 0
  private waiting = new DistinctFailures()
  /** The time of the last heartbeat that was saved (or of start-up); null until there is one. */
  private lastGoodBeat: Date | null = null
  /** Silences that were noticed and not yet saved as gaps. Oldest first; none overlaps another. */
  private pendingGaps: { from: Date; to: Date }[] = []
  private deps: Deps
  private watchdogMs: number
  private beatGapMs: number
  /** P2-7: aborted when the lease is lost (abandon): the checks in progress probe nothing further and send nothing. */
  private halt = new AbortController()

  constructor(deps: Deps, opts: { cycleWatchdogMs?: number; beatGapMs?: number } = {}) {
    // Final fix X (NB-4): the staggered start's allowance lives as long as this runner (one lease epoch).
    this.deps = { ...deps, db: counting(deps.db, () => (this.dbFailures += 1)), signal: this.halt.signal, rollout: deps.rollout ?? { allowance: deps.cfg.newRecordersPerRound ?? 10 } }
    this.watchdogMs = opts.cycleWatchdogMs ?? DEFAULT_CYCLE_WATCHDOG_MS
    this.beatGapMs = opts.beatGapMs ?? DEFAULT_BEAT_GAP_MS
  }

  /** One check of one kind. Callers that only want the schedule kept skip it when one is already running. */
  private cycle(kind: Kind, fn: () => Promise<unknown>): Promise<void> {
    const self: { p?: Promise<void> } = {}
    const p: Promise<void> = (async () => {
      await Promise.resolve() // so that `p` is set before anything below can finish
      try {
        await fn()
      } finally {
        if (this.running[kind] === self.p) delete this.running[kind]
      }
    })()
    self.p = p
    this.running[kind] = p
    return p
  }

  /** The scheduled way: if the same kind is already running, leave it be. */
  private scheduled(kind: Kind, fn: () => Promise<unknown>): Promise<void> {
    return this.running[kind] ? Promise.resolve() : this.cycle(kind, fn)
  }

  /** Waits for p, but not longer than the watchdog allows. Returns false if it had to give up. */
  private async within(p: Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.watchdogMs)
    })
    try {
      return await Promise.race([p.then(() => true as const, () => true as const), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The "check now" way: let one already running finish (its results may predate the request), then run one that starts afterwards.
   * Returns false if a cycle did not end within the watchdog time: the caller must then not report the run as checked.
   */
  private async fresh(kind: Kind, fn: () => Promise<unknown>): Promise<boolean> {
    const earlier = this.running[kind]
    if (earlier) {
      if (!(await this.within(earlier))) {
        logger.warn({ event: 'cycle_stuck', kind, message: 'A scheduled check did not end in time; not waiting for it any longer.' })
        return false
      }
      const next = this.running[kind] // a scheduled cycle that began in the meantime also began after the request
      if (next) return this.within(next)
    }
    const ok = await this.within(this.cycle(kind, fn))
    if (!ok) logger.warn({ event: 'cycle_stuck', kind, message: 'A check did not end in time; not waiting for it any longer.' })
    return ok
  }

  async runDevices(): Promise<void> {
    const failuresBefore = this.dbFailures
    let ranDevices = false
    let ranNvrs = false
    await this.scheduled('devices', () => {
      ranDevices = true
      return checkDevices(this.deps)
    })
    await this.scheduled('nvrs', () => {
      ranNvrs = true
      return checkNvrs(this.deps)
    })
    if (ranDevices && ranNvrs && this.dbFailures === failuresBefore) await this.markRound('devices')
  }

  async runCameras(onProgress?: (done: number, total: number) => void): Promise<void> {
    const failuresBefore = this.dbFailures
    let ran = false
    await this.scheduled('cameras', () => {
      ran = true
      return checkCameras(this.deps, onProgress)
    })
    if (ran && this.dbFailures === failuresBefore) await this.markRound('cameras')
  }

  /** Saves when a scheduled round finished, for the Home page. Only for a round this call ran whole, without database trouble. Never throws. */
  private async markRound(kind: 'devices' | 'cameras'): Promise<void> {
    if (this.halt.signal.aborted) return // a round cut short by a lost lease did not finish
    try {
      await this.deps.db.markRound(kind, this.deps.clock())
    } catch (e) {
      if (!isLeaseLost(e)) logger.error({ event: 'round_time_not_saved', kind, error: e })
    }
  }

  /** Everything now: devices, NVRs, then every NVR's cameras (progress per recorder), for the Monitoring page. */
  async runFull(): Promise<void> {
    await this.fullRun(false)
  }

  /**
   * A run is marked finished only when it really checked: cycles already in progress are waited for and then repeated, and if the database
   * failed during the run (nothing could be read or saved), or a cycle did not end in time, the run stays open and is repeated once, not sooner
   * than one poll interval later. The repeat is closed whatever its outcome, so the page never waits for ever; worker_state has no field for a
   * failure note. A run that is open but not being worked on (a failed final write, or a repeat that could not even start) is picked up by
   * checkRequests on every poll, never in a tight loop.
   */
  private async fullRun(isRetry: boolean): Promise<void> {
    if (this.fullBusy) return
    this.fullBusy = true
    const { db, clock } = this.deps
    const failuresBefore = this.dbFailures
    let writes: Promise<void> = Promise.resolve()
    let started = false
    let complete = true
    let failure: { error: unknown } | undefined
    try {
      await db.markRunStarted(clock(), 0)
      started = true
      this.runOpen = true
      complete = (await this.fresh('devices', () => checkDevices(this.deps))) && complete
      complete = (await this.fresh('nvrs', () => checkNvrs(this.deps))) && complete
      complete =
        (await this.fresh('cameras', () =>
          checkCameras(this.deps, (done, total) => {
            writes = writes.then(() => db.markProgress(done, total)).catch((e) => logger.error({ event: 'progress_write_failed', error: e }))
          }),
        )) && complete
    } catch (e) {
      failure = { error: e }
    }
    try {
      await writes
      if (!started) {
        // Nothing was started by this attempt. If it was the repeat, the first attempt's run is still open: do it again when the database is back.
        if (isRetry) this.scheduleRetry()
      } else if ((complete && !failure && this.dbFailures === failuresBefore) || isRetry) {
        this.retryPending = false
        await this.closeRun()
      } else {
        logger.warn({ event: 'run_not_clean', message: 'The run could not read, save or finish everything; it will be repeated once.' })
        this.scheduleRetry()
      }
    } finally {
      // Whatever happened above, the next request must be able to start a run.
      this.fullBusy = false
    }
    if (failure) throw failure.error
  }

  private scheduleRetry(): void {
    this.retryPending = true
    this.retryNotBefore = Date.now() + this.deps.cfg.pollSec * 1000
  }

  /** Marks the open run finished. If that fails the run stays open, and every poll tries again until it works. */
  private async closeRun(): Promise<void> {
    await this.deps.db.markRunFinished(this.deps.clock())
    this.runOpen = false
  }

  /**
   * The heartbeat: tells the web app the worker is alive. A failed write is logged and the next beat tries again.
   * A good beat that comes more than beatGapMs after the previous good one means the worker (or its database) was silent in between,
   * for whatever reason, without a restart. That time is recorded as a gap, so that it is not counted as downtime. A gap that cannot be
   * saved is kept and tried again at the next beat.
   */
  async beat(): Promise<void> {
    if (this.halt.signal.aborted) return
    const now = this.deps.clock()
    try {
      await this.deps.db.touchHeartbeat(now)
    } catch (e) {
      // P2-7: a lost lease is logged once by the lease itself (lease_lost), not on every beat.
      if (!isLeaseLost(e)) logger.error({ event: 'heartbeat_failed', error: e })
      return
    }
    const last = this.lastGoodBeat
    this.lastGoodBeat = now
    if (last && now.getTime() - last.getTime() > this.beatGapMs) this.pendingGaps.push({ from: last, to: now })
    await this.flushGaps()
  }

  private async flushGaps(): Promise<void> {
    while (this.pendingGaps.length > 0) {
      const gap = this.pendingGaps[0]
      try {
        await this.deps.db.recordGap(gap.from, gap.to)
      } catch (e) {
        logger.error({ event: 'gap_not_saved', error: e })
        return // kept; tried again at the next beat
      }
      this.pendingGaps.shift()
    }
  }

  /** Runs everything if someone asked for a check since the last run began. A failed read is logged; the next poll asks again. */
  async checkRequests(): Promise<void> {
    if (this.halt.signal.aborted) return
    if (this.retryPending) {
      if (Date.now() < this.retryNotBefore) return
      await this.fullRun(true)
      return
    }
    if (this.runOpen && !this.fullBusy) {
      try {
        await this.closeRun()
      } catch (e) {
        logger.error({ event: 'run_close_failed', error: e })
        return // tried again on the next poll
      }
    }
    let req
    try {
      req = await this.deps.db.readRequest()
    } catch (e) {
      logger.error({ event: 'check_request_read_failed', error: e })
      return
    }
    if (req.requestedAt && (!req.runStartedAt || req.requestedAt > req.runStartedAt)) await this.fullRun(false)
  }

  /** One beat: heartbeat, then run everything if someone asked for a check since the last run began. */
  async pollOnce(): Promise<void> {
    await this.beat()
    await this.checkRequests()
  }

  /**
   * Notes the time the worker was not running, closes a run that a crash left open, then starts the timers. If the gap cannot be recorded
   * (the database is unreachable), the heartbeat is left where it was so that nothing is lost, and recording is tried again every poll
   * interval; the timers start once it works. onReady is called once, when they do.
   */
  async start(opts: { onReady?: () => void } = {}): Promise<void> {
    this.stopped = false
    const { db, clock, cfg } = this.deps
    try {
      await db.recordStartupGap(clock(), MAX_SILENCE_MS)
    } catch (e) {
      this.waiting.report(e, (err) =>
        logger.error({ event: 'worker_waiting_for_database', message: 'Could not record the start-up gap; trying again.', error: err }),
      )
      if (this.stopped) return
      const t = setTimeout(() => {
        this.timers.delete(t)
        this.track(this.start(opts))
      }, cfg.pollSec * 1000)
      this.timers.add(t)
      return
    }
    this.waiting.clear()
    // The start-up gap ends here and the heartbeat was set to this moment, so the gaps found by later beats start here and never overlap it.
    this.lastGoodBeat = clock()
    if (this.stopped) return
    await this.closeStaleRun()
    if (this.stopped) return
    // The heartbeat has its own timer, so a long "check now" run cannot make the worker look dead.
    this.loop(() => this.beat(), cfg.pollSec * 1000)
    this.loop(() => this.checkRequests(), cfg.pollSec * 1000)
    this.loop(() => this.runDevices(), cfg.deviceCheckSec * 1000)
    this.loop(() => this.runCameras(), cfg.cameraCheckSec * 1000)
    opts.onReady?.()
  }

  /**
   * A previous worker that crashed in the middle of a run left it open, and the page would show it running for ever. That run never
   * finished checking, so it is not marked finished as it is: it is run again (a little later, like any repeat), and that closes it.
   */
  private async closeStaleRun(): Promise<void> {
    try {
      const req = await this.deps.db.readRequest()
      // runFinishedAt undefined means the data layer cannot say; leave it alone.
      if (req.runStartedAt && req.runFinishedAt !== undefined && (!req.runFinishedAt || req.runFinishedAt < req.runStartedAt)) {
        this.runOpen = true
        this.scheduleRetry()
        logger.warn({ event: 'stale_run_repeated', message: 'A run left open by an earlier worker will be run again.' })
      }
    } catch (e) {
      logger.error({ event: 'stale_run_check_failed', error: e })
    }
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  /**
   * P2-7: the lease was lost. Stops at once: no timer fires again, the checks in progress probe no further target and send nothing,
   * and nothing is written on the way out (every write would be refused anyway: another worker owns the state now). Not waited for.
   */
  abandon(): void {
    this.halt.abort()
    this.stop()
  }

  /**
   * Stops the timers, then waits for the cycles in progress, up to maxWaitMs. A run still open afterwards is marked finished, so the page
   * does not show it running for ever. Returns false if some cycles were still going.
   */
  async shutdown(maxWaitMs: number): Promise<boolean> {
    this.stop()
    let drained = true
    if (this.inflight.size > 0) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), maxWaitMs)
      })
      const all = Promise.allSettled([...this.inflight]).then(() => true)
      try {
        drained = await Promise.race([all, timeout])
      } finally {
        clearTimeout(timer)
      }
    }
    if (this.runOpen) {
      try {
        await this.deps.db.markRunFinished(this.deps.clock())
        this.runOpen = false
      } catch (e) {
        logger.error({ event: 'run_close_failed', error: e })
      }
    }
    return drained
  }

  private track(p: Promise<void>): void {
    const done = p.then(
      () => undefined,
      (e) => logger.error({ event: 'worker_loop_failed', error: e }),
    )
    this.inflight.add(done)
    void done.then(() => this.inflight.delete(done))
  }

  /** Runs fn every `ms`, counted from the start of the last run, not its end (a slow run does not push the schedule back). */
  private loop(fn: () => Promise<void>, ms: number): void {
    const tick = async () => {
      if (this.stopped) return
      const began = Date.now()
      try {
        await fn()
      } catch (e) {
        logger.error({ event: 'worker_loop_failed', error: e })
      }
      if (!this.stopped) {
        const elapsed = Math.min(ms, Math.max(0, Date.now() - began))
        const t = setTimeout(() => {
          this.timers.delete(t)
          this.track(tick())
        }, ms - elapsed)
        this.timers.add(t)
      }
    }
    this.track(tick())
  }
}
