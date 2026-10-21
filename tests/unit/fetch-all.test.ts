import { describe, expect, it } from 'vitest'
import { fetchAll } from '@/lib/supabase/fetch-all'

describe('fetchAll', () => {
  it('reads every page until a short page comes back', async () => {
    const all = Array.from({ length: 2300 }, (_, i) => i)
    const calls: [number, number][] = []
    const out = await fetchAll<number>(async (from, to) => {
      calls.push([from, to])
      return { data: all.slice(from, to + 1), error: null }
    })
    expect(out).toEqual(all)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('throws when a page fails', async () => {
    await expect(fetchAll<number>(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow()
  })
})
