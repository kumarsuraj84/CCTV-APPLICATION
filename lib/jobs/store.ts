// Persistence interface of the engine and an in-memory implementation (P7-0).
//
// Every write goes through `commit`, which applies a whole changeset atomically:
// - every written record is checked against its expected version (compare-and-set fencing);
// - every GUARD (a record or counter slot the caller READ to make its decision) must still have the version
//   the caller saw, which rejects write skew (two offers each seeing a free location);
// - a FENCE, when given, must carry the current token of the named lease (only the offering-lease holder may
//   offer; a holder that lost the lease is refused);
// - only if all checks pass are the records written (version + 1), the slots in `bump_slots` incremented and
//   the events appended (sequence numbers in commit order; the sequence, not the wall time, is the order).
// A PostgreSQL implementation does the same in one transaction (UPDATE ... WHERE id = $1 AND version = $2 for
// records and slots, a check of the lease row's fencing token, insert of the events; all or nothing).
import { fail, ok, type Fence, type Job, type JobEvent, type JobState, type NewJobEvent, type Outcome, type Rollout } from './types'

export interface VersionedWrite<T> {
  record: T
  /** null creates the record (it must not exist); a number must equal the stored version. */
  expected_version: number | null
}

/** Something read whose version must be unchanged at commit. Slots are counters such as "location:<id>", "target:<id>", "rollout-active:<id>". */
export type Guard =
  | { kind: 'rollout'; id: string; version: number }
  | { kind: 'job'; id: string; version: number }
  | { kind: 'slot'; key: string; version: number }

export interface Changeset {
  rollouts?: VersionedWrite<Rollout>[]
  jobs?: VersionedWrite<Job>[]
  events?: NewJobEvent[]
  guards?: Guard[]
  /** Counter slots this commit changes (their version is incremented). */
  bump_slots?: string[]
  fence?: Fence
}

export interface CommitResult {
  rollouts: Rollout[]
  jobs: Job[]
  events: JobEvent[]
}

export interface JobStore {
  getRollout(id: string): Promise<Rollout | null>
  listRollouts(): Promise<Rollout[]>
  getJob(id: string): Promise<Job | null>
  listJobsByRollout(rolloutId: string): Promise<Job[]>
  listJobsByTarget(targetId: string): Promise<Job[]>
  listJobsInStates(states: JobState[]): Promise<Job[]>
  /** Events in sequence order. */
  listEvents(filter?: { rollout_id?: string; job_id?: string }): Promise<JobEvent[]>
  /** Current versions of counter slots (0 when never bumped). Read BEFORE reading the data they protect. */
  readSlots(keys: string[]): Promise<Record<string, number>>
  /**
   * Take or renew a named lease. A different holder gets it only after it has run out, and then with a higher
   * fencing token; the same holder renewing keeps its token.
   */
  acquireLease(name: string, holder: string, now: number, ttl_ms: number): Promise<Outcome<Fence>>
  /** Atomic write of records plus appended events, with record versions, guards and an optional fence checked first. */
  commit(changes: Changeset): Promise<Outcome<CommitResult>>
  nextRolloutSeq(): Promise<number>
}

function copy<T>(v: T): T {
  return structuredClone(v)
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const inner of Object.values(v as object)) deepFreeze(inner)
    Object.freeze(v)
  }
  return v
}

export class InMemoryJobStore implements JobStore {
  private readonly rollouts = new Map<string, Rollout>()
  private readonly jobs = new Map<string, Job>()
  private readonly events: JobEvent[] = []
  private readonly slots = new Map<string, number>()
  private readonly leases = new Map<string, { holder: string; token: number; until: number }>()
  private seq = 0

  async getRollout(id: string): Promise<Rollout | null> {
    const r = this.rollouts.get(id)
    return r ? copy(r) : null
  }

  async listRollouts(): Promise<Rollout[]> {
    return [...this.rollouts.values()].sort((a, b) => a.seq - b.seq).map(copy)
  }

  async getJob(id: string): Promise<Job | null> {
    const j = this.jobs.get(id)
    return j ? copy(j) : null
  }

  private sortedJobs(pred: (j: Job) => boolean): Job[] {
    return [...this.jobs.values()].filter(pred).sort((a, b) => a.rollout_seq - b.rollout_seq || a.order - b.order || (a.id < b.id ? -1 : 1)).map(copy)
  }

  async listJobsByRollout(rolloutId: string): Promise<Job[]> {
    return this.sortedJobs((j) => j.rollout_id === rolloutId)
  }

  async listJobsByTarget(targetId: string): Promise<Job[]> {
    return this.sortedJobs((j) => j.target_id === targetId)
  }

  async listJobsInStates(states: JobState[]): Promise<Job[]> {
    const set = new Set(states)
    return this.sortedJobs((j) => set.has(j.state))
  }

  async listEvents(filter: { rollout_id?: string; job_id?: string } = {}): Promise<JobEvent[]> {
    return this.events.filter((e) => (filter.rollout_id === undefined || e.rollout_id === filter.rollout_id) && (filter.job_id === undefined || e.job_id === filter.job_id))
  }

  async readSlots(keys: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(keys.map((k) => [k, this.slots.get(k) ?? 0]))
  }

  async acquireLease(name: string, holder: string, now: number, ttl_ms: number): Promise<Outcome<Fence>> {
    const cur = this.leases.get(name)
    if (cur && cur.holder !== holder && cur.until > now) return fail('stale_fence', `The ${name} lease is held by another worker until ${new Date(cur.until).toISOString()}.`)
    const token = !cur ? 1 : cur.holder === holder && cur.until > now ? cur.token : cur.token + 1
    const lease = { holder, token, until: now + ttl_ms }
    this.leases.set(name, lease)
    return ok({ name, holder, token, until: lease.until })
  }

  async nextRolloutSeq(): Promise<number> {
    this.seq += 1
    return this.seq
  }

  async commit(changes: Changeset): Promise<Outcome<CommitResult>> {
    const check = <T extends { id: string; version: number }>(map: Map<string, T>, writes: VersionedWrite<T>[], kind: string): Outcome<true> => {
      const ids = new Set<string>()
      for (const w of writes) {
        if (ids.has(w.record.id)) return fail('version_conflict', `${kind} ${w.record.id} appears twice in one changeset`)
        ids.add(w.record.id)
        const current = map.get(w.record.id)
        if (w.expected_version === null ? current !== undefined : current?.version !== w.expected_version) {
          return fail('version_conflict', `${kind} ${w.record.id} was changed by someone else; read it again`, {
            expected: w.expected_version,
            actual: current?.version ?? null,
          })
        }
      }
      return ok(true)
    }
    if (changes.fence) {
      const lease = this.leases.get(changes.fence.name)
      if (!lease || lease.token !== changes.fence.token) return fail('stale_fence', `The ${changes.fence.name} lease was taken over; this writer may no longer offer.`)
    }
    for (const g of changes.guards ?? []) {
      const actual = g.kind === 'slot' ? (this.slots.get(g.key) ?? 0) : g.kind === 'rollout' ? this.rollouts.get(g.id)?.version : this.jobs.get(g.id)?.version
      if (actual !== g.version) {
        const what = g.kind === 'slot' ? g.key : `${g.kind} ${g.id}`
        return fail('version_conflict', `${what} changed since it was read; decide again`)
      }
    }
    const rw = changes.rollouts ?? []
    const jw = changes.jobs ?? []
    const r1 = check(this.rollouts, rw, 'rollout')
    if (!r1.ok) return r1
    const r2 = check(this.jobs, jw, 'job')
    if (!r2.ok) return r2

    const out: CommitResult = { rollouts: [], jobs: [], events: [] }
    for (const w of rw) {
      const stored = { ...copy(w.record), version: (w.expected_version ?? 0) + 1 }
      this.rollouts.set(stored.id, stored)
      out.rollouts.push(copy(stored))
    }
    for (const w of jw) {
      const stored = { ...copy(w.record), version: (w.expected_version ?? 0) + 1 }
      this.jobs.set(stored.id, stored)
      out.jobs.push(copy(stored))
    }
    for (const k of new Set(changes.bump_slots ?? [])) this.slots.set(k, (this.slots.get(k) ?? 0) + 1)
    for (const e of changes.events ?? []) {
      const stored = deepFreeze({ ...copy(e), seq: this.events.length + 1 })
      this.events.push(stored)
      out.events.push(stored)
    }
    return ok(out)
  }
}
