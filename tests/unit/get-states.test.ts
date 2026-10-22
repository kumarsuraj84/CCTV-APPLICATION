import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStates } from '@/lib/queries/status'

describe('getStates', () => {
  it('reads in chunks of 100, at most four at a time, and keeps every row', async () => {
    let running = 0
    let peak = 0
    const calls: string[][] = []
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: async (_col: string, ids: string[]) => {
              calls.push(ids)
              running++
              peak = Math.max(peak, running)
              await new Promise((r) => setTimeout(r, 5))
              running--
              return { data: ids.map((id) => ({ target_id: id, status: 'up', down_since: null, last_checked_at: null, last_up_at: null, error: null })), error: null }
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient
    const ids = Array.from({ length: 950 }, (_, i) => `id${i}`)
    const out = await getStates(client as never, 'camera', ids)
    expect(out.size).toBe(950)
    expect(calls).toHaveLength(10)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('still fails when a read fails', async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: 'x' } }) }) }) }) } as unknown as SupabaseClient
    await expect(getStates(client as never, 'device', ['a'])).rejects.toThrow('Could not read the status.')
  })
})
