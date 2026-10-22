// P2-3 database layer (migration 20261021000015_access_admin): who may grant what, the one-transaction change, the review record and the
// per-person summary. The rules are documented in docs/drishti/access-model.md "Who may grant what". Every call here is the service role
// (as the Server Action makes it) with an acting person; the person's own client is used only to prove what they then see.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, atCamera, atLocation, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
type Res = { data: unknown; error: { code?: string; message: string } | null }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args: Record<string, unknown>): Promise<Res> => (admin().rpc as any)(fn, args)
const ADMIN_SET = ['admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read']
const day = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

async function addStore(orgId: string, code: string): Promise<string> {
  const { data, error } = await admin().from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '192.0.2.10', nvr_username: 'viewer' }).select('id').single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}
async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, store_id: storeId, channel, name: `Camera ${channel}` }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}
async function liveGrants(userId: string) {
  const { data } = await admin().from('access_grants').select('id, capability, scope_kind, scope_id, valid_until, reason, granted_by').eq('user_id', userId).is('revoked_at', null).order('capability')
  return data ?? []
}
async function version(userId: string): Promise<number> {
  return Number((await admin().from('profiles').select('access_version').eq('id', userId).single()).data!.access_version)
}

describe('access administration in the database (P2-3)', () => {
  let org: string
  let L1: string, L2: string, c11: string, c12: string, c21: string
  let owner: TestUser, adm: TestUser, admNoAccess: TestUser, viewer: TestUser, otherAdmin: TestUser

  beforeAll(async () => {
    org = await createOrg()
    L1 = await addStore(org, 'D1')
    L2 = await addStore(org, 'D2')
    c11 = await addCamera(org, L1, 1)
    c12 = await addCamera(org, L1, 2)
    c21 = await addCamera(org, L2, 1)
    owner = await createUser(org, 'platform_owner')
    adm = await createUser(org, 'admin')
    admNoAccess = await createUser(org, 'admin')
    otherAdmin = await createUser(org, 'admin')
    viewer = await createUser(org, 'user')
    await grant(org, owner.id, ADMIN_SET)
    await grant(org, adm.id, ADMIN_SET)
    // The administrator holds live video for D1 only, and playback for D1 only until a date.
    await grant(org, adm.id, 'cctv.live', atLocation(L1))
    await grant(org, adm.id, 'cctv.playback', atLocation(L1), { validUntil: iso(Date.now() + 10 * day) })
    await grant(org, admNoAccess.id, ['admin.users', 'cctv.live'])
  })
  afterAll(() => cleanupOrg(org))

  const spec = (capability: string, kind: string, id: string | null, extra: Record<string, unknown> = {}) => ({ capability, scope_kind: kind, scope_id: id, ...extra })
  const grantAs = (actor: TestUser, user: TestUser, grants: unknown[], reason = 'Needed for the store team') =>
    rpc('grant_access', { p_org: org, p_user: user.id, p_grants: grants, p_actor: actor.id, p_reason: reason })

  describe('who may grant what', () => {
    it('an administrator gives what they hold, at an equal or narrower scope', async () => {
      const v = await createUser(org, 'user')
      expect((await grantAs(adm, v, [spec('cctv.live', 'location', L1)])).error).toBeNull()
      expect((await grantAs(adm, v, [spec('cctv.live', 'camera', c12)])).error).toBeNull()
      const live = await liveGrants(v.id)
      expect(live.map((g) => `${g.scope_kind}:${g.scope_id}`).sort()).toEqual([`camera:${c12}`, `location:${L1}`].sort())
      expect(live.every((g) => g.granted_by === adm.id)).toBe(true)
    })

    it('an administrator cannot give a location, a camera or a right they do not hold', async () => {
      const v = await createUser(org, 'user')
      for (const s of [spec('cctv.live', 'location', L2), spec('cctv.live', 'camera', c21), spec('cctv.live', 'organization', null), spec('it.inventory.view', 'organization', null)]) {
        const r = await grantAs(adm, v, [s])
        expect(r.error?.code, JSON.stringify(s)).toBe('42501')
        expect(r.error?.message).toMatch(/not held by the acting person/)
      }
      expect(await liveGrants(v.id)).toEqual([])
    })

    it('an administrator cannot give longer than they hold it themselves', async () => {
      const v = await createUser(org, 'user')
      const open = await grantAs(adm, v, [spec('cctv.playback', 'location', L1)])
      expect(open.error?.code).toBe('42501')
      const longer = await grantAs(adm, v, [spec('cctv.playback', 'location', L1, { valid_until: iso(Date.now() + 20 * day) })])
      expect(longer.error?.code).toBe('42501')
      const inside = await grantAs(adm, v, [spec('cctv.playback', 'camera', c11, { valid_until: iso(Date.now() + 5 * day) })])
      expect(inside.error).toBeNull()
    })

    it('an administrator without admin.access for the organisation changes nothing', async () => {
      const v = await createUser(org, 'user')
      const r = await grantAs(admNoAccess, v, [spec('cctv.live', 'location', L1)])
      expect(r.error?.code).toBe('42501')
      expect(r.error?.message).toMatch(/admin\.access/)
      expect((await rpc('revoke_grant', { p_org: org, p_user: viewer.id, p_grant_ids: [], p_actor: admNoAccess.id })).error?.code).toBe('42501')
    })

    it('nobody changes their own access, and a plain administrator cannot change an administrator', async () => {
      expect((await grantAs(adm, adm, [spec('cctv.live', 'camera', c11)])).error?.message).toMatch(/own access/)
      expect((await grantAs(owner, owner, [spec('cctv.live', 'camera', c11)])).error?.message).toMatch(/own access/)
      expect((await grantAs(adm, otherAdmin, [spec('cctv.live', 'camera', c11)])).error?.message).toMatch(/may not manage this person/)
    })

    it('a platform owner gives anything, but a reason is required for export and high-risk rights', async () => {
      const v = await createUser(org, 'operator')
      expect((await grantAs(owner, v, [spec('cctv.export', 'location', L2)], '')).error?.message).toMatch(/reason required/)
      expect((await grantAs(owner, v, [spec('it.os.deploy', 'organization', null)], '  ')).error?.message).toMatch(/reason required/)
      expect((await grantAs(owner, v, [spec('cctv.export', 'location', L2), spec('it.os.deploy', 'organization', null)], 'Regional IT lead')).error).toBeNull()
      expect((await grantAs(owner, v, [spec('cctv.live', 'location', L2)], '')).error).toBeNull() // low risk: no reason needed
    })

    it('the seven high-risk IT rights are for a platform owner to give, even to an administrator who holds them', async () => {
      const lead = await createUser(org, 'admin')
      await grant(org, lead.id, [...ADMIN_SET, 'it.remote.control', 'it.remote.view'])
      const v = await createUser(org, 'user')
      const r = await grantAs(lead, v, [spec('it.remote.control', 'organization', null)])
      expect(r.error?.code).toBe('42501')
      expect(r.error?.message).toMatch(/only a platform owner/)
      // it.remote.view is high risk too, but not one of the seven: an administrator who holds it may give it (with a reason).
      expect((await grantAs(lead, v, [spec('it.remote.view', 'organization', null)])).error).toBeNull()
    })

    it('administration rights go only to administrators, also from a platform owner', async () => {
      const m = await createUser(org, 'manager')
      expect((await grantAs(owner, m, [spec('admin.users', 'organization', null)])).error?.message).toMatch(/administration rights only for administrators/)
      const a = await createUser(org, 'admin')
      expect((await grantAs(owner, a, ADMIN_SET.map((c) => spec(c, 'organization', null)))).error).toBeNull()
    })

    it('grants made by the server itself (no acting person: scripts and fixtures) are not affected', async () => {
      const v = await createUser(org, 'user')
      expect((await rpc('grant_access', { p_org: org, p_user: v.id, p_grants: [spec('cctv.live', 'organization', null)] })).error).toBeNull()
    })
  })

  describe('apply_access_change', () => {
    it('revokes and grants in one transaction with a reason per change, and bumps the version once', async () => {
      const v = await createUser(org, 'user')
      const [old] = await grant(org, v.id, 'cctv.live', ORG_SCOPE)
      const before = await version(v.id)
      const r = await rpc('apply_access_change', {
        p_org: org, p_user: v.id, p_actor: owner.id, p_expected_version: before,
        p_changes: [
          { op: 'revoke', grant_id: old, reason: 'Narrowed to D1' },
          { op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L1, reason: 'Store team D1' },
          { op: 'grant', capability: 'cctv.export', scope_kind: 'camera', scope_id: c11, valid_until: iso(Date.now() + 3 * day), reason: 'Incident 42' },
        ],
      })
      expect(r.error).toBeNull()
      expect(r.data).toMatchObject({ added: 2, revoked: 1, version: before + 1 })
      expect((r.data as { grant_ids: string[] }).grant_ids).toHaveLength(2)
      const live = await liveGrants(v.id)
      expect(live.map((g) => `${g.capability}:${g.scope_kind}:${g.reason}`).sort()).toEqual(['cctv.export:camera:Incident 42', 'cctv.live:location:Store team D1'])
      const { data: gone } = await admin().from('access_grants').select('revoked_by, revoke_reason').eq('id', old).single()
      expect(gone).toEqual({ revoked_by: owner.id, revoke_reason: 'Narrowed to D1' })
    })

    it('refuses a stale expected version and changes nothing', async () => {
      const v = await createUser(org, 'user')
      const [g] = await grant(org, v.id, 'cctv.live', atLocation(L1))
      const stale = (await version(v.id)) - 1
      const r = await rpc('apply_access_change', { p_org: org, p_user: v.id, p_actor: owner.id, p_expected_version: stale, p_changes: [{ op: 'revoke', grant_id: g, reason: 'x x x' }] })
      expect(r.error?.code).toBe('40001')
      expect((await liveGrants(v.id)).map((x) => x.id)).toEqual([g])
    })

    it('is all or nothing: a refused grant keeps the revocations of the same change from happening', async () => {
      const v = await createUser(org, 'user')
      const [g] = await grant(org, v.id, 'cctv.live', atLocation(L1))
      const r = await rpc('apply_access_change', {
        p_org: org, p_user: v.id, p_actor: adm.id, p_expected_version: await version(v.id),
        p_changes: [{ op: 'revoke', grant_id: g, reason: 'Moving to D2' }, { op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L2, reason: 'D2' }],
      })
      expect(r.error?.code).toBe('42501')
      expect((await liveGrants(v.id)).map((x) => x.id)).toEqual([g])
    })

    it('a revocation needs a reason and must be one of the person’s live grants', async () => {
      const v = await createUser(org, 'user')
      const [g] = await grant(org, v.id, 'cctv.live', atLocation(L1))
      const [foreign] = await grant(org, viewer.id, 'cctv.live', atCamera(c21))
      const base = { p_org: org, p_user: v.id, p_actor: owner.id }
      expect((await rpc('apply_access_change', { ...base, p_changes: [{ op: 'revoke', grant_id: g, reason: '' }] })).error?.message).toMatch(/reason required/)
      expect((await rpc('apply_access_change', { ...base, p_changes: [{ op: 'revoke', grant_id: foreign, reason: 'Not theirs' }] })).error?.code).toBe('P0002')
      expect((await rpc('apply_access_change', { ...base, p_changes: [{ op: 'rename', grant_id: g }] })).error?.code).toBe('22023')
      expect((await rpc('apply_access_change', { ...base, p_actor: null, p_changes: [] })).error?.code).toBe('22023')
    })
  })

  describe('review of migrated grants', () => {
    it('keeping a migrated grant records who confirmed it, once; only reviewable live grants of other people', async () => {
      const m = await createUser(org, 'manager')
      const run = await rpc('access_migrate_legacy_test', { p_run: randomUUID(), p_users: [m.id] })
      expect(run.error).toBeNull()
      const migrated = await liveGrants(m.id)
      expect(migrated).toHaveLength(4)
      const ids = migrated.map((g) => g.id)
      const kept = await rpc('access_review_keep', { p_org: org, p_actor: owner.id, p_grant_ids: ids, p_note: 'Area manager, confirmed' })
      expect(kept.error).toBeNull()
      expect(kept.data).toBe(4)
      expect((await rpc('access_review_keep', { p_org: org, p_actor: owner.id, p_grant_ids: ids, p_note: null })).data).toBe(0) // already kept
      const { data: rowsBack } = await admin().from('access_grant_reviews').select('grant_id, reviewed_by, decision, note').eq('org_id', org)
      const mineBack = (rowsBack ?? []).filter((r) => ids.includes(r.grant_id))
      expect(mineBack).toHaveLength(4)
      for (const r of mineBack) expect(r).toMatchObject({ reviewed_by: owner.id, decision: 'kept', note: 'Area manager, confirmed' })
      // A manual grant is not a review item; one's own grants cannot be confirmed by oneself.
      const [manual] = await grant(org, viewer.id, 'cctv.live', atCamera(c12))
      expect((await rpc('access_review_keep', { p_org: org, p_actor: owner.id, p_grant_ids: [manual], p_note: null })).error?.code).toBe('P0002')
      const self = await createUser(org, 'admin')
      await grant(org, self.id, ADMIN_SET)
      await rpc('access_migrate_legacy_test', { p_run: randomUUID(), p_users: [self.id] })
      const own = (await liveGrants(self.id)).map((g) => g.id)
      expect((await rpc('access_review_keep', { p_org: org, p_actor: self.id, p_grant_ids: own, p_note: null })).error?.message).toMatch(/own access/)
    })

    it('signed-in people cannot read review records or call any of the new functions', async () => {
      const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
      for (const c of [viewer.client, owner.client, anon]) {
        expect((await c.from('access_grant_reviews').select('id')).error?.code).toBe('42501')
        for (const [fn, args] of [
          ['apply_access_change', { p_org: org, p_user: viewer.id, p_changes: [], p_actor: owner.id }],
          ['access_review_keep', { p_org: org, p_actor: owner.id, p_grant_ids: [], p_note: null }],
          ['access_grant_summary', { p_org: org }],
        ] as const) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expect(((await (c.rpc as any)(fn, args)) as Res).error?.code, fn).toBe('42501')
        }
      }
    })
  })

  it('access_grant_summary counts what is in effect now, per person and capability', async () => {
    const v = await createUser(org, 'user')
    await grant(org, v.id, 'cctv.live', [atLocation(L1), atLocation(L2), atCamera(c11)])
    await grant(org, v.id, 'cctv.playback', ORG_SCOPE, { validUntil: iso(Date.now() + 2 * day) })
    await grant(org, v.id, 'cctv.export', atCamera(c11), { validFrom: iso(Date.now() + day) }) // not started: not counted
    const r = await rpc('access_grant_summary', { p_org: org })
    expect(r.error).toBeNull()
    const mine = (r.data as { user_id: string; capability: string }[]).filter((x) => x.user_id === v.id)
    expect(mine.map((x) => x.capability).sort()).toEqual(['cctv.live', 'cctv.playback'])
    expect(mine.find((x) => x.capability === 'cctv.live')).toMatchObject({ organization_wide: false, locations: 2, cameras: 1, assets: 0, next_expiry: null })
    expect(mine.find((x) => x.capability === 'cctv.playback')).toMatchObject({ organization_wide: true, locations: 0 })
    expect((mine.find((x) => x.capability === 'cctv.playback') as unknown as { next_expiry: string }).next_expiry).not.toBeNull()
  })

  it('privileges: the new functions are for the server only, the table is closed, privilege_violations stays empty', async () => {
    const { data } = await admin().rpc('function_privileges')
    const byName = new Map((data ?? []).map((f) => [f.name, f]))
    for (const name of ['apply_access_change', 'access_review_keep', 'access_grant_summary']) {
      expect(byName.get(name)?.grantees, name).toEqual(['service_role'])
      expect(byName.get(name)?.search_path, name).toBe('')
    }
    for (const name of ['access_check_manager', 'access_check_grantor']) expect(byName.get(name)?.grantees, name).toEqual([])
    expect((await admin().rpc('privilege_violations')).data).toEqual([])
  })
})
