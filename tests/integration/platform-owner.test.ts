// Owner ruling P-1 (docs/drishti/DECISIONS.md): a platform owner ("Super administrator") holds every catalogue capability for the
// organisation as explicit grants, now and for capabilities added later; safeguards around super administrators.
// Migration 20261021000016; services lib/admin/users.ts and lib/admin/access.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyChange, previewChange, revokeAll } from '@/lib/admin/access'
import type { Actor } from '@/lib/admin/types'
import { createUser as createPerson, resetUserPassword, updateUser } from '@/lib/admin/users'
import { CAPABILITIES } from '@/lib/auth/capabilities'
import { OWNER_ONLY_CAPABILITIES } from '@/lib/admin/access-rules'
import { adminClient, cleanupOrg, createOrg, createUser, grant } from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[]) => [...a].sort()
const ALL = sorted(CAPABILITIES)
const orgWideOf = async (userId: string) =>
  sorted(((await admin().from('access_grants').select('capability').eq('user_id', userId).eq('scope_kind', 'organization').is('revoked_at', null)).data ?? []).map((g) => g.capability))

describe('platform owner = super administrator with full rights (P-1)', () => {
  let org: string
  let owner: Actor
  let plain: Actor

  beforeAll(async () => {
    org = await createOrg()
    const o = await createUser(org, 'platform_owner')
    await grant(org, o.id, ['admin.users', 'admin.access'])
    owner = { id: o.id, orgId: org, role: 'platform_owner' }
    const a = await createUser(org, 'admin')
    await grant(org, a.id, ['admin.users', 'admin.access', 'cctv.live'])
    plain = { id: a.id, orgId: org, role: 'admin' }
  })
  afterAll(() => cleanupOrg(org))

  it('grant_platform_owner_all gives every capability for the organisation, once, and only to an active platform owner', async () => {
    const o = await createUser(org, 'platform_owner')
    const first = await admin().rpc('grant_platform_owner_all', { p_org: org, p_user: o.id })
    expect(first.error).toBeNull()
    expect(first.data).toBe(ALL.length)
    expect(await orgWideOf(o.id)).toEqual(ALL)
    expect((await admin().rpc('grant_platform_owner_all', { p_org: org, p_user: o.id })).data).toBe(0)
    const { data: one } = await admin().from('access_grants').select('reason, source').eq('user_id', o.id).eq('capability', 'it.os.deploy').is('revoked_at', null).single()
    expect(one).toEqual({ reason: 'Super administrator: all capabilities', source: 'manual' }) // review M-8 (was "Platform owner: …")
    const notOwner = await createUser(org, 'admin')
    expect((await admin().rpc('grant_platform_owner_all', { p_org: org, p_user: notOwner.id })).error?.code).toBe('42501')
  })

  it('a capability added to the catalogue later goes to every active platform owner at once (probe rolled back)', async () => {
    const active = await createUser(org, 'platform_owner')
    const inactive = await createUser(org, 'platform_owner')
    await admin().from('profiles').update({ is_active: false }).eq('id', inactive.id)
    const someAdmin = await createUser(org, 'admin')
    const probe = await admin().rpc('access_catalogue_probe_test', { p_org: org })
    expect(probe.error).toBeNull()
    const holders = (probe.data as { after_insert_with_org: string[] }).after_insert_with_org // review M-13: the probe also covers updates
    expect(holders).toContain(active.id)
    expect(holders).toContain(owner.id)
    expect(holders).not.toContain(inactive.id)
    expect(holders).not.toContain(someAdmin.id)
    // Nothing stays behind.
    expect((await admin().from('capabilities').select('key').eq('key', 'it.zz_catalogue_probe')).data).toEqual([])
    expect((await admin().from('access_grants').select('id').eq('capability', 'it.zz_catalogue_probe')).data).toEqual([])
    const other = await createOrg()
    try {
      expect((await admin().from('organizations').update({ slug: `real-${other}` }).eq('id', other)).error).toBeNull()
      expect((await admin().rpc('access_catalogue_probe_test', { p_org: other })).error?.code).toBe('42501')
    } finally {
      await cleanupOrg(other)
    }
  })

  it('promotion to platform owner and reactivation of a platform owner give the full set (what was revoked comes back)', async () => {
    const made = await createPerson(admin(), owner, { email: `${crypto.randomUUID()}@example.test`, full_name: 'Future Owner', role: 'admin' })
    if (!made.ok) throw new Error(made.error)
    expect(await orgWideOf(made.userId)).toEqual([])
    expect((await updateUser(admin(), owner, made.userId, { role: 'platform_owner' })).ok).toBe(true)
    expect(await orgWideOf(made.userId)).toEqual(ALL)
    const { data: g } = await admin().from('access_grants').select('id').eq('user_id', made.userId).eq('capability', 'cctv.export').is('revoked_at', null).single()
    const v = Number((await admin().from('profiles').select('access_version').eq('id', made.userId).single()).data!.access_version)
    expect((await revokeAll(admin(), owner, made.userId, { grantIds: [g!.id], reason: 'Temporary removal', expectedVersion: v })).ok).toBe(true)
    expect(await orgWideOf(made.userId)).not.toContain('cctv.export')
    expect((await updateUser(admin(), owner, made.userId, { is_active: false })).ok).toBe(true)
    expect((await updateUser(admin(), owner, made.userId, { is_active: true })).ok).toBe(true)
    expect(await orgWideOf(made.userId)).toEqual(ALL)
    // Review I-2 (was: "demotion keeps the grants"): demotion to administrator removes the rights only a super administrator may hold.
    expect((await updateUser(admin(), owner, made.userId, { role: 'admin' })).ok).toBe(true)
    expect(await orgWideOf(made.userId)).toEqual(ALL.filter((c) => !(OWNER_ONLY_CAPABILITIES as readonly string[]).includes(c)))
  })

  it('creating a platform owner on the people screen gives the full set', async () => {
    const made = await createPerson(admin(), owner, { email: `${crypto.randomUUID()}@example.test`, full_name: 'New Owner', role: 'platform_owner' })
    if (!made.ok) throw new Error(made.error)
    expect(await orgWideOf(made.userId)).toEqual(ALL)
  })

  it('only a super administrator manages super administrators; an administrator cannot revoke or narrow their grants', async () => {
    const o2 = await createUser(org, 'platform_owner')
    await admin().rpc('grant_platform_owner_all', { p_org: org, p_user: o2.id })
    const email = () => `${crypto.randomUUID()}@example.test`
    expect((await createPerson(admin(), plain, { email: email(), full_name: 'X', role: 'platform_owner' })).ok).toBe(false)
    expect((await updateUser(admin(), plain, o2.id, { is_active: false })).ok).toBe(false)
    expect((await updateUser(admin(), plain, o2.id, { role: 'admin' })).ok).toBe(false)
    expect((await resetUserPassword(admin(), plain, o2.id)).ok).toBe(false)
    const { data: g } = await admin().from('access_grants').select('id').eq('user_id', o2.id).eq('capability', 'cctv.live').is('revoked_at', null).single()
    const v = Number((await admin().from('profiles').select('access_version').eq('id', o2.id).single()).data!.access_version)
    const revoke = [{ op: 'revoke' as const, grant_id: g!.id, reason: 'Narrowing a super administrator' }]
    expect(await previewChange(admin(), plain, o2.id, { changes: revoke, expectedVersion: v })).toMatchObject({ ok: false, error: expect.stringMatching(/not allowed/) })
    expect((await applyChange(admin(), plain, o2.id, { changes: revoke, expectedVersion: v, token: 'x' })).ok).toBe(false)
    const sqlTry = await admin().rpc('apply_access_change', { p_org: org, p_user: o2.id, p_changes: revoke, p_actor: plain.id, p_expected_version: v })
    expect(sqlTry.error?.code).toBe('42501')
    expect(await orgWideOf(o2.id)).toEqual(ALL)
  })

  it('there is always at least one active super administrator', async () => {
    const solo = await createOrg()
    try {
      const a = await createUser(solo, 'platform_owner')
      const b = await createUser(solo, 'platform_owner')
      const actorA: Actor = { id: a.id, orgId: solo, role: 'platform_owner' }
      // A is the actor but is no longer active in the database (for example deactivated a moment ago): B is the last active one.
      await admin().from('profiles').update({ is_active: false }).eq('id', a.id)
      const msg = 'There must always be at least one active super administrator.'
      expect(await updateUser(admin(), actorA, b.id, { is_active: false })).toEqual({ ok: false, error: msg })
      expect(await updateUser(admin(), actorA, b.id, { role: 'admin' })).toEqual({ ok: false, error: msg })
      expect((await admin().from('profiles').select('is_active, role').eq('id', b.id).single()).data).toEqual({ is_active: true, role: 'platform_owner' })
    } finally {
      await cleanupOrg(solo)
    }
  })
})
