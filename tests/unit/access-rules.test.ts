import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ADMINISTRATOR_SET,
  endOfDayIst,
  expiresSoon,
  grantRefusal,
  grantState,
  istDate,
  matrixChanges,
  MSG_EXPORT_ADMINS_ONLY,
  OWNER_ONLY_CAPABILITIES,
  presetChanges,
  PRESETS,
  reasonRequired,
  summarise,
  type Holding,
} from '@/lib/admin/access-rules'
import { ROLE_LABELS } from '@/lib/admin/roles'
import { CAPABILITIES } from '@/lib/auth/capabilities'
import { ADMIN_BASELINE } from '../../scripts/lib/demo'

// P2-3 pure rules of the access editor (docs/drishti/access-model.md "Who may grant what"). The database checks the same rules again
// (migration 20261021000015, tests/integration/access-admin-db.test.ts).

const now = new Date('2026-10-22T06:30:00Z') // 12:00 IST
const live = { key: 'cctv.live', area: 'cctv', risk: 'low', description: 'Watch live video' } as const
const exp = { key: 'cctv.export', area: 'cctv', risk: 'medium', description: 'Export' } as const
const remote = { key: 'it.remote.control', area: 'it', risk: 'high', description: 'Control a computer remotely' } as const
const remoteView = { key: 'it.remote.view', area: 'it', risk: 'high', description: 'View a computer screen remotely' } as const
const users = { key: 'admin.users', area: 'admin', risk: 'high', description: 'Read and manage people' } as const
const hold = (capability: string, scope_kind: Holding['scope_kind'], scope_id: string | null, valid_until: string | null = null): Holding => ({
  capability, scope_kind, scope_id, valid_from: '2026-01-01T00:00:00Z', valid_until,
})

describe('dates (IST, end of day)', () => {
  it('a valid-until date means the end of that day in India: access stops at midnight IST', () => {
    expect(endOfDayIst('2026-10-25')).toBe('2026-10-25T18:30:00.000Z') // 26 Oct 00:00 IST
    expect(endOfDayIst('2026-12-31')).toBe('2026-12-31T18:30:00.000Z')
    expect(() => endOfDayIst('2026-02-30')).toThrow()
    expect(() => endOfDayIst('25/10/2026')).toThrow()
  })
  it('istDate gives the calendar day in India', () => {
    expect(istDate(new Date('2026-10-22T18:29:59Z'))).toBe('2026-10-22')
    expect(istDate(new Date('2026-10-22T18:30:00Z'))).toBe('2026-10-23')
    // The end of a chosen day shows as that day.
    expect(istDate(new Date(new Date(endOfDayIst('2026-10-25')).getTime() - 1))).toBe('2026-10-25')
  })
  it('states and the expires-soon badge (7 days)', () => {
    const g = (from: string, until: string | null, revoked: string | null = null) => ({ valid_from: from, valid_until: until, revoked_at: revoked })
    expect(grantState(g('2026-10-01T00:00:00Z', null), now)).toBe('active')
    expect(grantState(g('2026-10-23T00:00:00Z', null), now)).toBe('future')
    expect(grantState(g('2026-10-01T00:00:00Z', '2026-10-22T06:30:00Z'), now)).toBe('expired') // valid_until is exclusive
    expect(grantState(g('2026-10-01T00:00:00Z', null, '2026-10-02T00:00:00Z'), now)).toBe('revoked')
    expect(expiresSoon(g('2026-10-01T00:00:00Z', '2026-10-29T06:30:00Z'), now)).toBe(true)
    expect(expiresSoon(g('2026-10-01T00:00:00Z', '2026-10-29T06:30:01Z'), now)).toBe(false)
    expect(expiresSoon(g('2026-10-01T00:00:00Z', null), now)).toBe(false)
    expect(expiresSoon(g('2026-10-01T00:00:00Z', '2026-10-21T00:00:00Z'), now)).toBe(false) // already over
  })
})

describe('reasons', () => {
  it('are required for export and every high-risk right, not for the others', () => {
    expect(reasonRequired(exp)).toBe(true)
    expect(reasonRequired(remote)).toBe(true)
    expect(reasonRequired(users)).toBe(true)
    expect(reasonRequired(live)).toBe(false)
    expect(reasonRequired({ key: 'cctv.playback', risk: 'medium' })).toBe(false)
  })
})

describe('who may grant what', () => {
  const base = { actorRole: 'admin' as const, actorId: 'a', targetId: 't', targetRole: 'user' as const, reason: '', now }
  const at = (capability: string, scope_kind: Holding['scope_kind'], scope_id: string | null, valid_until: string | null = null) => ({ capability, scope_kind, scope_id, valid_until })

  it('an administrator gives what they hold at an equal or narrower scope', () => {
    const holdings = [hold('cctv.live', 'location', 'L1')]
    expect(grantRefusal({ ...base, holdings, cap: live, spec: at('cctv.live', 'location', 'L1'), parentLocation: null })).toBeNull()
    expect(grantRefusal({ ...base, holdings, cap: live, spec: at('cctv.live', 'camera', 'C1'), parentLocation: 'L1' })).toBeNull()
    expect(grantRefusal({ ...base, holdings, cap: live, spec: at('cctv.live', 'camera', 'C9'), parentLocation: 'L2' })).toMatch(/hold yourself/)
    expect(grantRefusal({ ...base, holdings, cap: live, spec: at('cctv.live', 'organization', null), parentLocation: null })).toMatch(/hold yourself/)
    expect(grantRefusal({ ...base, holdings: [hold('cctv.live', 'organization', null)], cap: live, spec: at('cctv.live', 'camera', 'C9'), parentLocation: 'L2' })).toBeNull()
  })
  it('and for no longer than they hold it', () => {
    const holdings = [hold('cctv.live', 'organization', null, '2026-11-01T00:00:00Z')]
    expect(grantRefusal({ ...base, holdings, cap: live, spec: at('cctv.live', 'location', 'L1'), parentLocation: null })).toMatch(/no longer/)
    expect(grantRefusal({ ...base, holdings, cap: live, spec: at('cctv.live', 'location', 'L1', '2026-10-31T00:00:00Z'), parentLocation: null })).toBeNull()
    // A holding that is not in effect now counts for nothing.
    expect(grantRefusal({ ...base, holdings: [hold('cctv.live', 'organization', null, '2026-10-01T00:00:00Z')], cap: live, spec: at('cctv.live', 'location', 'L1', '2026-09-01T00:00:00Z'), parentLocation: null })).toMatch(/hold yourself/)
  })
  it('nobody changes their own access; a plain administrator manages viewers, operators and managers only', () => {
    const holdings = [hold('cctv.live', 'organization', null)]
    expect(grantRefusal({ ...base, targetId: 'a', holdings, cap: live, spec: at('cctv.live', 'location', 'L1'), parentLocation: null })).toMatch(/your own access/)
    expect(grantRefusal({ ...base, actorRole: 'platform_owner', targetId: 'a', holdings, cap: live, spec: at('cctv.live', 'location', 'L1'), parentLocation: null })).toMatch(/your own access/)
    expect(grantRefusal({ ...base, targetRole: 'admin', holdings, cap: live, spec: at('cctv.live', 'location', 'L1'), parentLocation: null })).toMatch(/not allowed to change/)
  })
  it('the seven high-risk IT rights only from a platform owner; administration rights only for administrators; reasons', () => {
    // Review ruling M-9: wifi.credentials.admin is owner-only like it.credentials.admin.
    expect(OWNER_ONLY_CAPABILITIES).toEqual(['it.os.deploy', 'it.credentials.admin', 'it.remote.control', 'it.script.run', 'it.software.manage', 'it.config.deploy', 'it.patch.manage', 'wifi.credentials.admin'])
    const holdings = [hold('it.remote.control', 'organization', null), hold('it.remote.view', 'organization', null)]
    expect(grantRefusal({ ...base, reason: 'Store IT lead', holdings, cap: remote, spec: at('it.remote.control', 'organization', null), parentLocation: null })).toMatch(/Only a super administrator/)
    expect(grantRefusal({ ...base, reason: 'Store IT lead', holdings, cap: remoteView, spec: at('it.remote.view', 'organization', null), parentLocation: null })).toBeNull()
    expect(grantRefusal({ ...base, reason: '', holdings, cap: remoteView, spec: at('it.remote.view', 'organization', null), parentLocation: null })).toMatch(/reason/)
    const owner = { ...base, actorRole: 'platform_owner' as const, holdings: [] }
    expect(grantRefusal({ ...owner, reason: 'Store IT lead', cap: remote, spec: at('it.remote.control', 'location', 'L1'), parentLocation: null })).toBeNull()
    // Ruling E-1: export only for administrators and super administrators (before: any role).
    expect(grantRefusal({ ...owner, targetRole: 'admin', reason: 'Incident 42', cap: exp, spec: at('cctv.export', 'camera', 'C1'), parentLocation: 'L1' })).toBeNull()
    expect(grantRefusal({ ...owner, targetRole: 'admin', reason: ' ', cap: exp, spec: at('cctv.export', 'camera', 'C1'), parentLocation: 'L1' })).toMatch(/reason/)
    for (const targetRole of ['user', 'operator', 'manager'] as const) {
      expect(grantRefusal({ ...owner, targetRole, reason: 'Incident 42', cap: exp, spec: at('cctv.export', 'camera', 'C1'), parentLocation: 'L1' }), targetRole).toBe(MSG_EXPORT_ADMINS_ONLY)
    }
    expect(grantRefusal({ ...owner, reason: 'Needed', targetRole: 'manager', cap: users, spec: at('admin.users', 'organization', null), parentLocation: null })).toMatch(/only be given to administrators/)
    expect(grantRefusal({ ...owner, reason: 'Needed', targetRole: 'admin', cap: users, spec: at('admin.users', 'organization', null), parentLocation: null })).toBeNull()
  })
})

describe('presets', () => {
  it('the administrator set is exactly what the migration, the dev-admin script and the demo give administrators', () => {
    const preset = PRESETS.find((p) => p.id === 'administrator-set')!
    expect(preset.capabilities).toEqual(ADMINISTRATOR_SET)
    expect([...ADMINISTRATOR_SET]).toEqual(ADMIN_BASELINE)
    const sql = readFileSync('supabase/migrations/20261021000012_capability_access_fixes.sql', 'utf8')
    const list = sql.match(/v_admin_caps text\[\] := ARRAY\[([^\]]+)\]/)![1].match(/'([^']+)'/g)!.map((s) => s.slice(1, -1))
    expect(list).toEqual([...ADMINISTRATOR_SET])
    expect(readFileSync('scripts/create-dev-admin.mjs', 'utf8')).toContain(ADMINISTRATOR_SET.map((c) => `'${c}'`).slice(0, 7).join(', '))
    expect(preset.organisationWide).toBe(true)
    expect(preset.forRoles).toEqual(['admin', 'platform_owner'])
  })
  it('store CCTV viewer is live + playback for the chosen locations; presets are no roles (they only expand)', () => {
    const p = PRESETS.find((x) => x.id === 'store-viewer')!
    expect(p.capabilities).toEqual(['cctv.live', 'cctv.playback'])
    expect(p.organisationWide).toBe(false)
    const cat = [{ key: 'cctv.live', area: 'cctv', risk: 'low', description: 'Live' }, { key: 'cctv.playback', area: 'cctv', risk: 'medium', description: 'Playback' }]
    expect(presetChanges(p, { locations: ['L1', 'L2'], catalogue: cat, grantable: ['cctv.live', 'cctv.playback'], validUntil: '2026-11-30', reason: '' })).toEqual([
      { op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: 'L1', valid_until: '2026-11-30', reason: '' },
      { op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: 'L2', valid_until: '2026-11-30', reason: '' },
      { op: 'grant', capability: 'cctv.playback', scope_kind: 'location', scope_id: 'L1', valid_until: '2026-11-30', reason: '' },
      { op: 'grant', capability: 'cctv.playback', scope_kind: 'location', scope_id: 'L2', valid_until: '2026-11-30', reason: '' },
    ])
    // Only what the administrator may give is expanded.
    expect(presetChanges(p, { locations: ['L1'], catalogue: cat, grantable: ['cctv.live'], validUntil: null, reason: '' }).map((c) => c.capability)).toEqual(['cctv.live'])
  })
  it('full rights (P-1): every capability of the catalogue for the organisation, for super administrators', () => {
    const p = PRESETS.find((x) => x.id === 'full-rights')!
    expect(p.forRoles).toEqual(['platform_owner'])
    const cat = CAPABILITIES.map((key) => ({ key, area: key.split('.')[0], risk: 'low', description: key, scope_kinds: ['organization'] }))
    const out = presetChanges(p, { locations: [], catalogue: cat, grantable: [...CAPABILITIES], validUntil: null, reason: 'Restore full rights' })
    expect(out.map((c) => c.capability)).toEqual([...CAPABILITIES])
    expect(out.every((c) => c.scope_kind === 'organization' && c.scope_id === null)).toBe(true)
  })
  it('the coverage × capability matrix becomes one grant per ticked cell', () => {
    expect(matrixChanges([{ scope_kind: 'location', scope_id: 'L1', capabilities: ['cctv.live'] }, { scope_kind: 'camera', scope_id: 'C1', capabilities: ['cctv.export', 'cctv.playback'] }, { scope_kind: 'camera', scope_id: 'C2', capabilities: [] }], null, 'Incident 7'))
      .toEqual([
        { op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: 'L1', valid_until: null, reason: 'Incident 7' },
        { op: 'grant', capability: 'cctv.export', scope_kind: 'camera', scope_id: 'C1', valid_until: null, reason: 'Incident 7' },
        { op: 'grant', capability: 'cctv.playback', scope_kind: 'camera', scope_id: 'C1', valid_until: null, reason: 'Incident 7' },
      ])
  })
  it('role labels: platform_owner is shown as Super administrator (P-1)', () => {
    expect(ROLE_LABELS).toEqual({ user: 'Viewer', operator: 'Operator', manager: 'Manager', admin: 'Administrator', platform_owner: 'Super administrator' })
  })
})

describe('summary for the people list', () => {
  const r = (capability: string, o: Partial<{ organization_wide: boolean; locations: number; cameras: number; assets: number }> = {}) => ({
    capability, organization_wide: false, locations: 0, cameras: 0, assets: 0, ...o,
  })
  it('says per capability what is in effect, and "none" for nothing', () => {
    expect(summarise([])).toBe('Live: none, Playback: none, IT: none')
    expect(summarise([r('cctv.live', { locations: 3 }), r('cctv.playback', { locations: 3 })])).toBe('Live: 3 locations, Playback: 3 locations, IT: none')
    expect(summarise([r('cctv.live', { locations: 1, cameras: 2 }), r('cctv.export', { cameras: 1 }), r('it.inventory.view', { organization_wide: true }), r('it.monitoring.view', { organization_wide: true })]))
      .toBe('Live: 1 location + 2 cameras, Playback: none, Export: 1 camera, IT: 2 rights (whole organisation)')
    expect(summarise([r('cctv.live', { organization_wide: true, locations: 2 }), r('it.inventory.view', { assets: 3 }), r('wifi.inventory.view', { locations: 1 }), r('admin.users', { organization_wide: true })]))
      .toBe('Live: whole organisation, Playback: none, IT: 1 right, Wi-Fi: 1 right, Admin: 1 right')
  })
})
