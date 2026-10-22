import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/actions/admin/access', () => ({ previewAccessAction: vi.fn(), applyAccessAction: vi.fn(), keepReviewedAction: vi.fn(), selfConfirmReviewAction: vi.fn() }))
vi.mock('@/lib/actions/admin/users', () => ({ createUserAction: vi.fn(), setActiveAction: vi.fn(), setRoleAction: vi.fn(), reactivationReviewAction: vi.fn(), resetPasswordAction: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { AccessEditor } from '@/components/admin/AccessEditor'
import { AccessGrantTable } from '@/components/admin/AccessGrantTable'
import { AccessPreviewPanel } from '@/components/admin/AccessPreviewPanel'
import { AccessReviewList } from '@/components/admin/AccessReviewList'
import { CreateUserForm } from '@/components/admin/CreateUserForm'
import { MSG_DEACTIVATE, UserRow } from '@/components/admin/UserRow'
import type { EditorData, GrantView } from '@/lib/admin/access'

// P2-3 component checks (static render): every control has a name (a <label for>, a wrapping <label> or aria-label), the wording of
// the assignment modes, the union rule, the review flag and expiry badge, Super administrator (P-1), neutral deactivation text.

/** Form controls without an accessible name. */
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
    if (name !== 'button' && before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue // wrapped in a label
    if (name === 'button') {
      const rest = html.slice(m.index + tag.length)
      const text = rest.slice(0, rest.indexOf('</button>')).replace(/<[^>]+>/g, '').trim()
      if (text) continue
    }
    out.push(tag)
  }
  return out
}

const grant = (o: Partial<GrantView>): GrantView => ({
  id: 'g1', capability: 'cctv.live', capabilityLabel: 'Watch live video', area: 'cctv', risk: 'low', scopeKind: 'location', scopeId: 's1', scopeLabel: 'S1 · Store one',
  source: 'manual', needsReview: false, validFrom: '2026-10-01T05:00:00Z', validUntil: null, lastDay: null, grantedAt: '2026-10-01T05:00:00Z', grantedByName: 'Admin A',
  reason: null, revokedAt: null, revokedByName: null, revokeReason: null, state: 'active', expiresSoon: false, keptAt: null, ...o,
})
const catalogue = [
  { key: 'cctv.live', area: 'cctv', risk: 'low', description: 'Watch live video', scope_kinds: ['organization', 'location', 'camera'] },
  { key: 'cctv.playback', area: 'cctv', risk: 'medium', description: 'Search recordings and play them back', scope_kinds: ['organization', 'location', 'camera'] },
  { key: 'cctv.export', area: 'cctv', risk: 'medium', description: 'Export or download recordings', scope_kinds: ['organization', 'location', 'camera'] },
  { key: 'it.inventory.view', area: 'it', risk: 'low', description: 'See IT assets', scope_kinds: ['organization', 'location', 'asset'] },
  { key: 'admin.users', area: 'admin', risk: 'high', description: 'Read and manage people', scope_kinds: ['organization'] },
]
const data = (o: Partial<EditorData> = {}): EditorData => ({
  person: { id: 'u1', full_name: 'Asha Viewer', email: 'asha@example.test', role: 'user', is_active: true, must_reset_password: false },
  version: 4, editable: true, notEditableReason: null, catalogue, grantable: ['cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view'],
  locations: [{ id: 's1', code: 'S1', name: 'Store one' }], cameras: [{ id: 'c1', store_id: 's1', channel: 1, name: 'Entrance' }], assets: [{ id: 'd1', store_id: 's1', name: 'Back-office PC', type: 'pc' }],
  grants: [
    grant({}),
    grant({ id: 'g2', capability: 'it.inventory.view', capabilityLabel: 'See IT assets', area: 'it', scopeKind: 'organization', scopeId: null, scopeLabel: 'Whole organisation', source: 'migrated:manager', needsReview: true, validUntil: '2026-10-25T18:30:00Z', lastDay: '2026-10-25', expiresSoon: true }),
    grant({ id: 'g3', state: 'revoked', revokedAt: '2026-10-10T05:00:00Z', revokedByName: 'Admin B', revokeReason: 'Moved away' }),
  ],
  ...o,
})

describe('AccessEditor', () => {
  it('lists every grant that is not removed, with a named Remove button, and keeps removed ones in the history', () => {
    const html = renderToStaticMarkup(<AccessEditor userId="u1" data={data()} />)
    expect(html).toContain('Current access')
    expect(html).toContain('aria-label="Remove Watch live video for S1 · Store one"')
    expect(html).toContain('aria-label="Remove See IT assets for Whole organisation"')
    expect(html).toContain('Moved over from the old manager role')
    expect(html).toContain('Please review')
    expect(html).toContain('Expires soon')
    expect(html).toContain('until the end of 25 Oct 2026')
    expect(html).toContain('History: removed grants (1)')
    expect(html).toContain('Moved away')
    expect(html).toMatch(/Access adds up/)
    expect(html).toMatch(/Nothing here narrows access\s+silently/)
    expect(unnamed(html)).toEqual([])
  })

  it('offers the assignment modes in plain words; saving needs a checked preview', () => {
    const html = renderToStaticMarkup(<AccessEditor userId="u1" data={data()} />)
    expect(html).toContain('All cameras in these locations')
    expect(html).toContain('Includes cameras added to the location later.')
    expect(html).toContain('Selected cameras')
    expect(html).toContain('New cameras are NOT included automatically.')
    expect(html).toContain('Whole organisation')
    expect(html).toContain('Preset: Location CCTV viewer (live + playback)')
    expect(html).toContain('Valid until (optional)')
    expect(html).toContain('Access ends at midnight India time after this day.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save these changes<\/button>/)
    expect(html).toContain('Saving is possible only after checking the effect of exactly these changes.')
  })

  it('a prepared removal (from the review) is on the list with a required reason', () => {
    const html = renderToStaticMarkup(<AccessEditor userId="u1" data={data()} prefill={{ revokeIds: ['g2'], revokeReason: 'Reviewed: not needed', builder: null }} />)
    expect(html).toContain('Changes to save (1)')
    expect(html).toContain('Will be removed')
    expect(html).toContain('Reason for removing (required)')
    expect(html).toContain('value="Reviewed: not needed"')
  })

  it('a super administrator shows full rights and a restore button when something is missing (P-1)', () => {
    const d = data({ person: { id: 'u9', full_name: 'Sam Super', email: 'sam@example.test', role: 'platform_owner', is_active: true, must_reset_password: false }, grantable: catalogue.map((c) => c.key) })
    const html = renderToStaticMarkup(<AccessEditor userId="u9" data={d} />)
    expect(html).toContain('Super administrator')
    expect(html).toContain('Super administrator: full rights (all capabilities) for the whole organisation.')
    expect(html).toContain('4 of 5 rights are missing')
    expect(html).toContain('Restore full rights')
    expect(html).toContain('>Administration</button>') // the area where the presets "Full rights" and "Administrator set" are offered
  })

  it('read-only when the administrator may not change this person: no Remove, no Add', () => {
    const html = renderToStaticMarkup(<AccessEditor userId="u1" data={data({ editable: false, notEditableReason: 'You are not allowed to change this person’s access.' })} />)
    expect(html).toContain('You can see the access but not change it.')
    expect(html).not.toContain('Remove…')
    expect(html).not.toContain('Add access')
  })
})

describe('the preview, the people list, the create form and the review', () => {
  it('the preview says per right what is gained and lost, with examples and their location, and lists the exact grants', () => {
    const html = renderToStaticMarkup(
      <AccessPreviewPanel
        personActive={false}
        capabilities={[{ capability: 'cctv.live', label: 'Watch live video', target: 'camera', added: 12, removed: 1, sampleAdded: [{ id: 'c1', label: 'S1 · Entrance' }], sampleRemoved: [{ id: 'c9', label: 'S2 · Gate' }] }]}
        lines={[
          { op: 'grant', capability: 'cctv.live', capabilityLabel: 'Watch live video', scopeKind: 'location', scopeLabel: 'S1 · Store one', lastDay: '2026-10-31', reason: '', alreadyGiven: false },
          { op: 'grant', capability: 'cctv.live', capabilityLabel: 'Watch live video', scopeKind: 'camera', scopeLabel: 'S1 · Entrance', lastDay: null, reason: '', alreadyGiven: true },
          { op: 'revoke', grantId: 'g', capabilityLabel: 'Watch live video', scopeLabel: 'S2 · Store two', reason: 'Moved' },
        ]}
      />,
    )
    expect(html).toContain('Gains 12 cameras')
    expect(html).toContain('Loses 1 camera')
    expect(html).toContain('S1 · Entrance and 11 more')
    expect(html).toContain('Grants that will be created (2)')
    expect(html).toContain('Already given: nothing changes')
    expect(html).toContain('Grants that will be removed (1)')
    expect(html).toContain('the changes apply once they can sign in')
  })

  it('the users list shows the role label (Super administrator), the access summary, and neutral deactivation text', () => {
    const html = renderToStaticMarkup(<table><tbody><UserRow showSummary u={{ id: 'u1', email: 'e@x.test', full_name: 'Owner', role: 'platform_owner', is_active: true, must_reset_password: false, manageable: true, is_self: false, summary: 'Live: 3 locations, Playback: 3 locations, IT: none' }} /></tbody></table>)
    expect(html).toContain('Super administrator')
    expect(html).toContain('Live: 3 locations, Playback: 3 locations, IT: none')
    expect(html).toContain('Deactivate…')
    expect(MSG_DEACTIVATE).not.toMatch(/video|minute|stream/i)
    expect(unnamed(html)).toEqual([])
  })

  it('the create form says roles give no access, labels every field and uses "location"', () => {
    const html = renderToStaticMarkup(<CreateUserForm allowedRoles={['user', 'operator', 'manager', 'admin', 'platform_owner']} stores={[{ id: 's1', code: 'S1', name: 'Store one' }]} />)
    expect(html).toContain('It gives no access to cameras, recordings, IT or Wi-Fi')
    expect(html).toContain('A new person starts with no access.')
    expect(html).toContain('Home location (optional, for information: gives no access)')
    expect(html).toContain('>Super administrator</option>')
    expect(html).toContain('No home location')
    expect(html).not.toMatch(/home store/i)
    expect(unnamed(html)).toEqual([])
  })

  it('the review list offers Keep, Remove and Convert per grant, and explains when one may not act', () => {
    const item = { ...grant({ id: 'r1', source: 'migrated:home', needsReview: true }), grantId: 'r1', userId: 'u2', personName: 'Ravi', personEmail: 'r@x.test', personRole: 'user', personActive: true, reviewDecision: null, keepRefusal: null }
    const html = renderToStaticMarkup(<AccessReviewList groups={[
      { userId: 'u2', personName: 'Ravi', personEmail: 'r@x.test', personRole: 'user', personActive: true, manageable: true, self: false, items: [item] },
      { userId: 'u3', personName: 'Me', personEmail: 'me@x.test', personRole: 'platform_owner', personActive: true, manageable: true, self: true, items: [{ ...item, userId: 'u3', grantId: 'r2', id: 'r2' }] },
    ]} />)
    expect(html).toContain('Keep (confirm)')
    expect(html).toContain('href="/admin/users/u2/access?revoke=r1"')
    expect(html).toContain('href="/admin/users/u2/access?convert=r1"')
    expect(html).toContain('Moved over from the old home-location rule')
    expect(html).toContain('Another administrator must review your own access.')
    expect(html).toContain('Super administrator')
    expect(unnamed(html)).toEqual([])
    expect(renderToStaticMarkup(<AccessReviewList groups={[]} />)).toContain('Nothing is waiting for review.')
  })

  it('the grant table says when nothing is there', () => {
    expect(renderToStaticMarkup(<AccessGrantTable grants={[]} mode="current" />)).toContain('This person has no access yet.')
  })
})
