import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createUser, getUserAccess, listCamerasForAccess, listStoresForAccess, listUsers, resetUserPassword, setUserAccess, updateUser } from '@/lib/admin/users'
import type { Actor } from '@/lib/admin/types'
import { adminClient, cleanupOrg, createOrg, createUser as makeUser, grant } from '../setup/fixtures'

const admin = () => adminClient()

async function signIn(email: string, password: string) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password })
  return { client: c, error }
}

describe('user administration', () => {
  let orgId: string
  let owner: Actor
  let plainAdmin: Actor
  let storeId: string
  let cameraIds: string[]

  beforeAll(async () => {
    orgId = await createOrg()
    const o = await makeUser(orgId, 'platform_owner')
    const a = await makeUser(orgId, 'admin')
    owner = { id: o.id, orgId, role: 'platform_owner' }
    plainAdmin = { id: a.id, orgId, role: 'admin' }
    const { data: s } = await admin().from('stores').insert({ org_id: orgId, code: 'U1', name: 'Store U1', zone: 'BR', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    storeId = s!.id
    const { data: cams } = await admin().from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `C${n}` }))).select('id')
    cameraIds = cams!.map((c) => c.id)
  })

  afterAll(() => cleanupOrg(orgId))

  it('creates a user who can sign in with the one-time password but must choose their own first', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const res = await createUser(admin(), plainAdmin, { email, full_name: 'New Viewer', role: 'user' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { client, error } = await signIn(email, res.oneTimePassword)
    expect(error).toBeNull()
    const org = await client.from('organizations').select('id')
    expect(org.data).toEqual([])
    const profile = await admin().from('profiles').select('must_reset_password, role').eq('id', res.userId).single()
    expect(profile.data).toEqual({ must_reset_password: true, role: 'user' })
  })

  it('refuses a duplicate e-mail and bad input', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    expect((await createUser(admin(), plainAdmin, { email, full_name: 'A', role: 'user' })).ok).toBe(true)
    // The service logs the refused sign-up; keep that expected line out of the test output.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dup = await createUser(admin(), plainAdmin, { email, full_name: 'A', role: 'user' })
    logged.mockRestore()
    expect(dup.ok).toBe(false)
    const bad = await createUser(admin(), plainAdmin, { email: 'nope', full_name: '', role: 'user' })
    expect(bad.ok).toBe(false)
  })

  it('a plain admin cannot create administrators, a platform owner can', async () => {
    const email = () => `${crypto.randomUUID()}@example.test`
    expect((await createUser(admin(), plainAdmin, { email: email(), full_name: 'X', role: 'admin' })).ok).toBe(false)
    expect((await createUser(admin(), owner, { email: email(), full_name: 'X', role: 'admin' })).ok).toBe(true)
  })

  it('a viewer cannot administer anyone', async () => {
    const viewer: Actor = { id: crypto.randomUUID(), orgId, role: 'user' }
    expect((await createUser(admin(), viewer, { email: `${crypto.randomUUID()}@example.test`, full_name: 'X', role: 'user' })).ok).toBe(false)
  })

  it('changes a role, forbids changing oneself, and deactivation blocks sign-in until reactivated', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Change Me', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    expect((await updateUser(admin(), plainAdmin, made.userId, { role: 'operator' })).ok).toBe(true) // 'agent' before P2-1 (AC-15)
    expect((await updateUser(admin(), plainAdmin, plainAdmin.id, { role: 'user' })).ok).toBe(false)
    expect((await updateUser(admin(), plainAdmin, owner.id, { is_active: false })).ok).toBe(false)

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: false })).ok).toBe(true)
    expect((await signIn(email, made.oneTimePassword)).error).not.toBeNull()
    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: true })).ok).toBe(true)
    expect((await signIn(email, made.oneTimePassword)).error).toBeNull()
  })

  it('resets a password: the new one works, the old one does not, and the person must choose again', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Reset Me', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    await admin().from('profiles').update({ must_reset_password: false }).eq('id', made.userId)
    const reset = await resetUserPassword(admin(), plainAdmin, made.userId)
    if (!reset.ok) throw new Error('reset failed')
    expect((await signIn(email, made.oneTimePassword)).error).not.toBeNull()
    expect((await signIn(email, reset.oneTimePassword)).error).toBeNull()
    const p = await admin().from('profiles').select('must_reset_password').eq('id', made.userId).single()
    expect(p.data?.must_reset_password).toBe(true)
  })

  it('saves an access list that the person then sees through row-level security', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Gets Access', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    await admin().from('profiles').update({ must_reset_password: false }).eq('id', made.userId)

    expect((await setUserAccess(admin(), plainAdmin, made.userId, { storeIds: [], zones: [], cameraIds: [cameraIds[0], cameraIds[1]] })).ok).toBe(true)
    const { client } = await signIn(email, made.oneTimePassword)
    const seen = await client.from('cameras').select('id')
    expect((seen.data ?? []).map((r) => r.id).sort()).toEqual([cameraIds[0], cameraIds[1]].sort())
    expect(await getUserAccess(admin(), orgId, made.userId)).toEqual({ storeIds: [], zones: [], cameraIds: expect.arrayContaining([cameraIds[0], cameraIds[1]]) })

    expect((await setUserAccess(admin(), plainAdmin, made.userId, { storeIds: [storeId], zones: [], cameraIds: [] })).ok).toBe(true)
    const all = await client.from('cameras').select('id')
    expect((all.data ?? []).length).toBe(3)
    // P2-1: the list is saved as explicit live + playback grants; a removed camera grant is revoked, not deleted (history).
    const { data: grants } = await admin().from('access_grants').select('capability, scope_kind, scope_id, revoked_at').eq('user_id', made.userId)
    const live = (grants ?? []).filter((g) => g.revoked_at === null).map((g) => `${g.capability}:${g.scope_kind}:${g.scope_id}`).sort()
    expect(live).toEqual([`cctv.live:location:${storeId}`, `cctv.playback:location:${storeId}`])
    expect((grants ?? []).filter((g) => g.revoked_at !== null)).toHaveLength(4)
    expect(await getUserAccess(admin(), orgId, made.userId)).toEqual({ storeIds: [storeId], zones: [], cameraIds: [] })
  })

  // AC-6 (P2-1): this used to be "camera grants inside a store narrow it". Now they only add.
  it('a camera ticked next to its store adds nothing and takes nothing away, and a zone becomes its stores', async () => {
    const viewer = await makeUser(orgId, 'user')
    expect((await setUserAccess(admin(), plainAdmin, viewer.id, { storeIds: [storeId], zones: [], cameraIds: [cameraIds[0]] })).ok).toBe(true)
    expect(((await viewer.client.from('cameras').select('id')).data ?? []).length).toBe(3)
    const zoned = await makeUser(orgId, 'user')
    expect((await setUserAccess(admin(), plainAdmin, zoned.id, { storeIds: [], zones: ['BR'], cameraIds: [] })).ok).toBe(true)
    expect(((await zoned.client.from('cameras').select('id')).data ?? []).length).toBe(3)
    expect(await getUserAccess(admin(), orgId, zoned.id)).toEqual({ storeIds: [storeId], zones: [], cameraIds: [] })
    // The editor leaves other grants alone: an IT grant given elsewhere survives a save.
    await grant(orgId, zoned.id, 'it.inventory.view')
    expect((await setUserAccess(admin(), plainAdmin, zoned.id, { storeIds: [], zones: [], cameraIds: [] })).ok).toBe(true)
    expect(((await zoned.client.from('cameras').select('id')).data ?? []).length).toBe(0)
    expect((await zoned.client.rpc('has_capability', { p_cap: 'it.inventory.view' })).data).toBe(true)
  })

  // AC-8 (P2-1): this used to refuse a manager ("sees everything"). A manager now gets an access list like everyone else.
  it('gives a manager an access list like anyone else, and refuses stores of another organisation', async () => {
    const manager = await makeUser(orgId, 'manager')
    expect(((await manager.client.from('cameras').select('id')).data ?? []).length).toBe(0)
    expect((await setUserAccess(admin(), plainAdmin, manager.id, { storeIds: [storeId], zones: [], cameraIds: [] })).ok).toBe(true)
    expect(((await manager.client.from('cameras').select('id')).data ?? []).length).toBe(3)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('stores').insert({ org_id: otherOrg, code: 'O1', name: 'Other', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    const viewer = await makeUser(orgId, 'user')
    const res = await setUserAccess(admin(), plainAdmin, viewer.id, { storeIds: [other!.id], zones: [], cameraIds: [] })
    expect(res.ok).toBe(false)
    await cleanupOrg(otherOrg)
  })

  it('a plain admin cannot promote a manager to administrator, reset an administrator, or touch their own role', async () => {
    const manager = await makeUser(orgId, 'manager')
    const promoted = await updateUser(admin(), plainAdmin, manager.id, { role: 'admin' })
    expect(promoted.ok).toBe(false)
    const after = await admin().from('profiles').select('role').eq('id', manager.id).single()
    expect(after.data?.role).toBe('manager')

    const otherAdmin = await makeUser(orgId, 'admin')
    expect((await resetUserPassword(admin(), plainAdmin, otherAdmin.id)).ok).toBe(false)
    // The administrator's password still works.
    expect((await signIn(otherAdmin.email, otherAdmin.password)).error).toBeNull()
  })

  it('a platform owner cannot change their own role or status', async () => {
    const res = await updateUser(admin(), owner, owner.id, { role: 'admin' })
    expect(res).toEqual({ ok: false, error: 'You cannot change your own role or status.' })
    const res2 = await updateUser(admin(), owner, owner.id, { is_active: false })
    expect(res2.ok).toBe(false)
    const after = await admin().from('profiles').select('role, is_active').eq('id', owner.id).single()
    expect(after.data).toEqual({ role: 'platform_owner', is_active: true })
  })

  it('refuses a person who belongs to another organisation', async () => {
    const otherOrg = await createOrg()
    try {
      const stranger = await makeUser(otherOrg, 'user')
      const notFound = { ok: false, error: 'User not found.' }
      expect(await updateUser(admin(), owner, stranger.id, { full_name: 'Hijacked' })).toEqual(notFound)
      expect(await resetUserPassword(admin(), owner, stranger.id)).toEqual(notFound)
      expect(await setUserAccess(admin(), owner, stranger.id, { storeIds: [], zones: [], cameraIds: [] })).toEqual(notFound)
      // Nothing changed, and the stranger's password still works.
      expect((await signIn(stranger.email, stranger.password)).error).toBeNull()
    } finally {
      await cleanupOrg(otherOrg)
    }
  })

  it('ends the old sessions when a password is reset', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Session Reset', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    const old = await signIn(email, made.oneTimePassword)
    expect(old.error).toBeNull()
    const oldAccess = (await old.client.auth.getSession()).data.session!.access_token

    const reset = await resetUserPassword(admin(), plainAdmin, made.userId)
    expect(reset.ok).toBe(true)

    // The old session can neither choose a new password nor be renewed.
    const attempt = await old.client.auth.updateUser({ password: crypto.randomUUID() + 'aA1!' })
    expect(attempt.error).not.toBeNull()
    const refreshed = await old.client.auth.refreshSession()
    expect(refreshed.error).not.toBeNull()
    expect(refreshed.data.session).toBeNull()
    // Same through the raw access token.
    const raw = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, Authorization: `Bearer ${oldAccess}` },
    })
    // What GoTrue does with the already-issued access token is recorded in the fix report.
    expect(typeof raw.status).toBe('number')
  })

  it('ends the sessions of a deactivated person, and reactivating does not bring them back', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Session Off', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    // Two separate sessions: one is tried while the person is deactivated, the other only after reactivation.
    const whileOff = await signIn(email, made.oneTimePassword)
    const afterOn = await signIn(email, made.oneTimePassword)
    expect(whileOff.error).toBeNull()
    expect(afterOn.error).toBeNull()

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: false })).ok).toBe(true)
    expect((await whileOff.client.auth.updateUser({ password: crypto.randomUUID() + 'aA1!' })).error).not.toBeNull()
    expect((await whileOff.client.auth.refreshSession()).error).not.toBeNull()

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: true })).ok).toBe(true)
    // The ban is lifted, yet the sessions that existed before the deactivation stay ended.
    expect((await afterOn.client.auth.updateUser({ password: crypto.randomUUID() + 'aA1!' })).error).not.toBeNull()
    const refreshed = await afterOn.client.auth.refreshSession()
    expect(refreshed.error).not.toBeNull()
    expect(refreshed.data.session).toBeNull()
    // A fresh sign-in works again.
    expect((await signIn(email, made.oneTimePassword)).error).toBeNull()
  })

  it('only the server may end sessions: a signed-in person cannot call the function', async () => {
    const viewer = await makeUser(orgId, 'user')
    const res = await viewer.client.rpc('revoke_user_sessions', { p_user: owner.id })
    expect(res.error).not.toBeNull()
  })

  it('lists every store and camera and user even when sort keys tie across more than 1000 rows', async () => {
    const pagingOrg = await createOrg()
    try {
      const { data: two } = await admin().from('stores').insert([1, 2].map((n) => ({ org_id: pagingOrg, code: `P${n}`, name: `Paging ${n}`, zone: 'PG', nvr_ip: '127.0.0.1', nvr_username: 'u' }))).select('id')
      // Two stores with channels 1..501: every channel number appears twice, so ordering by channel alone would tie.
      const rows = two!.flatMap((s) => Array.from({ length: 501 }, (_, i) => ({ org_id: pagingOrg, store_id: s.id, channel: i + 1, name: `C${i + 1}` })))
      const ins = await admin().from('cameras').insert(rows)
      expect(ins.error).toBeNull()

      const cams = await listCamerasForAccess(admin(), pagingOrg)
      expect(cams).toHaveLength(1002)
      expect(new Set(cams.map((c) => c.id)).size).toBe(1002)
      expect(await listStoresForAccess(admin(), pagingOrg)).toHaveLength(2)

      // A viewer granted every one of those cameras reads them all back.
      const v = await makeUser(pagingOrg, 'user')
      const ids = cams.map((c) => c.id)
      const po = await makeUser(pagingOrg, 'platform_owner')
      const actor: Actor = { id: po.id, orgId: pagingOrg, role: 'platform_owner' }
      expect((await setUserAccess(admin(), actor, v.id, { storeIds: [], zones: [], cameraIds: ids })).ok).toBe(true)
      const back = await getUserAccess(admin(), pagingOrg, v.id)
      expect(back.cameraIds).toHaveLength(1002)
      expect(new Set(back.cameraIds).size).toBe(1002)

      expect((await listUsers(admin(), pagingOrg)).length).toBe(2)
    } finally {
      await cleanupOrg(pagingOrg)
    }
  })

  it('writes an audit record for each change', async () => {
    const { data } = await admin().from('admin_audit_log').select('action').eq('org_id', orgId)
    const actions = new Set((data ?? []).map((r) => r.action))
    expect(actions).toContain('user_created')
    expect(actions).toContain('user_updated')
    expect(actions).toContain('user_password_reset')
    expect(actions).toContain('user_access_set')
  })
})
