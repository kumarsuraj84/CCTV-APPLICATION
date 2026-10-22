import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getVisibleStore, listVisibleDevices, listVisibleStores } from '@/lib/queries/inventory'
import { getDashboard } from '@/lib/queries/status'
import { adminClient, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

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
      (await admin.from('locations').insert({ org_id: orgId, code, name: `Store ${code}`, city: 'Patna', zone, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    storeA = await mk('AA', 'BR')
    storeB = await mk('BB', 'UP')
    await admin.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, location_id: storeA, channel: n, name: `C${n}` })))
    await admin.from('cameras').insert({ org_id: orgId, location_id: storeB, channel: 1, name: 'C1' })
    await admin.from('assets').insert([
      { org_id: orgId, location_id: storeA, type: 'server', name: 'A server', ip: '127.0.0.1', tcp_port: 1 },
      { org_id: orgId, location_id: storeB, type: 'footfall', name: 'B counter', ip: '127.0.0.1', tcp_port: 2 },
    ])
    viewer = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(storeA)) // a CCTV store grant (P2-1)
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

  // AC-4 (P2-1): a CCTV store grant shows the store's cameras but not its IT devices, nor the camera addresses.
  it('shows a store with its cameras only when it is visible, and its devices and addresses only with the IT view', async () => {
    const ok = await getVisibleStore(viewer.client, storeA)
    expect(ok?.cameras.map((c) => c.channel)).toEqual([1, 2])
    expect(ok?.devices).toEqual([])
    expect(ok?.showsAddresses).toBe(false)
    expect(await getVisibleStore(viewer.client, storeB)).toBeNull()
    const asManager = await getVisibleStore(manager.client, storeA)
    expect(asManager?.devices.map((d) => d.name)).toEqual(['A server'])
    expect(asManager?.showsAddresses).toBe(true)
  })

  it('lists visible devices and can filter by type', async () => {
    expect(await listVisibleDevices(viewer.client)).toEqual([]) // AC-4
    expect((await listVisibleDevices(manager.client)).map((d) => d.name).sort()).toEqual(['A server', 'B counter'])
    expect((await listVisibleDevices(manager.client, 'footfall')).map((d) => d.name)).toEqual(['B counter'])
  })

  it('pages through more than 1000 visible devices without repeating or losing rows', async () => {
    const admin = adminClient()
    const big = (await admin.from('locations').insert({ org_id: orgId, code: 'BIG', name: 'Store BIG', city: 'Patna', zone: 'BR', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    // Half of the rows share one name, so a sort on name alone has ties across the page boundary.
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      org_id: orgId, location_id: big, type: 'server' as const, name: i < 500 ? 'same name' : `big ${String(i).padStart(4, '0')}`, ip: '127.0.0.1', tcp_port: 1000 + i,
    }))
    const ins = await admin.from('assets').insert(rows)
    expect(ins.error).toBeNull()
    const reader = await createUser(orgId, 'user')
    await grant(orgId, reader.id, READ_EVERYTHING, atLocation(big)) // CCTV and IT read for the store (P2-1: devices need IT, AC-4)
    const list = await listVisibleDevices(reader.client)
    expect(list.length).toBe(1001)
    expect(new Set(list.map((d) => d.id)).size).toBe(1001)
    expect((await getDashboard(reader.client)).devices.server.total).toBe(1001)
  })
})

describe('viewer queries leave out what is switched off, page, and do not hide errors', () => {
  let orgId: string
  let live: string
  let off: string
  let manager: TestUser

  beforeAll(async () => {
    const admin = adminClient()
    orgId = await createOrg()
    const mk = async (code: string, active: boolean) =>
      (await admin.from('locations').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u', is_active: active }).select('id').single()).data!.id
    live = await mk('LV', true)
    off = await mk('OFF', false)
    await admin.from('cameras').insert([
      { org_id: orgId, location_id: live, channel: 1, name: 'On', is_active: true },
      { org_id: orgId, location_id: live, channel: 2, name: 'Off', is_active: false },
    ])
    await admin.from('assets').insert([
      { org_id: orgId, location_id: live, type: 'server', name: 'Enabled', ip: '127.0.0.1', tcp_port: 1, enabled: true },
      { org_id: orgId, location_id: live, type: 'server', name: 'Disabled', ip: '127.0.0.1', tcp_port: 2, enabled: false },
    ])
    manager = await createUser(orgId, 'manager')
    await grant(orgId, manager.id, READ_EVERYTHING) // AC-8 (P2-1): sees everything only through explicit grants
  })
  afterAll(() => cleanupOrg(orgId))

  it('shows only switched-on stores, cameras and devices', async () => {
    expect((await listVisibleStores(manager.client)).map((s) => [s.code, s.camera_count])).toEqual([['LV', 1]])
    const store = await getVisibleStore(manager.client, live)
    expect(store?.cameras.map((c) => c.name)).toEqual(['On'])
    expect(store?.devices.map((d) => d.name)).toEqual(['Enabled'])
    expect(await getVisibleStore(manager.client, off)).toBeNull()
    expect((await listVisibleDevices(manager.client)).map((d) => d.name)).toEqual(['Enabled'])
  })

  it('reads more than 1000 cameras of one store', async () => {
    const admin = adminClient()
    const big = (await admin.from('locations').insert({ org_id: orgId, code: 'BIGC', name: 'Store BIGC', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const ins = await admin.from('cameras').insert(Array.from({ length: 1001 }, (_, i) => ({ org_id: orgId, location_id: big, channel: i + 1, name: `Cam ${i + 1}` })))
    expect(ins.error).toBeNull()
    const store = await getVisibleStore(manager.client, big)
    expect(store?.cameras).toHaveLength(1001)
    expect(new Set(store?.cameras.map((c) => c.id)).size).toBe(1001)
  })

  it('a read error is an error, not an empty store', async () => {
    const broken = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: table === 'locations' ? { message: 'boom' } : null }),
          }),
        }),
      }),
    } as unknown as typeof manager.client
    await expect(getVisibleStore(broken, live)).rejects.toThrow()
    // Cameras that cannot be read must not turn into "No cameras to show".
    const real = manager.client
    const camerasBroken = new Proxy(real, {
      get(target, prop) {
        if (prop !== 'from') return Reflect.get(target, prop)
        return (table: string) => {
          if (table !== 'cameras') return target.from(table as 'locations')
          const failing: Record<string, unknown> = {}
          const chain: unknown = new Proxy(failing, {
            get: (_t, p) => (p === 'then' ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } }) : () => chain),
          })
          return chain
        }
      },
    }) as typeof manager.client
    await expect(getVisibleStore(camerasBroken, live)).rejects.toThrow()
  })
})
