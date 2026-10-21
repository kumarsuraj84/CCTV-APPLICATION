import { afterEach, describe, expect, it, vi } from 'vitest'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

afterEach(() => vi.unstubAllGlobals())

describe('resilientFetch', () => {
  it('retries a GET once after a network error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response('ok'))
    vi.stubGlobal('fetch', fn)
    const res = await resilientFetch('http://x.test/a')
    expect(await res.text()).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('does not retry a POST', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('network'))
    vi.stubGlobal('fetch', fn)
    await expect(resilientFetch('http://x.test/a', { method: 'POST' })).rejects.toThrow('network')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
