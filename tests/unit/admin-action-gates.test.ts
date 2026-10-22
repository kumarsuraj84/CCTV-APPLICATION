import { beforeEach, describe, expect, it, vi } from 'vitest'

// P2-2 (brief item 5): every admin action asks for an administrative role AND its admin.* capability through requireAdministration,
// before any client is made. One consistent rule: users -> admin.users, access -> admin.access, inventory, import and discovery ->
// admin.inventory. Check now needs it.monitoring.operate (the summary first, then the database as the person).

const m = vi.hoisted(() => ({ asked: [] as string[], refuse: false, profile: null as unknown, clients: 0 }))

vi.mock('@/lib/auth/profile', () => ({
  requireAdministration: async (cap: string) => {
    m.asked.push(cap)
    if (m.refuse) throw new Error('REDIRECT:/home')
    return { id: 'u1', org_id: 'o1', role: 'admin' }
  },
  requireProfile: async () => m.profile,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => (m.clients++, { tag: 'admin' }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => (m.clients++, { tag: 'rls' }) }))
vi.mock('@/lib/admin/users', () => ({
  createUser: async () => ({ ok: false, error: 'x' }), updateUser: async () => ({ ok: false, error: 'x' }),
  resetUserPassword: async () => ({ ok: false, error: 'x' }), setUserAccess: async () => ({ ok: false, error: 'x' }),
}))
vi.mock('@/lib/inventory/stores', () => ({ createStore: async () => ({ ok: false, error: 'x' }), updateStore: async () => ({ ok: false, error: 'x' }), deleteStore: async () => ({ ok: false, error: 'x' }) }))
vi.mock('@/lib/inventory/devices', () => ({ createDevice: async () => ({ ok: false, error: 'x' }), updateDevice: async () => ({ ok: false, error: 'x' }), deleteDevice: async () => ({ ok: false, error: 'x' }) }))
vi.mock('@/lib/import/apply', () => ({ importStores: async () => ({}), importDevices: async () => ({}) }))
vi.mock('@/lib/monitor/discovery', () => ({ discoverStoreCameras: async () => ({ ok: false, error: 'x' }) }))
const checkNow = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/monitor/check-now', () => ({ requestCheckNow: (...a: unknown[]) => checkNow(...(a as [])), MSG_CHECK_NOT_ALLOWED: 'You are not allowed to start a check.' }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => ({ limited: false }) }))

beforeEach(() => {
  m.asked = []
  m.refuse = false
  m.clients = 0
  checkNow.mockClear()
})

const fd = () => new FormData()

describe('admin actions', () => {
  it('ask for the capability that matches what they change', async () => {
    const users = await import('@/lib/actions/admin/users')
    const inv = await import('@/lib/actions/admin/inventory')
    const mon = await import('@/lib/actions/admin/monitoring')
    const cases: [string, () => Promise<unknown>][] = [
      ['admin.users', () => users.createUserAction({}, fd())],
      ['admin.users', () => users.setActiveAction('x', true)],
      ['admin.users', () => users.setRoleAction('x', 'user')],
      ['admin.users', () => users.resetPasswordAction('x')],
      ['admin.access', () => users.saveAccessAction('x', { storeIds: [], zones: [], cameraIds: [] })],
      ['admin.inventory', () => inv.saveStoreAction({}, fd())],
      ['admin.inventory', () => inv.deleteStoreAction('x')],
      ['admin.inventory', () => inv.saveDeviceAction({}, fd())],
      ['admin.inventory', () => inv.deleteDeviceAction('x')],
      ['admin.inventory', () => inv.importStoresAction({}, fd())],
      ['admin.inventory', () => inv.importDevicesAction({}, fd())],
      ['admin.inventory', () => mon.discoverCamerasAction('x')],
    ]
    for (const [cap, call] of cases) {
      m.asked = []
      await call()
      expect(m.asked, cap).toEqual([cap])
    }
  })

  it('make no client and change nothing when the gate refuses', async () => {
    m.refuse = true
    const users = await import('@/lib/actions/admin/users')
    const inv = await import('@/lib/actions/admin/inventory')
    const mon = await import('@/lib/actions/admin/monitoring')
    for (const call of [() => users.createUserAction({}, fd()), () => users.saveAccessAction('x', { storeIds: [], zones: [], cameraIds: [] }), () => inv.saveStoreAction({}, fd()), () => mon.discoverCamerasAction('x')]) {
      await expect(call()).rejects.toThrow('REDIRECT:/home')
    }
    expect(m.clients).toBe(0)
  })
})

describe('check now (action)', () => {
  const caps = (list: string[]) => ({ failed: false, grants: Object.fromEntries(list.map((c) => [c, { organization: false, locations: ['l1'], cameras: [], assets: [] }])) })
  it('is refused without it.monitoring.operate, whatever the role, before any client is made', async () => {
    const { requestCheckNowAction } = await import('@/lib/actions/monitor')
    for (const role of ['operator', 'admin', 'platform_owner']) {
      m.profile = { id: 'u1', org_id: 'o1', role, capabilities: caps(['it.monitoring.view', 'cctv.live', 'admin.inventory']) }
      expect(await requestCheckNowAction()).toEqual({ error: 'You are not allowed to start a check.' })
    }
    expect(m.clients).toBe(0)
    expect(checkNow).not.toHaveBeenCalled()
  })
  it('with it.monitoring.operate (any role) the service is asked with the person\'s own client', async () => {
    const { requestCheckNowAction } = await import('@/lib/actions/monitor')
    m.profile = { id: 'u1', org_id: 'o1', role: 'user', capabilities: caps(['it.monitoring.operate']) }
    expect((await requestCheckNowAction()).ok).toBe(true)
    expect(checkNow).toHaveBeenCalledTimes(1)
    expect((checkNow.mock.calls[0] as unknown[])[0]).toEqual({ admin: { tag: 'admin' }, rls: { tag: 'rls' } })
  })
})
