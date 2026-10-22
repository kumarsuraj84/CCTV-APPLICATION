import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getStates } from '@/lib/queries/status'
import { adminClient, atAsset, atLocation, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P2-2 fix round 1, I-1 (review): the checker's own words (check_state.error) and its method name recorder internals (refused logins,
// saved addresses and passwords, login methods). They are not readable by signed-in people any more (column privileges); the reasons
// come through status_reasons(type, ids), which gives the checker's text only with the IT view (camera: of its location; device: of
// the device; NVR: of the location) and otherwise, for a camera, "Recorder not reachable." (method nvr_down) or "The camera is not
// responding.". M-2: the organisation-wide profile read is based on admin.users only, never on a role.

const admin = () => adminClient()

describe('status reasons and column privileges (P2-2 fix round 1)', () => {
  let orgId: string
  let s1: string, cDown: string, cNvr: string, d1: string
  let cctvOnly: TestUser, itView: TestUser, assetOnly: TestUser, nobody: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    s1 = (await admin().from('stores').insert({ org_id: orgId, code: 'R1', name: 'R1', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    cDown = (await admin().from('cameras').insert({ org_id: orgId, store_id: s1, channel: 1, name: 'login refused' }).select('id').single()).data!.id
    cNvr = (await admin().from('cameras').insert({ org_id: orgId, store_id: s1, channel: 2, name: 'nvr down' }).select('id').single()).data!.id
    d1 = (await admin().from('devices').insert({ org_id: orgId, store_id: s1, type: 'server', name: 'D', ip: '192.0.2.9' }).select('id').single()).data!.id
    const at = new Date().toISOString()
    const rows = [
      { target_type: 'camera', target_id: cDown, method: 'rtsp', error: 'The recorder refused the login.' },
      { target_type: 'camera', target_id: cNvr, method: 'nvr_down', error: 'The NVR is not reachable.' },
      { target_type: 'device', target_id: d1, method: 'tcp', error: 'Connection refused on 192.0.2.9:3389' },
      { target_type: 'nvr', target_id: s1, method: 'tcp', error: 'Connection timed out to 127.0.0.1:80' },
    ]
    for (const r of rows) {
      const { error } = await admin().from('check_state').insert({ org_id: orgId, status: 'down', last_checked_at: at, down_since: at, ...r })
      if (error) throw new Error(error.message)
    }
    cctvOnly = await createUser(orgId, 'user')
    itView = await createUser(orgId, 'user')
    assetOnly = await createUser(orgId, 'user')
    nobody = await createUser(orgId, 'admin')
    await grant(orgId, cctvOnly.id, ['cctv.live', 'cctv.playback', 'cctv.export'], atLocation(s1))
    await grant(orgId, itView.id, ['cctv.live', 'it.monitoring.view'], atLocation(s1))
    await grant(orgId, assetOnly.id, 'cctv.live', atLocation(s1))
    await grant(orgId, assetOnly.id, 'it.inventory.view', atAsset(d1))
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
  })

  it('a signed-in person cannot select check_state.error or .method with their own client (42501), whatever they hold', async () => {
    for (const u of [cctvOnly, itView, nobody]) {
      for (const col of ['error', 'method', '*']) {
        const r = await u.client.from('check_state').select(col).eq('target_id', cDown)
        expect(r.error?.code, col).toBe('42501')
      }
      // The status columns stay readable (row security still decides which rows).
      expect((await u.client.from('check_state').select('target_id, status, down_since, last_checked_at, last_up_at').limit(1)).error).toBeNull()
    }
  })

  it('a CCTV-only viewer gets only the neutral camera reasons, and no device or NVR reason', async () => {
    const { data, error } = await cctvOnly.client.rpc('status_reasons', { p_type: 'camera', p_ids: [cDown, cNvr] })
    expect(error).toBeNull()
    const by = new Map((data ?? []).map((r) => [r.target_id, r.reason]))
    expect(by.get(cDown)).toBe('The camera is not responding.')
    expect(by.get(cNvr)).toBe('Recorder not reachable.')
    expect((await cctvOnly.client.rpc('status_reasons', { p_type: 'device', p_ids: [d1] })).data).toEqual([])
    expect((await cctvOnly.client.rpc('status_reasons', { p_type: 'nvr', p_ids: [s1] })).data).toEqual([])
    // Through the app's reader too.
    const states = await getStates(cctvOnly.client, 'camera', [cDown, cNvr])
    expect(states.get(cDown)?.error).toBe('The camera is not responding.')
    expect(states.get(cNvr)?.error).toBe('Recorder not reachable.')
    expect(JSON.stringify([...states.values()])).not.toMatch(/refused|NVR is not/)
  })

  it('the IT view of the location gets the checker\'s own words for cameras and the NVR', async () => {
    const states = await getStates(itView.client, 'camera', [cDown, cNvr])
    expect(states.get(cDown)?.error).toBe('The recorder refused the login.')
    expect(states.get(cNvr)?.error).toBe('The NVR is not reachable.')
    expect((await getStates(itView.client, 'nvr', [s1])).get(s1)?.error).toBe('Connection timed out to 127.0.0.1:80')
    expect((await getStates(itView.client, 'device', [d1])).get(d1)?.error).toBe('Connection refused on 192.0.2.9:3389')
  })

  it('an asset-only IT grant shows that device\'s reason but not the store\'s camera or NVR internals', async () => {
    expect((await getStates(assetOnly.client, 'device', [d1])).get(d1)?.error).toBe('Connection refused on 192.0.2.9:3389')
    expect((await getStates(assetOnly.client, 'camera', [cDown])).get(cDown)?.error).toBe('The camera is not responding.')
    expect((await getStates(assetOnly.client, 'nvr', [s1])).size).toBe(0)
  })

  it('nothing without a grant, and nothing for anonymous callers', async () => {
    expect((await nobody.client.rpc('status_reasons', { p_type: 'camera', p_ids: [cDown] })).data).toEqual([])
    const { createClient } = await import('@supabase/supabase-js')
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    expect((await anon.rpc('status_reasons' as never, { p_type: 'camera', p_ids: [cDown] } as never)).error).not.toBeNull()
  })

  // M-2: no role literal in the profile policy any more.
  it('an administrator without admin.users reads only their own profile; admin.users (any role) reads the organisation', async () => {
    const own = await nobody.client.from('profiles').select('id')
    expect((own.data ?? []).map((r) => r.id)).toEqual([nobody.id])
    const viewerWithUsers = await createUser(orgId, 'user')
    await grant(orgId, viewerWithUsers.id, 'admin.users', ORG_SCOPE)
    const all = await viewerWithUsers.client.from('profiles').select('id')
    expect((all.data ?? []).length).toBeGreaterThanOrEqual(5)
    const { data } = await admin().rpc('function_privileges')
    expect((data ?? []).find((f) => f.name === 'status_reasons')?.grantees).toEqual(['authenticated'])
    const policy = await admin().rpc('privilege_violations')
    expect(policy.data).toEqual([])
  })
})
