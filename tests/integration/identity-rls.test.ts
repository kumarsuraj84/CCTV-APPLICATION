import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupOrg, createOrg, createUser, grant, type TestUser } from '../setup/fixtures'

describe('identity row-level security', () => {
  let orgA: string
  let orgB: string
  let adminA: TestUser
  let viewerA: TestUser
  let resetA: TestUser
  let adminB: TestUser

  beforeAll(async () => {
    orgA = await createOrg()
    orgB = await createOrg()
    adminA = await createUser(orgA, 'admin')
    viewerA = await createUser(orgA, 'user')
    resetA = await createUser(orgA, 'user', { mustReset: true })
    adminB = await createUser(orgB, 'admin')
  })

  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('a user sees only their own organisation', async () => {
    const { data } = await viewerA.client.from('organizations').select('id')
    expect(data).toEqual([{ id: orgA }])
  })

  it('a viewer reads only their own profile', async () => {
    const { data } = await viewerA.client.from('profiles').select('id')
    expect(data).toEqual([{ id: viewerA.id }])
  })

  // P2-2 fix M-2: the organisation-wide read comes from admin.users (organisation scope), never from the role alone.
  it('an admin with admin.users reads every profile of their organisation and none of another; without it only their own', async () => {
    expect((await adminA.client.from('profiles').select('id')).data).toEqual([{ id: adminA.id }])
    await grant(orgA, adminA.id, 'admin.users')
    const { data } = await adminA.client.from('profiles').select('id')
    const ids = (data ?? []).map((r) => r.id).sort()
    expect(ids).toEqual([adminA.id, viewerA.id, resetA.id].sort())
    expect(ids).not.toContain(adminB.id)
  })

  it('a person who must reset the password has no organisation or role, but can read their own profile', async () => {
    const orgs = await resetA.client.from('organizations').select('id')
    expect(orgs.data).toEqual([])
    const role = await resetA.client.rpc('current_user_role')
    expect(role.data).toBeNull()
    const me = await resetA.client.from('profiles').select('id, must_reset_password')
    expect(me.data).toEqual([{ id: resetA.id, must_reset_password: true }])
  })

  it('signed-in users cannot change profiles', async () => {
    const upd = await viewerA.client.from('profiles').update({ role: 'admin' }).eq('id', viewerA.id)
    expect(upd.error?.code).toBe('42501')
    const ins = await adminA.client.from('profiles').insert({ id: crypto.randomUUID(), org_id: orgA, email: 'x@example.test' })
    expect(ins.error?.code).toBe('42501')
  })
})
