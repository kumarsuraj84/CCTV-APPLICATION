import { describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '@/lib/admin/types'
import { getMonitoringState, uptimeForPage } from '@/lib/monitor/uptime'

const fakeAdmin = (rows: { target_id: string; uptime_pct: number | null }[] = []) => {
  const rpc = vi.fn((...args: [string, Record<string, unknown>]) => Promise.resolve({ data: rows, error: null, args }))
  return { admin: { rpc } as unknown as AdminClient, rpc }
}
const NOW = new Date('2026-10-22T10:00:00Z')

describe('uptimeForPage', () => {
  it('measures up to now while monitoring runs', async () => {
    const { admin, rpc } = fakeAdmin([{ target_id: 'a', uptime_pct: 99.5 }])
    const out = await uptimeForPage(admin, 'org', 'camera', ['a', 'b'], '24h', { running: true, lastSeenAt: null })
    expect(out.get('a')).toBe(99.5)
    expect(out.get('b')).toBeNull()
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_now')
  })
  it('measures up to the last sign of life while it is stopped, so the stoppage is not downtime', async () => {
    const { admin, rpc } = fakeAdmin()
    const seen = new Date('2026-10-22T08:00:00Z')
    await uptimeForPage(admin, 'org', 'device', ['a'], '7d', { running: false, lastSeenAt: seen })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_now: seen.toISOString(), p_window: '168 hours' })
  })
  it('has no data at all when monitoring never ran', async () => {
    const { admin, rpc } = fakeAdmin()
    const out = await uptimeForPage(admin, 'org', 'device', ['a'], '24h', { running: false, lastSeenAt: null })
    expect(out.get('a')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('getMonitoringState', () => {
  const adminWith = (last_heartbeat: string | null, fail = false) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ single: async () => (fail ? { data: null, error: { message: 'down' } } : { data: { last_heartbeat }, error: null }) }) }) }) }) as unknown as AdminClient
  it('is running with a recent heartbeat', async () => {
    expect(await getMonitoringState(adminWith('2026-10-22T09:59:50Z'), NOW)).toEqual({ running: true, lastSeenAt: null })
  })
  it('is stopped with an old heartbeat and remembers when it was last seen', async () => {
    const s = await getMonitoringState(adminWith('2026-10-22T09:00:00Z'), NOW)
    expect(s.running).toBe(false)
    expect(s.lastSeenAt?.toISOString()).toBe('2026-10-22T09:00:00.000Z')
  })
  it('is stopped with no heartbeat or when the state cannot be read, and never throws', async () => {
    expect(await getMonitoringState(adminWith(null), NOW)).toEqual({ running: false, lastSeenAt: null })
    expect(await getMonitoringState(adminWith(null, true), NOW)).toEqual({ running: false, lastSeenAt: null })
  })
})
