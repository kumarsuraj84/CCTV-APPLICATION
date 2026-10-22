import { describe, expect, it } from 'vitest'
import { FAST_REFRESH_MS, FAST_WINDOW_MS, SLOW_REFRESH_MS, refreshDelayMs } from '@/lib/monitor/refresh-delay'

describe('Monitoring page refresh pace', () => {
  it('is fast while a check is waiting or running, however long the page has been open', () => {
    expect(refreshDelayMs({ busy: true, openedForMs: 0 })).toBe(8_000)
    expect(refreshDelayMs({ busy: true, openedForMs: 3_600_000 })).toBe(8_000)
  })

  it('is fast for the first two minutes after the page was opened, then slow', () => {
    expect(refreshDelayMs({ busy: false, openedForMs: 0 })).toBe(FAST_REFRESH_MS)
    expect(refreshDelayMs({ busy: false, openedForMs: FAST_WINDOW_MS - 1 })).toBe(FAST_REFRESH_MS)
    expect(refreshDelayMs({ busy: false, openedForMs: FAST_WINDOW_MS })).toBe(SLOW_REFRESH_MS)
    expect(SLOW_REFRESH_MS).toBe(30_000)
  })
})
