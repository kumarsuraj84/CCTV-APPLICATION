import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }))
vi.mock('@/lib/actions/streams', () => ({ openStreamsAction: vi.fn(), refreshStreamTokensAction: vi.fn(), renewStreamTokensAction: vi.fn() }))
vi.mock('@/lib/actions/groups', () => ({ addCamerasAction: vi.fn(), removeCameraAction: vi.fn(), createGroupAction: vi.fn() }))

import { LiveTreeView } from '@/components/live/LiveTreeView'
import { LiveWall, type WallCamera } from '@/components/live/LiveWall'
import { RollupCards } from '@/components/live/RollupCards'
import type { CameraCounts } from '@/lib/live/rollups'
import type { LiveTree } from '@/lib/live/tree'
import type { LandingBranch } from '@/lib/queries/live-landing'

// P4-L1: the Live landing (tree with status words and wall links; NVR rows only for the IT view), the wall (5×5, tour, open in a new
// window, group buttons only for people who may change groups) and the Home roll-up cards, rendered as the server sends them.

const zero: CameraCounts = { total: 0, live: 0, stale: 0, offline: 0, recorderUnreachable: 0, notChecked: 0, off: 0 }
const counts = (c: Partial<CameraCounts>): CameraCounts => ({ ...zero, ...c })
const tree: LiveTree = {
  regions: [{
    id: 'R1', code: 'BR', name: 'Bihar', counts: counts({ total: 4, live: 1, offline: 1, recorderUnreachable: 2 }), recorders: null,
    clusters: [{
      id: 'C1', code: 'PAT', name: 'Patna', counts: counts({ total: 4, live: 1, offline: 1, recorderUnreachable: 2 }), recorders: null,
      locations: [{ id: 'L1', code: 'PTA', name: 'Patna Ashok', city: 'Patna', counts: counts({ total: 4, live: 1, offline: 1, recorderUnreachable: 2 }), recorders: null }],
    }],
  }],
  clusters: [],
  locations: [{ id: 'L5', code: 'HO', name: 'Head office', city: 'Delhi', counts: counts({ total: 1, live: 1 }), recorders: null }],
}
const branch = (withNvr: boolean): LandingBranch => ({
  location: { id: 'L1', code: 'PTA', name: 'Patna Ashok' },
  cameras: [
    { id: 'cam-1', name: 'Front door', channel: 1, locationId: 'L1', locationCode: 'PTA', state: 'live', canPlayback: true },
    { id: 'cam-2', name: 'Back door', channel: 2, locationId: 'L1', locationCode: 'PTA', state: 'unreachable', canPlayback: false },
  ],
  recorders: withNvr ? [{ id: 'nvr-1', name: 'NVR alpha', status: 'down', stale: false, cameraIds: ['cam-1', 'cam-2'] }] : null,
})

describe('the Live landing tree', () => {
  it('shows each node with its counts in words, an "Open wall" link per region, cluster and location, and the places outside a cluster on their own', () => {
    const html = renderToStaticMarkup(<LiveTreeView tree={tree} branch={null} openId={null} query="" />)
    expect(html).toContain('4 cameras: 1 live, 1 offline, 2 recorder not reachable')
    for (const href of ['/live?region=R1', '/live?cluster=C1', '/live?location=L1', '/live?location=L5']) expect(html).toContain(`href="${href}"`)
    expect(html).toContain('Head office')
    expect(html).not.toMatch(/unassigned/i)
    expect(html).not.toContain('NVR')
  })

  it('an opened location lists its cameras with honest states and "open in a new window"; NVR rows only for the IT view', () => {
    const cctv = renderToStaticMarkup(<LiveTreeView tree={tree} branch={branch(false)} openId="L1" query="" />)
    expect(cctv).toContain('Recorder not reachable')
    expect(cctv).toContain('href="/live?camera=cam-1"')
    expect(cctv).toMatch(/<a[^>]*href="\/live\?camera=cam-2"[^>]*target="_blank"/)
    expect(cctv).not.toContain('NVR alpha')
    expect(cctv).not.toContain('/live?nvr=')
    const it = renderToStaticMarkup(<LiveTreeView tree={tree} branch={branch(true)} openId="L1" query="" />)
    expect(it).toContain('NVR alpha')
    expect(it).toContain('href="/live?nvr=nvr-1"')
  })

  it('says so when a search finds nothing, and when there is nothing at all', () => {
    expect(renderToStaticMarkup(<LiveTreeView tree={{ regions: [], clusters: [], locations: [] }} branch={null} openId={null} query="zzz" />)).toContain('No location matches')
    expect(renderToStaticMarkup(<LiveTreeView tree={{ regions: [], clusters: [], locations: [] }} branch={null} openId={null} query="" />)).toContain('No locations with cameras')
  })
})

const cams: WallCamera[] = Array.from({ length: 30 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Camera ${i + 1}`, storeCode: 'PTA', locationId: 'L1', channel: i + 1,
  status: i === 2 ? 'down' : 'up', stale: false, state: i === 2 ? 'unreachable' : 'live', canPlayback: i % 2 === 0,
}))

describe('the wall', () => {
  it('offers 1 to 5×5, the tour with its interval, and every tile can be opened in a new window', () => {
    const html = renderToStaticMarkup(<LiveWall cameras={cams} maxStreams={25} multiLocation={false} />)
    expect(html).toContain('5×5')
    expect(html).toContain('Start tour')
    expect(html).toMatch(/<select[^>]*aria-label="Tour interval"/)
    for (const s of [5, 10, 15, 30, 60]) expect(html).toContain(`>${s} s<`)
    expect(html).toContain(`href="/live?camera=${cams[0].id}"`)
    expect(html).toMatch(/target="_blank"/)
    expect(html).toContain('Recorder not reachable')
    expect(html).not.toContain('Add to group')
  })

  it('group buttons only for people who may change groups; "remove" only on the group\'s own wall for its own members', () => {
    const groups = { editable: [{ id: 'g1', name: 'Doors' }] }
    const add = renderToStaticMarkup(<LiveWall cameras={cams.slice(0, 2)} maxStreams={25} multiLocation={false} groupTools={groups} />)
    expect(add).toContain('Add to group')
    expect(add).not.toContain('Remove from this group')
    const own = renderToStaticMarkup(<LiveWall cameras={cams.slice(0, 2)} maxStreams={25} multiLocation={false} groupTools={{ ...groups, current: { id: 'g1', removable: [cams[0].id] } }} />)
    expect(own.match(/Remove from this group/g)).toHaveLength(1)
  })
})

describe('Home roll-up cards', () => {
  const rows = [{ id: 'R1', code: 'BR', name: 'Bihar', counts: counts({ total: 10, live: 7, offline: 1, recorderUnreachable: 2 }), recorders: { total: 3, up: 2, down: 1, notChecked: 0, stale: 0, off: 0 } }]
  it('per region: counts in words and a link to its wall; NVR words only with the IT view', () => {
    const it = renderToStaticMarkup(<RollupCards title="By region" level="region" rows={rows} liveLinks />)
    expect(it).toContain('10 cameras: 7 live, 1 offline, 2 recorder not reachable')
    expect(it).toContain('3 NVRs: 1 down')
    expect(it).toContain('href="/live?region=R1"')
    const cctv = renderToStaticMarkup(<RollupCards title="By region" level="region" rows={rows.map((r) => ({ ...r, recorders: null }))} liveLinks={false} />)
    expect(cctv).not.toContain('NVR')
    expect(cctv).not.toContain('/live?region=')
  })
})
