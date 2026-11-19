import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Release 1 final clean-up: the screen items left by final fix Y (final-review-C M-20, M-21).
//   M-20  a location's "items need a look" link opens the reconciliation list filtered to that location; the list can be filtered by
//         location and says so; a cluster's location count is a link to the locations of that cluster (and "no cluster" too).
//   M-21  the audit log is readable at 375 px: on a phone every entry is a stacked card; the wide table is for wider screens.

const L = 'aaaaaaaa-0000-4000-8000-000000000001'
const C = 'aaaaaaaa-0000-4000-8000-000000000003'
const R = 'aaaaaaaa-0000-4000-8000-000000000002'
const K = 'aaaaaaaa-0000-4000-8000-000000000005'
const N = 'aaaaaaaa-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({ findingsCalls: [] as unknown[], findings: [] as unknown[] }))
const no = vi.hoisted(() => async () => ({}))
vi.mock('@/lib/actions/admin/locations', () => ({
  saveRegionAction: no, saveClusterAction: no, previewMoveAction: no, moveNodeAction: no, applyProposalsAction: no, saveLocationAction: no, saveNetworkAction: no,
  saveRecorderAction: no, setMonitoringAction: no, testConnectionAction: no, discoverRecorderAction: no, remapCameraAction: no, mergeCamerasAction: no,
  dismissFindingAction: no, linkFindingAction: no, archiveNodeAction: no, restoreNodeAction: no, previewMergeAction: no, searchCamerasAction: no, previewProposalsAction: no,
}))
vi.mock('@/lib/actions/groups', () => ({ addCamerasAction: no, previewByKeywordAction: no, removeCamerasAction: no }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: () => { throw new Error('not found') } }))
vi.mock('@/lib/auth/profile', () => ({ requireAdministration: async () => ({ id: 'me', org_id: 'org-1' }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/inventory/findings', () => ({
  listFindings: async (_a: unknown, _o: unknown, opts?: unknown) => {
    h.findingsCalls.push(opts ?? {})
    return h.findings
  },
}))
vi.mock('@/lib/queries/admin-inventory', () => ({
  camerasByLocation: async () => new Map(),
  regionsAndClusters: async () => ({
    regions: [{ id: R, code: 'EAST', name: 'East', archived_at: null, clusters: 1 }],
    clusters: [{ id: C, code: 'PAT', name: 'Patna', region_id: R, archived_at: null, locations: 3 }],
    unclustered: 2,
  }),
  locationDetail: async () => ({
    location: { id: L, code: 'JCL', name: 'JCL - Jhansi', kind: 'store', city: 'Jhansi', address: null, zone: null, state: null, is_active: true, archived_at: null, cluster_id: null },
    recorders: [], network: null, unmappedCameras: 0,
  }),
}))

import ReconciliationPage from '@/app/(app)/admin/reconciliation/page'
import RegionsPage from '@/app/(app)/admin/regions/page'
import LocationPage from '@/app/(app)/admin/locations/[id]/page'
import { AuditEntries } from '@/components/admin/AuditEntries'
import { AddByName, PreviewPanel, UndoNotice } from '@/components/groups/AddByName'

const finding = (locationId: string, code: string) => ({
  id: K, kind: 'missing', recorderId: N, recorderName: 'Ground', locationId, locationCode: code, channel: 9, cameraId: K, cameraName: 'Old till',
  otherCameraId: null, reportedName: null, because: null, foundAt: '2026-10-22T05:00:00Z',
})
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

beforeEach(() => {
  h.findingsCalls = []
  h.findings = []
})

describe('final clean-up (C M-20): reconciliation by location, cluster counts as links', () => {
  it('a location\'s page links to the reconciliation list of that location only', async () => {
    h.findings = [finding(L, 'JCL')]
    const html = renderToStaticMarkup(await LocationPage({ params: Promise.resolve({ id: L }) }))
    expect(html).toContain(`href="/admin/reconciliation?location=${L}"`)
    expect(text(html)).toContain('1 item needs a look')
  })

  it('the reconciliation list filtered by a location asks only for that location and offers the whole list', async () => {
    h.findings = [finding(L, 'JCL')]
    const html = renderToStaticMarkup(await ReconciliationPage({ searchParams: Promise.resolve({ location: L }) }))
    expect(h.findingsCalls).toEqual([{ locationId: L }])
    expect(text(html)).toContain('Only location JCL')
    expect(html).toContain('href="/admin/reconciliation"')
  })

  it('without a filter (or with a malformed one) the whole list is asked for', async () => {
    renderToStaticMarkup(await ReconciliationPage({ searchParams: Promise.resolve({}) }))
    renderToStaticMarkup(await ReconciliationPage({ searchParams: Promise.resolve({ location: 'x\' or 1=1' }) }))
    expect(h.findingsCalls).toEqual([{}, {}])
  })

  it('a cluster\'s location count links to the locations of that cluster; "no cluster" links to those without one', async () => {
    const html = renderToStaticMarkup(await RegionsPage())
    expect(html).toMatch(new RegExp(`<a[^>]*href="/admin/locations\\?cluster=${C}"[^>]*>3 locations</a>`))
    expect(html).toMatch(/<a[^>]*href="\/admin\/locations\?cluster=none"[^>]*>2 locations<\/a>/)
  })
})

describe('final clean-up (C M-20): "Add by name" shows what it would add first, and the addition can be undone', () => {
  it('the form only looks (it never adds on its own)', () => {
    const html = renderToStaticMarkup(<AddByName groupId={K} />)
    expect(text(html)).toContain('Show matching cameras')
    expect(text(html)).not.toContain('Add matching cameras')
    expect(text(html)).toContain('You see the list before anything is added')
  })

  it('the preview names the first ten cameras, counts the rest and adds exactly those; nothing found offers only Close', () => {
    const cameras = Array.from({ length: 13 }, (_, i) => ({ id: `id-${i}`, name: `Door ${i + 1}` }))
    const html = renderToStaticMarkup(<PreviewPanel preview={{ word: 'door', cameras, truncated: false }} pending={false} onAdd={() => {}} onCancel={() => {}} />)
    expect(text(html)).toContain('13 cameras with “door” in the name would be added')
    expect(text(html)).toContain('Door 10')
    expect(text(html)).not.toContain('Door 11')
    expect(text(html)).toContain('and 3 more cameras')
    expect(text(html)).toContain('Add these 13 cameras')
    expect(text(html)).toContain('Cancel')
    const none = renderToStaticMarkup(<PreviewPanel preview={{ word: 'x', cameras: [], truncated: false }} pending={false} onAdd={() => {}} onCancel={() => {}} />)
    expect(text(none)).not.toContain('Add ')
    expect(text(none)).toContain('Close')
  })

  it('after the addition: how many, and an Undo button', () => {
    const html = renderToStaticMarkup(<UndoNotice count={4} pending={false} onUndo={() => {}} />)
    expect(text(html)).toContain('Added 4 cameras to the group.')
    expect(html).toMatch(/<button[^>]*>Undo<\/button>/)
  })
})

describe('final clean-up (C M-21): the audit log at phone width', () => {
  const rows = [{ id: '1', at: '2026-11-19T05:00:00Z', who: 'Asha (asha@example.test)', what: 'Archived', action: 'inventory_archived', target: 'Camera Door', detail: 'reason: moved' }]

  it('on a phone each entry is a stacked card with labels; the table shows only from the small breakpoint up', () => {
    const html = renderToStaticMarkup(<AuditEntries rows={rows} />)
    const list = /<ul[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(list).toContain('sm:hidden')
    expect(html).toMatch(/<div[^>]*class="[^"]*hidden[^"]*sm:block/)
    for (const label of ['When', 'Who', 'What', 'About', 'Details']) expect(text(html)).toContain(label)
    expect(html.match(/Asha/g)?.length).toBe(2) // once in the card, once in the table
  })
})
