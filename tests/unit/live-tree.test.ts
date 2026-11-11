import { describe, expect, it } from 'vitest'
import { buildLiveTree, filterTree, treeCounts } from '@/lib/live/tree'
import { cameraState, CAMERA_STATE_LABEL, countsText, indexRollups, nodeState, recorderText, sumCameras, sumRecorders, type CameraCounts, type RollupRow } from '@/lib/live/rollups'
import { MSG_CAMERA_NOT_RESPONDING, MSG_RECORDER_NOT_REACHABLE, NVR_DOWN_CAMERA_ERROR } from '@/lib/queries/status'

// P4-L1 brief item 1: the Live landing shows the viewer's own Region → Cluster → Location tree (only nodes they can see; a place that
// is not assigned to a cluster or region is simply listed on its own, no "Unassigned" bucket), with roll-up counts and honest states.

const zero: CameraCounts = { total: 0, live: 0, stale: 0, offline: 0, recorderUnreachable: 0, notChecked: 0, off: 0 }
const row = (level: RollupRow['level'], id: string, c: Partial<CameraCounts>, r: RollupRow['recorders'] = null): RollupRow => ({ level, id, cameras: { ...zero, ...c }, recorders: r })

describe('roll-up arithmetic and words', () => {
  it('reads the database rows into counts; NVR figures stay null when the viewer has no IT view', () => {
    const m = indexRollups([
      { level: 'location', node_id: 'L1', cameras_total: 4, cameras_live: 1, cameras_stale: 0, cameras_offline: 1, cameras_recorder_unreachable: 2, cameras_not_checked: 0, cameras_off: 0,
        recorders_total: null, recorders_up: null, recorders_down: null, recorders_not_checked: null, recorders_stale: null, recorders_off: null },
    ])
    expect(m.get('location:L1')).toEqual(row('location', 'L1', { total: 4, live: 1, offline: 1, recorderUnreachable: 2 }))
  })

  it('sums locations into totals (each camera belongs to exactly one location); NVRs only where known', () => {
    const a = row('location', 'a', { total: 3, live: 2, offline: 1 }, { total: 1, up: 1, down: 0, notChecked: 0, stale: 0, off: 0 })
    const b = row('location', 'b', { total: 2, recorderUnreachable: 2 })
    expect(sumCameras([a, b])).toEqual({ ...zero, total: 5, live: 2, offline: 1, recorderUnreachable: 2 })
    expect(sumRecorders([a, b])).toEqual({ total: 1, up: 1, down: 0, notChecked: 0, stale: 0, off: 0 })
    expect(sumRecorders([b])).toBeNull()
  })

  it('a node\'s dot: offline first, then recorder not reachable, then not checked; live only when everything checked is live', () => {
    expect(nodeState({ ...zero, total: 3, live: 2, offline: 1 })).toBe('offline')
    expect(nodeState({ ...zero, total: 3, live: 1, recorderUnreachable: 2 })).toBe('unreachable')
    expect(nodeState({ ...zero, total: 3, live: 2, notChecked: 1 })).toBe('not_checked')
    expect(nodeState({ ...zero, total: 3, live: 2, stale: 1 })).toBe('not_checked')
    expect(nodeState({ ...zero, total: 3, live: 3 })).toBe('live')
    expect(nodeState({ ...zero, total: 3, live: 1, off: 2 })).toBe('live')
    expect(nodeState({ ...zero, total: 2, off: 2 })).toBe('off')
    expect(nodeState(zero)).toBe('empty')
  })

  it('says the counts in plain words, never colour alone, without IT words for cameras', () => {
    expect(countsText({ ...zero, total: 4, live: 1, offline: 1, recorderUnreachable: 2 })).toBe('4 cameras: 1 live, 1 offline, 2 recorder not reachable')
    expect(countsText({ ...zero, total: 1, live: 1 })).toBe('1 camera: 1 live')
    // Final fix Y (final review C M-15): "not checked yet" (never) and "not checked lately" (stale) are two states on every screen.
    expect(countsText({ ...zero, total: 5, live: 2, stale: 1, notChecked: 1, off: 1 })).toBe('5 cameras: 2 live, 1 not checked lately, 1 not checked yet, 1 switched off')
    expect(countsText(zero)).toBe('No cameras')
    expect(recorderText(null)).toBeNull()
    expect(recorderText({ total: 2, up: 1, down: 1, notChecked: 0, stale: 0, off: 0 })).toBe('2 NVRs: 1 down')
    expect(recorderText({ total: 1, up: 1, down: 0, notChecked: 0, stale: 0, off: 0 })).toBe('1 NVR: all up')
    expect(recorderText({ total: 3, up: 1, down: 0, notChecked: 1, stale: 0, off: 1 })).toBe('3 NVRs: 1 not checked yet, 1 switched off')
  })

  it('one camera\'s honest state: recorder not reachable is not "offline"', () => {
    expect(cameraState({ status: 'up', stale: false, reason: null })).toBe('live')
    expect(cameraState({ status: 'up', stale: true, reason: null })).toBe('stale')
    expect(cameraState({ status: 'down', stale: false, reason: MSG_CAMERA_NOT_RESPONDING })).toBe('offline')
    expect(cameraState({ status: 'down', stale: false, reason: MSG_RECORDER_NOT_REACHABLE })).toBe('unreachable')
    expect(cameraState({ status: 'down', stale: false, reason: NVR_DOWN_CAMERA_ERROR })).toBe('unreachable') // the IT view gets the checker's words
    expect(cameraState({ status: 'unknown', stale: false, reason: null })).toBe('not_checked')
    expect(cameraState({ status: null, stale: false, reason: null })).toBe('not_checked')
    expect(cameraState({ status: 'off', stale: false, reason: null })).toBe('off')
    expect(CAMERA_STATE_LABEL).toEqual({
      live: 'Live', offline: 'Offline', unreachable: 'Recorder not reachable', not_checked: 'Not checked yet', stale: 'Not checked lately', off: 'Switched off',
    })
  })
})

describe('buildLiveTree', () => {
  const regions = [{ id: 'R2', code: 'WB', name: 'West Bengal' }, { id: 'R1', code: 'BR', name: 'Bihar' }]
  const clusters = [
    { id: 'C1', code: 'PAT', name: 'Patna', region_id: 'R1' },
    { id: 'C2', code: 'GAY', name: 'Gaya', region_id: 'R1' },
    { id: 'C3', code: 'KOL', name: 'Kolkata', region_id: 'R2' },
    { id: 'C9', code: 'ORP', name: 'Orphan', region_id: 'R-hidden' },
  ]
  const locations = [
    { id: 'L2', code: 'PTB', name: 'Patna Boring Road', city: 'Patna', cluster_id: 'C1' },
    { id: 'L1', code: 'PTA', name: 'Patna Ashok', city: 'Patna', cluster_id: 'C1' },
    { id: 'L3', code: 'GYA', name: 'Gaya Main', city: 'Gaya', cluster_id: 'C2' },
    { id: 'L4', code: 'KOL', name: 'Kolkata Park', city: 'Kolkata', cluster_id: 'C3' },
    { id: 'L5', code: 'HO', name: 'Head office', city: 'Delhi', cluster_id: null },
    { id: 'L6', code: 'XYZ', name: 'Hidden cluster', city: null, cluster_id: 'C-hidden' },
    { id: 'L7', code: 'ORP1', name: 'Orphan one', city: null, cluster_id: 'C9' },
    { id: 'L8', code: 'NOC', name: 'No cameras for me', city: null, cluster_id: 'C2' },
  ]
  const rollups = [
    row('location', 'L1', { total: 4, live: 4 }), row('location', 'L2', { total: 2, offline: 1, live: 1 }), row('location', 'L3', { total: 1, live: 1 }),
    row('location', 'L4', { total: 3, recorderUnreachable: 3 }), row('location', 'L5', { total: 1, live: 1 }), row('location', 'L6', { total: 2, live: 2 }),
    row('location', 'L7', { total: 1, notChecked: 1 }),
    row('cluster', 'C1', { total: 6, live: 5, offline: 1 }), row('cluster', 'C2', { total: 1, live: 1 }), row('cluster', 'C3', { total: 3, recorderUnreachable: 3 }),
    row('cluster', 'C9', { total: 1, notChecked: 1 }),
    row('region', 'R1', { total: 7, live: 6, offline: 1 }), row('region', 'R2', { total: 3, recorderUnreachable: 3 }),
  ]
  const tree = buildLiveTree({ regions, clusters, locations, rollups })

  it('nests region → cluster → location by code, with each node\'s own roll-up', () => {
    expect(tree.regions.map((r) => r.code)).toEqual(['BR', 'WB'])
    expect(tree.regions[0].clusters.map((c) => c.code)).toEqual(['GAY', 'PAT'])
    expect(tree.regions[0].clusters[1].locations.map((l) => l.code)).toEqual(['PTA', 'PTB'])
    expect(tree.regions[0].counts).toEqual({ ...zero, total: 7, live: 6, offline: 1 })
    expect(tree.regions[0].clusters[1].counts.offline).toBe(1)
  })

  it('lists places outside a visible cluster or region on their own: no "Unassigned" bucket is made', () => {
    expect(tree.locations.map((l) => l.code)).toEqual(['HO', 'XYZ'])
    expect(tree.clusters.map((c) => c.code)).toEqual(['ORP'])
    expect(tree.clusters[0].locations.map((l) => l.code)).toEqual(['ORP1'])
    expect(JSON.stringify(tree)).not.toMatch(/unassigned/i)
  })

  it('shows only locations with something to show; a location without a roll-up row is left out', () => {
    const all = [...tree.locations, ...tree.clusters.flatMap((c) => c.locations), ...tree.regions.flatMap((r) => r.clusters.flatMap((c) => c.locations))]
    expect(all.map((l) => l.id)).not.toContain('L8')
    expect(all).toHaveLength(7)
  })

  it('a cluster or region without any shown location does not appear', () => {
    const t = buildLiveTree({ regions, clusters, locations: locations.filter((l) => l.id === 'L5'), rollups: rollups.filter((r) => r.id === 'L5') })
    expect(t.regions).toEqual([])
    expect(t.clusters).toEqual([])
    expect(t.locations.map((l) => l.code)).toEqual(['HO'])
  })

  it('the totals of the whole tree are the sum of its locations', () => {
    expect(treeCounts(tree)).toEqual({ ...zero, total: 14, live: 9, offline: 1, recorderUnreachable: 3, notChecked: 1 })
  })

  it('search by location code, name or city keeps the path to each match; by cluster or region keeps all below it', () => {
    const byCode = filterTree(tree, 'ptb')
    expect(byCode.regions.map((r) => r.code)).toEqual(['BR'])
    expect(byCode.regions[0].clusters.map((c) => c.code)).toEqual(['PAT'])
    expect(byCode.regions[0].clusters[0].locations.map((l) => l.code)).toEqual(['PTB'])
    expect(byCode.locations).toEqual([])
    expect(filterTree(tree, 'Delhi').locations.map((l) => l.code)).toEqual(['HO'])
    const byCluster = filterTree(tree, 'gaya')
    expect(byCluster.regions[0].clusters.map((c) => c.code)).toEqual(['GAY'])
    expect(byCluster.regions[0].clusters[0].locations.map((l) => l.code)).toEqual(['GYA'])
    const byRegion = filterTree(tree, 'west bengal')
    expect(byRegion.regions.map((r) => r.code)).toEqual(['WB'])
    expect(byRegion.regions[0].clusters[0].locations.map((l) => l.code)).toEqual(['KOL'])
    expect(filterTree(tree, '  ')).toEqual(tree)
    const none = filterTree(tree, 'nothing like this')
    expect([none.regions, none.clusters, none.locations]).toEqual([[], [], []])
  })
})
