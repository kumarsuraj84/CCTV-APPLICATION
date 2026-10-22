import { describe, expect, it } from 'vitest'
import { coversCamera, coversLocation, coversSomeWholeLocation, type Capabilities, type ScopeSummary } from '@/lib/auth/capabilities'

// P2-5a (ruling C-1; C-1 addendum: "UI summary helpers lib/auth/capabilities.ts coversCamera/coversLocation"): the display helpers
// never recompute the hierarchy. They use what my_access_summary computed in the database: the locations covered whole (location,
// cluster and region grants expanded) and the cameras on granted recorders. Display only — every operation checks again in SQL.

const scope = (o: Partial<ScopeSummary>): ScopeSummary => ({ organization: false, locations: [], cameras: [], assets: [], ...o })
const caps = (grants: Capabilities['grants']): Capabilities => ({ failed: false, grants })

describe('display helpers with regions, clusters and recorders', () => {
  it('a cluster grant covers the locations the database expanded it to, and their cameras', () => {
    const c = caps({ 'cctv.live': scope({ clusters: ['C1'], coveredLocations: ['L1', 'L2'] }) })
    expect(coversLocation(c, 'cctv.live', 'L1')).toBe(true)
    expect(coversLocation(c, 'cctv.live', 'L3')).toBe(false)
    expect(coversCamera(c, 'cctv.live', { id: 'K1', store_id: 'L2' })).toBe(true)
    expect(coversCamera(c, 'cctv.live', { id: 'K9', store_id: 'L3' })).toBe(false)
    expect(coversSomeWholeLocation(c, 'cctv.live')).toBe(true)
  })

  it('a recorder grant covers its cameras but never a whole location', () => {
    const c = caps({ 'cctv.live': scope({ recorders: ['N1'], recorderCameras: ['K1', 'K2'] }) })
    expect(coversCamera(c, 'cctv.live', { id: 'K1', store_id: 'L1' })).toBe(true)
    expect(coversCamera(c, 'cctv.live', { id: 'K3', store_id: 'L1' })).toBe(false)
    expect(coversLocation(c, 'cctv.live', 'L1')).toBe(false)
    expect(coversSomeWholeLocation(c, 'cctv.live')).toBe(false)
  })

  it('the union never narrows; the organisation covers everything; a summary without the new fields keeps the old meaning', () => {
    const c = caps({ 'cctv.live': scope({ coveredLocations: ['L1'], cameras: ['K9'], recorderCameras: ['K7'] }), 'cctv.playback': scope({ organization: true }) })
    expect(['K1', 'K9', 'K7'].map((id) => coversCamera(c, 'cctv.live', { id, store_id: id === 'K1' ? 'L1' : 'L5' }))).toEqual([true, true, true])
    expect(coversLocation(c, 'cctv.playback', 'ANY')).toBe(true)
    const old = caps({ 'cctv.live': scope({ locations: ['L1'] }) })
    expect(coversLocation(old, 'cctv.live', 'L1')).toBe(true)
    expect(coversCamera(old, 'cctv.live', { id: 'K1', store_id: 'L1' })).toBe(true)
  })
})
