// P2-3 access editor service (lib/admin/access.ts) against the local database: the five directive assignment cases (AC-5), overlap
// (AC-6), presets, the preview against SQL (AC-9), lost-update protection, expiry (AC-12), revocation and history, the review of
// migrated grants (D-2a) and the permission boundaries. The Server Actions in lib/actions/admin/access.ts are thin wrappers (gates,
// rate limits) tested in tests/unit/access-actions.test.ts.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  accessSummaries,
  applyChange,
  keepReviewed,
  listReview,
  loadEditor,
  MSG_CONFLICT,
  MSG_PREVIEW_FIRST,
  previewChange,
  revokeAll,
  type AccessChange,
} from '@/lib/admin/access'
import { ADMINISTRATOR_SET, endOfDayIst, istDate } from '@/lib/admin/access-rules'
import type { Actor } from '@/lib/admin/types'
import { adminClient, atLocation, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[]) => [...a].sort()
const day = 86_400_000

async function addStore(orgId: string, code: string): Promise<string> {
  const { data, error } = await admin().from('locations').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '192.0.2.10', nvr_username: 'viewer' }).select('id').single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}
async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: storeId, channel, name: `Camera ${channel}` }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}
async function addDevice(orgId: string, storeId: string, name: string, port: number): Promise<string> {
  const { data, error } = await admin().from('assets').insert({ org_id: orgId, location_id: storeId, type: 'server', name, ip: '192.0.2.50', tcp_port: port }).select('id').single()
  if (error || !data) throw new Error(`addDevice: ${error?.message}`)
  return data.id
}
const effective = async (userId: string, cap: string, at?: string) =>
  sorted(((await admin().rpc('report_effective_camera_ids', { p_user: userId, p_cap: cap, ...(at ? { p_at: at } : {}) })).data as string[] | null) ?? [])
const seenCameras = async (u: TestUser) => sorted(((await u.client.from('cameras').select('id')).data ?? []).map((r) => r.id))
const canFor = async (u: TestUser, cap: string, kind: 'camera' | 'location', id: string) => (await u.client.rpc('has_capability_for', { p_cap: cap, p_kind: kind, p_id: id })).data
const versionOf = async (id: string) => Number((await admin().from('profiles').select('access_version').eq('id', id).single()).data!.access_version)

const g = (capability: string, scope_kind: 'organization' | 'location' | 'camera' | 'asset', scope_id: string | null, o: { valid_until?: string | null; reason?: string } = {}): AccessChange =>
  ({ op: 'grant', capability, scope_kind, scope_id, valid_until: o.valid_until ?? null, reason: o.reason ?? '' })
const r = (grant_id: string, reason = 'No longer needed'): AccessChange => ({ op: 'revoke', grant_id, reason })

describe('access editor service (P2-3)', () => {
  let org: string
  let L1: string, L2: string, L3: string
  let c11: string, c12: string, c21: string, c22: string, c31: string
  let d1: string
  let owner: Actor, plain: Actor
  let ownerUser: TestUser

  /** Preview, then save with the preview's token and version: the only way the screen saves. */
  async function save(actor: Actor, userId: string, changes: AccessChange[]) {
    const p = await previewChange(admin(), actor, userId, { changes, expectedVersion: await versionOf(userId) })
    if (!p.ok) return p
    return applyChange(admin(), actor, userId, { changes, expectedVersion: p.version, token: p.token })
  }

  beforeAll(async () => {
    org = await createOrg()
    L1 = await addStore(org, 'E1')
    L2 = await addStore(org, 'E2')
    L3 = await addStore(org, 'E3')
    c11 = await addCamera(org, L1, 1)
    c12 = await addCamera(org, L1, 2)
    c21 = await addCamera(org, L2, 1)
    c22 = await addCamera(org, L2, 2)
    c31 = await addCamera(org, L3, 1)
    d1 = await addDevice(org, L1, 'Back-office PC', 4100)
    ownerUser = await createUser(org, 'platform_owner')
    await grant(org, ownerUser.id, ['admin.users', 'admin.access'])
    owner = { id: ownerUser.id, orgId: org, role: 'platform_owner' }
    const p = await createUser(org, 'admin')
    await grant(org, p.id, ['admin.users', 'admin.access'])
    await grant(org, p.id, ['cctv.live', 'cctv.playback'], [atLocation(L1), atLocation(L2)])
    plain = { id: p.id, orgId: org, role: 'admin' }
  })
  afterAll(() => cleanupOrg(org))

  describe('the five assignment cases (AC-5)', () => {
    it('1: all cameras in one location, including cameras added later', async () => {
      const v = await createUser(org, 'user')
      expect((await save(owner, v.id, [g('cctv.live', 'location', L1)])).ok).toBe(true)
      expect(await seenCameras(v)).toEqual(sorted([c11, c12]))
      const later = await addCamera(org, L1, 9)
      expect(await seenCameras(v)).toEqual(sorted([c11, c12, later]))
      await admin().rpc('inventory_archive', { p_org: org, p_kind: 'camera', p_id: later }) // P2-5a: archived, never deleted
    })

    it('2: all cameras across selected locations', async () => {
      const v = await createUser(org, 'user')
      expect((await save(owner, v.id, [g('cctv.live', 'location', L1), g('cctv.live', 'location', L2)])).ok).toBe(true)
      expect(await seenCameras(v)).toEqual(sorted([c11, c12, c21, c22]))
    })

    it('3: selected cameras in one location; a camera added later is NOT included', async () => {
      const v = await createUser(org, 'user')
      expect((await save(owner, v.id, [g('cctv.live', 'camera', c11), g('cctv.live', 'camera', c12)])).ok).toBe(true)
      const later = await addCamera(org, L1, 8)
      expect(await seenCameras(v)).toEqual(sorted([c11, c12]))
      await admin().rpc('inventory_archive', { p_org: org, p_kind: 'camera', p_id: later }) // P2-5a: archived, never deleted
    })

    it('4: selected cameras across locations', async () => {
      const v = await createUser(org, 'user')
      expect((await save(owner, v.id, [g('cctv.live', 'camera', c11), g('cctv.live', 'camera', c21)])).ok).toBe(true)
      expect(await seenCameras(v)).toEqual(sorted([c11, c21]))
    })

    it('5: different live, playback and export for the same coverage (live for a location, export for two cameras)', async () => {
      // Owner ruling E-1 (P2-3 review): export only for administrators, so the person here is an administrator (was a viewer).
      const v = await createUser(org, 'admin')
      const res = await save(owner, v.id, [
        g('cctv.live', 'location', L1),
        g('cctv.playback', 'location', L1),
        g('cctv.export', 'camera', c11, { reason: 'Incident 7 evidence' }),
        g('cctv.export', 'camera', c12, { reason: 'Incident 7 evidence' }),
      ])
      expect(res.ok).toBe(true)
      expect(await canFor(v, 'cctv.live', 'location', L1)).toBe(true)
      expect(await canFor(v, 'cctv.export', 'camera', c11)).toBe(true)
      expect(await canFor(v, 'cctv.export', 'location', L1)).toBe(false)
      expect(await canFor(v, 'cctv.live', 'camera', c21)).toBe(false)
    })

    it('IT rights per capability at location or asset scope, separate from CCTV', async () => {
      const v = await createUser(org, 'operator')
      expect((await save(owner, v.id, [g('it.inventory.view', 'asset', d1), g('it.monitoring.operate', 'location', L1)])).ok).toBe(true)
      expect(((await v.client.from('assets').select('id')).data ?? []).map((x) => x.id)).toEqual([d1])
      expect(await seenCameras(v)).toEqual([])
    })
  })

  it('overlap is a union: a camera next to its location adds nothing, and the preview says so (AC-6)', async () => {
    const v = await createUser(org, 'user')
    expect((await save(owner, v.id, [g('cctv.live', 'location', L1)])).ok).toBe(true)
    const p = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'camera', c11)], expectedVersion: await versionOf(v.id) })
    if (!p.ok) throw new Error(p.error)
    expect(p.capabilities.find((c) => c.capability === 'cctv.live')).toMatchObject({ added: 0, removed: 0 })
    expect((await save(owner, v.id, [g('cctv.live', 'camera', c11)])).ok).toBe(true)
    expect(await seenCameras(v)).toEqual(sorted([c11, c12]))
    // An identical grant again is "already given": nothing changes.
    const again = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: await versionOf(v.id) })
    if (!again.ok) throw new Error(again.error)
    expect(again.lines[0]).toMatchObject({ op: 'grant', alreadyGiven: true })
  })

  it('the administrator set preset gives a new administrator the thirteen organisation-wide grants in one save', async () => {
    const newAdmin = await createUser(org, 'admin')
    const changes = ADMINISTRATOR_SET.map((c) => g(c, 'organization', null, { reason: 'New regional administrator' }))
    const p = await previewChange(admin(), owner, newAdmin.id, { changes, expectedVersion: await versionOf(newAdmin.id) })
    if (!p.ok) throw new Error(p.error)
    expect(p.lines).toHaveLength(13)
    expect(p.capabilities.find((c) => c.capability === 'cctv.live')?.added).toBe(5)
    expect(p.capabilities.find((c) => c.capability === 'admin.access')?.added).toBe(1)
    const res = await applyChange(admin(), owner, newAdmin.id, { changes, expectedVersion: p.version, token: p.token })
    expect(res.ok).toBe(true)
    const caps = sorted((((await newAdmin.client.rpc('my_access_summary')).data ?? []) as { capability: string }[]).map((x) => x.capability))
    expect(caps).toEqual(sorted(ADMINISTRATOR_SET))
    // A plain administrator cannot do this for an administrator.
    const other = await createUser(org, 'admin')
    const refused = await previewChange(admin(), plain, other.id, { changes, expectedVersion: 0 })
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/not allowed to change/) })
  })

  it('the preview counts equal what the save does, measured in SQL (AC-9)', async () => {
    const v = await createUser(org, 'user')
    const [old] = await grant(org, v.id, 'cctv.live', atLocation(L2))
    const changes = [r(old, 'Moved to E1'), g('cctv.live', 'location', L1), g('cctv.live', 'camera', c31)]
    const before = await effective(v.id, 'cctv.live')
    const p = await previewChange(admin(), owner, v.id, { changes, expectedVersion: await versionOf(v.id) })
    if (!p.ok) throw new Error(p.error)
    const res = await applyChange(admin(), owner, v.id, { changes, expectedVersion: p.version, token: p.token })
    expect(res.ok).toBe(true)
    const after = await effective(v.id, 'cctv.live')
    const added = after.filter((x) => !before.includes(x))
    const removed = before.filter((x) => !after.includes(x))
    const live = p.capabilities.find((c) => c.capability === 'cctv.live')!
    expect({ added: live.added, removed: live.removed }).toEqual({ added: added.length, removed: removed.length })
    expect(sorted(live.sampleAdded.map((s) => s.id))).toEqual(sorted(added))
    expect(live.sampleAdded.every((s) => /^E[13] · Camera \d$/.test(s.label))).toBe(true) // each camera with its location
    expect(p.lines.map((l) => l.op)).toEqual(['revoke', 'grant', 'grant'])
  })

  describe('lost-update protection and the preview step', () => {
    it('a stale version at preview or save gives the friendly conflict message and changes nothing', async () => {
      const v = await createUser(org, 'user')
      const pageVersion = await versionOf(v.id)
      const p = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: pageVersion })
      if (!p.ok) throw new Error(p.error)
      await grant(org, v.id, 'cctv.playback', atLocation(L3)) // someone else changes this person meanwhile
      const res = await applyChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: p.version, token: p.token })
      expect(res).toEqual({ ok: false, error: MSG_CONFLICT, conflict: true })
      expect(await effective(v.id, 'cctv.live')).toEqual([])
      const stalePreview = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: pageVersion })
      expect(stalePreview).toEqual({ ok: false, error: MSG_CONFLICT, conflict: true })
    })

    it('saving needs the token of a preview of exactly these changes', async () => {
      const v = await createUser(org, 'user')
      const p = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: await versionOf(v.id) })
      if (!p.ok) throw new Error(p.error)
      expect(await applyChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L2)], expectedVersion: p.version, token: p.token })).toEqual({ ok: false, error: MSG_PREVIEW_FIRST })
      expect(await applyChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: p.version, token: 'x'.repeat(64) })).toEqual({ ok: false, error: MSG_PREVIEW_FIRST })
      expect(await effective(v.id, 'cctv.live')).toEqual([])
    })
  })

  describe('expiry (AC-12)', () => {
    it('a valid-until date counts until the end of that day in India, not a moment longer', async () => {
      const v = await createUser(org, 'user')
      const last = istDate(new Date(Date.now() + 3 * day))
      expect((await save(owner, v.id, [g('cctv.live', 'location', L1, { valid_until: last })])).ok).toBe(true)
      const row = (await admin().from('access_grants').select('valid_until').eq('user_id', v.id).is('revoked_at', null).single()).data!
      expect(new Date(row.valid_until!).toISOString()).toBe(endOfDayIst(last))
      const end = new Date(endOfDayIst(last)).getTime()
      expect(await effective(v.id, 'cctv.live', new Date(end - 1000).toISOString())).toEqual(sorted([c11, c12]))
      expect(await effective(v.id, 'cctv.live', new Date(end).toISOString())).toEqual([])
      const ed = await loadEditor(admin(), owner, v.id)
      expect(ed?.grants[0]).toMatchObject({ state: 'active', expiresSoon: true, lastDay: last })
    })

    it('a date in the past is refused; today is allowed', async () => {
      const v = await createUser(org, 'user')
      const yesterday = istDate(new Date(Date.now() - day))
      const res = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1, { valid_until: yesterday })], expectedVersion: 0 })
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/today or later/) })
      const today = await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', L1, { valid_until: istDate(new Date()) })], expectedVersion: 0 })
      expect(today.ok).toBe(true)
    })
  })

  describe('revocation and history', () => {
    it('every live grant is listed and can be revoked with a reason: organisation-wide, dated, future and one-sided ones too', async () => {
      const v = await createUser(org, 'user')
      const [orgWide] = await grant(org, v.id, 'it.inventory.view', ORG_SCOPE)
      const [dated] = await grant(org, v.id, 'cctv.live', atLocation(L3), { validUntil: new Date(Date.now() + 2 * day).toISOString() })
      const [future] = await grant(org, v.id, 'cctv.playback', atLocation(L2), { validFrom: new Date(Date.now() + day).toISOString() })
      const ed = await loadEditor(admin(), owner, v.id)
      expect(sorted(ed!.grants.filter((x) => x.state !== 'revoked').map((x) => x.id))).toEqual(sorted([orgWide, dated, future]))
      expect(ed!.grants.find((x) => x.id === future)?.state).toBe('future')
      const missingReason = await previewChange(admin(), owner, v.id, { changes: [r(orgWide, '')], expectedVersion: ed!.version })
      expect(missingReason).toMatchObject({ ok: false, error: expect.stringMatching(/reason/) })
      expect((await save(owner, v.id, [r(orgWide, 'Left the IT team'), r(dated, 'Project over'), r(future, 'Not needed')])).ok).toBe(true)
      const after = await loadEditor(admin(), owner, v.id)
      // History is never edited: the rows are still there, revoked, with who and why.
      expect(after!.grants.map((x) => x.state)).toEqual(['revoked', 'revoked', 'revoked'])
      expect(after!.grants.find((x) => x.id === orgWide)).toMatchObject({ revokeReason: 'Left the IT team', revokedByName: 'Test User' })
      expect(await effective(v.id, 'cctv.live')).toEqual([])
    })

    it('revoke-all (used when reactivating a person) revokes exactly the listed live grants', async () => {
      const v = await createUser(org, 'user')
      const ids = await grant(org, v.id, ['cctv.live', 'cctv.playback'], atLocation(L1))
      const res = await revokeAll(admin(), owner, v.id, { grantIds: ids, reason: 'Reviewed on reactivation', expectedVersion: await versionOf(v.id) })
      expect(res).toMatchObject({ ok: true, revoked: 2 })
      expect(await effective(v.id, 'cctv.playback')).toEqual([])
      expect((await revokeAll(admin(), owner, v.id, { grantIds: ids, reason: 'again', expectedVersion: await versionOf(v.id) })).ok).toBe(false)
    })
  })

  describe('permission boundaries', () => {
    it('a plain administrator gives only what they hold, where they hold it', async () => {
      const v = await createUser(org, 'user')
      expect((await save(plain, v.id, [g('cctv.live', 'camera', c21)])).ok).toBe(true)
      // Review M-14: each refusal says exactly why.
      const cases: [AccessChange, string][] = [
        [g('cctv.live', 'location', L3), 'You can only give rights you hold yourself, for the same places: “Watch live video”.'],
        [g('cctv.export', 'camera', c11, { reason: 'Incident' }), 'Download rights (export) can only be given to administrators and super administrators.'],
        [g('cctv.export', 'camera', c11), 'Give a reason for “Export or download recordings as files” (at least three characters).'],
        [g('it.inventory.view', 'organization', null), 'You can only give rights you hold yourself, for the same places: “See IT assets, their addresses and NVR addresses”.'],
        [g('it.os.deploy', 'location', L1, { reason: 'x y z' }), 'Only a super administrator can give “Deploy operating systems”.'],
        [g('cctv.live', 'location', L1, { valid_until: istDate(new Date(Date.now() - day)) }), 'The valid-until date must be today or later.'],
      ]
      for (const [bad, message] of cases) {
        const res = await previewChange(admin(), plain, v.id, { changes: [bad], expectedVersion: await versionOf(v.id) })
        expect(res, JSON.stringify(bad)).toEqual({ ok: false, error: message })
      }
    })

    it('nobody edits their own access; people and places of another organisation are not found', async () => {
      expect(await previewChange(admin(), owner, owner.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/your own access/) })
      const otherOrg = await createOrg()
      try {
        const stranger = await createUser(otherOrg, 'user')
        const foreignStore = await addStore(otherOrg, 'X1')
        expect(await previewChange(admin(), owner, stranger.id, { changes: [g('cctv.live', 'location', L1)], expectedVersion: 0 })).toEqual({ ok: false, error: 'User not found.' })
        expect(await loadEditor(admin(), owner, stranger.id)).toBeNull()
        const v = await createUser(org, 'user')
        expect(await previewChange(admin(), owner, v.id, { changes: [g('cctv.live', 'location', foreignStore)], expectedVersion: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
      } finally {
        await cleanupOrg(otherOrg)
      }
    })

    it('bad input is refused in plain words', async () => {
      const v = await createUser(org, 'user')
      const cases: [unknown[], string][] = [
        [[], 'Add at least one change first.'],
        [[{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: 'nope', valid_until: null, reason: '' }], 'Choose a location, camera or asset.'],
        [[{ op: 'grant', capability: 'cctv.unknown', scope_kind: 'organization', scope_id: null, valid_until: null, reason: '' }], 'One of the rights is not known.'],
        [[{ op: 'grant', capability: 'admin.users', scope_kind: 'location', scope_id: L1, valid_until: null, reason: 'x y z' }], '“Read and manage people” cannot be given for a single location.'],
        [[{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: null, valid_until: null, reason: '' }], 'Choose a location, camera or asset for each right.'],
        [[{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L1, valid_until: '2026-02-30', reason: '' }], 'Use a real date for “valid until”.'],
        [[{ op: 'grant', capability: 'admin.users', scope_kind: 'organization', scope_id: null, valid_until: null, reason: 'x y z' }], 'Administration rights can only be given to administrators.'],
      ]
      for (const [changes, message] of cases) {
        const res = await previewChange(admin(), owner, v.id, { changes, expectedVersion: 0 })
        expect(res, JSON.stringify(changes)).toEqual({ ok: false, error: message })
      }
    })
  })

  describe('review of migrated grants (D-2a)', () => {
    it('lists migrated home, manager and administrator grants with the report notes, and keeping them removes them from the open list', async () => {
      const homeViewer = await createUser(org, 'user', { storeId: L1 })
      const storeViewer = await createUser(org, 'user')
      // A legacy store grant that showed an IT device: it is migrated for CCTV only and the person deliberately loses the device (AC-4).
      expect((await admin().from('user_store_access').insert({ org_id: org, user_id: storeViewer.id, store_id: L1 })).error).toBeNull()
      const manager = await createUser(org, 'manager')
      expect((await admin().rpc('access_migrate_legacy_test', { p_run: randomUUID(), p_users: [homeViewer.id, storeViewer.id, manager.id] })).error).toBeNull()
      const review = await listReview(admin(), org)
      const mine = review.open.filter((x) => [homeViewer.id, manager.id].includes(x.userId))
      expect(mine.filter((x) => x.userId === homeViewer.id).map((x) => x.source)).toEqual(['migrated:home', 'migrated:home'])
      expect(mine.filter((x) => x.userId === manager.id)).toHaveLength(4)
      expect(review.open.some((x) => x.userId === storeViewer.id)).toBe(false) // a plain store grant is not a review item
      const lost = review.notes.find((n) => n.userId === storeViewer.id)
      expect(lost).toMatchObject({ lostDevices: true })
      expect(lost!.note).toMatch(/IT devices no longer visible/)
      expect(review.notes.find((n) => n.userId === manager.id)?.note).toMatch(/Manager role/)

      const managerIds = mine.filter((x) => x.userId === manager.id).map((x) => x.grantId)
      expect(await keepReviewed(admin(), owner, { grantIds: managerIds, note: 'Area manager' })).toEqual({ ok: true, kept: 4 })
      const again = await listReview(admin(), org)
      expect(again.open.some((x) => x.userId === manager.id)).toBe(false)
      expect(again.kept.filter((x) => x.userId === manager.id)).toHaveLength(4)
      expect(again.openCount).toBe(again.open.length)
      const { data: audit } = await admin().from('admin_audit_log').select('action, detail').eq('org_id', org).eq('action', 'access_review_kept')
      expect(audit?.[0]?.detail).toMatchObject({ grant_ids: expect.arrayContaining(managerIds), count: 4, note: 'Area manager' })
    })
  })

  it('people summary and audit events (grant, revoke) with ids, capability, scope, expiry and reason, no secrets', async () => {
    const v = await createUser(org, 'user')
    const until = istDate(new Date(Date.now() + 5 * day))
    expect((await save(owner, v.id, [g('cctv.live', 'location', L1), g('cctv.playback', 'location', L1, { valid_until: until })])).ok).toBe(true)
    const summary = await accessSummaries(admin(), org)
    expect(summary.get(v.id)).toBe('Live: 1 location, Playback: 1 location, IT: none')
    const { data } = await admin().from('admin_audit_log').select('action, detail, entity_id, actor_id').eq('org_id', org).eq('entity_id', v.id)
    const granted = (data ?? []).find((a) => a.action === 'access_granted')
    expect(granted?.actor_id).toBe(owner.id)
    expect(granted?.detail).toMatchObject({ count: 2, grants: expect.arrayContaining([expect.objectContaining({ capability: 'cctv.playback', scope_kind: 'location', scope_id: L1, valid_until: endOfDayIst(until) })]) })
    expect(JSON.stringify(data)).not.toMatch(/password|token|secret/i)
  })
})
