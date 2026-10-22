// P2-1 VA-18: migrating the old access model to explicit grants keeps every person's CCTV cameras exactly (directive AC-6, AC-7, AL-7,
// decisions D-2 / D-2a). Legacy rows are written into the retired tables, the legacy evaluator (the old visible_camera_ids rules,
// verbatim, as a server-only function) gives the "before" set, the migration function runs, and the new functions give the "after" set.
// The "before" sets are also written out by hand from the old rules (they are the assertions the old inventory-rls test made), so the
// legacy evaluator itself is checked.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createUser, type Role, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[]) => [...a].sort()

type Person = { u: TestUser; stores?: string[]; zones?: string[]; cameras?: string[] }

async function setOf(fn: 'access_legacy_camera_ids' | 'access_legacy_device_ids', userId: string, ignoreStatus: boolean): Promise<string[]> {
  const { data, error } = await admin().rpc(fn, { p_user: userId, p_ignore_status: ignoreStatus })
  if (error) throw new Error(`${fn}: ${error.message}`)
  return sorted((data as unknown as string[]) ?? [])
}
async function effective(fn: 'access_effective_camera_ids' | 'access_effective_device_ids', userId: string, cap: string, ignoreStatus: boolean): Promise<string[]> {
  const { data, error } = await admin().rpc(fn, { p_user: userId, p_cap: cap, p_ignore_status: ignoreStatus })
  if (error) throw new Error(`${fn}: ${error.message}`)
  return sorted((data as unknown as string[]) ?? [])
}

describe('VA-18: migration of the old access model (AC-6, AC-7, AL-7, D-2a)', () => {
  let orgId: string
  let M1: string, M2: string, M3: string
  let m11: string, m12: string, m13: string, m21: string, m22: string, m31: string
  let e1: string, e2: string, e3: string, e0: string
  const people: Record<string, Person> = {}
  const run = randomUUID()
  let migrated = 0

  beforeAll(async () => {
    orgId = await createOrg()
    const a = admin()
    const store = async (code: string, zone: string) => (await a.from('stores').insert({ org_id: orgId, code, name: code, zone, nvr_ip: '192.0.2.1', nvr_username: 'u' }).select('id').single()).data!.id
    M1 = await store('M1', 'Z')
    M2 = await store('M2', 'Z')
    M3 = await store('M3', 'Y')
    const cam = async (s: string, ch: number) => (await a.from('cameras').insert({ org_id: orgId, store_id: s, channel: ch, name: `C${ch}` }).select('id').single()).data!.id
    m11 = await cam(M1, 1); m12 = await cam(M1, 2); m13 = await cam(M1, 3)
    m21 = await cam(M2, 1); m22 = await cam(M2, 2)
    m31 = await cam(M3, 1)
    let p = 30
    const dev = async (s: string | null) => (await a.from('devices').insert({ org_id: orgId, store_id: s, type: 'server', name: `D${p}`, ip: '192.0.2.2', tcp_port: p++ }).select('id').single()).data!.id
    e1 = await dev(M1); e2 = await dev(M2); e3 = await dev(M3); e0 = await dev(null)

    const make = async (key: string, role: Role, o: { home?: string; mustReset?: boolean } & Omit<Person, 'u'> = {}) => {
      const u = await createUser(orgId, role, { storeId: o.home ?? null, mustReset: o.mustReset })
      people[key] = { u, stores: o.stores, zones: o.zones, cameras: o.cameras }
      for (const s of o.stores ?? []) expect((await a.from('user_store_access').insert({ org_id: orgId, user_id: u.id, store_id: s })).error).toBeNull()
      for (const z of o.zones ?? []) expect((await a.from('user_zone_access').insert({ org_id: orgId, user_id: u.id, zone: z })).error).toBeNull()
      for (const c of o.cameras ?? []) expect((await a.from('user_camera_access').insert({ org_id: orgId, user_id: u.id, camera_id: c })).error).toBeNull()
    }
    await make('storeOnly', 'user', { stores: [M1] })
    await make('zoneOnly', 'user', { zones: ['Z'] })
    await make('homeOnly', 'user', { home: M3 })
    await make('storePlusCam', 'user', { stores: [M1], cameras: [m12] })
    await make('zonePlusCam', 'user', { zones: ['Z'], cameras: [m21] })
    await make('homePlusCam', 'user', { home: M1, cameras: [m13] })
    await make('camOnly', 'user', { cameras: [m11, m31] })
    await make('storeAndHome', 'user', { home: M2, stores: [M2] })
    await make('operator', 'operator', { stores: [M3] })
    await make('manager', 'manager', { stores: [M1] })
    await make('admin', 'admin')
    await make('owner', 'platform_owner')
    await make('emptyZone', 'user', { zones: ['NO-SUCH-ZONE'] })
    await make('nobody', 'user')
    await make('inactive', 'user', { stores: [M1] })
    await a.from('profiles').update({ is_active: false }).eq('id', people.inactive.u.id)
    await make('mustReset', 'user', { zones: ['Z'], mustReset: true })
  })
  afterAll(() => cleanupOrg(orgId))

  // The old rules, written out by hand (inventory-rls before P2-1): store/zone/home grants give all cameras of the store, except where
  // the person also has camera grants in that store (then only those); managers and administrators see everything.
  const expectedBefore = (): Record<string, string[]> => ({
    storeOnly: [m11, m12, m13],
    zoneOnly: [m11, m12, m13, m21, m22],
    homeOnly: [m31],
    storePlusCam: [m12],
    zonePlusCam: [m11, m12, m13, m21],
    homePlusCam: [m13],
    camOnly: [m11, m31],
    storeAndHome: [m21, m22],
    operator: [m31],
    manager: [m11, m12, m13, m21, m22, m31],
    admin: [m11, m12, m13, m21, m22, m31],
    owner: [m11, m12, m13, m21, m22, m31],
    emptyZone: [],
    nobody: [],
    inactive: [m11, m12, m13],
    mustReset: [m11, m12, m13, m21, m22],
  })
  const expectedDevicesBefore = (): Record<string, string[]> => ({
    storeOnly: [e1], zoneOnly: [e1, e2], homeOnly: [e3], storePlusCam: [e1], zonePlusCam: [e1, e2], homePlusCam: [e1], camOnly: [],
    storeAndHome: [e2], operator: [e3], manager: [e0, e1, e2, e3], admin: [e0, e1, e2, e3], owner: [e0, e1, e2, e3],
    emptyZone: [], nobody: [], inactive: [e1], mustReset: [e1, e2],
  })

  it('the legacy evaluator reproduces the old rules (status ignored), and gives nothing to inactive or reset people (status respected)', async () => {
    for (const [key, cams] of Object.entries(expectedBefore())) {
      expect(await setOf('access_legacy_camera_ids', people[key].u.id, true), key).toEqual(sorted(cams))
      expect(await setOf('access_legacy_device_ids', people[key].u.id, true), key).toEqual(sorted(expectedDevicesBefore()[key]))
    }
    expect(await setOf('access_legacy_camera_ids', people.inactive.u.id, false)).toEqual([])
    expect(await setOf('access_legacy_camera_ids', people.mustReset.u.id, false)).toEqual([])
  })

  it('migrates, after which every person has exactly the same live and playback cameras as before, and no export', async () => {
    const res = await admin().rpc('access_migrate_legacy', { p_run: run, p_users: Object.values(people).map((p) => p.u.id) })
    expect(res.error).toBeNull()
    migrated = res.data as number
    expect(migrated).toBeGreaterThan(0)
    for (const [key, cams] of Object.entries(expectedBefore())) {
      const id = people[key].u.id
      for (const cap of ['cctv.live', 'cctv.playback']) {
        expect(await effective('access_effective_camera_ids', id, cap, true), `${key} ${cap}`).toEqual(sorted(cams))
        expect(await effective('access_effective_camera_ids', id, cap, false), `${key} ${cap} (status)`).toEqual(await setOf('access_legacy_camera_ids', id, false))
      }
      const exportCams = await effective('access_effective_camera_ids', id, 'cctv.export', true)
      expect(exportCams, `${key} export`).toEqual(key === 'admin' || key === 'owner' ? sorted(cams) : [])
    }
  })

  it('people see the same cameras through their own sign-in, and the retired tables no longer matter', async () => {
    const seen = async (u: TestUser) => sorted(((await u.client.from('cameras').select('id')).data ?? []).map((r) => r.id))
    expect(await seen(people.storeOnly.u)).toEqual(sorted([m11, m12, m13]))
    expect(await seen(people.storePlusCam.u)).toEqual([m12])
    expect(await seen(people.homeOnly.u)).toEqual([m31])
    expect(sorted(((await people.storePlusCam.u.client.from('stores').select('id')).data ?? []).map((r) => r.id))).toEqual([M1])
    // Taking the old rows away changes nothing now.
    await admin().from('user_store_access').delete().eq('user_id', people.storeOnly.u.id)
    expect(await seen(people.storeOnly.u)).toEqual(sorted([m11, m12, m13]))
  })

  it('IT device visibility that came through a store, zone or home grant is not migrated (AC-4); managers and administrators keep theirs', async () => {
    for (const key of ['storeOnly', 'zoneOnly', 'homeOnly', 'storePlusCam', 'operator', 'inactive']) {
      for (const cap of ['it.inventory.view', 'it.monitoring.view']) {
        expect(await effective('access_effective_device_ids', people[key].u.id, cap, true), `${key} ${cap}`).toEqual([])
      }
    }
    for (const key of ['manager', 'admin', 'owner']) {
      expect(await effective('access_effective_device_ids', people[key].u.id, 'it.inventory.view', true), key).toEqual(sorted([e0, e1, e2, e3]))
    }
    const devices = async (u: TestUser) => ((await u.client.from('devices').select('id')).data ?? []).length
    expect(await devices(people.storeOnly.u)).toBe(0)
    expect(await devices(people.manager.u)).toBe(4)
  })

  it('writes one report row per person, flags home-store and manager grants for review, and lists the lost IT visibility', async () => {
    const { data, error } = await admin().from('access_migration_report').select('user_id, old_model, new_grants, note').eq('run_id', run)
    expect(error).toBeNull()
    const byUser = new Map((data ?? []).map((r) => [r.user_id, r]))
    expect(byUser.size).toBe(Object.keys(people).length)
    type G = { capability: string; scope_kind: string; scope_id: string | null; source: string; needs_review: boolean }
    const grantsOf = (key: string) => (byUser.get(people[key].u.id)!.new_grants as G[])
    const noteOf = (key: string) => byUser.get(people[key].u.id)!.note ?? ''

    expect(grantsOf('homeOnly')).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'cctv.live', scope_kind: 'location', scope_id: M3, source: 'migrated:home', needs_review: true }),
    ]))
    expect(noteOf('homeOnly')).toMatch(/home store/i)
    expect(grantsOf('storeAndHome').filter((g) => g.scope_id === M2).every((g) => g.source === 'migrated:store' && !g.needs_review)).toBe(true)
    expect(grantsOf('zoneOnly').map((g) => [g.capability, g.scope_kind, g.scope_id, g.source])).toEqual(expect.arrayContaining([
      ['cctv.live', 'location', M1, 'migrated:zone'], ['cctv.playback', 'location', M2, 'migrated:zone'],
    ]))
    expect(grantsOf('storePlusCam').map((g) => [g.capability, g.scope_kind, g.scope_id, g.source]).sort()).toEqual([
      ['cctv.live', 'camera', m12, 'migrated:camera'], ['cctv.playback', 'camera', m12, 'migrated:camera'],
    ])
    const managerGrants = grantsOf('manager').filter((g) => g.scope_kind === 'organization')
    expect(managerGrants.map((g) => g.capability).sort()).toEqual(['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'])
    expect(managerGrants.every((g) => g.source === 'migrated:manager' && g.needs_review)).toBe(true)
    expect(noteOf('manager')).toMatch(/manager/i)
    const adminCaps = grantsOf('admin').filter((g) => g.source === 'migrated:admin').map((g) => g.capability).sort()
    expect(adminCaps).toEqual(sorted([
      'cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate', 'wifi.inventory.view',
      'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read',
    ]))
    // No high-risk IT capability is given to anybody.
    for (const r of data ?? []) {
      for (const g of r.new_grants as G[]) expect(['it.remote.view', 'it.remote.control', 'it.script.run', 'it.software.manage', 'it.config.deploy', 'it.patch.manage', 'it.credentials.admin', 'it.os.deploy', 'it.diagnostics']).not.toContain(g.capability)
    }
    for (const key of ['storeOnly', 'zoneOnly', 'homeOnly', 'operator']) expect(noteOf(key), key).toMatch(/AC-4/)
    expect(noteOf('camOnly')).not.toMatch(/AC-4/)
    expect(noteOf('emptyZone')).toMatch(/zone/i)
    expect(noteOf('inactive')).toMatch(/inactive/i)
    expect(grantsOf('nobody')).toEqual([])
    expect((byUser.get(people.zonePlusCam.u.id)!.old_model as { zones: string[] }).zones).toEqual(['Z'])

    // The grants themselves carry the same source and review flag.
    const { data: rows } = await admin().from('access_grants').select('source, needs_review').eq('user_id', people.homeOnly.u.id)
    expect((rows ?? []).every((r) => r.source === 'migrated:home' && r.needs_review)).toBe(true)
  })

  it('running the migration again adds nothing', async () => {
    const before = (await admin().from('access_grants').select('id', { count: 'exact', head: true }).eq('org_id', orgId)).count
    const again = await admin().rpc('access_migrate_legacy', { p_run: randomUUID(), p_users: Object.values(people).map((p) => p.u.id) })
    expect(again.error).toBeNull()
    expect(again.data).toBe(0)
    expect((await admin().from('access_grants').select('id', { count: 'exact', head: true }).eq('org_id', orgId)).count).toBe(before)
  })
})
