import { describe, expect, it, vi } from 'vitest'
import { HOUSEKEEPING_EVERY_MS, runHousekeeping } from '@/lib/monitor/housekeeping'

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
