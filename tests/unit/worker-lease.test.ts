import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LEASE_NAME, LEASE_RENEW_EVERY_MS, LEASE_TTL_SEC, WorkerLease, type WorkerLeaseOptions } from '@/lib/monitor/lease'
import { MemoryLeaseDb } from '../helpers/memory-lease'

// P2-7 (D-8, SO-14): the worker's lease with a fencing token. The database decides who holds it (its own clock); the worker only
// measures durations on a monotonic clock of its own, so a difference between the two clocks never matters (brief item 5f).

const HOLDER_A = '00000000-0000-4000-8000-00000000000a'
const HOLDER_B = '00000000-0000-4000-8000-00000000000b'

/** Two clocks: the worker's monotonic clock and the database clock, moved together by sleep (time passes for both). */
function world() {
  const db = new MemoryLeaseDb()
  const mono = { t: 50 }
  const slept: number[] = []
  const logs: Record<string, unknown>[] = []
  const pass = (ms: number) => {
    mono.t += ms
    db.dbNow += ms
  }
  const sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('aborted')
    slept.push(ms)
    pass(ms)
  }
  const lease = (o: Partial<WorkerLeaseOptions> = {}) =>
    new WorkerLease({ rpc: db.rpc, holder: HOLDER_A, monotonic: () => mono.t, log: (e) => logs.push(e), ...o })
  return { db, mono, slept, logs, pass, sleep, lease, events: (name: string) => logs.filter((l) => l.event === name) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorkerLease (P2-7)', () => {
  it('defaults: lease name "monitor", TTL 20 s, renewal every 5 s; a bad name or holder is refused at once', () => {
    expect(DEFAULT_LEASE_NAME).toBe('monitor')
    expect(LEASE_TTL_SEC).toBe(20)
    expect(LEASE_RENEW_EVERY_MS).toBe(5000)
    const w = world()
    expect(w.lease().name).toBe('monitor')
    expect(w.lease({ name: 'monitor:shard-3' }).name).toBe('monitor:shard-3')
    expect(() => w.lease({ name: 'Monitor shard' })).toThrow()
    expect(() => w.lease({ name: '' })).toThrow()
    expect(() => w.lease({ holder: 'not-a-uuid' })).toThrow()
    // Without a holder a fresh one is made for this process.
    expect(new WorkerLease({ rpc: w.db.rpc }).holder).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('acquires a free lease (token 1) and sends name, holder and TTL; a second worker is told it is taken', async () => {
    const w = world()
    const a = w.lease()
    expect(await a.tryAcquire()).toEqual({ result: 'acquired', token: 1 })
    expect(a.token()).toBe(1)
    expect(w.db.callsOf('worker_acquire_lease')[0].args).toMatchObject({ p_name: 'monitor', p_holder: HOLDER_A, p_ttl_sec: 20 })
    const b = w.lease({ holder: HOLDER_B })
    const answer = await b.tryAcquire()
    expect(answer.result).toBe('taken')
    expect(b.token()).toBeNull()
  })

  it('two workers started together: exactly one holds the lease', async () => {
    const w = world()
    const workers = Array.from({ length: 8 }, (_, i) => w.lease({ holder: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}` }))
    const answers = await Promise.all(workers.map((x) => x.tryAcquire()))
    expect(answers.filter((r) => r.result === 'acquired')).toHaveLength(1)
    expect(workers.filter((x) => x.token() !== null)).toHaveLength(1)
  })

  it('waits in standby while another holder is live (logged once), and takes over with token + 1 when that lease runs out', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    const b = w.lease({ holder: HOLDER_B })
    const never = new AbortController().signal
    // A stops renewing (paused). B keeps trying; the database lets it in once A's lease has run out on the DATABASE clock.
    expect(await b.acquire(never, w.sleep)).toBe(true)
    expect(b.token()).toBe(2)
    expect(w.events('lease_standby')).toHaveLength(1)
    // B never waited longer than the rest of A's lease (plus a little), and never in a tight loop.
    expect(w.slept.every((ms) => ms >= 250 && ms <= LEASE_TTL_SEC * 1000 + 250)).toBe(true)
    expect(w.slept.reduce((s, ms) => s + ms, 0)).toBeGreaterThanOrEqual(20_000)
  })

  it('a database that cannot be reached at start-up is tried again with a growing pause (never a crash), each kind of failure logged once', async () => {
    const w = world()
    w.db.failNext = 4
    const a = w.lease()
    expect(await a.acquire(new AbortController().signal, w.sleep)).toBe(true)
    expect(w.slept).toEqual([1000, 2000, 4000, 8000])
    expect(w.events('lease_acquire_failed')).toHaveLength(1)
    w.db.failWith = 'error'
    const many = world()
    many.db.failNext = 9
    many.db.failWith = 'error'
    await many.lease().acquire(new AbortController().signal, many.sleep)
    expect(Math.max(...many.slept)).toBe(30_000) // the pause stops growing at 30 s
  })

  it('stops trying when asked to', async () => {
    const w = world()
    w.db.failing.add('worker_acquire_lease')
    const stop = new AbortController()
    const sleep = async (ms: number, signal?: AbortSignal) => {
      await w.sleep(ms, signal)
      if (w.slept.length === 3) stop.abort()
    }
    expect(await w.lease().acquire(stop.signal, sleep)).toBe(false)
  })

  it('renews every 5 s with the token it holds; the lease stays held for as long as renewals work', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    const run = new AbortController()
    let rounds = 0
    const sleep = async (ms: number, signal?: AbortSignal) => {
      await w.sleep(ms, signal)
      if (++rounds === 12) run.abort()
    }
    await a.keepRenewing(run.signal, sleep)
    const renewals = w.db.callsOf('worker_renew_lease')
    expect(renewals.length).toBe(11)
    expect(renewals[0].args).toMatchObject({ p_name: 'monitor', p_holder: HOLDER_A, p_fencing_token: 1, p_ttl_sec: 20 })
    expect(w.slept.every((ms) => ms === 5000)).toBe(true)
    expect(a.token()).toBe(1) // 60 s later, still the same epoch
  })

  it('a refused renewal (the token is stale: someone took over) ends the lease at once: lease_lost logged once, listeners told once', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    const seen: string[] = []
    a.onLost((reason) => seen.push(reason))
    w.db.expire('monitor')
    const b = w.lease({ holder: HOLDER_B })
    expect((await b.tryAcquire()).result).toBe('acquired')
    expect(await a.renew()).toBe('refused')
    expect(a.token()).toBeNull()
    expect(await a.renew()).toBe('not_held')
    expect(seen).toEqual(['renewal_refused'])
    expect(w.events('lease_lost')).toHaveLength(1)
    // Review round 1 (M-6): the fencing token is logged as `epoch` (a token is no secret, and the logger hides fields named "token").
    expect(w.events('lease_lost')[0]).toMatchObject({ lease: 'monitor', epoch: 1, reason: 'renewal_refused' })
  })

  it('renewal errors (database outage) keep the lease until the local deadline (TTL minus a margin, on the monotonic clock), then it is lost', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    w.db.failing.add('worker_renew_lease')
    w.pass(5000)
    expect(await a.renew()).toBe('error')
    expect(a.token()).toBe(1)
    w.pass(10_000)
    expect(await a.renew()).toBe('error')
    expect(a.token()).toBe(1) // 15 s after the last good renewal
    w.pass(3500) // 18.5 s: inside the safety margin before the database's 20 s
    expect(a.token()).toBeNull()
    expect(w.events('lease_lost')[0]).toMatchObject({ reason: 'renewal_timed_out' })
    expect(w.events('lease_renew_failed')).toHaveLength(1) // the same failure twice is logged once
  })

  it('a worker whose database calls all hang (paused, cut off) still ends the epoch at its local deadline, without anyone asking for the token', async () => {
    const db = new MemoryLeaseDb()
    const logs: Record<string, unknown>[] = []
    const a = new WorkerLease({ rpc: db.rpc, holder: HOLDER_A, ttlSec: 1, renewEveryMs: 100, marginMs: 400, log: (e) => logs.push(e) })
    await a.tryAcquire()
    const seen: string[] = []
    a.onLost((r) => seen.push(r))
    db.gate = new Promise<void>(() => {}) // nothing is ever answered again
    void a.renew()
    await new Promise((r) => setTimeout(r, 800)) // the local deadline is 600 ms after the acquisition was sent
    expect(seen).toEqual(['renewal_timed_out'])
    expect(logs.filter((l) => l.event === 'lease_lost')).toHaveLength(1)
  })

  it('a renewal that is answered late counts from when it was SENT (the database clock may be ahead), never from the answer', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    let open!: () => void
    w.db.gate = new Promise<void>((r) => (open = r))
    w.pass(4000)
    const pending = a.renew()
    w.pass(10_000) // the answer takes 10 s
    w.db.gate = null
    open()
    expect(await pending).toBe('renewed')
    w.pass(4500) // 14.5 s after the renewal was sent
    expect(a.token()).toBe(1)
    w.pass(4000) // 18.5 s after it was sent: past the local deadline even though the answer came 8.5 s ago
    expect(a.token()).toBeNull()
  })

  it('the fence of an epoch never carries a later epoch\'s token: after a loss and a new acquisition the old fence stays shut', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    const first = a.fence()
    expect(first.name).toBe('monitor')
    expect(first.token()).toBe(1)
    first.lost('write_refused')
    expect(first.token()).toBeNull()
    expect(w.events('lease_lost')[0]).toMatchObject({ reason: 'write_refused' })
    // The same holder acquires again: a NEW token (review round 1, M-2), and the old fence never returns any token.
    expect(await a.tryAcquire()).toEqual({ result: 'acquired', token: 2 })
    const second = a.fence()
    expect(second.token()).toBe(2)
    expect(first.token()).toBeNull()
    expect(w.db.accepts('monitor', 1)).toBe(false) // a request of the old epoch already on its way is refused by the database too
    first.lost('write_refused') // a late refusal of the old epoch does not end the new one
    expect(second.token()).not.toBeNull()
  })

  it('release hands the lease back with its token: the token is gone, nobody is told it was lost, and another worker gets it at once', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    const seen: string[] = []
    a.onLost((r) => seen.push(r))
    expect(await a.release()).toBe(true)
    expect(w.db.callsOf('worker_release_lease')[0].args).toMatchObject({ p_name: 'monitor', p_holder: HOLDER_A, p_fencing_token: 1 })
    expect(a.token()).toBeNull()
    expect(seen).toEqual([])
    expect(await w.lease({ holder: HOLDER_B }).tryAcquire()).toEqual({ result: 'acquired', token: 2 })
    expect(await a.release()).toBe(false) // nothing held: nothing sent
    expect(w.db.callsOf('worker_release_lease')).toHaveLength(1)
  })

  it('a release whose answer never comes gives up after its time limit (a first Ctrl+C never hangs on the database; review M-3)', async () => {
    const w = world()
    const a = w.lease({ releaseTimeoutMs: 100 })
    await a.tryAcquire()
    w.db.gate = new Promise<void>(() => {})
    const began = Date.now()
    expect(await a.release()).toBe(false)
    expect(Date.now() - began).toBeLessThan(1000)
    expect(a.token()).toBeNull()
  })

  it('the default log shows the fencing token as "epoch", not redacted (review M-6)', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(String(l)))
    vi.spyOn(console, 'error').mockImplementation((l: string) => void lines.push(String(l)))
    const db = new MemoryLeaseDb()
    const a = new WorkerLease({ rpc: db.rpc, holder: HOLDER_A })
    await a.tryAcquire()
    const acquired = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'lease_acquired')
    expect(acquired).toMatchObject({ lease: 'monitor', epoch: 1 })
    expect(lines.join('\n')).not.toContain('[redacted]')
  })

  it('a release that cannot reach the database never throws (the lease then simply runs out)', async () => {
    const w = world()
    const a = w.lease()
    await a.tryAcquire()
    w.db.failNext = 1
    expect(await a.release()).toBe(false)
    expect(a.token()).toBeNull()
  })

  it('two lease names are independent: two workers hold "monitor:shard-1" and "monitor:shard-2" at the same time', async () => {
    const w = world()
    const one = w.lease({ name: 'monitor:shard-1' })
    const two = w.lease({ name: 'monitor:shard-2', holder: HOLDER_B })
    expect((await one.tryAcquire()).result).toBe('acquired')
    expect((await two.tryAcquire()).result).toBe('acquired')
    expect(w.db.accepts('monitor:shard-1', one.token())).toBe(true)
    expect(w.db.accepts('monitor:shard-2', two.token())).toBe(true)
    expect(one.status()).toMatchObject({ name: 'monitor:shard-1', held: true, token: 1 })
  })

  it('never reads the wall clock: a worker whose clock is years off keeps the same lease decisions (brief item 5f)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2041-01-01T00:00:00Z'))
    const spy = vi.spyOn(Date, 'now')
    const w = world()
    w.db.dbNow = Date.parse('2026-10-23T08:00:00Z') // the database is fifteen years "behind" the worker
    const a = w.lease()
    expect((await a.tryAcquire()).result).toBe('acquired')
    w.pass(5000)
    expect(await a.renew()).toBe('renewed')
    vi.setSystemTime(new Date('1999-01-01T00:00:00Z')) // and now the worker's clock jumps back
    w.pass(5000)
    expect(await a.renew()).toBe('renewed')
    expect(a.token()).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('status reports holder, token and how long ago the lease was taken and renewed (monotonic clock)', async () => {
    const w = world()
    const a = w.lease()
    expect(a.status()).toMatchObject({ name: 'monitor', holder: HOLDER_A, held: false, token: null })
    await a.tryAcquire()
    w.pass(5000)
    await a.renew()
    w.pass(2000)
    expect(a.status()).toMatchObject({ held: true, token: 1, heldForMs: 7000, renewedAgoMs: 2000 })
  })
})
