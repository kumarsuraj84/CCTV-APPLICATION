import { logger } from '@/lib/observability/logger'
import { checkCameras, checkDevices, checkNvrs, type Deps } from '@/lib/monitor/checks'

const MAX_SILENCE_MS = 30_000

/** Runs the checks on their schedules, answers "check now" requests and keeps the heartbeat. */
export class MonitorRunner {
  private timers = new Set<NodeJS.Timeout>()
  private inflight = new Set<Promise<void>>()
  private stopped = false
  private busy = { devices: false, cameras: false, full: false }

  constructor(private deps: Deps) {}

  async runDevices(): Promise<void> {
    if (this.busy.devices) return
    this.busy.devices = true
    try {
      await checkDevices(this.deps)
      await checkNvrs(this.deps)
    } finally {
      this.busy.devices = false
    }
  }

  async runCameras(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.busy.cameras) return
    this.busy.cameras = true
    try {
      await checkCameras(this.deps, onProgress)
    } finally {
      this.busy.cameras = false
    }
  }

  /** Everything now: devices, NVRs, then every store's cameras, with progress for the Monitoring page. */
  async runFull(): Promise<void> {
    if (this.busy.full) return
    this.busy.full = true
    const { db, clock } = this.deps
    let writes: Promise<void> = Promise.resolve()
    try {
      await db.markRunStarted(clock(), 0)
      await this.runDevices()
      await this.runCameras((done, total) => {
        writes = writes.then(() => db.markProgress(done, total)).catch((e) => logger.error({ event: 'progress_write_failed', error: e }))
      })
    } finally {
      try {
        await writes
        await db.markRunFinished(clock())
      } finally {
        // Whatever happened above, the next request must be able to start a run.
        this.busy.full = false
      }
    }
  }

  /** The heartbeat: tells the web app the worker is alive. A failed write is logged and the next beat tries again. */
  async beat(): Promise<void> {
    try {
      await this.deps.db.touchHeartbeat(this.deps.clock())
    } catch (e) {
      logger.error({ event: 'heartbeat_failed', error: e })
    }
  }

  /** Runs everything if someone asked for a check since the last run began. A failed read is logged; the next poll asks again. */
  async checkRequests(): Promise<void> {
    let req
    try {
      req = await this.deps.db.readRequest()
    } catch (e) {
      logger.error({ event: 'check_request_read_failed', error: e })
      return
    }
    if (req.requestedAt && (!req.runStartedAt || req.requestedAt > req.runStartedAt)) await this.runFull()
  }

  /** One beat: heartbeat, then run everything if someone asked for a check since the last run began. */
  async pollOnce(): Promise<void> {
    await this.beat()
    await this.checkRequests()
  }

  /**
   * Notes the time the worker was not running, then starts the timers. If the gap cannot be recorded (the database is unreachable), the heartbeat is
   * left where it was so that nothing is lost, and recording is tried again every poll interval; the timers start once it works.
   */
  async start(): Promise<void> {
    this.stopped = false
    const { db, clock, cfg } = this.deps
    try {
      await db.recordStartupGap(clock(), MAX_SILENCE_MS)
    } catch (e) {
      logger.error({ event: 'startup_gap_failed', error: e })
      if (this.stopped) return
      const t = setTimeout(() => {
        this.timers.delete(t)
        this.track(this.start())
      }, cfg.pollSec * 1000)
      this.timers.add(t)
      return
    }
    if (this.stopped) return
    // The heartbeat has its own timer, so a long "check now" run cannot make the worker look dead.
    this.loop(() => this.beat(), cfg.pollSec * 1000)
    this.loop(() => this.checkRequests(), cfg.pollSec * 1000)
    this.loop(() => this.runDevices(), cfg.deviceCheckSec * 1000)
    this.loop(() => this.runCameras(), cfg.cameraCheckSec * 1000)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  /** Stops the timers, then waits for the cycles in progress, up to maxWaitMs. Returns false if some were still running. */
  async shutdown(maxWaitMs: number): Promise<boolean> {
    this.stop()
    if (this.inflight.size === 0) return true
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), maxWaitMs)
    })
    const drained = Promise.allSettled([...this.inflight]).then(() => true)
    try {
      return await Promise.race([drained, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private track(p: Promise<void>): void {
    const done = p.then(
      () => undefined,
      (e) => logger.error({ event: 'worker_loop_failed', error: e }),
    )
    this.inflight.add(done)
    void done.then(() => this.inflight.delete(done))
  }

  private loop(fn: () => Promise<void>, ms: number): void {
    const tick = async () => {
      if (this.stopped) return
      try {
        await fn()
      } catch (e) {
        logger.error({ event: 'worker_loop_failed', error: e })
      }
      if (!this.stopped) {
        const t = setTimeout(() => {
          this.timers.delete(t)
          this.track(tick())
        }, ms)
        this.timers.add(t)
      }
    }
    this.track(tick())
  }
}
