import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/actions/admin/users', () => ({ saveAccessAction: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AccessEditor } from '@/components/admin/AccessEditor'
import type { OtherGrant } from '@/lib/admin/users'

// Review fix I-4 (P2-1): the interim editor never hides access it does not edit.
const base = { userId: 'u1', stores: [{ id: 's1', code: 'S1', name: 'Store one', zone: null }], cameras: [] }
const orgWide: OtherGrant = {
  id: 'g1', capability: 'it.inventory.view', capabilityLabel: 'See IT assets, their addresses and NVR addresses', scopeKind: 'organization', scopeId: null,
  scopeLabel: 'Whole organisation', source: 'migrated:manager', needsReview: true, validFrom: '2026-10-22T05:00:00Z', validUntil: null, state: 'effective',
}

describe('AccessEditor', () => {
  it('lists other live grants read-only with a plain warning, the source, the review flag and the dates', () => {
    const expired: OtherGrant = { ...orgWide, id: 'g2', capability: 'cctv.live', capabilityLabel: 'Watch live video', scopeKind: 'location', scopeId: 's1', scopeLabel: 'S1 · Store one', source: 'manual', needsReview: false, validUntil: '2026-10-21T05:00:00Z', state: 'expired' }
    const html = renderToStaticMarkup(<AccessEditor {...base} initial={{ storeIds: [], zones: [], cameraIds: [], other: [orgWide, expired] }} />)
    expect(html).toContain('This person also has access that this screen does not edit')
    expect(html).toContain('See IT assets, their addresses and NVR addresses')
    expect(html).toContain('Whole organisation')
    expect(html).toContain('Moved over from the old manager role')
    expect(html).toContain('Please review')
    expect(html).toContain('Expired')
    expect(html).toContain('S1 · Store one')
    // Read-only: no checkbox in that list.
    const section = html.slice(html.indexOf('This person also has access'))
    expect(section.slice(0, section.indexOf('</section>'))).not.toContain('type="checkbox"')
  })

  it('shows no warning when there is nothing else', () => {
    const html = renderToStaticMarkup(<AccessEditor {...base} initial={{ storeIds: [], zones: [], cameraIds: [], other: [] }} />)
    expect(html).not.toContain('does not edit')
  })
})
