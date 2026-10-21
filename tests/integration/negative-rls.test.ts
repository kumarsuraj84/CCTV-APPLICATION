import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

describe('row security: negative cases', () => {
  let orgId: string
  let agent: TestUser
  let deactivated: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = adminClient()
    const { data: s } = await a.from('stores').insert({ org_id: orgId, code: 'NEG', name: 'Neg', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    await a.from('cameras').insert({ org_id: orgId, store_id: s!.id, channel: 1, name: 'C1' })
    agent = await createUser(orgId, 'agent')
    deactivated = await createUser(orgId, 'admin')
    await a.from('profiles').update({ is_active: false }).eq('id', deactivated.id)
  })
  afterAll(() => cleanupOrg(orgId))

  it('an operator with no grants sees nothing, only managers and above see everything', async () => {
    expect((await agent.client.from('stores').select('id')).data).toEqual([])
    expect((await agent.client.from('cameras').select('id')).data).toEqual([])
  })

  it('a deactivated admin whose token is still valid sees no organisation data and only their own profile row', async () => {
    expect((await deactivated.client.from('stores').select('id')).data).toEqual([])
    expect((await deactivated.client.from('organizations').select('id')).data).toEqual([])
    expect((await deactivated.client.from('profiles').select('id')).data).toEqual([{ id: deactivated.id }])
  })

  it('anonymous callers are refused on every inventory table', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const columns = { stores: 'id', cameras: 'id', devices: 'id', profiles: 'id', organizations: 'id', user_store_access: 'user_id' } as const
    for (const [table, column] of Object.entries(columns)) {
      const res = await anon.from(table as keyof typeof columns).select(column).limit(1)
      expect(res.error?.code, table).toBe('42501')
    }
  })

  it('anonymous and signed-in callers cannot call the server-only functions', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const calls: [keyof Database['public']['Functions'], object][] = [
      ['replace_user_access', { p_user: crypto.randomUUID(), p_stores: [], p_zones: [], p_cameras: [] }],
      ['nvr_store_credential', { p_store: crypto.randomUUID(), p_secret: 'x' }],
      ['revoke_user_sessions', { p_user: crypto.randomUUID() }],
    ]
    for (const [fn, args] of calls) {
      expect((await anon.rpc(fn, args as never)).error?.code, `anon ${fn}`).toBe('42501')
      expect((await agent.client.rpc(fn, args as never)).error?.code, `agent ${fn}`).toBe('42501')
    }
  })
})
