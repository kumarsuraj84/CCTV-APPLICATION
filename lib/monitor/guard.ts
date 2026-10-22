export type GuardDeps = {
  /** The time of the last heartbeat in worker_state, or null if there has never been one. May throw if the database cannot be read. */
  readHeartbeat: () => Promise<Date | null>
  now: () => Date
  sleep: (ms: number) => Promise<void>
  pollSec: number
}

/**
 * Only one worker may run against a database: two would write the same checks and overwrite each other's state.
 * worker_state has no owner column, so this looks at the heartbeat instead. A heartbeat older than three poll intervals means nobody is running.
 * A newer one is either a live worker or one that has only just stopped; waiting a little longer than one poll interval tells them apart,
 * because a live worker beats again in that time.
 */
export async function anotherWorkerIsRunning(deps: GuardDeps): Promise<boolean> {
  const first = await deps.readHeartbeat()
  if (!first) return false
  if (deps.now().getTime() - first.getTime() > deps.pollSec * 3000) return false
  await deps.sleep(deps.pollSec * 1000 + 1500)
  const second = await deps.readHeartbeat()
  return !!second && second.getTime() !== first.getTime()
}
