import { describe, expect, it } from 'vitest'
import { THUMBNAIL_CAPABILITY, thumbnailAllowed } from '@/lib/streams/thumbnail'

// P2-2 brief item 2: thumbnails do not exist yet; when they do, a snapshot of a camera is a live picture, so it goes through this one
// choke point: cctv.live for that camera, asked as the person (has_capability_for).
describe('thumbnail choke point', () => {
  it('asks has_capability_for(cctv.live, camera, id) and allows only on true', async () => {
    const calls: unknown[] = []
    const rls = (answer: unknown) => ({ rpc: async (fn: string, a: unknown) => (calls.push([fn, a]), { data: answer, error: null }) }) as never
    const id = '00000000-0000-4000-8000-000000000001'
    expect(THUMBNAIL_CAPABILITY).toBe('cctv.live')
    expect(await thumbnailAllowed(rls(true), id)).toBe(true)
    expect(await thumbnailAllowed(rls(false), id)).toBe(false)
    expect(calls[0]).toEqual(['has_capability_for', { p_cap: 'cctv.live', p_kind: 'camera', p_id: id }])
    const broken = { rpc: async () => ({ data: null, error: { code: 'XX000' } }) } as never
    expect(await thumbnailAllowed(broken, id)).toBe(false)
  })
})
