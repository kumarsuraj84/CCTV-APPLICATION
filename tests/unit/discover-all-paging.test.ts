import { describe, expect, it } from 'vitest'
import { discoverAllCounts } from '@/lib/inventory/discover-all'
import { discoverAllRecorders, MSG_STOPPED } from '@/lib/monitor/discovery'

// T-1 carry-over (P2-5c re-review, B-M11): the NVR list of "Find cameras for all locations" is read page by page, so an organisation with
// more than 1,000 NVRs (the most PostgREST sends at once) is never cut off. Synthetic rows behind a fake query chain that behaves like
// PostgREST: .range(from, to) returns at most that window, and an .in(…) read returns only the ids asked for.

const N = 2500
const ids = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
const row = (id: string, i: number) => ({
  id, org_id: 'org', location_id: `loc-${i}`, http_port: 80, rtsp_port: 554, username: 'viewer', clock_offset_sec: null,
  monitoring_enabled: i % 10 !== 0, // every tenth NVR is switched off
  assets: { name: `NVR ${i}`, ip: '192.0.2.1', enabled: true, archived_at: null }, locations: { code: `L${i}`, is_active: i % 25 !== 1 },
})

function fakeAdmin() {
  const ranges: [number, number][] = []
  const builder = (wanted?: readonly string[]) => {
    const b = {
      select: () => b, eq: () => b, is: () => b, order: () => b,
      in: (_col: string, list: readonly string[]) => builder(list),
      range: (f: number, t: number) => {
        ranges.push([f, t])
        return Promise.resolve({ data: ids.slice(f, t + 1).map((id, k) => row(id, f + k)), error: null })
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({ data: ids.map((id, i) => row(id, i)).filter((r) => (wanted ?? ids).includes(r.id)), error: null }).then(ok, bad),
    }
    return b
  }
  return { client: { from: () => builder(), rpc: async () => ({ error: null }) }, ranges }
}

const rls = {
  rpc: async () => ({
    error: null,
    data: [{ capability: 'admin.inventory', organization_wide: true, location_ids: [], camera_ids: [], asset_ids: [], region_ids: [], cluster_ids: [], recorder_ids: [], covered_location_ids: [], recorder_camera_ids: [] }],
  }),
}

describe('more than 1,000 NVRs are never cut off', () => {
  it('"Find cameras for all locations" reads the NVR list in pages and covers every NVR', async () => {
    const { client, ranges } = fakeAdmin()
    const progress: [number, number][] = []
    const res = await discoverAllRecorders(
      { admin: client as never, rls: rls as never }, { id: 'u1', orgId: 'org', role: 'admin' },
      { shouldStop: () => true, onProgress: (d, t) => progress.push([d, t]) },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.items).toHaveLength(N)
    expect(new Set(res.items.map((i) => i.recorderId)).size).toBe(N)
    expect(res.items.every((i) => !i.ok && i.error === MSG_STOPPED)).toBe(true)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(progress.at(-1)).toEqual([N, N])
  })

  it('the counts on the page read every page too', async () => {
    const { client, ranges } = fakeAdmin()
    const counts = await discoverAllCounts(client as never, 'org')
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(counts.recorders).toBe(N)
    expect(counts.switchedOff).toBe(N / 10)
  })
})
