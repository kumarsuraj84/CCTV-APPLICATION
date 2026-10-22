import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, atLocation, cleanupOrg, createOrg, createUser, grant, type TestUser } from '../setup/fixtures'

// P2-3 review M-14: the real access and user Server Actions with the signed-in person's own JWT. Only the Next request plumbing is
// replaced (no forwarded id, so the session is checked with GoTrue; the cookie client is the test user's own client). Nothing else is
// mocked: requireAdministration reads my_access_summary as the person, the service is the real one.

const m = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.client as SupabaseClient<Database> }))

const admin = () => adminClient()
const redirected = (e: unknown) => String((e as { digest?: string })?.digest ?? e).includes('NEXT_REDIRECT')

describe('access entry points with a real JWT (P2-3 fix round 1)', () => {
  let org: string
  let store: string
  let managerWithAccess: TestUser, plainAdmin: TestUser, target: TestUser

  beforeAll(async () => {
    org = await createOrg()
    store = (await admin().from('locations').insert({ org_id: org, code: 'EP1', name: 'EP1', nvr_ip: '192.0.2.1', nvr_username: 'v' }).select('id').single()).data!.id
    managerWithAccess = await createUser(org, 'manager')
    await grant(org, managerWithAccess.id, ['admin.access', 'admin.users', 'cctv.live'])
    plainAdmin = await createUser(org, 'admin')
    await grant(org, plainAdmin.id, ['admin.access', 'admin.users', 'cctv.live'])
    target = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  it('a manager holding admin.access cannot use any access or user action (the administrative role is required); nothing changes', async () => {
    m.client = managerWithAccess.client
    const access = await import('@/lib/actions/admin/access')
    const users = await import('@/lib/actions/admin/users')
    const change = [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: store, valid_until: null, reason: '' }]
    const calls: (() => Promise<unknown>)[] = [
      () => access.previewAccessAction(target.id, { changes: change, expectedVersion: 0 }),
      () => access.applyAccessAction(target.id, { changes: change, expectedVersion: 0, token: 'x' }),
      () => access.keepReviewedAction({ grantIds: [] }),
      () => users.setRoleAction(target.id, 'operator'),
      () => users.reactivationReviewAction(target.id),
    ]
    for (const call of calls) {
      let error: unknown = null
      try {
        await call()
      } catch (e) {
        error = e
      }
      expect(redirected(error)).toBe(true)
    }
    expect((await admin().from('access_grants').select('id').eq('user_id', target.id)).data).toEqual([])
    expect((await admin().from('profiles').select('role').eq('id', target.id).single()).data?.role).toBe('user')
  })

  it('a plain administrator cannot promote anyone to super administrator through the action', async () => {
    m.client = plainAdmin.client
    const users = await import('@/lib/actions/admin/users')
    expect(await users.setRoleAction(target.id, 'platform_owner')).toEqual({ error: 'You are not allowed to give that role.' })
    expect((await admin().from('profiles').select('role').eq('id', target.id).single()).data?.role).toBe('user')
  })

  it('a plain administrator previews and saves a grant they hold, through the real actions', async () => {
    m.client = plainAdmin.client
    const access = await import('@/lib/actions/admin/access')
    const change = [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: store, valid_until: null, reason: '' }]
    const p = await access.previewAccessAction(target.id, { changes: change, expectedVersion: 0 })
    if (!p.ok) throw new Error(p.error)
    expect(await access.applyAccessAction(target.id, { changes: change, expectedVersion: p.version, token: p.token })).toMatchObject({ ok: true, added: 1 })
    expect((await target.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: store })).data).toBe(true)
    expect(atLocation(store).kind).toBe('location')
  })
})
