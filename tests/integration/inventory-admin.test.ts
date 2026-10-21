import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/users'
import { importDevices, importStores } from '@/lib/import/apply'
import { parseDevicesCsv } from '@/lib/import/devices-csv'
import { parseStoresCsv } from '@/lib/import/stores-csv'
import { createDevice, deleteDevice, updateDevice } from '@/lib/inventory/devices'
import { createStore, deleteStore, updateStore } from '@/lib/inventory/stores'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

const admin = () => adminClient()
const password = (store: string) => admin().rpc('nvr_read_credential', { p_store: store })

describe('inventory administration', () => {
  let orgId: string
  let actor: Actor

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
  })
  afterAll(() => cleanupOrg(orgId))

  it('imports stores: saves the NVR password in the vault, normalises the zone and makes placeholder cameras', async () => {
    const csv = 'name,city,zone,ip,port,http_port,user,password,channels\nAlpha,Patna,br,192.0.2.10,,,viewer,Secret-A1,4\nBeta,Ranchi,JH,192.0.2.11,,,viewer,Secret-B1,2\n'
    const parsed = parseStoresCsv(csv)
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res).toEqual({ created: 2, updated: 0, errors: [] })

    const { data: stores } = await admin().from('stores').select('id, code, zone').eq('org_id', orgId).order('code')
    expect(stores?.map((s) => [s.code, s.zone])).toEqual([['ALPHA', 'BR'], ['BETA', 'Jharkhand']])
    expect((await password(stores![0].id)).data).toBe('Secret-A1')
    const { data: cams } = await admin().from('cameras').select('name').eq('store_id', stores![0].id).order('channel')
    expect(cams?.map((c) => c.name)).toEqual(['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'])
  })

  it('a second import updates stores, keeps the password when the cell is empty and keeps camera names', async () => {
    const { data: alpha } = await admin().from('stores').select('id').eq('org_id', orgId).eq('code', 'ALPHA').single()
    await admin().from('cameras').update({ name: 'Front door' }).eq('store_id', alpha!.id).eq('channel', 1)
    const parsed = parseStoresCsv('name,city,zone,ip,user,password,channels\nAlpha,Patna City,BR,192.0.2.99,viewer,,4\n')
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res).toEqual({ created: 0, updated: 1, errors: [] })
    const { data: row } = await admin().from('stores').select('city, nvr_ip').eq('id', alpha!.id).single()
    expect(row).toEqual({ city: 'Patna City', nvr_ip: '192.0.2.99' })
    expect((await password(alpha!.id)).data).toBe('Secret-A1')
    const { data: cam } = await admin().from('cameras').select('name').eq('store_id', alpha!.id).eq('channel', 1).single()
    expect(cam?.name).toBe('Front door')
  })

  it('a new store without a password is reported, not created', async () => {
    const parsed = parseStoresCsv('name,ip,user,password\nGamma,192.0.2.12,viewer,\n')
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res.created).toBe(0)
    expect(res.errors).toEqual([{ line: 2, message: 'A new store needs a password for its NVR.' }])
    const { data } = await admin().from('stores').select('id').eq('org_id', orgId).eq('code', 'GAMMA')
    expect(data).toEqual([])
  })

  it('imports devices, links them to stores by code and reports unknown stores', async () => {
    const parsed = parseDevicesCsv('name,type,store_code,ip,port\nERP,server,alpha,192.0.2.20,443\nHead office switch,other,,192.0.2.21,\nLost,server,nowhere,192.0.2.22,\n')
    const res = await importDevices(admin(), actor, parsed.rows)
    expect(res.created).toBe(2)
    expect(res.errors).toEqual([{ line: 4, message: 'There is no store with the code NOWHERE.' }])
    const again = await importDevices(admin(), actor, parsed.rows.slice(0, 2))
    expect(again).toEqual({ created: 0, updated: 2, errors: [] })
    const { data } = await admin().from('devices').select('id').eq('org_id', orgId)
    expect(data).toHaveLength(2)
  })

  it('creates, changes and deletes one store; deleting removes its cameras and detaches its devices', async () => {
    const made = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.30', nvr_username: 'viewer', nvr_password: 'Secret-D1', zone: 'up', channels: 3 })
    if (!made.ok) throw new Error(made.error)
    expect((await password(made.storeId)).data).toBe('Secret-D1')
    // The service logs the refused duplicate; keep that expected line out of the test output.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dup = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.31', nvr_username: 'viewer', nvr_password: 'x', channels: 0 })
    logged.mockRestore()
    expect(dup.ok).toBe(false)

    expect((await updateStore(admin(), actor, made.storeId, { name: 'Delta', ip: '192.0.2.32', nvr_username: 'viewer', nvr_password: 'Secret-D2', zone: 'UP', channels: 3 })).ok).toBe(true)
    expect((await password(made.storeId)).data).toBe('Secret-D2')

    const dev = await createDevice(admin(), actor, { name: 'Counter', type: 'footfall', store_id: made.storeId, ip: '192.0.2.33' })
    if (!dev.ok) throw new Error(dev.error)
    expect((await deleteStore(admin(), actor, made.storeId)).ok).toBe(true)
    expect((await password(made.storeId)).data).toBeNull()
    const { data: cams } = await admin().from('cameras').select('id').eq('store_id', made.storeId)
    expect(cams).toEqual([])
    const { data: d } = await admin().from('devices').select('store_id').eq('id', dev.deviceId).single()
    expect(d?.store_id).toBeNull()
  })

  it('changes and deletes a device, and refuses a store of another organisation', async () => {
    const dev = await createDevice(admin(), actor, { name: 'Scanner', type: 'attendance', ip: '192.0.2.40', tcp_port: 4370 })
    if (!dev.ok) throw new Error(dev.error)
    expect((await updateDevice(admin(), actor, dev.deviceId, { name: 'Scanner 2', type: 'attendance', ip: '192.0.2.41', tcp_port: 4370 })).ok).toBe(true)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('stores').insert({ org_id: otherOrg, code: 'ZZ', name: 'ZZ', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    expect((await createDevice(admin(), actor, { name: 'Bad', type: 'server', ip: '192.0.2.42', store_id: other!.id })).ok).toBe(false)
    await cleanupOrg(otherOrg)
    expect((await deleteDevice(admin(), actor, dev.deviceId)).ok).toBe(true)
  })

  it('only administrators may change inventory', async () => {
    const viewer: Actor = { id: crypto.randomUUID(), orgId, role: 'user' }
    expect((await createDevice(admin(), viewer, { name: 'X', type: 'server', ip: '192.0.2.50' })).ok).toBe(false)
    expect((await createStore(admin(), viewer, { name: 'X', ip: '192.0.2.51', nvr_username: 'u', nvr_password: 'p', channels: 0 })).ok).toBe(false)
  })
})
