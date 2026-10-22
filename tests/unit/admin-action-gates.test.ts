import { existsSync } from 'node:fs'
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
  mayAdminister: () => true,
}))
vi.mock('@/lib/admin/access', () => ({
  previewChange: async () => ({ ok: false, error: 'x' }), applyChange: async () => ({ ok: false, error: 'x' }), keepReviewed: async () => ({ ok: false, error: 'x' }),
  reviewBeforeReactivation: async () => ({ ok: false, error: 'x' }), selfConfirmReview: async () => ({ ok: false, error: 'x' }), revokeAll: async () => ({ ok: false, error: 'x' }), MSG_CONFLICT: 'conflict',
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
// P2-6: the user-administration actions use the web app's role plus GoTrue's admin API (createUserAdminClient).
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => (m.clients++, { tag: 'admin' }), createUserAdminClient: () => (m.clients++, { tag: 'admin' }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => (m.clients++, { tag: 'rls' }) }))
vi.mock('@/lib/admin/users', () => ({
  createUser: async () => ({ ok: false, error: 'x' }), updateUser: async () => ({ ok: false, error: 'x' }),
  resetUserPassword: async () => ({ ok: false, error: 'x' }),
}))
vi.mock('@/lib/inventory/stores', () => ({ createStore: async () => ({ ok: false, error: 'x' }), updateStore: async () => ({ ok: false, error: 'x' }), deleteStore: async () => ({ ok: false, error: 'x' }) }))
vi.mock('@/lib/inventory/devices', () => ({ createDevice: async () => ({ ok: false, error: 'x' }), updateDevice: async () => ({ ok: false, error: 'x' }), deleteDevice: async () => ({ ok: false, error: 'x' }) }))
vi.mock('@/lib/import/apply', () => ({ importStores: async () => ({}), importDevices: async () => ({}) }))
vi.mock('@/lib/monitor/discovery', () => ({ discoverStoreCameras: async () => ({ ok: false, error: 'x' }), discoverRecorderCameras: async () => ({ ok: false, error: 'x' }) }))
// P2-5c-1 services (the actions are tested here for their gate; the services in tests/integration/p2-5c-admin.test.ts).
const no = async () => ({ ok: false, error: 'x' })
vi.mock('@/lib/inventory/hierarchy', () => ({ saveRegion: no, saveCluster: no, previewMove: no, moveNode: no, hierarchyProposals: no, applyProposals: no, previewProposals: no }))
vi.mock('@/lib/inventory/locations', () => ({ saveLocation: no, saveNetworkDefinition: no }))
vi.mock('@/lib/inventory/recorder-admin', () => ({ saveRecorder: no, setRecorderMonitoring: no, testRecorderConnection: no }))
vi.mock('@/lib/inventory/mapping', () => ({ remapCamera: no, mergeCameras: no, previewMerge: no, searchCameras: no }))
vi.mock('@/lib/inventory/findings', () => ({ dismissFinding: no, linkFinding: no }))
vi.mock('@/lib/inventory/assets', () => ({ saveAsset: no, addDependency: no, removeDependency: no, addEndpoint: no, retireEndpoint: no }))
vi.mock('@/lib/inventory/archive', () => ({ archiveInventory: no, restoreInventory: no }))
const checkNow = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/monitor/check-now', () => ({ requestCheckNow: (...a: unknown[]) => checkNow(...(a as [])), MSG_CHECK_NOT_ALLOWED: 'You are not allowed to start a check.' }))
// P2-6 (D-11): the counts are shared (lib/rate-limit-shared.ts); these tests are about the gates, so nobody is ever over a limit.
vi.mock('@/lib/rate-limit-shared', async (orig) => ({ ...(await orig<typeof import('@/lib/rate-limit-shared')>()), refusalFor: async () => null, adminRefusalFor: async () => null }))

beforeEach(() => {
  m.asked = []
  m.refuse = false
  m.clients = 0
  checkNow.mockClear()
})

const fd = () => new FormData()

/**
 * P2-5c-1: every new administration action (regions, clusters, moves, proposals, locations, network, NVRs, mapping, merge,
 * reconciliation, assets, archive and restore from the new screens) asks for admin.inventory first, before any client is made.
 */
function p25c(): (() => Promise<unknown>)[] {
  const load = () => import('@/lib/actions/admin/locations')
  const assets = () => import('@/lib/actions/admin/assets')
  return [
    async () => (await load()).saveRegionAction({}, fd()),
    async () => (await load()).saveClusterAction({}, fd()),
    async () => (await load()).previewMoveAction({ kind: 'location', id: 'x', to: null }),
    async () => (await load()).moveNodeAction({ kind: 'location', id: 'x', to: null }),
    async () => (await load()).applyProposalsAction([]),
    async () => (await load()).saveLocationAction({}, fd()),
    async () => (await load()).saveNetworkAction('x', {}, fd()),
    async () => (await load()).saveRecorderAction('x', {}, fd()),
    async () => (await load()).setMonitoringAction('x', { enabled: false, reason: 'x' }),
    async () => (await load()).testConnectionAction('x'),
    async () => (await load()).discoverRecorderAction('x'),
    async () => (await load()).remapCameraAction({ cameraId: 'x', recorderId: 'y', channel: 1 }),
    async () => (await load()).mergeCamerasAction({ keepId: 'x', duplicateId: 'y', confirmation: 'z' }),
    // P2-5c-1 review round 1: the merge preview (I-5), the organisation-wide camera search (M-2) and the proposal preview (M-1).
    async () => (await load()).previewMergeAction({ keepId: 'x', duplicateId: 'y' }),
    async () => (await load()).searchCamerasAction('door'),
    async () => (await load()).previewProposalsAction([]),
    async () => (await load()).dismissFindingAction('x', 'note'),
    async () => (await load()).linkFindingAction('x'),
    async () => (await load()).archiveNodeAction('location', 'x'),
    async () => (await load()).restoreNodeAction('location', 'x'),
    async () => (await assets()).saveAssetAction({}, fd()),
    async () => (await assets()).addDependencyAction({ childId: 'x', parentId: 'y', kind: 'network' }),
    async () => (await assets()).removeDependencyAction('x'),
    async () => (await assets()).addEndpointAction('x', { spaceId: 'y', host: 'h', port: '', purpose: 'other' }),
    async () => (await assets()).retireEndpointAction('x'),
  ]
}

describe('admin actions', () => {
  it('ask for the capability that matches what they change', async () => {
    const users = await import('@/lib/actions/admin/users')
    const access = await import('@/lib/actions/admin/access')
    const inv = await import('@/lib/actions/admin/inventory')
    const cases: [string, () => Promise<unknown>][] = [
      ['admin.users', () => users.createUserAction({}, fd())],
      ['admin.users', () => users.setActiveAction('x', true)],
      ['admin.users', () => users.setRoleAction('x', 'user')],
      ['admin.users', () => users.resetPasswordAction('x')],
      ['admin.users', () => users.reactivationReviewAction('x')],
      // P2-3: the access editor and the review (the interim saveAccessAction is gone).
      ['admin.access', () => access.previewAccessAction('x', { changes: [], expectedVersion: 0 })],
      ['admin.access', () => access.applyAccessAction('x', { changes: [], expectedVersion: 0, token: '' })],
      ['admin.access', () => access.keepReviewedAction({ grantIds: [] })],
      ['admin.access', () => access.selfConfirmReviewAction({ grantIds: [], reason: '' })],
      ['admin.inventory', () => inv.saveDeviceAction({}, fd())],
      ['admin.inventory', () => inv.deleteDeviceAction('x')],
      ['admin.inventory', () => inv.importDevicesAction({}, fd())],
      ...p25c().map((call): [string, () => Promise<unknown>] => ['admin.inventory', call]),
    ]
    for (const [cap, call] of cases) {
      m.asked = []
      await call()
      expect(m.asked, cap).toEqual([cap])
    }
  })

  // T-1 carry-over (P2-5c re-review N2): the old "Manage stores" page is gone, so its actions are too. importStoresAction posted through the old
  // lenient CSV reader and echoed cell values; no screen used it. The Import page uses the strict reader (lib/actions/admin/import-locations.ts).
  it('no longer offers the actions of the retired "Manage stores" page', async () => {
    const inv = (await import('@/lib/actions/admin/inventory')) as Record<string, unknown>
    for (const name of ['saveStoreAction', 'deleteStoreAction', 'importStoresAction']) expect(inv[name], name).toBeUndefined()
    // …and so is the per-location "Find cameras" action and its button (each NVR has its own on its page; "Find cameras for all locations" has a page).
    expect(existsSync('lib/actions/admin/monitoring.ts')).toBe(false)
    expect(existsSync('components/monitor/FindCamerasButton.tsx')).toBe(false)
  })

  it('make no client and change nothing when the gate refuses', async () => {
    m.refuse = true
    const users = await import('@/lib/actions/admin/users')
    const access = await import('@/lib/actions/admin/access')
    const inv = await import('@/lib/actions/admin/inventory')
    for (const call of [
      () => users.createUserAction({}, fd()), () => users.setActiveAction('x', true, { revokeAll: { grantIds: [], reason: 'x', expectedVersion: 0 } }),
      () => access.previewAccessAction('x', { changes: [], expectedVersion: 0 }), () => access.applyAccessAction('x', { changes: [], expectedVersion: 0, token: '' }),
      () => access.keepReviewedAction({ grantIds: [] }), () => inv.saveDeviceAction({}, fd()), () => inv.importDevicesAction({}, fd()),
      ...p25c(),
    ]) {
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
