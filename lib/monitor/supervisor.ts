import type { LeaseFence, LeaseLog, LeaseLostReason, Sleep, WorkerLease } from '@/lib/monitor/lease'

// P2-7 (WP-2.5, D-8): the worker does its work only while it holds the lease. standby (waiting for the lease) → active (a runner whose
// every write carries this epoch's token; the lease is renewed every 5 s) → on a lost lease the runner is abandoned at once and the
// worker goes back to standby and tries again → on stop the runner is shut down while the lease is still held, then the lease is
// handed back so that another worker can take it at once. docs/drishti/worker-lease.md.

/** What the supervisor needs of a runner (MonitorRunner). */
export interface SupervisedRunner {
  start(opts?: { onReady?: () => void }): Promise<void>
  /** The lease is lost: stop at once, write nothing more. */
  abandon(): void
  /** Graceful stop while the lease is still held. Returns false if work was still going when the wait ended. */
  shutdown(maxWaitMs: number): Promise<boolean>
}

export type SupervisorDeps = {
  lease: WorkerLease
  /** A runner for one epoch: its data layer must tag every write with this fence. */
  makeRunner: (fence: LeaseFence) => SupervisedRunner
  sleep: Sleep
  log: LeaseLog
  /** Called each time a runner has started (once per epoch). */
  onActive?: (token: number | null) => void
}

export type SupervisorPhase = 'standby' | 'active' | 'stopped'

export class WorkerSupervisor {
  phase: SupervisorPhase = 'standby'
  private readonly stopping = new AbortController()
  private active: { runner: SupervisedRunner; renewing: AbortController } | null = null
  private running: Promise<void> | null = null

  constructor(private readonly d: SupervisorDeps) {}

  /** Runs until stop(). Never throws (each step catches its own failures). */
  run(): Promise<void> {
    this.running ??= this.loop()
    return this.running
  }

  /** True while this worker holds the lease and its runner works (housekeeping runs only then). */
  isActive(): boolean {
    return this.phase === 'active' && this.d.lease.token() !== null
  }

  private async loop(): Promise<void> {
    const { lease, sleep, log } = this.d
    const stop = this.stopping.signal
    const stopped = new Promise<'stopped'>((resolve) => stop.addEventListener('abort', () => resolve('stopped'), { once: true }))
    while (!stop.aborted) {
      this.phase = 'standby'
      if (!(await lease.acquire(stop, sleep))) break
      if (stop.aborted) break // taken just as the worker was asked to stop: stop() hands it back
      let off: () => void = () => {}
      const lost = new Promise<LeaseLostReason>((resolve) => (off = lease.onLost(resolve)))
      const renewing = new AbortController()
      const runner = this.d.makeRunner(lease.fence())
      this.active = { runner, renewing }
      void lease.keepRenewing(renewing.signal, sleep)
      this.phase = 'active'
      try {
        await runner.start()
        this.d.onActive?.(lease.token())
      } catch (e) {
        log({ event: 'worker_start_failed', error: e })
      }
      const why = await Promise.race([lost, stopped])
      off()
      if (why === 'stopped') return // stop() shuts the runner down and releases the lease
      renewing.abort()
      runner.abandon()
      this.active = null
      log({ event: 'worker_standby', reason: why, message: 'The lease was lost: all checks stopped. Waiting to take it again.' })
    }
    this.phase = 'stopped'
  }

  /**
   * Stops the worker: the runner (if any) finishes what it can within maxWaitMs, its last writes still fenced with a valid token, then
   * the lease is released. Returns whether the runner finished its work in time.
   */
  async stop(maxWaitMs: number): Promise<boolean> {
    this.stopping.abort()
    const a = this.active
    this.active = null
    let drained = true
    if (a) {
      try {
        drained = await a.runner.shutdown(maxWaitMs)
      } catch (e) {
        drained = false
        this.d.log({ event: 'worker_shutdown_failed', error: e })
      }
      a.renewing.abort()
    }
    await this.d.lease.release()
    this.phase = 'stopped'
    if (this.running) await this.running
    return drained
  }
}
