import { describe, expect, it, vi } from 'vitest'
import { HOUSEKEEPING_EVERY_MS, runHousekeeping, scheduleHousekeeping } from '@/lib/monitor/housekeeping'

// P2-6 (D-11, D-14, addendum): the worker prunes the shared rate-limit windows, the media session rows and the credential-read log
// under its own database role. One failure never stops the others, and nothing is thrown.
describe('worker housekeeping', () => {
  it('calls the three prune functions and reports what each removed', async () => {
    const calls: string[] = []
    const rpc = vi.fn(async (name: string) => {
      calls.push(name)
      return { data: name === 'rate_limit_prune' ? 4 : name === 'media_sessions_prune' ? 2 : 0, error: null }
    })
    const log = vi.fn()
    const r = await runHousekeeping({ rpc }, log)
    expect(calls.sort()).toEqual(['media_sessions_prune', 'rate_limit_prune', 'vault_reads_prune'])
    expect(r).toEqual({ rate_limit_prune: 4, media_sessions_prune: 2, vault_reads_prune: 0 })
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'housekeeping_done' }))
  })

  it('a failing prune is logged by its code only and the others still run', async () => {
    const rpc = vi.fn(async (name: string) =>
      name === 'media_sessions_prune' ? { data: null, error: { code: '42501', message: 'permission denied for function media_sessions_prune' } } : { data: 1, error: null })
    const log = vi.fn()
    const r = await runHousekeeping({ rpc }, log)
    expect(r).toEqual({ rate_limit_prune: 1, media_sessions_prune: null, vault_reads_prune: 1 })
    const failed = log.mock.calls.map((c) => c[0]).find((e) => e.event === 'housekeeping_failed')
    expect(failed).toEqual({ event: 'housekeeping_failed', task: 'media_sessions_prune', errorCode: '42501' })
  })

  it('a thrown error counts as a failure, never escapes', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('network down')
    })
    await expect(runHousekeeping({ rpc }, vi.fn())).resolves.toEqual({ rate_limit_prune: null, media_sessions_prune: null, vault_reads_prune: null })
  })

  it('runs every ten minutes', () => {
    expect(HOUSEKEEPING_EVERY_MS).toBe(10 * 60_000)
  })
})

// P5.4 brief item 3 (P2-4: never-opened media session rows pile up until media_sessions_prune runs): the worker schedules the
// clean-up itself — 30 s after it starts, then every 10 minutes — and runs it only while it holds the lease; a slow run is never
// stacked under the next one; stop() ends the schedule.
describe('the worker schedules the clean-up (P5.4)', () => {
  it('first after 30 s, then every 10 minutes, only while active; never two at once; stop ends it', async () => {
    vi.useFakeTimers()
    try {
      let active = false
      let running = 0
      let most = 0
      let release: (() => void) | null = null
      const run = vi.fn(async () => {
        running++
        most = Math.max(most, running)
        await new Promise<void>((r) => (release = r))
        running--
      })
      const stop = scheduleHousekeeping({ isActive: () => active, run })
      await vi.advanceTimersByTimeAsync(29_000)
      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000) // 30 s: in standby, nothing runs
      expect(run).not.toHaveBeenCalled()
      active = true
      await vi.advanceTimersByTimeAsync(HOUSEKEEPING_EVERY_MS)
      expect(run).toHaveBeenCalledTimes(1)
      // The run is still busy when the next one is due: it is not stacked.
      await vi.advanceTimersByTimeAsync(HOUSEKEEPING_EVERY_MS)
      expect(run).toHaveBeenCalledTimes(1)
      release!()
      await vi.advanceTimersByTimeAsync(HOUSEKEEPING_EVERY_MS)
      expect(run).toHaveBeenCalledTimes(2)
      release!()
      expect(most).toBe(1)
      stop()
      await vi.advanceTimersByTimeAsync(5 * HOUSEKEEPING_EVERY_MS)
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a run that throws is contained and the schedule goes on', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn(async () => {
        throw new Error('database down')
      })
      const stop = scheduleHousekeeping({ isActive: () => true, run })
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(HOUSEKEEPING_EVERY_MS)
      expect(run).toHaveBeenCalledTimes(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
