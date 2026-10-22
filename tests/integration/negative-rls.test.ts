import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

describe('row security: negative cases', () => {
  let orgId: string
  let operator: TestUser
  let manager: TestUser
  let admin: TestUser
  let deactivated: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = adminClient()
    const { data: s } = await a.from('stores').insert({ org_id: orgId, code: 'NEG', name: 'Neg', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    await a.from('cameras').insert({ org_id: orgId, store_id: s!.id, channel: 1, name: 'C1' })
    await a.from('devices').insert({ org_id: orgId, store_id: s!.id, type: 'server', name: 'D1', ip: '127.0.0.1', tcp_port: 1 })
    operator = await createUser(orgId, 'operator')
    manager = await createUser(orgId, 'manager')
    admin = await createUser(orgId, 'admin')
    deactivated = await createUser(orgId, 'admin')
    await grant(orgId, deactivated.id, READ_EVERYTHING)
    await a.from('profiles').update({ is_active: false }).eq('id', deactivated.id)
  })
  afterAll(() => cleanupOrg(orgId))

  // AC-8 (P2-1): this used to say "only managers and above see everything". No role gives data access by itself any more.
  it('no role sees any store, camera, device or status without grants: operator, manager and administrator alike', async () => {
    for (const u of [operator, manager, admin]) {
      for (const t of ['stores', 'cameras', 'devices', 'check_state', 'outages', 'camera_groups', 'store_status'] as const) {
        const res = await u.client.from(t as 'stores').select('org_id')
        expect(res.error, t).toBeNull()
        expect(res.data, t).toEqual([])
      }
    }
  })

  it('a deactivated admin whose token is still valid sees no organisation data and only their own profile row, grants or not', async () => {
    expect((await deactivated.client.from('stores').select('id')).data).toEqual([])
    expect((await deactivated.client.from('cameras').select('id')).data).toEqual([])
    expect((await deactivated.client.from('devices').select('id')).data).toEqual([])
    expect((await deactivated.client.from('organizations').select('id')).data).toEqual([])
    expect((await deactivated.client.from('profiles').select('id')).data).toEqual([{ id: deactivated.id }])
    expect((await deactivated.client.from('access_grants').select('id')).data).toEqual([])
    expect((await deactivated.client.rpc('has_capability', { p_cap: 'cctv.live' })).data).toBe(false)
  })

  it('anonymous callers are refused on every inventory and access table', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const columns = {
      stores: 'id', cameras: 'id', devices: 'id', profiles: 'id', organizations: 'id', user_store_access: 'user_id',
      access_grants: 'id', capabilities: 'key', access_migration_report: 'id', store_nvr_endpoints: 'store_id', camera_endpoints: 'camera_id',
    } as const
    for (const [table, column] of Object.entries(columns)) {
      const res = await anon.from(table as keyof typeof columns).select(column).limit(1)
      expect(res.error?.code, table).toBe('42501')
    }
  })

  it('anonymous and signed-in callers cannot call the server-only functions', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const calls: [keyof Database['public']['Functions'], object][] = [
      ['grant_access', { p_org: orgId, p_user: operator.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'organization' }] }],
      ['replace_user_grants', { p_org: orgId, p_user: operator.id, p_capabilities: ['cctv.live'], p_scope_kinds: ['organization'], p_grants: [{ capability: 'cctv.live', scope_kind: 'organization' }] }],
      ['revoke_grant', { p_org: orgId, p_user: operator.id, p_grant_ids: [] }],
      ['preview_access_change', { p_user: operator.id, p_changes: [] }],
      ['nvr_store_credential', { p_store: crypto.randomUUID(), p_secret: 'x' }],
      ['revoke_user_sessions', { p_user: crypto.randomUUID() }],
    ]
    for (const [fn, args] of calls) {
      expect((await anon.rpc(fn, args as never)).error?.code, `anon ${fn}`).toBe('42501')
      expect((await operator.client.rpc(fn, args as never)).error?.code, `operator ${fn}`).toBe('42501')
      expect((await admin.client.rpc(fn, args as never)).error?.code, `admin ${fn}`).toBe('42501')
    }
    // Nothing was granted on the way.
    expect((await operator.client.rpc('has_capability', { p_cap: 'cctv.live' })).data).toBe(false)
  })
})
