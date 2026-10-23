import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerLease, type LeaseFence } from '@/lib/monitor/lease'
import { STOP_ACQUIRE_WAIT_MS, WorkerSupervisor, type SupervisedRunner } from '@/lib/monitor/supervisor'
import { MemoryLeaseDb } from '../helpers/memory-lease'

// P2-7 (D-8): the worker runs its checks only while it holds the lease. It waits in standby while another worker holds it, stops all work
// when the lease is lost (and goes back to standby to try again), and hands the lease back when it is stopped.

const HOLDERS = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2']

/** A runner that only records what happened to it and what token its fence carried when it started. */
class FakeRunner implements SupervisedRunner {
  events: string[] = []
  constructor(public fence: LeaseFence) {}
  async start() {
    this.events.push(`start:${this.fence.token()}`)
  }
  abandon() {
    this.events.push('abandon')
  }
  async shutdown() {
    this.events.push(`shutdown:${this.fence.token()}`)
    return true
  }
}

/** Real time is used here, so that the supervisor's own loops run; the clocks below only measure the lease (fast, short TTL). */
function setup(db = new MemoryLeaseDb(), holder = HOLDERS[0]) {
  const start = Date.now()
  const logs: Record<string, unknown>[] = []
  const runners: FakeRunner[] = []
  // The database clock follows real time; the lease is short so that the tests are quick.
  const lease = new WorkerLease({ rpc: async (fn, args) => {
    db.dbNow = 1_000_000 + (Date.now() - start)
    return db.rpc(fn, args)
  }, holder, ttlSec: 1, renewEveryMs: 100, marginMs: 200, log: (e) => logs.push(e) })
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'))
      const t = setTimeout(resolve, Math.min(ms, 50))
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
    })
  const supervisor = new WorkerSupervisor({
    lease,
    sleep,
    log: (e) => logs.push(e),
    makeRunner: (fence) => {
      const r = new FakeRunner(fence)
      runners.push(r)
      return r
    },
  })
  return { db, lease, supervisor, runners, logs }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

afterEach(() => vi.restoreAllMocks())

describe('WorkerSupervisor (P2-7)', () => {
  it('two workers started together: exactly one becomes active, the other waits in standby', async () => {
    const db = new MemoryLeaseDb()
    const a = setup(db, HOLDERS[0])
    const b = setup(db, HOLDERS[1])
    void a.supervisor.run()
    void b.supervisor.run()
    await until(() => a.runners.length + b.runners.length === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(a.runners.length + b.runners.length).toBe(1)
    expect([a.supervisor.phase, b.supervisor.phase].sort()).toEqual(['active', 'standby'])
    await a.supervisor.stop(1000)
    await b.supervisor.stop(1000)
  })

  it('a runner starts only with a valid token, and the lease is renewed while it runs', async () => {
    const s = setup()
    void s.supervisor.run()
    await until(() => s.runners.length === 1)
    expect(s.runners[0].events[0]).toBe('start:1')
    await new Promise((r) => setTimeout(r, 1500)) // longer than the 1 s TTL: renewals keep it
    expect(s.lease.token()).toBe(1)
    expect(s.db.callsOf('worker_renew_lease').length).toBeGreaterThan(5)
    await s.supervisor.stop(1000)
  })

  it('a lost lease stops all work at once (abandon, nothing more written), then the worker waits in standby and takes the lease again', async () => {
    const s = setup()
    void s.supervisor.run()
    await until(() => s.runners.length === 1)
    // Someone else takes the lease over (the database says so on the next renewal).
    s.db.expire('monitor')
    const other = new WorkerLease({ rpc: s.db.rpc, holder: HOLDERS[1], ttlSec: 1 })
    expect((await other.tryAcquire()).result).toBe('acquired')
    await until(() => s.runners[0].events.includes('abandon'))
    expect(s.runners[0].fence.token()).toBeNull()
    expect(s.supervisor.phase).toBe('standby')
    expect(s.logs.filter((l) => l.event === 'lease_lost')).toHaveLength(1)
    expect(s.logs.some((l) => l.event === 'worker_standby')).toBe(true)
    // The other worker stops renewing: ours takes over with a new token and a NEW runner; the old one stays shut.
    await until(() => s.runners.length === 2, 4000)
    expect(s.runners[1].events[0]).toBe('start:3')
    expect(s.runners[0].fence.token()).toBeNull()
    expect(s.runners[0].events).toEqual(['start:1', 'abandon'])
    await s.supervisor.stop(1000)
  })

  it('stopping shuts the runner down while the lease is still held (its last writes are fenced with a valid token), then releases it: another worker gets it at once', async () => {
    const s = setup()
    void s.supervisor.run()
    await until(() => s.runners.length === 1)
    expect(await s.supervisor.stop(1000)).toBe(true)
    expect(s.runners[0].events).toEqual(['start:1', 'shutdown:1'])
    expect(s.db.callsOf('worker_release_lease')).toHaveLength(1)
    expect(s.supervisor.phase).toBe('stopped')
    const other = new WorkerLease({ rpc: s.db.rpc, holder: HOLDERS[1], ttlSec: 1 })
    expect(await other.tryAcquire()).toEqual({ result: 'acquired', token: 2 })
  })

  it('stopping while in standby ends the wait; no runner was ever made', async () => {
    const db = new MemoryLeaseDb()
    const holder = setup(db, HOLDERS[1])
    void holder.supervisor.run()
    await until(() => holder.runners.length === 1)
    const s = setup(db, HOLDERS[0])
    const done = s.supervisor.run()
    await new Promise((r) => setTimeout(r, 200))
    expect(s.supervisor.phase).toBe('standby')
    await s.supervisor.stop(1000)
    await done
    expect(s.runners).toHaveLength(0)
    expect(s.db.callsOf('worker_release_lease')).toHaveLength(0) // it held nothing, so it hands nothing back
    expect(holder.supervisor.phase).toBe('active')
    await holder.supervisor.stop(1000)
  })

  it('stopping while an acquisition is on its way: the lease it then gets is handed back at once, and no runner is made (review M-3)', async () => {
    const s = setup()
    let open!: () => void
    s.db.gate = new Promise<void>((r) => (open = r))
    const done = s.supervisor.run()
    await until(() => s.db.callsOf('worker_acquire_lease').length === 1)
    const stopping = s.supervisor.stop(1000)
    s.db.gate = null
    open() // the database answers: the lease was taken after all
    await stopping
    await done
    expect(s.runners).toHaveLength(0)
    expect(s.db.callsOf('worker_release_lease')).toHaveLength(1)
    const other = new WorkerLease({ rpc: s.db.rpc, holder: HOLDERS[1], ttlSec: 1 })
    expect((await other.tryAcquire()).result).toBe('acquired') // at once, not after the TTL
  })

  it('release 1 (P2-7 re-review R-4): stopping while an acquisition never gets an answer returns within the bound, and a late answer is still handed back', async () => {
    const s = setup()
    let open!: () => void
    s.db.gate = new Promise<void>((r) => (open = r))
    const done = s.supervisor.run()
    await until(() => s.db.callsOf('worker_acquire_lease').length === 1)
    const t0 = Date.now()
    await s.supervisor.stop(1000, { acquireWaitMs: 300 })
    const waited = Date.now() - t0
    expect(waited).toBeLessThan(1500) // before: stop() waited for the unanswered acquisition for ever
    expect(s.supervisor.phase).toBe('stopped')
    // The answer comes after the stop: the lease taken is handed back at once, no runner is made.
    s.db.gate = null
    open()
    await done
    expect(s.runners).toHaveLength(0)
    await until(() => s.db.callsOf('worker_release_lease').length === 1)
  })

  it('release 1 (R-4): the default bound for an acquisition in flight at stop is 3 s', () => {
    expect(STOP_ACQUIRE_WAIT_MS).toBe(3000)
  })

  it('survives a database outage: a runner is never started without a token; once the database is back the lease is taken', async () => {
    const s = setup()
    s.db.failing.add('worker_acquire_lease')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    void s.supervisor.run()
    await new Promise((r) => setTimeout(r, 300))
    expect(s.runners).toHaveLength(0)
    s.db.failing.clear()
    await until(() => s.runners.length === 1)
    expect(s.runners[0].events[0]).toBe('start:1')
    await s.supervisor.stop(1000)
  })

  it('the worker entry point uses the lease supervisor; the heartbeat guard is gone (brief item 3, 5j)', () => {
    const root = path.resolve(__dirname, '../..')
    const entry = readFileSync(path.join(root, 'services/worker/index.ts'), 'utf8')
    expect(entry).toContain('WorkerSupervisor')
    expect(entry).toContain('WorkerLease')
    expect(entry).not.toMatch(/waitForSoleWorker|anotherWorkerIsRunning|lib\/monitor\/guard/)
    expect(() => readFileSync(path.join(root, 'lib/monitor/guard.ts'))).toThrow()
  })
})
