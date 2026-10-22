// Persistence interface of the engine and an in-memory implementation (P7-0).
//
// Every write goes through `commit`, which applies a whole changeset atomically: every record is checked
// against its expected version first (compare-and-set fencing), and only if all match are the records
// written (version + 1) and the events appended. A PostgreSQL implementation does the same in one
// transaction (`UPDATE ... WHERE id = $1 AND version = $2`, insert events, all or nothing).
import { fail, ok, type Job, type JobEvent, type JobState, type NewJobEvent, type Outcome, type Rollout } from './types'

export interface VersionedWrite<T> {
  record: T
  /** null creates the record (it must not exist); a number must equal the stored version. */
  expected_version: number | null
}

export interface Changeset {
  rollouts?: VersionedWrite<Rollout>[]
  jobs?: VersionedWrite<Job>[]
  events?: NewJobEvent[]
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
  /** Atomic, compare-and-set write of records plus appended events. */
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
    const rw = changes.rollouts ?? []
    const jw = changes.jobs ?? []
    const ev = changes.events ?? []
    const r1 = check(this.rollouts, rw, 'rollout')
    if (!r1.ok) return r1
    const r2 = check(this.jobs, jw, 'job')
    if (!r2.ok) return r2
    let lastAt = this.events.length ? this.events[this.events.length - 1].at : -Infinity
    for (const e of ev) {
      if (e.at < lastAt) return fail('version_conflict', 'events must not go back in time')
      lastAt = e.at
    }

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
    for (const e of ev) {
      const stored = deepFreeze({ ...copy(e), seq: this.events.length + 1 })
      this.events.push(stored)
      out.events.push(stored)
    }
    return ok(out)
  }
}
