import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor, AdminClient } from '@/lib/admin/users'
import { createStore, updateStore } from '@/lib/inventory/stores'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

// The real admin client, except that creating cameras fails. Everything else is the real local database.
function failingCameras(): AdminClient {
  const real = adminClient()
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => (table === 'cameras' ? { upsert: async () => ({ error: { code: 'XX000', message: 'camera table down' } }) } : target.from(table as 'stores'))
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as AdminClient
}

const input = { name: 'Camfail', code: 'CF1', city: 'Pune', zone: 'BR', state: 'BR', address: '', ip: '192.0.2.77', rtsp_port: 554, http_port: 80, nvr_username: 'viewer', nvr_password: 'Secret-CF1', channels: 3, is_active: true }

describe('a store is saved but its cameras cannot be created', () => {
  let orgId: string
  let actor: Actor
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
  })
  afterEach(() => logged.mockClear())
  afterAll(async () => {
    logged.mockRestore()
    await cleanupOrg(orgId)
  })

  it('createStore keeps the store, writes the audit row and returns a plain error', async () => {
    const res = await createStore(failingCameras(), actor, input)
    expect(res).toEqual({ ok: false, error: 'The store was saved, but its cameras could not be created. Open the store and save it again.' })
    const { data: store } = await adminClient().from('stores').select('id').eq('org_id', orgId).eq('code', 'CF1').single()
    expect(store).not.toBeNull()
    const { data: audit } = await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('entity_id', store!.id)
    expect(audit?.map((a) => a.action)).toEqual(['store_created'])
    const { count } = await adminClient().from('cameras').select('id', { count: 'exact', head: true }).eq('store_id', store!.id)
    expect(count).toBe(0)
    expect(JSON.stringify(res)).not.toContain('camera table down')
  })

  it('updateStore does the same, and a retry with a working client creates the cameras', async () => {
    const { data: store } = await adminClient().from('stores').select('id').eq('org_id', orgId).eq('code', 'CF1').single()
    const res = await updateStore(failingCameras(), actor, store!.id, { ...input, nvr_password: '', city: 'Patna' })
    expect(res).toEqual({ ok: false, error: 'The store was saved, but its cameras could not be created. Open the store and save it again.' })
    const { data: row } = await adminClient().from('stores').select('city').eq('id', store!.id).single()
    expect(row?.city).toBe('Patna')
    const { data: audit } = await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('entity_id', store!.id).order('created_at')
    expect(audit?.map((a) => a.action)).toEqual(['store_created', 'store_updated'])

    const retry = await updateStore(adminClient(), actor, store!.id, { ...input, nvr_password: '' })
    expect(retry).toEqual({ ok: true })
    const { count } = await adminClient().from('cameras').select('id', { count: 'exact', head: true }).eq('store_id', store!.id)
    expect(count).toBe(3)
  })
})
