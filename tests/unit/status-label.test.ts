import { describe, expect, it } from 'vitest'
import { isStale, STALE_AFTER_MINUTES, statusLabel } from '@/lib/queries/status'

describe('statusLabel', () => {
  it('uses the words the screens use', () => {
    expect(statusLabel('up')).toBe('Live')
    expect(statusLabel('down')).toBe('Offline')
    expect(statusLabel('unknown')).toBe('Not checked yet')
    expect(statusLabel(null)).toBe('Not checked yet')
    expect(statusLabel(undefined)).toBe('Not checked yet')
  })

  it('says "Not checked lately" for a live result that has gone stale, and for nothing else', () => {
    expect(statusLabel('up', true)).toBe('Not checked lately')
    expect(statusLabel('up', false)).toBe('Live')
    // Offline stays offline; never checked stays never checked.
    expect(statusLabel('down', true)).toBe('Offline')
    expect(statusLabel('unknown', true)).toBe('Not checked yet')
    expect(statusLabel(null, true)).toBe('Not checked yet')
  })
})

describe('isStale', () => {
  const NOW = new Date('2026-10-22T10:00:00Z')
  const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

  it('is the 20 minute limit of the database', () => {
    expect(STALE_AFTER_MINUTES).toBe(20)
  })

  it('is true only when the last check is older than the limit; exactly the limit is still fresh', () => {
    expect(isStale(minAgo(1), NOW)).toBe(false)
    expect(isStale(minAgo(STALE_AFTER_MINUTES), NOW)).toBe(false)
    expect(isStale(new Date(NOW.getTime() - STALE_AFTER_MINUTES * 60_000 - 1).toISOString(), NOW)).toBe(true)
    expect(isStale(minAgo(600), NOW)).toBe(true)
  })

  it('treats a missing or unreadable time as stale', () => {
    expect(isStale(null, NOW)).toBe(true)
    expect(isStale(undefined, NOW)).toBe(true)
    expect(isStale('not a time', NOW)).toBe(true)
  })
})
