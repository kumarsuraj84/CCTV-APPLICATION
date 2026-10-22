// Injected dependencies of the engine: time and ids. The engine never reads the real clock or uses timers.
import { randomUUID } from 'node:crypto'

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number
}

export interface IdGenerator {
  /** A new unique id. Lease tokens come from here too, so a production generator must be unguessable. */
  next(prefix: string): string
}

export const systemClock: Clock = { now: () => Date.now() }

/** Production ids: random UUIDs (unguessable lease tokens). */
export const randomIds: IdGenerator = { next: (prefix) => `${prefix}-${randomUUID()}` }
