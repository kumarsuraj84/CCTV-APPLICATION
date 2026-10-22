import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const no = vi.hoisted(() => async () => ({}))
vi.mock('@/lib/actions/admin/locations', () => ({
  saveRegionAction: no, saveClusterAction: no, previewMoveAction: no, moveNodeAction: no, applyProposalsAction: no, saveLocationAction: no, saveNetworkAction: no,
  saveRecorderAction: no, setMonitoringAction: no, testConnectionAction: no, discoverRecorderAction: no, remapCameraAction: no, mergeCamerasAction: no,
  dismissFindingAction: no, linkFindingAction: no, archiveNodeAction: no, restoreNodeAction: no,
}))
vi.mock('@/lib/actions/admin/assets', () => ({ saveAssetAction: no, addDependencyAction: no, removeDependencyAction: no, addEndpointAction: no, retireEndpointAction: no }))
vi.mock('@/lib/actions/groups', () => ({ addRuleAction: no, removeRuleAction: no, addCamerasAction: no, addByKeywordAction: no, removeCameraAction: no }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { ArchiveButton } from '@/components/admin/inventory/ArchiveButton'
import { AssetForm } from '@/components/admin/inventory/AssetForm'
import { ClusterForm, RegionForm } from '@/components/admin/inventory/HierarchyForms'
import { DependencyPicker, EndpointsEditor } from '@/components/admin/inventory/AssetLinks'
import { FindingsList } from '@/components/admin/inventory/FindingsList'
import { LocationForm } from '@/components/admin/inventory/LocationForm'
import { MappingEditor } from '@/components/admin/inventory/MappingEditor'
import { MoveForm } from '@/components/admin/inventory/MoveForm'
import { NetworkForm } from '@/components/admin/inventory/NetworkForm'
import { ProposalTool } from '@/components/admin/inventory/ProposalTool'
import { MonitoringSwitch, RecorderForm, TestConnectionButton } from '@/components/admin/inventory/RecorderForm'
import { GroupRules } from '@/components/groups/GroupRules'
import { AccessBuilder } from '@/components/admin/AccessBuilder'

/** Form controls without an accessible name (the same check as the P2-3 component tests). */
function unnamed(html: string): string[] {
  const out: string[] = []
  const re = /<(input|select|textarea|button)\b([^>]*)>/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [tag, name, attrs] = m
    if (/type="hidden"/.test(attrs)) continue
    if (/aria-label="[^"]+"/.test(attrs)) continue
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1]
    if (id && html.includes(`for="${id}"`)) continue
    const before = html.slice(0, m.index)
    if (name !== 'button' && before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue
    if (name === 'button') {
      const rest = html.slice(m.index + tag.length)
      const text = rest.slice(0, rest.indexOf('</button>')).replace(/<[^>]+>/g, '').trim()
      if (text) continue
    }
    out.push(tag)
  }
  return out
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const L = 'aaaaaaaa-0000-4000-8000-000000000001'
const R = 'aaaaaaaa-0000-4000-8000-000000000002'
const C = 'aaaaaaaa-0000-4000-8000-000000000003'
const N = 'aaaaaaaa-0000-4000-8000-000000000004'
const K = 'aaaaaaaa-0000-4000-8000-000000000005'

describe('P2-5c-1 screens: every field has a visible label and the wording is plain (Location, never Store)', () => {
  const screens: [string, string][] = [
    ['region form', renderToStaticMarkup(<RegionForm />)],
    ['cluster form', renderToStaticMarkup(<ClusterForm regions={[{ id: R, code: 'EAST', name: 'East' }]} />)],
    ['location form (new)', renderToStaticMarkup(<LocationForm clusters={[{ id: C, code: 'PAT', name: 'Patna', regionName: 'East' }]} />)],
    ['location form (edit)', renderToStaticMarkup(<LocationForm location={{ id: L, code: 'JCL', kind: 'store', name: 'JCL - Jhansi', city: 'Jhansi', address: null, zone: 'UP', state: 'UP', is_active: true }} clusters={[]} />)],
    ['network form', renderToStaticMarkup(<NetworkForm locationId={L} definition={null} />)],
    ['recorder form (new)', renderToStaticMarkup(<RecorderForm locationId={L} />)],
    ['recorder form (edit)', renderToStaticMarkup(<RecorderForm locationId={L} recorder={{ id: N, name: 'Ground', host: '10.0.0.5', http_port: 80, rtsp_port: 554, username: 'viewer', expected_channels: 16, clock_offset_sec: null, password_saved: true }} />)],
    ['monitoring switch', renderToStaticMarkup(<MonitoringSwitch recorderId={N} enabled reason={null} />)],
    ['test connection', renderToStaticMarkup(<TestConnectionButton recorderId={N} />)],
    ['move form', renderToStaticMarkup(<MoveForm kind="location" id={L} current={null} options={[{ id: C, label: 'PAT · Patna' }]} />)],
    ['archive button', renderToStaticMarkup(<ArchiveButton kind="location" id={L} archived={false} name="JCL - Jhansi" />)],
    ['mapping editor', renderToStaticMarkup(<MappingEditor cameras={[{ id: K, name: 'Entrance', channel: 1, recorderId: N, history: [{ recorderName: 'Ground', channel: 1, validFrom: '2026-10-01T05:00:00Z', validTo: null }] }]} recorders={[{ id: N, name: 'Ground' }]} mergeCandidates={[{ id: L, label: 'Entrance (First floor, channel 2)' }]} />)],
    ['findings', renderToStaticMarkup(<FindingsList findings={[
      { id: K, kind: 'possible_move', recorderId: N, recorderName: 'Ground', locationId: L, locationCode: 'JCL', channel: 5, cameraId: K, cameraName: 'Door', otherCameraId: null, reportedName: 'Door', because: 'same_name', foundAt: '2026-10-22T05:00:00Z' },
      { id: L, kind: 'missing', recorderId: N, recorderName: 'Ground', locationId: L, locationCode: 'JCL', channel: 9, cameraId: K, cameraName: 'Old till', otherCameraId: null, reportedName: null, because: null, foundAt: '2026-10-22T05:00:00Z' },
    ]} mergeCandidates={{ [K]: [{ id: R, label: 'Old till (First floor, channel 3)' }] }} />)],
    ['asset form', renderToStaticMarkup(<AssetForm locations={[{ id: L, code: 'JCL', name: 'JCL - Jhansi' }]} spaces={[{ id: R, name: 'Company network' }]} />)],
    ['dependencies', renderToStaticMarkup(<DependencyPicker assetId={K} dependencies={[{ id: R, parentId: N, parentName: 'Core switch', kind: 'network' }]} candidates={[{ id: N, label: 'Core switch (JCL)' }]} />)],
    ['endpoints', renderToStaticMarkup(<EndpointsEditor assetId={K} endpoints={[{ id: R, spaceName: 'Company network', host: '10.0.0.9', port: null, purpose: 'management', retiredAt: null }]} spaces={[{ id: R, name: 'Company network' }]} />)],
    ['proposals', renderToStaticMarkup(<ProposalTool rows={[{ locationId: L, code: 'JCL', zone: 'UP', state: 'UP', proposedClusterCode: 'UP', proposedRegionCode: 'UP', existingClusterId: null, existingRegionId: null }]} />)],
    ['group rules', renderToStaticMarkup(<GroupRules groupId={K} rules={[{ id: R, kind: 'cluster', label: 'Cluster PAT · Patna', nameContains: null }]} places={{ region: [{ id: R, label: 'East' }], cluster: [{ id: C, label: 'PAT · Patna' }], location: [{ id: L, label: 'JCL · Jhansi' }], recorder: [{ id: N, label: 'JCL · Ground' }] }} />)],
  ]
  // Ruling T-1: the product word is "location". "Store" is still a location KIND ("Store", "Head office", …), so only the kind label
  // may say it; no sentence, heading or field name does.
  const STORE_WORDING = /\bstores\b|\b(this|a|the|another|each|every|of the|your) store\b|\bstore (code|name|page)\b/i
  for (const [name, html] of screens) {
    it(name, () => {
      expect(unnamed(html), name).toEqual([])
      expect(text(html), name).not.toMatch(STORE_WORDING)
    })
  }

  it('the NVR password is never put into the page; an edit says whether one is saved', () => {
    const html = renderToStaticMarkup(<RecorderForm locationId={L} recorder={{ id: N, name: 'Ground', host: '10.0.0.5', http_port: 80, rtsp_port: 554, username: 'viewer', expected_channels: 16, clock_offset_sec: 30, password_saved: true }} />)
    expect(html).toMatch(/type="password"[^>]*autoComplete="new-password"|autoComplete="new-password"[^>]*type="password"/i)
    expect(text(html)).toContain('A password is saved. Leave empty to keep it.')
    expect(html).not.toMatch(/name="password"[^>]*value="[^"]+"/)
  })

  it('moving a location says what happens to access and to open video', () => {
    const t = text(renderToStaticMarkup(<MoveForm kind="location" id={L} current={C} options={[{ id: C, label: 'PAT · Patna' }]} />))
    expect(t).toContain('Check the effect on access')
    expect(t).toContain('No cluster')
  })

  it('the access editor offers "A region", "A cluster" and "NVR(s)" next to locations and cameras', () => {
    const html = renderToStaticMarkup(
      <AccessBuilder
        catalogue={[{ key: 'cctv.live', area: 'cctv', risk: 'low', description: 'Watch live video', scope_kinds: ['organization', 'region', 'cluster', 'location', 'recorder', 'camera'] }]}
        grantable={['cctv.live']} targetRole="user" locations={[{ id: L, code: 'JCL', name: 'Jhansi' }]} cameras={[]} assets={[]}
        regions={[{ id: R, code: 'EAST', name: 'East' }]} clusters={[{ id: C, code: 'PAT', name: 'Patna', region_id: R }]} recorders={[{ id: N, location_id: L, name: 'Ground' }]}
        onAdd={() => {}}
      />,
    )
    const t = text(html)
    for (const words of ['A region', 'A cluster', 'NVR(s)', 'All cameras in these locations', 'Selected cameras', 'Whole organisation']) expect(t).toContain(words)
    expect(unnamed(html)).toEqual([])
  })
})
