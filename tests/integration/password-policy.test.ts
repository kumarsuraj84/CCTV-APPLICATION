import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

// The auth service itself must enforce the password policy, because a signed-in person can call it directly.
describe('auth service password policy', () => {
  let orgId: string
  let person: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    person = await createUser(orgId, 'user')
  })

  afterAll(() => cleanupOrg(orgId))

  it('rejects a short password', async () => {
    const { error } = await person.client.auth.updateUser({ password: 'Ab1xyz' })
    expect(error).not.toBeNull()
  })

  it('rejects a long password with no digit', async () => {
    const { error } = await person.client.auth.updateUser({ password: 'abcdefghijklmnop' })
    expect(error).not.toBeNull()
  })

  it('accepts a long password with letters and digits', async () => {
    const { error } = await person.client.auth.updateUser({ password: `Zk${'q'.repeat(10)}7${'m'.repeat(2)}` })
    expect(error).toBeNull()
  })
})
