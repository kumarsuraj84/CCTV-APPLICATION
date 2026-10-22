import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminClient, atAsset, atCamera, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, primaryRecorderOf, READ_EVERYTHING, type GrantScope, type TestUser,
} from '../setup/fixtures'

// P2-1 rewrote this file for the capability model (docs/drishti/access-model.md). The old assertions it replaces encoded behaviour the
// directive forbids: a manager seeing everything (AC-8), store and zone grants revealing IT devices (AC-4), camera grants narrowing a
// store grant (AC-6) and a home store acting as a grant (AC-7). Each case below names the requirement it now proves.

// P2-5a: stores → locations, devices → assets (ids unchanged). A location's NVR is now an asset too (a recorder). Review I-2: every
// asset row the person can read is counted — the stores' NVR recorder assets are named in the positive expectations below.
type Table = 'locations' | 'cameras' | 'assets'

async function addStore(orgId: string, code: string, zone: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('locations')
    .insert({ org_id: orgId, code, name: `Store ${code}`, zone, nvr_ip: '127.0.0.1', nvr_username: 'viewer' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}

async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await adminClient()
    .from('cameras')
    .insert({ org_id: orgId, location_id: storeId, channel, name: `Camera ${channel}` })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}

let devicePort = 9 // devices are unique per address and port, so each fixture device gets its own port
async function addDevice(orgId: string, storeId: string | null, type: 'server' | 'attendance', name: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('assets')
    .insert({ org_id: orgId, location_id: storeId, type, name, ip: '127.0.0.1', tcp_port: devicePort++ })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addDevice: ${error?.message}`)
  return data.id
}

async function idsOf(user: TestUser, table: Table): Promise<string[]> {
  const { data, error } = await user.client.from(table).select('id')
  expect(error).toBeNull()
  return (data ?? []).map((r) => r.id).sort()
}

const sorted = (...a: string[]) => [...a].sort()

describe('inventory visibility (row-level security, capability model)', () => {
  let orgA: string
  let orgB: string
  let s1: string, s2: string, s3: string, sB: string
  let c11: string, c12: string, c21: string, c31: string, c32: string
  let d1: string, d3: string, d0: string
  let n1: string, n2: string, n3: string // the stores' NVR recorder assets
  let manager: TestUser, managerWithGrants: TestUser, zoneUser: TestUser, storeUser: TestUser, camUser: TestUser, mixedUser: TestUser
  let zoneCamUser: TestUser, ownStoreUser: TestUser, nobody: TestUser, resetUser: TestUser, managerB: TestUser, admin: TestUser, itUser: TestUser

  const cctv = (orgId: string, u: TestUser, scopes: GrantScope[]) => grant(orgId, u.id, CCTV_VIEW, scopes)

  beforeAll(async () => {
    orgA = await createOrg()
    orgB = await createOrg()
    s1 = await addStore(orgA, 'S1', 'BR')
    s2 = await addStore(orgA, 'S2', 'BR')
    s3 = await addStore(orgA, 'S3', 'UP')
    sB = await addStore(orgB, 'SB', 'BR')
    c11 = await addCamera(orgA, s1, 1)
    c12 = await addCamera(orgA, s1, 2)
    c21 = await addCamera(orgA, s2, 1)
    c31 = await addCamera(orgA, s3, 1)
    c32 = await addCamera(orgA, s3, 2)
    await addCamera(orgB, sB, 1)
    d1 = await addDevice(orgA, s1, 'server', 'ERP')
    d3 = await addDevice(orgA, s3, 'attendance', 'Door')
    d0 = await addDevice(orgA, null, 'server', 'Head office')
    await addDevice(orgB, sB, 'server', 'Other org')
    ;[n1, n2, n3] = await Promise.all([s1, s2, s3].map((s) => primaryRecorderOf(s)))

    manager = await createUser(orgA, 'manager')
    managerWithGrants = await createUser(orgA, 'manager')
    admin = await createUser(orgA, 'admin')
    zoneUser = await createUser(orgA, 'user')
    storeUser = await createUser(orgA, 'operator')
    camUser = await createUser(orgA, 'user')
    mixedUser = await createUser(orgA, 'user')
    zoneCamUser = await createUser(orgA, 'user')
    ownStoreUser = await createUser(orgA, 'user', { storeId: s1 })
    nobody = await createUser(orgA, 'user')
    resetUser = await createUser(orgA, 'user', { mustReset: true })
    managerB = await createUser(orgB, 'manager')
    itUser = await createUser(orgA, 'user')

    await grant(orgA, managerWithGrants.id, READ_EVERYTHING)
    await cctv(orgA, zoneUser, [atLocation(s1), atLocation(s2)]) // what a zone grant for BR became (D-2: the stores in the zone now)
    await cctv(orgA, storeUser, [atLocation(s3)])
    await cctv(orgA, camUser, [atCamera(c11)])
    await cctv(orgA, mixedUser, [atLocation(s3), atCamera(c32)])
    await cctv(orgA, zoneCamUser, [atLocation(s1), atLocation(s2), atCamera(c12)])
    await cctv(orgA, resetUser, [atLocation(s1)])
    await grant(orgB, managerB.id, READ_EVERYTHING)
    await grant(orgA, itUser.id, ['it.inventory.view'], [atLocation(s1), atAsset(d0)])
  })

  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('AC-8: a manager without grants sees nothing; with organisation-wide read grants they see everything of their organisation', async () => {
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await idsOf(manager, t)).toEqual([])
    expect(await idsOf(managerWithGrants, 'locations')).toEqual(sorted(s1, s2, s3))
    expect(await idsOf(managerWithGrants, 'cameras')).toEqual(sorted(c11, c12, c21, c31, c32))
    expect(await idsOf(managerWithGrants, 'assets')).toEqual(sorted(d1, d3, d0, n1, n2, n3))
  })

  it('AC-4: CCTV grants for the stores of a zone give those stores and cameras, and no devices', async () => {
    expect(await idsOf(zoneUser, 'locations')).toEqual(sorted(s1, s2))
    expect(await idsOf(zoneUser, 'cameras')).toEqual(sorted(c11, c12, c21))
    expect(await idsOf(zoneUser, 'assets')).toEqual([])
  })

  it('AC-4: a CCTV store grant gives all cameras of that store and no devices (also for an operator)', async () => {
    expect(await idsOf(storeUser, 'locations')).toEqual(sorted(s3))
    expect(await idsOf(storeUser, 'cameras')).toEqual(sorted(c31, c32))
    expect(await idsOf(storeUser, 'assets')).toEqual([])
  })

  it('a camera-only grant shows that camera and its store, but no devices', async () => {
    expect(await idsOf(camUser, 'locations')).toEqual(sorted(s1))
    expect(await idsOf(camUser, 'cameras')).toEqual(sorted(c11))
    expect(await idsOf(camUser, 'assets')).toEqual([])
  })

  it('AC-6: camera grants inside a granted store add to it and never narrow it', async () => {
    expect(await idsOf(mixedUser, 'locations')).toEqual(sorted(s3))
    expect(await idsOf(mixedUser, 'cameras')).toEqual(sorted(c31, c32))
    expect(await idsOf(mixedUser, 'assets')).toEqual([])
  })

  it('AC-6: the union holds per store too: a camera grant beside store grants changes nothing for the other stores', async () => {
    expect(await idsOf(zoneCamUser, 'locations')).toEqual(sorted(s1, s2))
    expect(await idsOf(zoneCamUser, 'cameras')).toEqual(sorted(c11, c12, c21))
  })

  it('AC-7: a home store on the profile gives nothing at all', async () => {
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await idsOf(ownStoreUser, t)).toEqual([])
  })

  it('AC-4: devices come only with an IT capability: a location grant shows its devices, an asset grant exactly that one; no cameras', async () => {
    expect(await idsOf(itUser, 'assets')).toEqual(sorted(d1, d0, n1))
    expect(await idsOf(itUser, 'cameras')).toEqual([])
    expect(await idsOf(itUser, 'locations')).toEqual(sorted(s1)) // the device without a store adds no store
  })

  it('a user without grants sees nothing, and neither does one who must still choose a password', async () => {
    for (const u of [nobody, resetUser]) {
      expect(await idsOf(u, 'locations')).toEqual([])
      expect(await idsOf(u, 'cameras')).toEqual([])
      expect(await idsOf(u, 'assets')).toEqual([])
    }
  })

  it('another organisation sees only its own rows', async () => {
    expect(await idsOf(managerB, 'locations')).toEqual(sorted(sB))
    expect((await idsOf(managerB, 'cameras')).length).toBe(1)
  })

  it('nobody writes inventory through the data API', async () => {
    const insert = await managerWithGrants.client.from('locations').insert({ org_id: orgA, code: 'X', name: 'X', nvr_ip: '127.0.0.1', nvr_username: 'u' })
    expect(insert.error?.code).toBe('42501')
    const update = await zoneUser.client.from('cameras').update({ name: 'changed' }).eq('id', c11)
    expect(update.error?.code).toBe('42501')
    const del = await managerWithGrants.client.from('assets').delete().eq('id', d1)
    expect(del.error?.code).toBe('42501')
  })

  it('people read their own grants, admin.access reads everyone’s, and the audit log needs admin.audit.read', async () => {
    const own = await zoneUser.client.from('access_grants').select('scope_id').eq('capability', 'cctv.live')
    expect(sorted(...(own.data ?? []).map((r) => r.scope_id!))).toEqual(sorted(s1, s2))
    expect((await admin.client.from('access_grants').select('id')).data).toEqual([]) // the role alone reads nothing (AC-8)
    await grant(orgA, admin.id, ['admin.access', 'admin.audit.read'])
    const others = await admin.client.from('access_grants').select('user_id').eq('capability', 'cctv.playback')
    expect(new Set((others.data ?? []).map((r) => r.user_id)).size).toBe(7)
    await adminClient().from('admin_audit_log').insert({ org_id: orgA, actor_id: admin.id, action: 'test' })
    expect(((await admin.client.from('admin_audit_log').select('id')).data ?? []).length).toBe(1)
    expect((await zoneUser.client.from('admin_audit_log').select('id')).data).toEqual([])
  })

  it('refuses to grant a store or camera of another organisation', async () => {
    const { data: camB } = await adminClient().from('cameras').select('id').eq('org_id', orgB).limit(1).single()
    for (const [kind, id] of [['location', sB], ['camera', camB!.id]] as const) {
      const { error } = await adminClient().rpc('grant_access', { p_org: orgA, p_user: nobody.id, p_grants: [{ capability: 'cctv.live', scope_kind: kind, scope_id: id }] })
      expect(error?.message).toContain('outside organisation')
    }
  })

  it('the database refuses links between rows of different organisations', async () => {
    const db = adminClient()
    const { data: camB } = await db.from('cameras').select('id').eq('org_id', orgB).limit(1).single()
    expect(camB?.id).toBeTruthy()

    const camera = await db.from('cameras').insert({ org_id: orgA, location_id: sB, channel: 9, name: 'Cross' })
    expect(camera.error?.code).toBe('23503')
    const device = await db.from('assets').insert({ org_id: orgA, location_id: sB, type: 'server', name: 'Cross', ip: '127.0.0.1' })
    expect(device.error?.code).toBe('23503')
    // The retired grant tables keep their keys until they are dropped.
    const storeGrant = await db.from('user_store_access').insert({ org_id: orgA, user_id: nobody.id, store_id: sB })
    expect(storeGrant.error?.code).toBe('23503')
    const cameraGrant = await db.from('user_camera_access').insert({ org_id: orgA, user_id: nobody.id, camera_id: camB!.id })
    expect(cameraGrant.error?.code).toBe('23503')
    const zoneGrant = await db.from('user_zone_access').insert({ org_id: orgB, user_id: nobody.id, zone: 'BR' })
    expect(zoneGrant.error?.code).toBe('23503')
    const profile = await db.from('profiles').update({ location_id: sB }).eq('id', nobody.id)
    expect(profile.error?.code).toBe('23503')

    // A device with no store is still fine.
    const loose = await db.from('assets').insert({ org_id: orgA, location_id: null, type: 'other', name: 'Loose', ip: '127.0.0.1' })
    expect(loose.error).toBeNull()
  })

  // P2-5a (brief item 2) replaces "deleting a store detaches its devices and revokes the grants": a location is never deleted (history
  // is kept); it is archived with its devices, and an archived location grants nothing while the grant row itself stays as it was.
  it('a location cannot be deleted; archiving keeps its devices and grants as history, and the grant then gives nothing', async () => {
    const db = adminClient()
    const tmp = await addStore(orgA, 'TMP', 'XX')
    const dev = await addDevice(orgA, tmp, 'server', 'Temp device')
    const [g] = await grant(orgA, nobody.id, 'cctv.live', atLocation(tmp))
    expect(await idsOf(nobody, 'locations')).toEqual([tmp])
    const del = await db.from('locations').delete().eq('id', tmp)
    expect(del.error?.code).toBe('DR003')
    expect((await db.rpc('inventory_archive', { p_org: orgA, p_kind: 'location', p_id: tmp })).error).toBeNull()
    const back = await db.from('assets').select('location_id, org_id, enabled').eq('id', dev).single()
    expect(back.data).toEqual({ location_id: tmp, org_id: orgA, enabled: false })
    const row = await db.from('access_grants').select('scope_id, location_id, revoked_at').eq('id', g).single()
    expect(row.data).toEqual({ scope_id: tmp, location_id: tmp, revoked_at: null })
    expect(await idsOf(nobody, 'locations')).toEqual([])
    expect((await nobody.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: tmp })).data).toBe(false)
  })

  it('a location\'s NVR is a recorder asset: visible with the IT view of the location, never with CCTV rights', async () => {
    const nvrs = (await itUser.client.from('assets').select('id, type').eq('is_recorder', true)).data ?? []
    expect(nvrs.map((n) => n.type)).toEqual(['nvr'])
    expect(nvrs.map((n) => n.id)).toEqual([await primaryRecorderOf(s1)])
    expect((await zoneUser.client.from('assets').select('id')).data).toEqual([])
  })

  it('NVR passwords live in the vault and only the server can read them', async () => {
    const admin = adminClient()
    const secret = `Nvr-${randomUUID()}`
    expect((await admin.rpc('nvr_store_credential', { p_store: s1, p_secret: secret })).error).toBeNull()
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBe(secret)
    // P2-5a: the recorder owns the vault pointer (recorders.secret_id, name recorder:<id>); the legacy location column stays empty.
    const row = await admin.from('recorders').select('secret_id').eq('id', await primaryRecorderOf(s1)).single()
    expect(row.data?.secret_id).toBeTruthy()
    expect((await admin.from('locations').select('nvr_secret_id').eq('id', s1).single()).data?.nvr_secret_id).toBeNull()

    const denied = await managerWithGrants.client.rpc('nvr_read_credential', { p_store: s1 })
    expect(denied.error?.code).toBe('42501')
    expect(denied.data).toBeNull()

    const changed = `Nvr-${randomUUID()}`
    await admin.rpc('nvr_store_credential', { p_store: s1, p_secret: changed })
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBe(changed)

    await admin.rpc('nvr_delete_credential', { p_store: s1 })
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBeNull()
  })
})
