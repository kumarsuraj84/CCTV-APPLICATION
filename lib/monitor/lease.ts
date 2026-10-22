import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { DistinctFailures } from '@/lib/monitor/failure-log'
import { logger } from '@/lib/observability/logger'

// P2-7 (WP-2.5, decision D-8, tracker SO-14): the worker's lease with a fencing token. Design and failure modes:
// docs/drishti/worker-lease.md. The database (migration 20261021000036) decides who holds a lease, on ITS clock only; every worker
// write carries the lease name and token and is refused in its own transaction when they are not current (worker_fence, SQLSTATE
// WL001). Here the worker only measures durations on a monotonic clock, so a difference between its clock and the database's never
// matters: a token is used only until (time the last good renewal was SENT) + TTL - margin, which is never later than the database's
// own lease_until.

export const DEFAULT_LEASE_NAME = 'monitor'
export const LEASE_TTL_SEC = 20
export const LEASE_RENEW_EVERY_MS = 5_000
/** The token is not used during the last part of the TTL (clock rate differences, a slow answer). */
export const LEASE_MARGIN_MS = 2_000
/** SQLSTATE of a worker write refused by the fence in the database. */
export const LEASE_REFUSED_SQLSTATE = 'WL001'

const LEASE_NAME = /^[a-z][a-z0-9_-]*(:[a-z0-9_-]+)*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ERROR_BACKOFF_MS = 30_000

/** A write that was not sent (no valid token) or that the database refused because the lease is no longer this worker's. */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError'
}
export const isLeaseLost = (e: unknown): e is LeaseLostError => e instanceof LeaseLostError

export type LeaseLostReason = 'renewal_refused' | 'renewal_timed_out' | 'write_refused'

/**
 * What the data layer needs to tag a write: the lease name and the token of ONE epoch (one acquisition). token() is null once that
 * epoch is over, even when the same worker has taken the lease again since: work begun in an old epoch never writes in a new one.
 */
export interface LeaseFence {
  readonly name: string
  token(): number | null
  /** The database refused a write of this epoch: it is over. */
  lost(reason: LeaseLostReason): void
}

type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null }
export type LeaseRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<RpcAnswer>
export type LeaseLog = (entry: Record<string, unknown>) => void
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

export type WorkerLeaseOptions = {
  rpc: LeaseRpc
  /** Default 'monitor'. The sharding seam: later shards hold 'monitor:shard-<n>' (docs/drishti/worker-lease.md). */
  name?: string
  /** This process's identity as a holder (a UUID); a fresh one by default. */
  holder?: string
  /** Shown to people reading the lease (host, process id); never anything secret. */
  holderInfo?: Record<string, string | number | boolean>
  ttlSec?: number
  renewEveryMs?: number
  marginMs?: number
  /** How long a release waits for the database before giving up (default 3 s). */
  releaseTimeoutMs?: number
  /** Milliseconds on a monotonic clock (performance.now by default). Only differences are used; the wall clock is never read. */
  monotonic?: () => number
  log?: LeaseLog
}

export type AcquireAnswer = { result: 'acquired'; token: number } | { result: 'taken'; retryAfterMs: number } | { result: 'error'; error: unknown }

type Held = { epoch: number; token: number; validUntil: number; acquiredAt: number; renewedAt: number }

const defaultLog: LeaseLog = (e) => (e.event === 'lease_lost' || String(e.event).endsWith('_failed') ? logger.warn(e) : logger.info(e))
const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? (data[0] as T | undefined) : (data as T | undefined) ?? undefined)

export class WorkerLease {
  readonly name: string
  readonly holder: string
  private readonly rpc: LeaseRpc
  private readonly ttlSec: number
  private readonly renewEveryMs: number
  private readonly marginMs: number
  private readonly releaseTimeoutMs: number
  private readonly monotonic: () => number
  private readonly log: LeaseLog
  private readonly holderInfo: Record<string, string | number | boolean>
  private held: Held | null = null
  /** Ends the epoch at its local deadline even when nothing asks for the token (every database call hangs: a paused or cut-off worker). */
  private watchdog: NodeJS.Timeout | undefined
  private epochs = 0
  private listeners = new Set<(reason: LeaseLostReason) => void>()
  private renewFailures = new DistinctFailures()
  private acquireFailures = new DistinctFailures()

  constructor(o: WorkerLeaseOptions) {
    this.name = o.name ?? DEFAULT_LEASE_NAME
    if (this.name.length > 100 || !LEASE_NAME.test(this.name)) throw new Error(`"${this.name}" is not a lease name (lower-case letters, digits, "-" and "_", parts separated by ":")`)
    this.holder = o.holder ?? randomUUID()
    if (!UUID.test(this.holder)) throw new Error('The lease holder must be a UUID.')
    this.rpc = o.rpc
    this.ttlSec = o.ttlSec ?? LEASE_TTL_SEC
    this.renewEveryMs = o.renewEveryMs ?? LEASE_RENEW_EVERY_MS
    this.marginMs = o.marginMs ?? LEASE_MARGIN_MS
    this.releaseTimeoutMs = o.releaseTimeoutMs ?? 3_000
    this.monotonic = o.monotonic ?? (() => performance.now())
    this.log = o.log ?? defaultLog
    this.holderInfo = o.holderInfo ?? {}
  }

  /** One attempt. Never throws. A lease already held (and still valid here) is not asked for again. */
  async tryAcquire(): Promise<AcquireAnswer> {
    const current = this.token()
    if (current !== null) return { result: 'acquired', token: current }
    const sent = this.monotonic()
    let answer: RpcAnswer
    try {
      answer = await this.rpc('worker_acquire_lease', { p_name: this.name, p_holder: this.holder, p_ttl_sec: this.ttlSec, p_holder_info: this.holderInfo })
    } catch (e) {
      return { result: 'error', error: e }
    }
    if (answer.error) return { result: 'error', error: new Error(`taking the worker lease failed: ${answer.error.message}`) }
    const row = first<{ acquired?: boolean; fencing_token?: number | string | null; retry_after_ms?: number | null }>(answer.data)
    const token = row?.fencing_token === null || row?.fencing_token === undefined ? NaN : Number(row.fencing_token)
    if (!row?.acquired || !Number.isSafeInteger(token) || token < 1) {
      return { result: 'taken', retryAfterMs: Math.max(0, Number(row?.retry_after_ms) || 0) }
    }
    this.held = { epoch: ++this.epochs, token, validUntil: sent + this.ttlSec * 1000 - this.marginMs, acquiredAt: sent, renewedAt: sent }
    this.arm(this.held)
    this.acquireFailures.clear()
    this.renewFailures.clear()
    this.log({ event: 'lease_acquired', lease: this.name, epoch: token, ttlSec: this.ttlSec })
    return { result: 'acquired', token }
  }

  /**
   * Waits until this worker holds the lease (true) or the signal says stop (false). Never throws. While another worker holds it, it tries
   * again just after that lease would run out (the database says when); when the database cannot be reached, after 1, 2, 4 ... up to 30 s.
   */
  async acquire(signal: AbortSignal, sleep: Sleep): Promise<boolean> {
    let errors = 0
    let standbyLogged = false
    while (!signal.aborted) {
      const a = await this.tryAcquire()
      if (a.result === 'acquired') return true
      let wait: number
      if (a.result === 'taken') {
        errors = 0
        if (!standbyLogged) this.log({ event: 'lease_standby', lease: this.name, message: 'Another worker holds the lease; waiting in standby.' })
        standbyLogged = true
        wait = Math.min(this.ttlSec * 1000, Math.max(250, a.retryAfterMs + 250))
      } else {
        this.acquireFailures.report(a.error, (e) => this.log({ event: 'lease_acquire_failed', lease: this.name, message: 'Could not reach the database to take the lease; trying again.', error: e }))
        wait = Math.min(MAX_ERROR_BACKOFF_MS, 1000 * 2 ** Math.min(errors++, 5))
      }
      if (signal.aborted) break
      try {
        await sleep(wait, signal)
      } catch {
        // woken early because the worker is stopping; the loop condition ends it
      }
    }
    return false
  }

  /** One renewal with the token of the current epoch. 'refused' ends the epoch at once; 'error' keeps it until the local deadline. */
  async renew(): Promise<'renewed' | 'refused' | 'error' | 'not_held'> {
    const h = this.held
    if (!h || this.token() === null) return 'not_held'
    const sent = this.monotonic()
    let answer: RpcAnswer | undefined
    let failure: unknown
    try {
      answer = await this.rpc('worker_renew_lease', { p_name: this.name, p_holder: this.holder, p_fencing_token: h.token, p_ttl_sec: this.ttlSec })
      if (answer.error) failure = new Error(`renewing the worker lease failed: ${answer.error.message}`)
    } catch (e) {
      failure = e
    }
    if (this.held !== h) return 'not_held' // the epoch ended while the renewal was on its way
    if (failure !== undefined || !answer) {
      this.renewFailures.report(failure, (e) => this.log({ event: 'lease_renew_failed', lease: this.name, epoch: h.token, error: e }))
      if (this.monotonic() >= h.validUntil) this.markLost(h, 'renewal_timed_out')
      return 'error'
    }
    const row = first<{ renewed?: boolean }>(answer.data)
    if (!row?.renewed) {
      this.markLost(h, 'renewal_refused')
      return 'refused'
    }
    h.validUntil = sent + this.ttlSec * 1000 - this.marginMs
    h.renewedAt = sent
    this.arm(h)
    this.renewFailures.clear()
    return 'renewed'
  }

  /** Renews every renewEveryMs until the signal says stop or the epoch is over. Never throws. */
  async keepRenewing(signal: AbortSignal, sleep: Sleep): Promise<void> {
    while (!signal.aborted && this.held) {
      try {
        await sleep(this.renewEveryMs, signal)
      } catch {
        // stopping
      }
      if (signal.aborted) return
      const r = await this.renew()
      if (r === 'refused' || r === 'not_held') return
    }
  }

  /** The token of the current epoch while it is valid here; null otherwise (and an epoch past its local deadline is ended now). */
  token(): number | null {
    const h = this.held
    if (!h) return null
    if (this.monotonic() >= h.validUntil) {
      this.markLost(h, 'renewal_timed_out')
      return null
    }
    return h.token
  }

  /** The fence of the CURRENT epoch, for the data layer of the runner that works in it. */
  fence(): LeaseFence {
    const epoch = this.held?.epoch ?? -1
    return {
      name: this.name,
      token: () => (this.held && this.held.epoch === epoch ? this.token() : null),
      lost: (reason) => {
        if (this.held && this.held.epoch === epoch) this.markLost(this.held, reason)
      },
    }
  }

  /** Called once per lost epoch (never for a release). Returns the function that stops the calls. */
  onLost(fn: (reason: LeaseLostReason) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Hands the lease back (graceful shutdown) so another worker can take it at once. Never throws; false when nothing was released.
   * Waits at most releaseTimeoutMs for the database (review round 1, M-3): a stop never hangs on an unanswered call; the lease then
   * simply runs out.
   */
  async release(): Promise<boolean> {
    const h = this.held
    if (!h) return false
    this.held = null // no write of this epoch is sent from now on
    clearTimeout(this.watchdog)
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${this.releaseTimeoutMs} ms`)), this.releaseTimeoutMs)
    })
    try {
      const answer = await Promise.race([this.rpc('worker_release_lease', { p_name: this.name, p_holder: this.holder, p_fencing_token: h.token }), timeout])
      if (answer.error) throw new Error(answer.error.message)
      const released = answer.data === true
      this.log({ event: 'lease_released', lease: this.name, epoch: h.token, released })
      return released
    } catch (e) {
      this.log({ event: 'lease_release_failed', lease: this.name, epoch: h.token, message: 'Could not hand the lease back; it runs out by itself.', error: e })
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** For logs and health: who, which token, how long held and since the last good renewal (monotonic milliseconds). */
  status(): { name: string; holder: string; held: boolean; token: number | null; heldForMs: number | null; renewedAgoMs: number | null } {
    const token = this.token()
    const h = this.held
    const now = this.monotonic()
    return {
      name: this.name, holder: this.holder, held: token !== null, token,
      heldForMs: h ? Math.round(now - h.acquiredAt) : null, renewedAgoMs: h ? Math.round(now - h.renewedAt) : null,
    }
  }

  /** (Re)starts the watchdog for this epoch's local deadline. It does not keep the process alive. */
  private arm(h: Held): void {
    clearTimeout(this.watchdog)
    const t = setTimeout(() => {
      // Past the deadline: token() ends the epoch. A timer that fired a little early waits for the rest.
      if (this.held === h && this.token() !== null) this.arm(h)
    }, Math.max(0, h.validUntil - this.monotonic()) + 10)
    t.unref?.()
    this.watchdog = t
  }

  private markLost(h: Held, reason: LeaseLostReason): void {
    if (this.held !== h) return
    this.held = null
    clearTimeout(this.watchdog)
    this.log({ event: 'lease_lost', lease: this.name, epoch: h.token, reason, message: 'The lease is no longer this worker\'s: all work stops and the worker waits in standby.' })
    for (const fn of [...this.listeners]) {
      try {
        fn(reason)
      } catch {
        // a listener's failure must not keep the others from hearing it
      }
    }
  }
}
