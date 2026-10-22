// Push-style runner (P7-0): drives hub-side adapters (e.g. a Wi-Fi AP adapter) through the engine protocol.
// One step: tick the engine; for each offer take a snapshot where supported, apply with the idempotency key,
// and report the acknowledgement and result; ask stopping jobs to stop; reconcile unknown jobs of reachable
// targets; re-read and verify jobs in verification. A pull-style agent maps onto the same engine calls from
// its check-in (see docs/drishti/job-engine.md).
import type { AdapterTarget, JobAdapter } from './adapter'
import type { JobEngine, TickReport } from './engine'
import type { Job, Plan } from './types'

export interface StepReport {
  tick: TickReport
  delivered: number
  /** Offers whose response never arrived (the job becomes unknown when its lease runs out). */
  no_response: number
  stops_requested: number
  reconciled: number
  verified: number
}

export class RolloutRunner {
  private readonly stopsSent = new Set<string>()

  constructor(private readonly engine: JobEngine, private readonly adapters: Record<string, JobAdapter>) {}

  async step(): Promise<StepReport> {
    const tick = await this.engine.tick()
    const rep: StepReport = { tick, delivered: 0, no_response: 0, stops_requested: 0, reconciled: 0, verified: 0 }
    for (const job of tick.offered) {
      if (await this.deliver(job)) rep.delivered += 1
      else rep.no_response += 1
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
    const adapter = r ? this.adapters[r.plan.adapter] : undefined
    if (!r || !adapter) return null
    return { adapter, target: { target_id: job.target_id, location_id: job.location_id }, plan: r.plan }
  }

  private async deliver(job: Job): Promise<boolean> {
    const ctx = await this.context(job)
    if (!ctx || !job.lease) return false
    const token = job.lease.token
    if (ctx.adapter.describeCapabilities().operations.snapshot) {
      const snap = await ctx.adapter.snapshot(ctx.target)
      await this.engine.recordSnapshot(job.id, token, snap.status === 'taken' ? { status: 'taken', ref: snap.ref } : { status: snap.status })
    }
    const resp = await ctx.adapter.apply(ctx.target, ctx.plan, job.idempotency_key)
    if (!resp.delivered) {
      // No answer: never re-send. The lease runs out, the job becomes unknown and is reconciled.
      if (resp.acknowledged) await this.engine.ack(job.id, token)
      return false
    }
    await this.engine.ack(job.id, token)
    await this.engine.reportResult(job.id, token, { outcome: resp.outcome, message: resp.message })
    return true
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
    if (!ctx) return false
    const rq = await this.engine.beginReconcile(job.id)
    if (!rq.ok) return false
    const resp = await ctx.adapter.reconcile(ctx.target, rq.value.idempotency_key)
    const res = await this.engine.recordReconcile(job.id, rq.value.token, resp.reachable ? resp.state : 'unknown')
    return res.ok
  }

  private async verify(job: Job): Promise<boolean> {
    const ctx = await this.context(job)
    if (!ctx) return false
    const v = await ctx.adapter.verify(ctx.target, ctx.plan)
    return (await this.engine.recordVerification(job.id, v)).ok
  }
}
