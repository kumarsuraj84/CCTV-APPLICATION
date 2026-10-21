import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/users'
import { createDevice } from '@/lib/inventory/devices'
import { createStore, deleteStore } from '@/lib/inventory/stores'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

const admin = () => adminClient()

describe('database hardening', () => {
  let orgId: string
  let actor: Actor
  let storeId: string

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
    const { data } = await admin()
      .from('stores')
      .insert({ org_id: orgId, code: 'HARD', name: 'Hardening', nvr_ip: '127.0.0.1', nvr_username: 'u' })
      .select('id')
      .single()
    storeId = data!.id
  })
  afterAll(() => cleanupOrg(orgId))

  it('no public table is writable by signed-in users or readable by anon, and default access is closed', async () => {
    const { data, error } = await admin().rpc('privilege_violations')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('only the service role may call privilege_violations', async () => {
    const person = await createUser(orgId, 'user')
    const denied = await person.client.rpc('privilege_violations')
    expect(denied.error?.code).toBe('42501')
  })

  it('refuses two devices with the same address and port, also when the port is empty', async () => {
    const a = await createDevice(admin(), actor, { name: 'One', type: 'server', ip: '192.0.2.50', tcp_port: 443 })
    expect(a.ok).toBe(true)
    expect((await createDevice(admin(), actor, { name: 'Two', type: 'server', ip: '192.0.2.50', tcp_port: 443 })).ok).toBe(false)
    expect((await createDevice(admin(), actor, { name: 'Three', type: 'other', ip: '192.0.2.51' })).ok).toBe(true)
    expect((await createDevice(admin(), actor, { name: 'Four', type: 'other', ip: '192.0.2.51' })).ok).toBe(false)
    expect((await createDevice(admin(), actor, { name: 'Five', type: 'server', ip: '192.0.2.50', tcp_port: 8443 })).ok).toBe(true)
  })

  it('refuses an empty NVR password and copes with a stale vault pointer', async () => {
    const empty = await admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: '' })
    expect(empty.error).not.toBeNull()

    const first = `Nvr-${randomUUID()}`
    expect((await admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: first })).error).toBeNull()
    // Point the store at a vault row that does not exist, as after a partial failure.
    await admin().from('stores').update({ nvr_secret_id: randomUUID() }).eq('id', storeId)
    const second = `Nvr-${randomUUID()}`
    expect((await admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: second })).error).toBeNull()
    expect((await admin().rpc('nvr_read_credential', { p_store: storeId })).data).toBe(second)
  })

  it('two simultaneous saves of an NVR password both succeed and leave one of them', async () => {
    const a = `Nvr-${randomUUID()}`
    const b = `Nvr-${randomUUID()}`
    const [ra, rb] = await Promise.all([
      admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: a }),
      admin().rpc('nvr_store_credential', { p_store: storeId, p_secret: b }),
    ])
    expect(ra.error).toBeNull()
    expect(rb.error).toBeNull()
    const read = (await admin().rpc('nvr_read_credential', { p_store: storeId })).data
    expect([a, b]).toContain(read)
  })

  it('deleteStore keeps the store when its vault secret cannot be removed', async () => {
    const made = await createStore(admin(), actor, { name: 'Keeper', ip: '192.0.2.60', nvr_username: 'viewer', nvr_password: 'Secret-K1', channels: 0 })
    if (!made.ok) throw new Error(made.error)
    const real = admin()
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'rpc') {
          return (fn: string, args: object) =>
            fn === 'nvr_delete_credential' ? Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }) : (target.rpc as (f: string, a: object) => unknown)(fn, args)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const res = await deleteStore(failing, actor, made.storeId)
    expect(res.ok).toBe(false)
    const { data } = await real.from('stores').select('id').eq('id', made.storeId)
    expect(data).toHaveLength(1)
    expect((await deleteStore(real, actor, made.storeId)).ok).toBe(true)
  })
})
