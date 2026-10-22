// P2-7 (D-8): an in-memory stand-in for the lease functions of migration 20261021000036 (worker_acquire_lease, worker_renew_lease,
// worker_release_lease) with the same rules, on a database clock of its own (dbNow, in milliseconds). Unit tests move that clock and the
// worker's monotonic clock separately, so a difference between the two is part of what they can show.

type Row = { holder: string; until: number; token: number; released: boolean }
type Answer = { data: unknown; error: { code?: string; message: string } | null }

export class MemoryLeaseDb {
  /** The database clock (ms). Only the database decides whether a lease is live: lease_until > now. */
  dbNow = 1_000_000
  rows = new Map<string, Row>()
  calls: { fn: string; args: Record<string, unknown> }[] = []
  /** The next n calls fail: 'throw' = the request never got an answer, 'error' = PostgREST answered with an error. */
  failNext = 0
  failWith: 'throw' | 'error' = 'throw'
  /** Calls to these functions fail while set (an outage of one kind of call). */
  failing = new Set<string>()
  /** When set, calls wait for this promise before they are answered (a slow or paused database). */
  gate: Promise<void> | null = null

  rpc = async (fn: string, args: Record<string, unknown>): Promise<Answer> => {
    this.calls.push({ fn, args })
    if (this.gate) await this.gate
    if (this.failNext > 0 || this.failing.has(fn)) {
      if (this.failNext > 0) this.failNext--
      if (this.failWith === 'throw') throw new TypeError('fetch failed')
      return { data: null, error: { code: 'PGRST000', message: 'the database cannot be reached' } }
    }
    const now = this.dbNow
    const name = String(args.p_name)
    const row = this.rows.get(name)
    switch (fn) {
      case 'worker_acquire_lease': {
        const holder = String(args.p_holder)
        const ttl = Number(args.p_ttl_sec) * 1000
        if (!row) {
          this.rows.set(name, { holder, until: now + ttl, token: 1, released: false })
          return { data: [{ acquired: true, fencing_token: 1, lease_until: new Date(now + ttl).toISOString(), retry_after_ms: 0 }], error: null }
        }
        if (row.until <= now || row.holder === holder) {
          const sameLive = row.holder === holder && row.until > now && !row.released
          const token = sameLive ? row.token : row.token + 1
          this.rows.set(name, { holder, until: now + ttl, token, released: false })
          return { data: [{ acquired: true, fencing_token: token, lease_until: new Date(now + ttl).toISOString(), retry_after_ms: 0 }], error: null }
        }
        return { data: [{ acquired: false, fencing_token: null, lease_until: new Date(row.until).toISOString(), retry_after_ms: row.until - now }], error: null }
      }
      case 'worker_renew_lease': {
        const ok = !!row && row.holder === String(args.p_holder) && row.token === Number(args.p_fencing_token) && row.until > now && !row.released
        if (!ok) return { data: [{ renewed: false, lease_until: row ? new Date(row.until).toISOString() : null }], error: null }
        row.until = now + Number(args.p_ttl_sec) * 1000
        return { data: [{ renewed: true, lease_until: new Date(row.until).toISOString() }], error: null }
      }
      case 'worker_release_lease': {
        const ok = !!row && row.holder === String(args.p_holder) && row.token === Number(args.p_fencing_token) && !row.released
        if (ok) {
          row.until = Math.min(row.until, now)
          row.released = true
        }
        return { data: ok, error: null }
      }
      default:
        return { data: null, error: { message: `unknown function ${fn}` } }
    }
  }

  /** What the database fence would decide for a write with this lease and token. */
  accepts(name: string, token: number | null): boolean {
    const row = this.rows.get(name)
    return token !== null && !!row && row.token === token && row.until > this.dbNow && !row.released
  }

  /** Ends a lease as if its holder had stopped renewing long ago. */
  expire(name: string): void {
    const row = this.rows.get(name)
    if (row) row.until = this.dbNow - 1
  }

  callsOf(fn: string) {
    return this.calls.filter((c) => c.fn === fn)
  }
}
