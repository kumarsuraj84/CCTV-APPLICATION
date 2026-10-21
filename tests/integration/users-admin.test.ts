import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createUser, getUserAccess, resetUserPassword, setUserAccess, updateUser, type Actor } from '@/lib/admin/users'
import { adminClient, cleanupOrg, createOrg, createUser as makeUser } from '../setup/fixtures'

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
    expect((await updateUser(admin(), plainAdmin, made.userId, { role: 'agent' })).ok).toBe(true)
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
  })

  it('refuses an access list for a role that sees everything, and for stores of another organisation', async () => {
    const manager = await makeUser(orgId, 'manager')
    expect((await setUserAccess(admin(), plainAdmin, manager.id, { storeIds: [storeId], zones: [], cameraIds: [] })).ok).toBe(false)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('stores').insert({ org_id: otherOrg, code: 'O1', name: 'Other', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    const viewer = await makeUser(orgId, 'user')
    const res = await setUserAccess(admin(), plainAdmin, viewer.id, { storeIds: [other!.id], zones: [], cameraIds: [] })
    expect(res.ok).toBe(false)
    await cleanupOrg(otherOrg)
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
