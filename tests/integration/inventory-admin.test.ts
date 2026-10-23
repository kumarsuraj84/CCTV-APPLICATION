import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { importDevices } from '@/lib/import/apply'
import { createStore, deleteStore, importStores, parseStoresCsv, updateStore } from '../setup/legacy-import'
import { parseDevicesCsv } from '@/lib/import/devices-csv'
import { createDevice, deleteDevice, updateDevice } from '@/lib/inventory/devices'
import { MSG_PASSWORD_AGAIN } from '@/lib/inventory/recorder-admin'
import { adminClient, cleanupOrg, createOrg, createRecorder, createUser, primaryRecorderOf } from '../setup/fixtures'

const admin = () => adminClient()
// P2-5b: a store's NVR login belongs to its primary recorder (read through the recorder-keyed server function only).
const password = async (store: string) => admin().rpc('recorder_read_credential', { p_recorder: await primaryRecorderOf(store) })
const recorderOf = async (store: string) => {
  const id = await primaryRecorderOf(store)
  const r = (await admin().from('recorders').select('http_port, rtsp_port, username, expected_channels, assets!recorders_asset_fk!inner(ip, location_id)').eq('id', id).single()).data!
  return { id, ...r }
}

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

    const { data: stores } = await admin().from('locations').select('id, code, zone').eq('org_id', orgId).order('code')
    expect(stores?.map((s) => [s.code, s.zone])).toEqual([['ALPHA', 'BR'], ['BETA', 'Jharkhand']])
    expect((await password(stores![0].id)).data).toBe('Secret-A1')
    // P2-5b: the legacy row is a location plus its primary recorder (the NVR's own address, ports, login, channels) and cameras mapped to it.
    const rec = await recorderOf(stores![0].id)
    expect(rec).toMatchObject({ http_port: 80, rtsp_port: 554, username: 'viewer', expected_channels: 4, assets: { ip: '192.0.2.10', location_id: stores![0].id } })
    const { data: cams } = await admin().from('cameras').select('name, recorder_id, channel').eq('location_id', stores![0].id).order('channel')
    expect(cams?.map((c) => [c.name, c.recorder_id, c.channel])).toEqual([1, 2, 3, 4].map((n) => [`Camera ${n}`, rec.id, n]))
  })

  // P2-5c-1 review I-4 replaces "a second import keeps the password when the cell is empty" for a CHANGED address: the saved password
  // belongs to the address and web port it was saved for, so a row that moves the NVR without a password is refused (nothing changes);
  // with a password the new one is saved. An unchanged address with an empty cell still keeps the saved password.
  it('a second import updates stores and keeps camera names; an empty password keeps the saved one only while the address stays', async () => {
    const { data: alpha } = await admin().from('locations').select('id').eq('org_id', orgId).eq('code', 'ALPHA').single()
    await admin().from('cameras').update({ name: 'Front door' }).eq('location_id', alpha!.id).eq('channel', 1)
    const same = await importStores(admin(), actor, parseStoresCsv('name,city,zone,ip,user,password,channels\nAlpha,Patna City,BR,192.0.2.10,viewer,,4\n').rows)
    expect(same).toEqual({ created: 0, updated: 1, errors: [] })
    const { data: row } = await admin().from('locations').select('city').eq('id', alpha!.id).single()
    expect(row).toEqual({ city: 'Patna City' })
    expect((await password(alpha!.id)).data).toBe('Secret-A1')
    const moved = await importStores(admin(), actor, parseStoresCsv('name,city,zone,ip,user,password,channels\nAlpha,Gaya,BR,192.0.2.99,viewer,,4\n').rows)
    expect(moved).toEqual({ created: 0, updated: 0, errors: [{ line: 2, message: MSG_PASSWORD_AGAIN }] })
    expect((await recorderOf(alpha!.id)).assets.ip).toBe('192.0.2.10')
    expect((await admin().from('locations').select('city').eq('id', alpha!.id).single()).data).toEqual({ city: 'Patna City' })
    const withPassword = await importStores(admin(), actor, parseStoresCsv('name,city,zone,ip,user,password,channels\nAlpha,Patna City,BR,192.0.2.99,viewer,Secret-A9,4\n').rows)
    expect(withPassword).toEqual({ created: 0, updated: 1, errors: [] })
    expect((await recorderOf(alpha!.id)).assets.ip).toBe('192.0.2.99')
    expect((await password(alpha!.id)).data).toBe('Secret-A9')
    const { data: cam } = await admin().from('cameras').select('name').eq('location_id', alpha!.id).eq('channel', 1).single()
    expect(cam?.name).toBe('Front door')
  })

  it('P2-5b: a location\'s second NVR is never touched by the legacy import or the store form; placeholders go to the primary only', async () => {
    const { data: alpha } = await admin().from('locations').select('id').eq('org_id', orgId).eq('code', 'ALPHA').single()
    const primary = await primaryRecorderOf(alpha!.id)
    const second = await createRecorder(orgId, alpha!.id, { name: 'Second', host: '192.0.2.150', httpPort: 8080, rtspPort: 8554, username: 'other', secret: 'Second-pass' })
    const res = await importStores(admin(), actor, parseStoresCsv('name,ip,user,password,channels\nAlpha,192.0.2.98,viewer,Secret-A2,6\n').rows)
    expect(res).toEqual({ created: 0, updated: 1, errors: [] })
    expect(await primaryRecorderOf(alpha!.id)).toBe(primary)
    expect((await recorderOf(alpha!.id)).assets.ip).toBe('192.0.2.98')
    const s = (await admin().from('recorders').select('http_port, rtsp_port, username, assets!recorders_asset_fk!inner(ip)').eq('id', second).single()).data!
    expect(s).toEqual({ http_port: 8080, rtsp_port: 8554, username: 'other', assets: { ip: '192.0.2.150' } })
    expect((await admin().rpc('recorder_read_credential', { p_recorder: second })).data).toBe('Second-pass')
    // Channels 5 and 6 were added on the primary NVR; nothing on the second one.
    const onPrimary = (await admin().from('cameras').select('channel').eq('recorder_id', primary).order('channel')).data!.map((c) => c.channel)
    expect(onPrimary).toEqual([1, 2, 3, 4, 5, 6])
    expect((await admin().from('cameras').select('id').eq('recorder_id', second)).data).toEqual([])
    // The same through the store form.
    // P2-5c-1 review I-4: a changed NVR address needs the password again (tests/integration/p2-5c-fixes.test.ts), so the form sends it.
    expect((await updateStore(admin(), actor, alpha!.id, { name: 'Alpha', ip: '192.0.2.97', nvr_user: 'viewer', nvr_password: 'Secret-A3', channels: 6 })).ok).toBe(true)
    expect((await admin().from('recorders').select('assets!recorders_asset_fk!inner(ip)').eq('id', second).single()).data).toEqual({ assets: { ip: '192.0.2.150' } })
  })

  it('a new store without a password is reported, not created', async () => {
    const parsed = parseStoresCsv('name,ip,user,password\nGamma,192.0.2.12,viewer,\n')
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res.created).toBe(0)
    expect(res.errors).toEqual([{ line: 2, message: 'A new location needs a password for its NVR.' }])
    const { data } = await admin().from('locations').select('id').eq('org_id', orgId).eq('code', 'GAMMA')
    expect(data).toEqual([])
  })

  it('imports devices, links them to stores by code and reports unknown stores', async () => {
    const parsed = parseDevicesCsv('name,type,store_code,ip,port\nERP,server,alpha,192.0.2.20,443\nHead office switch,other,,192.0.2.21,\nLost,server,nowhere,192.0.2.22,\n')
    const res = await importDevices(admin(), actor, parsed.rows)
    expect(res.created).toBe(2)
    expect(res.errors).toEqual([{ line: 4, message: 'There is no location with the code NOWHERE.' }])
    const again = await importDevices(admin(), actor, parsed.rows.slice(0, 2))
    expect(again).toEqual({ created: 0, updated: 2, errors: [] })
    // (The stores' NVRs are assets too since P2-5a — recorders — and are not devices of the import.)
    const { data } = await admin().from('assets').select('id').eq('org_id', orgId).eq('is_recorder', false)
    expect(data).toHaveLength(2)
  })

  // P2-5a (brief item 2) replaces "deleting removes its cameras and detaches its devices": deleting is archiving. The location, its
  // cameras and devices are switched off and archived (they keep their location, ids and history) and the recorder keeps its vault
  // login (archive keeps the secret; only the purge of a test organisation removes it). An archived location frees its code.
  it('creates, changes and deletes (archives) one store; its cameras and devices are archived with it, nothing is erased', async () => {
    const made = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.30', nvr_user:'viewer', nvr_password: 'Secret-D1', zone: 'up', channels: 3 })
    if (!made.ok) throw new Error(made.error)
    expect((await password(made.storeId)).data).toBe('Secret-D1')
    // The service logs the refused duplicate; keep that expected line out of the test output.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dup = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.31', nvr_user:'viewer', nvr_password: 'x', channels: 0 })
    logged.mockRestore()
    expect(dup.ok).toBe(false)

    expect((await updateStore(admin(), actor, made.storeId, { name: 'Delta', ip: '192.0.2.32', nvr_user:'viewer', nvr_password: 'Secret-D2', zone: 'UP', channels: 3 })).ok).toBe(true)
    expect((await password(made.storeId)).data).toBe('Secret-D2')

    const dev = await createDevice(admin(), actor, { name: 'Counter', type: 'footfall', store_id: made.storeId, ip: '192.0.2.33' })
    if (!dev.ok) throw new Error(dev.error)
    const camsBefore = (await admin().from('cameras').select('id').eq('location_id', made.storeId)).data!
    expect(camsBefore).toHaveLength(3)
    expect((await deleteStore(admin(), actor, made.storeId)).ok).toBe(true)
    expect((await admin().from('locations').select('archived_at, is_active').eq('id', made.storeId).single()).data!.is_active).toBe(false)
    const { data: cams } = await admin().from('cameras').select('id, archived_at').eq('location_id', made.storeId)
    expect(cams?.map((c) => c.id).sort()).toEqual(camsBefore.map((c) => c.id).sort())
    expect(cams?.every((c) => c.archived_at !== null)).toBe(true)
    const { data: d } = await admin().from('assets').select('location_id, enabled, archived_at').eq('id', dev.deviceId).single()
    expect(d).toMatchObject({ location_id: made.storeId, enabled: false })
    expect(d?.archived_at).not.toBeNull()
    const rec = (await admin().from('recorders').select('id').eq('location_id', made.storeId).single()).data!.id
    expect((await admin().rpc('recorder_read_credential', { p_recorder: rec })).data).toBe('Secret-D2')
    expect((await deleteStore(admin(), actor, made.storeId)).ok).toBe(false) // already archived: "Store not found."
    // The code is free again for a new location.
    const again = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.34', nvr_user:'viewer', nvr_password: 'Secret-D3', channels: 0 })
    expect(again.ok).toBe(true)
  })

  it('changes and deletes a device, and refuses a store of another organisation', async () => {
    const dev = await createDevice(admin(), actor, { name: 'Scanner', type: 'attendance', ip: '192.0.2.40', tcp_port: 4370 })
    if (!dev.ok) throw new Error(dev.error)
    expect((await updateDevice(admin(), actor, dev.deviceId, { name: 'Scanner 2', type: 'attendance', ip: '192.0.2.41', tcp_port: 4370 })).ok).toBe(true)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('locations').insert({ org_id: otherOrg, code: 'ZZ', name: 'ZZ' }).select('id').single()
    expect((await createDevice(admin(), actor, { name: 'Bad', type: 'server', ip: '192.0.2.42', store_id: other!.id })).ok).toBe(false)
    await cleanupOrg(otherOrg)
    expect((await deleteDevice(admin(), actor, dev.deviceId)).ok).toBe(true)
  })

  it('a location\'s NVR is not a device: the device screens refuse to change or delete it (review M4)', async () => {
    const made = await createStore(admin(), actor, { name: 'Echo', ip: '192.0.2.60', nvr_user:'viewer', nvr_password: 'Secret-E', channels: 0 })
    if (!made.ok) throw new Error(made.error)
    const nvr = (await admin().rpc('recorder_primary_of', { p_location: made.storeId })).data as string
    const before = (await admin().from('assets').select('name, ip, enabled, archived_at').eq('id', nvr).single()).data
    expect(await updateDevice(admin(), actor, nvr, { name: 'Renamed', type: 'server', ip: '192.0.2.61' }))
      .toEqual({ ok: false, error: 'This is the NVR of a location. Change it under Locations and NVRs.' })
    expect(await deleteDevice(admin(), actor, nvr)).toEqual({ ok: false, error: 'This is the NVR of a location. Change it under Locations and NVRs.' })
    expect((await admin().from('assets').select('name, ip, enabled, archived_at').eq('id', nvr).single()).data).toEqual(before)
  })

  it('only administrators may change inventory', async () => {
    const viewer: Actor = { id: crypto.randomUUID(), orgId, role: 'user' }
    expect((await createDevice(admin(), viewer, { name: 'X', type: 'server', ip: '192.0.2.50' })).ok).toBe(false)
    expect((await createStore(admin(), viewer, { name: 'X', ip: '192.0.2.51', nvr_user:'u', nvr_password: 'p', channels: 0 })).ok).toBe(false)
  })
})
