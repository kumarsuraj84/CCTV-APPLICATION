import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

describe('row security: negative cases', () => {
  let orgId: string
  let operator: TestUser
  let manager: TestUser
  let admin: TestUser
  let deactivated: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const a = adminClient()
    const s = { id: (await createSite(orgId, { code: 'NEG', name: 'Neg', host: '127.0.0.1', username: 'u' })).locationId }
    await a.from('cameras').insert({ org_id: orgId, location_id: s.id, channel: 1, name: 'C1' })
    await a.from('assets').insert({ org_id: orgId, location_id: s.id, type: 'server', name: 'D1', ip: '127.0.0.1', tcp_port: 1 })
    // P2-5a: a region and a cluster above the location, so the hierarchy tables have rows that must stay invisible too.
    const r = (await a.from('regions').insert({ org_id: orgId, code: 'NEGR', name: 'Neg region' }).select('id').single()).data!.id
    const c = (await a.from('clusters').insert({ org_id: orgId, region_id: r, code: 'NEGC', name: 'Neg cluster' }).select('id').single()).data!.id
    await a.from('locations').update({ cluster_id: c }).eq('id', s!.id)
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
      for (const t of ['locations', 'cameras', 'assets', 'check_state', 'outages', 'camera_groups', 'location_status', 'regions', 'clusters', 'recorders',
        'camera_channel_mappings', 'asset_endpoints', 'network_definitions', 'asset_dependencies', 'recorder_status', 'recorder_endpoints', 'camera_endpoints',
        'location_hierarchy'] as const) {
        const res = await u.client.from(t as 'locations').select('org_id')
        expect(res.error, t).toBeNull()
        expect(res.data, t).toEqual([])
      }
    }
  })

  it('a deactivated admin whose token is still valid sees no organisation data and only their own profile row, grants or not', async () => {
    expect((await deactivated.client.from('locations').select('id')).data).toEqual([])
    expect((await deactivated.client.from('cameras').select('id')).data).toEqual([])
    expect((await deactivated.client.from('assets').select('id')).data).toEqual([])
    expect((await deactivated.client.from('regions').select('id')).data).toEqual([])
    expect((await deactivated.client.from('clusters').select('id')).data).toEqual([])
    expect((await deactivated.client.from('recorders').select('id')).data).toEqual([])
    expect((await deactivated.client.from('organizations').select('id')).data).toEqual([])
    expect((await deactivated.client.from('profiles').select('id')).data).toEqual([{ id: deactivated.id }])
    expect((await deactivated.client.from('access_grants').select('id')).data).toEqual([])
    expect((await deactivated.client.rpc('has_capability', { p_cap: 'cctv.live' })).data).toBe(false)
  })

  it('anonymous callers are refused on every inventory and access table', async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const columns = {
      locations: 'id', cameras: 'id', assets: 'id', profiles: 'id', organizations: 'id', user_store_access: 'user_id',
      access_grants: 'id', capabilities: 'key', access_migration_report: 'id', recorder_endpoints: 'recorder_id', camera_endpoints: 'camera_id',
      // P2-5a: every new table and view.
      regions: 'id', clusters: 'id', recorders: 'id', camera_channel_mappings: 'id', address_spaces: 'id', asset_endpoints: 'id',
      network_definitions: 'id', asset_dependencies: 'id', device_capabilities: 'id', location_status: 'location_id', recorder_status: 'recorder_id',
      location_hierarchy: 'location_id', inventory_migration_report: 'id',
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
      ['preview_access_change', { p_org: orgId, p_user: operator.id, p_changes: [] }],
      ['access_migrate_legacy_test', { p_run: crypto.randomUUID(), p_users: [operator.id] }],
      // P2-5b: the location-keyed nvr_* wrappers are gone; the recorder functions (and recorder_save) are the server's only path.
      ['recorder_store_credential', { p_recorder: crypto.randomUUID(), p_secret: 'x' }],
      ['recorder_read_credential', { p_recorder: crypto.randomUUID() }],
      ['recorder_save', { p_org: orgId, p_location: crypto.randomUUID(), p_recorder: null, p_host: '127.0.0.1', p_http_port: 80, p_rtsp_port: 554, p_username: 'u' }],
      ['recorder_set_monitoring', { p_org: orgId, p_recorder: crypto.randomUUID(), p_enabled: false, p_reason: 'xyz' }],
      ['inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: crypto.randomUUID() }],
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
