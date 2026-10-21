import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

type Table = 'stores' | 'cameras' | 'devices'

async function addStore(orgId: string, code: string, zone: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('stores')
    .insert({ org_id: orgId, code, name: `Store ${code}`, zone, nvr_ip: '127.0.0.1', nvr_username: 'viewer' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}

async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await adminClient()
    .from('cameras')
    .insert({ org_id: orgId, store_id: storeId, channel, name: `Camera ${channel}` })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}

let devicePort = 9 // devices are unique per address and port, so each fixture device gets its own port
async function addDevice(orgId: string, storeId: string | null, type: 'server' | 'attendance', name: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('devices')
    .insert({ org_id: orgId, store_id: storeId, type, name, ip: '127.0.0.1', tcp_port: devicePort++ })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addDevice: ${error?.message}`)
  return data.id
}

async function grant(userId: string, g: { stores?: string[]; zones?: string[]; cameras?: string[] }) {
  const { error } = await adminClient().rpc('replace_user_access', {
    p_user: userId,
    p_stores: g.stores ?? [],
    p_zones: g.zones ?? [],
    p_cameras: g.cameras ?? [],
  })
  if (error) throw new Error(`grant: ${error.message}`)
}

async function idsOf(user: TestUser, table: Table): Promise<string[]> {
  const { data, error } = await user.client.from(table).select('id')
  expect(error).toBeNull()
  return (data ?? []).map((r) => r.id).sort()
}

const sorted = (...a: string[]) => [...a].sort()

describe('inventory visibility (row-level security)', () => {
  let orgA: string
  let orgB: string
  let s1: string, s2: string, s3: string, sB: string
  let c11: string, c12: string, c21: string, c31: string, c32: string
  let d1: string, d3: string, d0: string
  let manager: TestUser, zoneUser: TestUser, storeUser: TestUser, camUser: TestUser, mixedUser: TestUser
  let zoneCamUser: TestUser, ownStoreUser: TestUser, nobody: TestUser, resetUser: TestUser, managerB: TestUser, admin: TestUser

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

    manager = await createUser(orgA, 'manager')
    admin = await createUser(orgA, 'admin')
    zoneUser = await createUser(orgA, 'user')
    storeUser = await createUser(orgA, 'agent')
    camUser = await createUser(orgA, 'user')
    mixedUser = await createUser(orgA, 'user')
    zoneCamUser = await createUser(orgA, 'user')
    ownStoreUser = await createUser(orgA, 'user', { storeId: s1 })
    nobody = await createUser(orgA, 'user')
    resetUser = await createUser(orgA, 'user', { mustReset: true })
    managerB = await createUser(orgB, 'manager')

    await grant(zoneUser.id, { zones: ['BR'] })
    await grant(storeUser.id, { stores: [s3] })
    await grant(camUser.id, { cameras: [c11] })
    await grant(mixedUser.id, { stores: [s3], cameras: [c32] })
    await grant(zoneCamUser.id, { zones: ['BR'], cameras: [c12] })
    await grant(resetUser.id, { stores: [s1] })
  })

  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('a manager sees everything in their organisation and nothing of another', async () => {
    expect(await idsOf(manager, 'stores')).toEqual(sorted(s1, s2, s3))
    expect(await idsOf(manager, 'cameras')).toEqual(sorted(c11, c12, c21, c31, c32))
    expect(await idsOf(manager, 'devices')).toEqual(sorted(d1, d3, d0))
  })

  it('a zone grant gives every store and camera of that zone, and the devices of those stores', async () => {
    expect(await idsOf(zoneUser, 'stores')).toEqual(sorted(s1, s2))
    expect(await idsOf(zoneUser, 'cameras')).toEqual(sorted(c11, c12, c21))
    expect(await idsOf(zoneUser, 'devices')).toEqual(sorted(d1))
  })

  it('a store grant gives all cameras and devices of that store (also for an operator)', async () => {
    expect(await idsOf(storeUser, 'stores')).toEqual(sorted(s3))
    expect(await idsOf(storeUser, 'cameras')).toEqual(sorted(c31, c32))
    expect(await idsOf(storeUser, 'devices')).toEqual(sorted(d3))
  })

  it('a camera-only grant shows that camera and its store, but no devices', async () => {
    expect(await idsOf(camUser, 'stores')).toEqual(sorted(s1))
    expect(await idsOf(camUser, 'cameras')).toEqual(sorted(c11))
    expect(await idsOf(camUser, 'devices')).toEqual([])
  })

  it('camera grants inside a granted store limit the user to those cameras', async () => {
    expect(await idsOf(mixedUser, 'stores')).toEqual(sorted(s3))
    expect(await idsOf(mixedUser, 'cameras')).toEqual(sorted(c32))
    expect(await idsOf(mixedUser, 'devices')).toEqual(sorted(d3))
  })

  it('the limit applies per store: other stores of a zone grant stay fully visible', async () => {
    expect(await idsOf(zoneCamUser, 'stores')).toEqual(sorted(s1, s2))
    expect(await idsOf(zoneCamUser, 'cameras')).toEqual(sorted(c12, c21))
    expect(await idsOf(zoneCamUser, 'devices')).toEqual(sorted(d1))
  })

  it('a store login sees its own store without any grant', async () => {
    expect(await idsOf(ownStoreUser, 'stores')).toEqual(sorted(s1))
    expect(await idsOf(ownStoreUser, 'cameras')).toEqual(sorted(c11, c12))
    expect(await idsOf(ownStoreUser, 'devices')).toEqual(sorted(d1))
  })

  it('a user without grants sees nothing, and neither does one who must still choose a password', async () => {
    for (const u of [nobody, resetUser]) {
      expect(await idsOf(u, 'stores')).toEqual([])
      expect(await idsOf(u, 'cameras')).toEqual([])
      expect(await idsOf(u, 'devices')).toEqual([])
    }
  })

  it('another organisation sees only its own rows', async () => {
    expect(await idsOf(managerB, 'stores')).toEqual(sorted(sB))
    expect((await idsOf(managerB, 'cameras')).length).toBe(1)
  })

  it('nobody writes inventory through the data API', async () => {
    const insert = await manager.client.from('stores').insert({ org_id: orgA, code: 'X', name: 'X', nvr_ip: '127.0.0.1', nvr_username: 'u' })
    expect(insert.error?.code).toBe('42501')
    const update = await zoneUser.client.from('cameras').update({ name: 'changed' }).eq('id', c11)
    expect(update.error?.code).toBe('42501')
    const del = await manager.client.from('devices').delete().eq('id', d1)
    expect(del.error?.code).toBe('42501')
  })

  it('users read their own grants, admins read everyone’s, and the audit log is for admins only', async () => {
    const own = await zoneUser.client.from('user_zone_access').select('zone')
    expect(own.data).toEqual([{ zone: 'BR' }])
    const others = await admin.client.from('user_store_access').select('user_id')
    expect((others.data ?? []).length).toBe(3)
    await adminClient().from('admin_audit_log').insert({ org_id: orgA, actor_id: admin.id, action: 'test' })
    expect(((await admin.client.from('admin_audit_log').select('id')).data ?? []).length).toBe(1)
    expect((await zoneUser.client.from('admin_audit_log').select('id')).data).toEqual([])
  })

  it('refuses to grant a store or camera of another organisation', async () => {
    const { error } = await adminClient().rpc('replace_user_access', { p_user: nobody.id, p_stores: [sB], p_zones: [], p_cameras: [] })
    expect(error?.message).toContain('outside organisation')
  })

  it('the database refuses links between rows of different organisations', async () => {
    const db = adminClient()
    const { data: camB } = await db.from('cameras').select('id').eq('org_id', orgB).limit(1).single()
    expect(camB?.id).toBeTruthy()

    const camera = await db.from('cameras').insert({ org_id: orgA, store_id: sB, channel: 9, name: 'Cross' })
    expect(camera.error?.code).toBe('23503')
    const device = await db.from('devices').insert({ org_id: orgA, store_id: sB, type: 'server', name: 'Cross', ip: '127.0.0.1' })
    expect(device.error?.code).toBe('23503')
    const storeGrant = await db.from('user_store_access').insert({ org_id: orgA, user_id: nobody.id, store_id: sB })
    expect(storeGrant.error?.code).toBe('23503')
    const cameraGrant = await db.from('user_camera_access').insert({ org_id: orgA, user_id: nobody.id, camera_id: camB!.id })
    expect(cameraGrant.error?.code).toBe('23503')
    const zoneGrant = await db.from('user_zone_access').insert({ org_id: orgB, user_id: nobody.id, zone: 'BR' })
    expect(zoneGrant.error?.code).toBe('23503')
    const profile = await db.from('profiles').update({ store_id: sB }).eq('id', nobody.id)
    expect(profile.error?.code).toBe('23503')

    // A device with no store is still fine.
    const loose = await db.from('devices').insert({ org_id: orgA, store_id: null, type: 'other', name: 'Loose', ip: '127.0.0.1' })
    expect(loose.error).toBeNull()
  })

  it('deleting a store detaches its devices but keeps their organisation', async () => {
    const db = adminClient()
    const tmp = await addStore(orgA, 'TMP', 'XX')
    const dev = await addDevice(orgA, tmp, 'server', 'Temp device')
    const del = await db.from('stores').delete().eq('id', tmp)
    expect(del.error).toBeNull()
    const back = await db.from('devices').select('store_id, org_id').eq('id', dev).single()
    expect(back.data).toEqual({ store_id: null, org_id: orgA })
  })

  it('NVR passwords live in the vault and only the server can read them', async () => {
    const admin = adminClient()
    const secret = `Nvr-${randomUUID()}`
    expect((await admin.rpc('nvr_store_credential', { p_store: s1, p_secret: secret })).error).toBeNull()
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBe(secret)
    const row = await admin.from('stores').select('nvr_secret_id').eq('id', s1).single()
    expect(row.data?.nvr_secret_id).toBeTruthy()

    const denied = await manager.client.rpc('nvr_read_credential', { p_store: s1 })
    expect(denied.error?.code).toBe('42501')
    expect(denied.data).toBeNull()

    const changed = `Nvr-${randomUUID()}`
    await admin.rpc('nvr_store_credential', { p_store: s1, p_secret: changed })
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBe(changed)

    await admin.rpc('nvr_delete_credential', { p_store: s1 })
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBeNull()
  })
})
