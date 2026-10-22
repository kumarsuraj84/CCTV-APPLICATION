/** Passes a failure on only when it differs from the one before, so a database that stays down does not fill the log every few seconds. */
export class DistinctFailures {
  private last: string | undefined

  report(e: unknown, log: (e: unknown) => void): void {
    const key = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    if (key === this.last) return
    this.last = key
    log(e)
  }

  /** Call when things work again, so the next failure is reported even if it looks like an old one. */
  clear(): void {
    this.last = undefined
  }
}
