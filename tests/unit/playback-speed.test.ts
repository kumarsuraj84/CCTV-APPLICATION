import { describe, expect, it, vi } from 'vitest'
import { explainVodFailure, fastMinutes, isSpeed, MAX_FAST_MINUTES, SPEEDS, speedLabel, vodUrl } from '@/lib/streams/speed'

describe('speeds', () => {
  it('are 1x, 2x, 4x and 8x', () => {
    expect([...SPEEDS]).toEqual([1, 2, 4, 8])
    expect(SPEEDS.map(speedLabel)).toEqual(['1x', '2x', '4x', '8x'])
    expect([1, 2, 4, 8].every(isSpeed)).toBe(true)
    expect([0, 3, 16, '2', null, undefined, Number.NaN].some(isSpeed)).toBe(false)
  })
  it('a fast clip is at most 30 minutes and at least 1', () => {
    expect(MAX_FAST_MINUTES).toBe(30)
    expect([5, 10, 30, 60, 0, -4, 1.4, Number.NaN].map(fastMinutes)).toEqual([5, 10, 30, 30, 1, 1, 1, 1])
  })
})

describe('vodUrl', () => {
  it('carries the camera, the start and the clipped length as an encoded query, and nothing else', () => {
    const url = vodUrl({ camera: '0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111', start: '2026-10-22T14:30:00Z', minutes: 60 })
    expect(url).toBe('/api/vod?camera=0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111&start=2026-10-22T14%3A30%3A00Z&minutes=30')
  })
  it('cannot be bent into another address by what is passed in', () => {
    const url = vodUrl({ camera: 'x&minutes=1#', start: 'a b', minutes: 5 })
    const parsed = new URL(url, 'http://localhost')
    expect(parsed.pathname).toBe('/api/vod')
    expect(parsed.searchParams.getAll('minutes')).toEqual(['5'])
    expect(parsed.searchParams.get('camera')).toBe('x&minutes=1#')
    expect(parsed.hash).toBe('')
  })
})

describe('explainVodFailure', () => {
  const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
  it('asks the same address again with probe=1 and gives back the plain message', async () => {
    const f = vi.fn(json(404, { error: 'There is no recording at that time.' }))
    expect(await explainVodFailure('/api/vod?camera=a&start=b&minutes=5', f)).toBe('There is no recording at that time.')
    expect(f.mock.calls[0][0]).toBe('/api/vod?camera=a&start=b&minutes=5&probe=1')
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
  })
  it('is null when the check passes, and when the answer cannot be understood or the server cannot be reached', async () => {
    expect(await explainVodFailure('/api/vod?x=1', json(200, { ok: true }))).toBeNull()
    expect(await explainVodFailure('/api/vod?x=1', json(500, { nope: 1 }))).toBeNull()
    expect(await explainVodFailure('/api/vod?x=1', json(500, { error: 'x'.repeat(400) }))).toBeNull()
    expect(await explainVodFailure('/api/vod?x=1', (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch)).toBeNull()
    expect(await explainVodFailure('/api/vod?x=1', (async () => { throw new TypeError('network') }) as unknown as typeof fetch)).toBeNull()
  })
})
