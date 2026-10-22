// Push-style runner (P7-0): drives hub-side adapters (e.g. a Wi-Fi AP adapter) through the engine protocol.
// One step: renew the offering lease and tick the engine with its fence; for each offer take a snapshot where
// supported, re-check the job right before apply, apply with the idempotency key and the expected hashes, and
// report acknowledgement, start, heartbeat and result; ask stopping jobs to stop; reconcile unknown jobs that are
// due; verify jobs in verification (or report "unsupported" when the adapter cannot read back). A pull-style
// agent maps onto the same engine calls from its check-in (see docs/drishti/job-engine.md).
import type { AdapterTarget, JobAdapter } from './adapter'
import type { JobEngine, TickReport } from './engine'
import type { Job, OfferedJob, Plan } from './types'

export interface StepReport {
  tick: TickReport
  delivered: number
  /** Offers whose response never arrived (the job becomes unknown when its lease runs out). */
  no_response: number
  /** Offers not applied because the re-check right before apply failed. */
  skipped: number
  stops_requested: number
  reconciled: number
  verified: number
}

export class RolloutRunner {
  private readonly stopsSent = new Set<string>()
  /** Raw lease tokens of the jobs this runner delivered (kept in memory only; tests use them to replay messages). */
  readonly deliveredTokens = new Map<string, string>()

  constructor(private readonly engine: JobEngine, private readonly adapters: Record<string, JobAdapter>, private readonly holder = 'runner', private readonly leaseTtlMs = 120_000) {}

  async step(): Promise<StepReport> {
    const empty: TickReport = { offered: [], changed: 0, conflicts: 0 }
    const fence = await this.engine.acquireOfferingLease(this.holder, this.leaseTtlMs)
    const tick = fence.ok ? await this.engine.tick(fence.value) : empty
    const rep: StepReport = { tick, delivered: 0, no_response: 0, skipped: 0, stops_requested: 0, reconciled: 0, verified: 0 }
    for (const job of tick.offered) {
      const res = await this.deliver(job)
      if (res === 'delivered') rep.delivered += 1
      else if (res === 'no_response') rep.no_response += 1
      else rep.skipped += 1
    }
    rep.stops_requested = await this.sendStops()
    for (const job of await this.engine.reconcileCandidates()) if (await this.reconcile(job)) rep.reconciled += 1
    for (const job of await this.engine.verificationCandidates()) if (await this.verify(job)) rep.verified += 1
    return rep
  }

  /** Steps with the clock moving `stepMs` between steps until no rollout is open or `maxSteps` is reached. Returns the steps used. */
  async runUntilSettled(clock: { advance(ms: number): unknown }, stepMs = 1_000, maxSteps = 500): Promise<number> {
    for (let i = 0; i < maxSteps; i++) {
      await this.step()
      const open = (await this.engine.listOpenRollouts()).length
      if (open === 0) return i + 1
      clock.advance(stepMs)
    }
    return maxSteps
  }

  private async context(job: Job): Promise<{ adapter: JobAdapter; target: AdapterTarget; plan: Plan } | null> {
    const r = await this.engine.getRollout(job.rollout_id)
    const adapter = r && Object.hasOwn(this.adapters, r.plan.adapter) ? this.adapters[r.plan.adapter] : undefined
    if (!r || !adapter) return null
    return { adapter, target: { target_id: job.target_id, location_id: job.location_id }, plan: r.plan }
  }

  private async deliver(job: OfferedJob): Promise<'delivered' | 'no_response' | 'skipped'> {
    const ctx = await this.context(job)
    if (!ctx) return 'skipped'
    const token = job.token
    this.deliveredTokens.set(job.id, token)
    if (ctx.adapter.describeCapabilities().operations.snapshot) {
      const snap = await ctx.adapter.snapshot(ctx.target)
      const rec = await this.engine.recordSnapshot(job.id, token, snap.status === 'taken' ? snap : { status: snap.status })
      if (rec.ok && rec.value.state === 'failed') return 'skipped'
    }
    // Re-check right before apply: the lease may have expired, the rollout may have ended or the plan changed.
    const check = await this.engine.checkBeforeApply(job.id, token)
    if (!check.ok) return 'skipped'
    const resp = await ctx.adapter.apply(ctx.target, check.value.plan, check.value.idempotency_key, { payload_hash: check.value.payload_hash, effective_hash: check.value.effective_hash })
    if (!resp.delivered) {
      // No answer: never re-send. The lease runs out, the job becomes unknown and is reconciled.
      if (resp.acknowledged) await this.engine.ack(job.id, token)
      return 'no_response'
    }
    await this.engine.ack(job.id, token)
    await this.engine.start(job.id, token)
    await this.engine.heartbeat(job.id, token)
    await this.engine.reportResult(job.id, token, { outcome: resp.outcome, message: resp.message })
    return 'delivered'
  }

  private async sendStops(): Promise<number> {
    let n = 0
    for (const job of await this.engine.jobsInStates(['offered', 'acked', 'running'])) {
      if (job.stop !== 'requested' || this.stopsSent.has(job.id)) continue
      const ctx = await this.context(job)
      if (!ctx) continue
      await ctx.adapter.stop(ctx.target, job.idempotency_key)
      this.stopsSent.add(job.id)
      n += 1
    }
    return n
  }

  private async reconcile(job: Job): Promise<boolean> {
    const ctx = await this.context(job)
    if (!ctx || !ctx.adapter.describeCapabilities().operations.reconcile) return false
    const rq = await this.engine.beginReconcile(job.id)
    if (!rq.ok) return false
    const resp = await ctx.adapter.reconcile(ctx.target, rq.value.idempotency_key)
    const res = await this.engine.recordReconcile(job.id, rq.value.token, resp.reachable ? resp.state : 'unknown')
    return res.ok
  }

  private async verify(job: Job): Promise<boolean> {
    const ctx = await this.context(job)
    if (!ctx) return false
    const rq = await this.engine.beginVerification(job.id)
    if (!rq.ok) return false
    const v = ctx.adapter.describeCapabilities().operations.verify
      ? await ctx.adapter.verify(ctx.target, ctx.plan)
      : { outcome: 'unsupported' as const, expected: {}, observed: {} }
    return (await this.engine.recordVerification(job.id, rq.value.token, v)).ok
  }
}
