import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getVisibleStore, homeCounts, listVisibleDevices, listVisibleStores } from '@/lib/queries/inventory'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

describe('viewer queries respect access', () => {
  let orgId: string
  let storeA: string
  let storeB: string
  let viewer: TestUser
  let manager: TestUser

  beforeAll(async () => {
    const admin = adminClient()
    orgId = await createOrg()
    const mk = async (code: string, zone: string) =>
      (await admin.from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, city: 'Patna', zone, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    storeA = await mk('AA', 'BR')
    storeB = await mk('BB', 'UP')
    await admin.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: storeA, channel: n, name: `C${n}` })))
    await admin.from('cameras').insert({ org_id: orgId, store_id: storeB, channel: 1, name: 'C1' })
    await admin.from('devices').insert([
      { org_id: orgId, store_id: storeA, type: 'server', name: 'A server', ip: '127.0.0.1' },
      { org_id: orgId, store_id: storeB, type: 'footfall', name: 'B counter', ip: '127.0.0.1' },
    ])
    viewer = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    await admin.rpc('replace_user_access', { p_user: viewer.id, p_stores: [storeA], p_zones: [], p_cameras: [] })
  })
  afterAll(() => cleanupOrg(orgId))

  it('lists only visible stores, with their camera counts, and can search', async () => {
    const mine = await listVisibleStores(viewer.client)
    expect(mine.map((s) => [s.code, s.camera_count])).toEqual([['AA', 2]])
    const all = await listVisibleStores(manager.client)
    expect(all.map((s) => s.code)).toEqual(['AA', 'BB'])
    expect((await listVisibleStores(manager.client, 'store b')).map((s) => s.code)).toEqual(['BB'])
    // A search made only of special characters becomes empty, which means no filter at all.
    expect((await listVisibleStores(manager.client, '%,()')).length).toBe(2)
  })

  it('shows a store with its cameras and devices only when it is visible', async () => {
    const ok = await getVisibleStore(viewer.client, storeA)
    expect(ok?.cameras.map((c) => c.channel)).toEqual([1, 2])
    expect(ok?.devices.map((d) => d.name)).toEqual(['A server'])
    expect(await getVisibleStore(viewer.client, storeB)).toBeNull()
  })

  it('lists visible devices and can filter by type', async () => {
    expect((await listVisibleDevices(viewer.client)).map((d) => d.name)).toEqual(['A server'])
    expect((await listVisibleDevices(manager.client, 'footfall')).map((d) => d.name)).toEqual(['B counter'])
  })

  it('counts what the person may see', async () => {
    expect(await homeCounts(viewer.client)).toEqual({ stores: 1, cameras: 2, devices: { server: 1 } })
    expect(await homeCounts(manager.client)).toEqual({ stores: 2, cameras: 3, devices: { server: 1, footfall: 1 } })
  })
})
