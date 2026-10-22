import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { createDevice } from '@/lib/inventory/devices'
import { createStore, deleteStore } from '@/lib/inventory/stores'
import { adminClient, cleanupOrg, createOrg, createSite, createUser } from '../setup/fixtures'

const admin = () => adminClient()

describe('database hardening', () => {
  let orgId: string
  let actor: Actor
  let recorderId: string

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
    // P2-5b: the NVR is a recorder; its login is saved and read through the recorder-keyed functions only.
    recorderId = (await createSite(orgId, { code: 'HARD', name: 'Hardening', host: '127.0.0.1', username: 'u' })).recorderId
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
    const empty = await admin().rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: '' })
    expect(empty.error).not.toBeNull()

    const first = `Nvr-${randomUUID()}`
    expect((await admin().rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: first })).error).toBeNull()
    // The recorder owns the vault pointer and it can only be written by the credential functions (a stale pointer cannot be planted).
    expect((await admin().from('recorders').update({ secret_id: randomUUID() }).eq('id', recorderId)).error?.code).toBe('42501')
    // A pointer to a vault row that no longer exists (as after a partial failure) is replaced by a new secret.
    const pointer = (await admin().from('recorders').select('secret_id').eq('id', recorderId).single()).data!.secret_id
    expect(pointer).not.toBeNull()
    const second = `Nvr-${randomUUID()}`
    expect((await admin().rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: second })).error).toBeNull()
    expect((await admin().rpc('recorder_read_credential', { p_recorder: recorderId })).data).toBe(second)
    // P2-5b: the location-keyed wrappers are gone.
    expect((await admin().rpc('nvr_read_credential' as never, { p_store: randomUUID() } as never)).error?.code).toBe('PGRST202')
  })

  it('two simultaneous saves of an NVR password both succeed and leave one of them', async () => {
    const a = `Nvr-${randomUUID()}`
    const b = `Nvr-${randomUUID()}`
    const [ra, rb] = await Promise.all([
      admin().rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: a }),
      admin().rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: b }),
    ])
    expect(ra.error).toBeNull()
    expect(rb.error).toBeNull()
    const read = (await admin().rpc('recorder_read_credential', { p_recorder: recorderId })).data
    expect([a, b]).toContain(read)
  })

  // P2-5a (brief item 2): "deleteStore keeps the store when its vault secret cannot be removed" protected against an orphaned secret
  // after a hard delete. Deleting is archiving now: the row and the recorder's secret are both kept (restore brings them back), so no
  // secret can be orphaned; a failure of the archive itself leaves the store as it was.
  it('deleteStore archives the store and keeps its vault secret; a failing archive leaves the store active', async () => {
    const made = await createStore(admin(), actor, { name: 'Keeper', ip: '192.0.2.60', nvr_user: 'viewer', nvr_password: 'Secret-K1', channels: 0 })
    if (!made.ok) throw new Error(made.error)
    const real = admin()
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'rpc') {
          return (fn: string, args: object) =>
            fn === 'inventory_archive' ? Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }) : (target.rpc as (f: string, a: object) => unknown)(fn, args)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    expect((await deleteStore(failing, actor, made.storeId)).ok).toBe(false)
    expect((await real.from('locations').select('is_active, archived_at').eq('id', made.storeId).single()).data).toEqual({ is_active: true, archived_at: null })
    expect((await deleteStore(real, actor, made.storeId)).ok).toBe(true)
    expect((await real.from('locations').select('archived_at').eq('id', made.storeId).single()).data?.archived_at).not.toBeNull()
    const rec = (await real.from('recorders').select('id').eq('location_id', made.storeId).single()).data!.id
    expect((await real.rpc('recorder_read_credential', { p_recorder: rec })).data).toBe('Secret-K1')
  })
})
