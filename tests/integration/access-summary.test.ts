import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCapabilities, type ScopeSummary } from '@/lib/auth/capabilities'
import { adminClient, atAsset, atCamera, atLocation, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P2-2 (WP-2.1b): the request's capability summary. One call (my_access_summary) answers, for the signed-in person only, which
// capabilities count right now and at which scopes. The database applies every rule of access_grants_of (active person, chosen password,
// not revoked, inside the validity window, MFA when enforced), so the app never re-implements them.

const admin = () => adminClient()
const scope = (o: Partial<ScopeSummary>): ScopeSummary => ({
  organization: false, locations: [], cameras: [], assets: [], regions: [], clusters: [], recorders: [], coveredLocations: [], recorderCameras: [], ...o,
})

describe('my_access_summary / readCapabilities', () => {
  let orgId: string, otherOrg: string
  let s1: string, s2: string, c1: string, d1: string
  let mixed: TestUser, nobody: TestUser, expired: TestUser, future: TestUser, revoked: TestUser, inactive: TestUser, mustReset: TestUser, adminPerson: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    const store = async (org: string, code: string) => (await admin().from('locations').insert({ org_id: org, code, name: code, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    s1 = await store(orgId, 'S1')
    s2 = await store(orgId, 'S2')
    c1 = (await admin().from('cameras').insert({ org_id: orgId, location_id: s2, channel: 1, name: 'C1' }).select('id').single()).data!.id
    d1 = (await admin().from('assets').insert({ org_id: orgId, location_id: s2, type: 'server', name: 'D1', ip: '127.0.0.1' }).select('id').single()).data!.id
    mixed = await createUser(orgId, 'user')
    nobody = await createUser(orgId, 'user')
    expired = await createUser(orgId, 'user')
    future = await createUser(orgId, 'user')
    revoked = await createUser(orgId, 'user')
    inactive = await createUser(orgId, 'user')
    mustReset = await createUser(orgId, 'user', { mustReset: true })
    adminPerson = await createUser(orgId, 'admin')
    await grant(orgId, mixed.id, 'cctv.live', [atLocation(s1), atCamera(c1)])
    await grant(orgId, mixed.id, 'cctv.playback', atCamera(c1))
    await grant(orgId, mixed.id, 'it.inventory.view', atAsset(d1))
    await grant(orgId, mixed.id, 'it.monitoring.view', ORG_SCOPE)
    await grant(orgId, expired.id, 'cctv.live', atLocation(s1), { validFrom: '2020-01-01T00:00:00Z', validUntil: '2020-02-01T00:00:00Z' })
    await grant(orgId, future.id, 'cctv.live', atLocation(s1), { validFrom: '2099-01-01T00:00:00Z' })
    const ids = await grant(orgId, revoked.id, ['cctv.live', 'cctv.playback'], atLocation(s1))
    await admin().rpc('revoke_grant', { p_org: orgId, p_user: revoked.id, p_grant_ids: [ids[0]], p_reason: 'test' })
    await grant(orgId, inactive.id, 'cctv.live', ORG_SCOPE)
    await admin().from('profiles').update({ is_active: false }).eq('id', inactive.id)
    await grant(orgId, mustReset.id, 'cctv.live', ORG_SCOPE)
    await grant(orgId, adminPerson.id, ['admin.users', 'admin.inventory'], ORG_SCOPE)
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('lists each capability once with its scopes: organisation-wide flag and the specific locations, cameras and assets', async () => {
    const c = await readCapabilities(mixed.client)
    expect(c.failed).toBe(false)
    expect(Object.keys(c.grants).sort()).toEqual(['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'])
    // P2-5a: the summary also carries the region/cluster/recorder scopes and the locations they cover (computed by the database).
    expect(c.grants['cctv.live']).toEqual(scope({ locations: [s1], cameras: [c1], coveredLocations: [s1] }))
    expect(c.grants['cctv.playback']).toEqual(scope({ cameras: [c1] }))
    expect(c.grants['it.inventory.view']).toEqual(scope({ assets: [d1] }))
    expect(c.grants['it.monitoring.view']).toEqual(scope({ organization: true }))
  })

  it('is empty without grants, for an ended or not yet started grant, and for a revoked one; the other kind stays', async () => {
    expect((await readCapabilities(nobody.client)).grants).toEqual({})
    expect((await readCapabilities(expired.client)).grants).toEqual({})
    expect((await readCapabilities(future.client)).grants).toEqual({})
    const r = await readCapabilities(revoked.client)
    expect(Object.keys(r.grants)).toEqual(['cctv.playback'])
  })

  it('gives nothing to a deactivated person or one who must still choose a password, even with organisation-wide grants', async () => {
    expect((await readCapabilities(inactive.client)).grants).toEqual({})
    expect((await readCapabilities(mustReset.client)).grants).toEqual({})
  })

  it('administrative capabilities are organisation-wide only', async () => {
    const c = await readCapabilities(adminPerson.client)
    expect(c.grants['admin.users']).toEqual(scope({ organization: true }))
    expect(c.grants['admin.inventory']?.organization).toBe(true)
    expect(c.grants['cctv.live']).toBeUndefined() // the administrator role gives no data access (AC-8)
  })

  it('answers about the caller only, and an anonymous caller is refused: the summary is "failed" and holds nothing', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const a = await readCapabilities(anon as never)
    expect(a.failed).toBe(true)
    expect(a.grants).toEqual({})
    const direct = await anon.rpc('my_access_summary' as never)
    expect(direct.error).not.toBeNull()
    // The service role is no person: the function knows no caller and returns nothing.
    const svc = await readCapabilities(admin())
    expect(svc.grants).toEqual({})
  })

  it('the app knows exactly the capabilities of the database catalogue', async () => {
    const { CAPABILITIES } = await import('@/lib/auth/capabilities')
    const { data } = await admin().from('capabilities').select('key')
    expect([...CAPABILITIES].sort()).toEqual((data ?? []).map((r) => r.key).sort())
  })

  it('reflects a revocation on the next read (nothing is cached across requests)', async () => {
    const person = await createUser(orgId, 'user')
    const [g] = await grant(orgId, person.id, 'cctv.live', atLocation(s2))
    expect(Object.keys((await readCapabilities(person.client)).grants)).toEqual(['cctv.live'])
    await admin().rpc('revoke_grant', { p_org: orgId, p_user: person.id, p_grant_ids: [g], p_reason: 'test' })
    expect((await readCapabilities(person.client)).grants).toEqual({})
  })
})
