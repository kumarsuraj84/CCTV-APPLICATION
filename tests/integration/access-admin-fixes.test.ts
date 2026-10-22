// P2-3 review fix round 1: last super administrator in SQL (I-1), demotion (I-2), reactivation listing (M-1), expired grants are not
// re-dated (M-2), audit of automatic full rights (M-3), wifi.credentials.admin owner-only (M-9), review = grant rule (M-10), break-glass
// self-confirmation (M-11), catalogue updates (M-13), new reason text (M-8), catalogue wording after D-L1 (T-1).
// Migration 20261021000017_access_admin_fixes.sql; services lib/admin/users.ts and lib/admin/access.ts.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyChange, keepReviewed, listReview, MSG_CONFLICT, previewChange, reviewBeforeReactivation, selfConfirmReview, type AccessChange } from '@/lib/admin/access'
import type { Actor } from '@/lib/admin/types'
import { MSG_LAST_SUPER_ADMIN, updateUser } from '@/lib/admin/users'
import { MSG_EXPORT_ADMINS_ONLY } from '@/lib/admin/access-rules'
import { adminClient, atLocation, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[]) => [...a].sort()
const day = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const ADMIN_SET = ['admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read']
const OWNER_ONLY = ['it.os.deploy', 'it.credentials.admin', 'it.remote.control', 'it.script.run', 'it.software.manage', 'it.config.deploy', 'it.patch.manage', 'wifi.credentials.admin']
const versionOf = async (id: string) => Number((await admin().from('profiles').select('access_version').eq('id', id).single()).data!.access_version)
const live = async (id: string) => (await admin().from('access_grants').select('id, capability, scope_kind, scope_id, valid_from, valid_until, revoked_at, revoke_reason, reason').eq('user_id', id).is('revoked_at', null)).data ?? []
const actorOf = (u: TestUser, orgId: string, role: Actor['role']): Actor => ({ id: u.id, orgId, role })
async function addStore(orgId: string, code: string) {
  return (await admin().from('stores').insert({ org_id: orgId, code, name: `Location ${code}`, nvr_ip: '192.0.2.10', nvr_username: 'v' }).select('id').single()).data!.id as string
}
async function addCamera(orgId: string, storeId: string, ch: number) {
  return (await admin().from('cameras').insert({ org_id: orgId, store_id: storeId, channel: ch, name: `Camera ${ch}` }).select('id').single()).data!.id as string
}
async function owners(orgId: string, n: number): Promise<TestUser[]> {
  const out: TestUser[] = []
  for (let i = 0; i < n; i++) {
    const o = await createUser(orgId, 'platform_owner')
    await admin().rpc('grant_platform_owner_all', { p_org: orgId, p_user: o.id })
    out.push(o)
  }
  return out
}

describe('P2-3 fix round 1', () => {
  let org: string
  let L1: string, c11: string, c12: string
  let owner: TestUser, plain: TestUser
  let ownerA: Actor, plainA: Actor

  beforeAll(async () => {
    org = await createOrg()
    L1 = await addStore(org, 'F1')
    c11 = await addCamera(org, L1, 1)
    c12 = await addCamera(org, L1, 2)
    ;[owner] = await owners(org, 1)
    plain = await createUser(org, 'admin')
    await grant(org, plain.id, [...ADMIN_SET, 'cctv.live', 'cctv.playback', 'wifi.credentials.admin'])
    ownerA = actorOf(owner, org, 'platform_owner')
    plainA = actorOf(plain, org, 'admin')
  })
  afterAll(() => cleanupOrg(org))

  describe('I-1: at least one active super administrator, enforced in the database', () => {
    it('two super administrators deactivating (or demoting) each other at the same time: exactly one succeeds', async () => {
      for (const patch of [{ is_active: false }, { role: 'admin' }] as const) {
        const solo = await createOrg()
        try {
          const [a, b] = await owners(solo, 2)
          const res = await Promise.all([
            updateUser(admin(), actorOf(a, solo, 'platform_owner'), b.id, patch),
            updateUser(admin(), actorOf(b, solo, 'platform_owner'), a.id, patch),
          ])
          expect(res.filter((r) => r.ok), JSON.stringify(patch)).toHaveLength(1)
          // The loser is refused either by the last-super-administrator rule, or — when the winner's change landed first — because the
          // loser is no longer an active super administrator who may act at all. Both leave exactly one active super administrator.
          expect([MSG_LAST_SUPER_ADMIN, 'You are not allowed to change this user.']).toContain((res.find((r) => !r.ok) as { error: string }).error)
          const { data } = await admin().from('profiles').select('id').eq('org_id', solo).eq('role', 'platform_owner').eq('is_active', true)
          expect(data).toHaveLength(1)
        } finally {
          await cleanupOrg(solo)
        }
      }
    })

    it('the service role cannot deactivate, demote or delete the last one either; deleting the sign-in does not remove it', async () => {
      const solo = await createOrg()
      try {
        const [only] = await owners(solo, 1)
        for (const patch of [{ is_active: false }, { role: 'admin' as const }]) {
          const r = await admin().from('profiles').update(patch).eq('id', only.id)
          expect(r.error?.code, JSON.stringify(patch)).toBe('DR001')
        }
        expect((await admin().from('profiles').delete().eq('id', only.id)).error?.code).toBe('DR001')
        expect((await admin().auth.admin.deleteUser(only.id)).error).not.toBeNull()
        expect((await admin().from('profiles').select('is_active, role').eq('id', only.id).single()).data).toEqual({ is_active: true, role: 'platform_owner' })
        // With a second active one, the first may go.
        const [second] = await owners(solo, 1)
        expect((await admin().from('profiles').update({ is_active: false }).eq('id', only.id)).error).toBeNull()
        expect(second.id).not.toBe(only.id)
      } finally {
        await cleanupOrg(solo)
      }
    })
  })

  describe('I-2: demotion removes the rights the new role may not keep, in one transaction, audited', () => {
    it('an administrator demoted to manager loses every admin.* grant and can no longer read other people, grants or the audit log', async () => {
      const a = await createUser(org, 'admin')
      await grant(org, a.id, [...ADMIN_SET, 'cctv.live'])
      const other = await createUser(org, 'user')
      await grant(org, other.id, 'cctv.live', atLocation(L1))
      expect(((await a.client.from('profiles').select('id')).data ?? []).length).toBeGreaterThan(1)
      const res = await updateUser(admin(), ownerA, a.id, { role: 'manager' }, { expectedVersion: await versionOf(a.id) })
      expect(res).toMatchObject({ ok: true, revoked: ADMIN_SET.length })
      expect(sorted((await live(a.id)).map((g) => g.capability))).toEqual(['cctv.live'])
      const { data: gone } = await admin().from('access_grants').select('revoke_reason, revoked_by').eq('user_id', a.id).like('capability', 'admin.%')
      for (const g of gone ?? []) expect(g).toEqual({ revoke_reason: 'Role changed: administration rights removed', revoked_by: owner.id })
      // Its own client, with a fresh token (the grants are read per request anyway).
      expect(((await a.client.from('profiles').select('id')).data ?? []).map((p) => p.id)).toEqual([a.id])
      expect(((await a.client.from('access_grants').select('user_id')).data ?? []).every((g) => g.user_id === a.id)).toBe(true)
      expect((await a.client.from('admin_audit_log').select('id')).data).toEqual([])
      const { data: audit } = await admin().from('admin_audit_log').select('action, detail, actor_id').eq('entity_id', a.id).eq('action', 'access_revoked')
      expect(audit?.[0]).toMatchObject({ actor_id: owner.id, detail: { count: ADMIN_SET.length, reason: 'Role changed: administration rights removed' } })
    })

    it('a super administrator demoted to administrator loses exactly the rights only a super administrator may hold, keeps the rest', async () => {
      const [s] = await owners(org, 1)
      const before = (await live(s.id)).length
      const res = await updateUser(admin(), ownerA, s.id, { role: 'admin' })
      expect(res).toMatchObject({ ok: true, revoked: OWNER_ONLY.length })
      const after = (await live(s.id)).map((g) => g.capability)
      expect(after).toHaveLength(before - OWNER_ONLY.length)
      for (const c of OWNER_ONLY) expect(after).not.toContain(c)
      expect(after).toContain('admin.access')
    })

    it('a stale expected version refuses the role change and changes nothing', async () => {
      const a = await createUser(org, 'admin')
      await grant(org, a.id, ['admin.users'])
      const stale = (await versionOf(a.id)) - 1
      expect(await updateUser(admin(), ownerA, a.id, { role: 'user' }, { expectedVersion: stale })).toEqual({ ok: false, error: MSG_CONFLICT })
      expect((await admin().from('profiles').select('role').eq('id', a.id).single()).data?.role).toBe('admin')
      expect((await live(a.id)).map((g) => g.capability)).toEqual(['admin.users'])
    })

    it('a plain administrator cannot promote anyone to super administrator (also not in SQL)', async () => {
      const m = await createUser(org, 'manager')
      expect(await updateUser(admin(), plainA, m.id, { role: 'platform_owner' })).toEqual({ ok: false, error: 'You are not allowed to give that role.' })
      const sql = await admin().rpc('change_person_role', { p_org: org, p_actor: plain.id, p_user: m.id, p_role: 'platform_owner' })
      expect(sql.error?.code).toBe('42501')
      expect((await admin().from('profiles').select('role').eq('id', m.id).single()).data?.role).toBe('manager')
    })
  })

  it('M-1: the grants of a person are listed for reactivation only to someone who may manage them, and only while inactive unless they hold admin.access', async () => {
    const v = await createUser(org, 'user')
    await grant(org, v.id, 'cctv.live', atLocation(L1))
    expect(await reviewBeforeReactivation(admin(), plainA, v.id, { mayReadAccess: false })).toEqual({ ok: false, error: 'This person is active; their access is shown on the access screen.' })
    expect((await reviewBeforeReactivation(admin(), plainA, v.id, { mayReadAccess: true })).ok).toBe(true)
    await admin().from('profiles').update({ is_active: false }).eq('id', v.id)
    expect((await reviewBeforeReactivation(admin(), plainA, v.id, { mayReadAccess: false })).ok).toBe(true)
    expect(await reviewBeforeReactivation(admin(), plainA, owner.id, { mayReadAccess: true })).toEqual({ ok: false, error: 'You are not allowed to change this user.' })
  })

  describe('M-2: an expired grant is history; only grants in effect or touching the new window are joined', () => {
    const save = async (userId: string, changes: AccessChange[]) => {
      const p = await previewChange(admin(), ownerA, userId, { changes, expectedVersion: await versionOf(userId) })
      if (!p.ok) throw new Error(p.error)
      const r = await applyChange(admin(), ownerA, userId, { changes, expectedVersion: p.version, token: p.token })
      if (!r.ok) throw new Error(r.error)
      return p
    }
    const g = (capability: string, id: string): AccessChange => ({ op: 'grant', capability, scope_kind: 'location', scope_id: id, valid_until: null, reason: '' })

    it('giving an expired location again leaves the expired grant exactly as it was and adds a new one; the preview says so', async () => {
      const v = await createUser(org, 'user')
      const [old] = await grant(org, v.id, 'cctv.live', atLocation(L1), { validFrom: iso(Date.now() - 3 * day), validUntil: iso(Date.now() - day) })
      const before = (await admin().from('access_grants').select('*').eq('id', old).single()).data
      const p = await save(v.id, [g('cctv.live', L1)])
      expect(p.capabilities.find((c) => c.capability === 'cctv.live')).toMatchObject({ added: 2, removed: 0 })
      expect((await admin().from('access_grants').select('*').eq('id', old).single()).data).toEqual(before) // stays expired, not re-dated
      const rows = await live(v.id)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.id !== old)?.valid_until).toBeNull()
    })

    it('touching windows are joined into one grant; a gap keeps two grants', async () => {
      const v = await createUser(org, 'user')
      const t1 = Date.now() + day
      const t2 = Date.now() + 2 * day
      const t3 = Date.now() + 3 * day
      await grant(org, v.id, 'cctv.playback', atLocation(L1), { validFrom: iso(t1), validUntil: iso(t2) })
      await grant(org, v.id, 'cctv.playback', atLocation(L1), { validFrom: iso(t2), validUntil: iso(t3) })
      const joined = await live(v.id)
      expect(joined).toHaveLength(1)
      expect([new Date(joined[0].valid_from).getTime(), new Date(joined[0].valid_until!).getTime()]).toEqual([t1, t3])
      await grant(org, v.id, 'cctv.playback', atLocation(L1), { validFrom: iso(t3 + day), validUntil: iso(t3 + 2 * day) })
      expect(await live(v.id)).toHaveLength(2)
    })
  })

  it('M-3 and M-8: promotion and reactivation give the full set with an audit record naming the acting person and the new reason', async () => {
    const p = await createUser(org, 'admin')
    expect((await updateUser(admin(), ownerA, p.id, { role: 'platform_owner' })).ok).toBe(true)
    const rows = await live(p.id)
    expect(rows.every((r) => r.reason === 'Super administrator: all capabilities')).toBe(true)
    const audit = async () => (await admin().from('admin_audit_log').select('action, actor_id, detail').eq('entity_id', p.id).eq('action', 'access_granted')).data ?? []
    expect((await audit())[0]).toMatchObject({ actor_id: owner.id, detail: { source: 'platform_owner_auto', count: rows.length } })
    const victim = rows.find((r) => r.capability === 'cctv.export')!
    await admin().rpc('revoke_grant', { p_org: org, p_user: p.id, p_grant_ids: [victim.id], p_reason: 'test' })
    expect((await updateUser(admin(), ownerA, p.id, { is_active: false })).ok).toBe(true)
    expect((await updateUser(admin(), ownerA, p.id, { is_active: true })).ok).toBe(true)
    expect((await audit()).map((a) => (a.detail as { count: number }).count).sort()).toEqual([1, rows.length].sort((x, y) => x - y))
  })

  describe('E-1: downloads (cctv.export) only for administrators and super administrators', () => {
    it('is refused for a viewer, an operator and a manager, through the service the actions use and through the RPC', async () => {
      for (const role of ['user', 'operator', 'manager'] as const) {
        const v = await createUser(org, role)
        const change: AccessChange = { op: 'grant', capability: 'cctv.export', scope_kind: 'camera', scope_id: c11, valid_until: null, reason: 'Incident 9' }
        expect(await previewChange(admin(), ownerA, v.id, { changes: [change], expectedVersion: 0 }), role).toEqual({ ok: false, error: MSG_EXPORT_ADMINS_ONLY })
        const rpc = await admin().rpc('grant_access', { p_org: org, p_user: v.id, p_grants: [{ capability: 'cctv.export', scope_kind: 'camera', scope_id: c11 }], p_actor: owner.id, p_reason: 'Incident 9' })
        expect(rpc.error?.message, role).toMatch(/download rights only for administrators/)
        expect(await live(v.id)).toEqual([])
      }
      const a = await createUser(org, 'admin')
      const ok: AccessChange = { op: 'grant', capability: 'cctv.export', scope_kind: 'camera', scope_id: c12, valid_until: null, reason: 'Incident 9' }
      expect((await previewChange(admin(), ownerA, a.id, { changes: [ok], expectedVersion: 0 })).ok).toBe(true)
    })

    it('a demotion out of the administrative roles revokes export together with admin.*', async () => {
      const a = await createUser(org, 'admin')
      await grant(org, a.id, ['admin.users', 'cctv.export', 'cctv.live'])
      const res = await updateUser(admin(), ownerA, a.id, { role: 'operator' })
      expect(res).toMatchObject({ ok: true, revoked: 2 })
      expect((await live(a.id)).map((g) => g.capability)).toEqual(['cctv.live'])
      const { data } = await admin().from('access_grants').select('revoke_reason').eq('user_id', a.id).eq('capability', 'cctv.export').single()
      expect(data?.revoke_reason).toBe('Role changed: download rights removed')
    })

    it('existing data: no live export grant of a non-administrator outside the test organisations (the migration revoked any)', async () => {
      const { data: orgs } = await admin().from('organizations').select('id, slug')
      const real = (orgs ?? []).filter((o) => !o.slug.startsWith('test-')).map((o) => o.id)
      const { data: grants } = await admin().from('access_grants').select('user_id').eq('capability', 'cctv.export').is('revoked_at', null).in('org_id', real)
      const ids = [...new Set((grants ?? []).map((g) => g.user_id))]
      const { data: people } = ids.length ? await admin().from('profiles').select('id, role').in('id', ids) : { data: [] }
      expect((people ?? []).filter((p) => !['admin', 'platform_owner'].includes(p.role))).toEqual([])
    })
  })

  it('M-9: wifi.credentials.admin is given only by a super administrator', async () => {
    const v = await createUser(org, 'user')
    const change: AccessChange = { op: 'grant', capability: 'wifi.credentials.admin', scope_kind: 'organization', scope_id: null, valid_until: null, reason: 'Wi-Fi lead' }
    expect(await previewChange(admin(), plainA, v.id, { changes: [change], expectedVersion: 0 })).toEqual({ ok: false, error: 'Only a super administrator can give “Manage Wi-Fi passphrases and device credentials”.' })
    const sql = await admin().rpc('grant_access', { p_org: org, p_user: v.id, p_grants: [{ capability: 'wifi.credentials.admin', scope_kind: 'organization' }], p_actor: plain.id, p_reason: 'Wi-Fi lead' })
    expect(sql.error?.message).toMatch(/only a platform owner/)
  })

  describe('reviews', () => {
    it('M-10: keeping a migrated grant needs the right to give it', async () => {
      const m = await createUser(org, 'manager')
      await admin().rpc('access_migrate_legacy_test', { p_run: randomUUID(), p_users: [m.id] })
      const it = (await live(m.id)).find((g) => g.capability === 'it.inventory.view')!
      expect(await keepReviewed(admin(), plainA, { grantIds: [it.id] })).toEqual({ ok: false, error: 'You can only confirm access you could give yourself.' })
      const ok = (await live(m.id)).find((g) => g.capability === 'cctv.live')!
      expect(await keepReviewed(admin(), plainA, { grantIds: [ok.id] })).toEqual({ ok: true, kept: 1 })
    })

    it('M-11: the only super administrator may confirm their own migrated grants with a typed reason (break-glass), audited', async () => {
      const solo = await createOrg()
      try {
        // Migrated first (migrated:admin grants, waiting for review), then the rest of the full set.
        const only = await createUser(solo, 'platform_owner')
        await admin().rpc('access_migrate_legacy_test', { p_run: randomUUID(), p_users: [only.id] })
        await admin().rpc('grant_platform_owner_all', { p_org: solo, p_user: only.id })
        const actor = actorOf(only, solo, 'platform_owner')
        const review = await listReview(admin(), solo, actor)
        const mine = review.open.filter((i) => i.userId === only.id).map((i) => i.grantId)
        expect(mine.length).toBeGreaterThan(0)
        expect(review.selfConfirmAllowed).toBe(true)
        expect(await selfConfirmReview(admin(), actor, { grantIds: mine, reason: 'short' })).toMatchObject({ ok: false })
        expect(await selfConfirmReview(admin(), actor, { grantIds: mine, reason: 'Only super administrator of this organisation' })).toEqual({ ok: true, confirmed: mine.length })
        const after = await listReview(admin(), solo, actor)
        expect(after.open.filter((i) => i.userId === only.id)).toEqual([])
        expect(after.kept.find((i) => i.userId === only.id)?.reviewDecision).toBe('self_confirmed')
        const { data: audit } = await admin().from('admin_audit_log').select('action, detail').eq('org_id', solo).eq('action', 'access_review_self_confirmed')
        expect(audit?.[0]?.detail).toMatchObject({ count: mine.length, reason: 'Only super administrator of this organisation' })
        // With a second super administrator, break-glass is refused.
        await owners(solo, 1)
        expect((await listReview(admin(), solo, actor)).selfConfirmAllowed).toBe(false)
        expect(await selfConfirmReview(admin(), actor, { grantIds: mine, reason: 'Only super administrator of this organisation' })).toEqual({ ok: false, error: 'Another super administrator exists: they must review your access.' })
      } finally {
        await cleanupOrg(solo)
      }
    })
  })

  it('M-13: a catalogue capability that gains organisation scope goes to every active super administrator (probe rolled back)', async () => {
    const r = await admin().rpc('access_catalogue_probe_test', { p_org: org })
    expect(r.error).toBeNull()
    const out = r.data as { after_insert_without_org: string[]; after_update_to_org: string[] }
    expect(out.after_insert_without_org).toEqual([])
    expect(out.after_update_to_org).toContain(owner.id)
    expect(out.after_update_to_org).not.toContain(plain.id)
  })

  it('T-1 (D-L1): export is about files; playback descriptions no longer mention fast playback under export', async () => {
    const { data } = await admin().from('capabilities').select('key, description').in('key', ['cctv.export', 'cctv.playback'])
    const d = Object.fromEntries((data ?? []).map((c) => [c.key, c.description]))
    expect(d['cctv.export']).toBe('Export or download recordings as files')
    expect(d['cctv.export']).not.toMatch(/fast playback/i)
    expect(d['cctv.playback']).toMatch(/fast playback/i)
  })

  it('privileges of the new functions', async () => {
    const { data } = await admin().rpc('function_privileges')
    const by = new Map((data ?? []).map((f) => [f.name, f.grantees]))
    for (const n of ['change_person_role', 'set_person_active', 'access_review_self_confirm', 'access_teardown_test_org_people']) expect(by.get(n), n).toEqual(['service_role'])
    for (const n of ['profiles_keep_super_admin', 'access_merge_plan', 'access_check_people_admin']) expect(by.get(n), n).toEqual([])
    expect((await admin().rpc('privilege_violations')).data).toEqual([])
    expect(ORG_SCOPE.kind).toBe('organization')
  })
})
