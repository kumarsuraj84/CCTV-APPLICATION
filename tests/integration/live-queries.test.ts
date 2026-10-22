import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getLiveScope } from '@/lib/queries/live'
import { adminClient, atLocation, CCTV_VIEW, cleanupOrg, createOrg, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()

describe('getLiveScope', () => {
  let orgId: string, otherOrg: string
  let sA: string, sB: string, sOff: string
  let a1: string, a2: string, aOff: string, b1: string, off1: string, foreign: string
  let viewer: TestUser, manager: TestUser, nobody: TestUser
  let group: string
  const now = new Date()

  async function store(org: string, code: string, active = true) {
    const { data, error } = await admin().from('stores').insert({ org_id: org, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'v', is_active: active }).select('id').single()
    if (error || !data) throw new Error(error?.message)
    return data.id
  }
  async function camera(org: string, storeId: string, channel: number, name: string, active = true) {
    const { data, error } = await admin().from('cameras').insert({ org_id: org, store_id: storeId, channel, name, is_active: active }).select('id').single()
    if (error || !data) throw new Error(error?.message)
    return data.id
  }
  const setState = async (id: string, status: 'up' | 'down', minutesAgo: number) => {
    const at = new Date(now.getTime() - minutesAgo * 60_000).toISOString()
    const { error } = await admin().from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: id, status, last_checked_at: at, last_up_at: status === 'up' ? at : null })
    if (error) throw new Error(error.message)
  }

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    sA = await store(orgId, 'LA')
    sB = await store(orgId, 'LB')
    sOff = await store(orgId, 'LO', false)
    a1 = await camera(orgId, sA, 2, 'Second')
    a2 = await camera(orgId, sA, 1, 'First')
    aOff = await camera(orgId, sA, 3, 'Switched off', false)
    b1 = await camera(orgId, sB, 1, 'B one')
    off1 = await camera(orgId, sOff, 1, 'In a switched-off store')
    foreign = await camera(otherOrg, await store(otherOrg, 'LX'), 1, 'Other organisation')
    viewer = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    // AC-8 (P2-1): the manager sees everything here only because of these explicit organisation-wide grants.
    await grant(orgId, manager.id, READ_EVERYTHING)
    nobody = await createUser(orgId, 'user')
    const g = await admin().from('camera_groups').insert({ org_id: orgId, name: 'Doors', created_by: manager.id }).select('id').single()
    group = g.data!.id
    await admin().from('camera_group_items').insert([a1, b1].map((camera_id) => ({ org_id: orgId, group_id: group, camera_id })))
    await grant(orgId, viewer.id, CCTV_VIEW, atLocation(sA)) // a store grant, as explicit live + playback grants (P2-1)
    await setState(a1, 'up', 1)
    await setState(a2, 'down', 1)
    await setState(b1, 'up', 60)
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('a store: its working cameras in channel order, with the status each one has', async () => {
    const scope = await getLiveScope(manager.client, { store: sA }, now)
    expect(scope).toMatchObject({ kind: 'store', title: 'LA · Store LA' })
    expect(scope!.cameras.map((c) => [c.name, c.channel, c.storeCode, c.status, c.stale])).toEqual([
      ['First', 1, 'LA', 'down', false],
      ['Second', 2, 'LA', 'up', false],
    ])
  })

  it('a live result that is old counts as not checked lately; a camera never checked has no status', async () => {
    const scope = await getLiveScope(manager.client, { store: sB }, now)
    expect(scope!.cameras.map((c) => [c.status, c.stale])).toEqual([['up', true]])
    await admin().from('cameras').insert({ org_id: orgId, store_id: sB, channel: 9, name: 'Never checked' })
    const again = await getLiveScope(manager.client, { store: sB }, now)
    expect(again!.cameras.find((c) => c.name === 'Never checked')).toMatchObject({ status: null, stale: false })
  })

  it('a group: only the cameras the person may see', async () => {
    expect((await getLiveScope(manager.client, { group }, now))!.cameras.map((c) => c.id).sort()).toEqual([a1, b1].sort())
    expect((await getLiveScope(viewer.client, { group }, now))!.cameras.map((c) => c.id)).toEqual([a1])
  })

  it('one camera', async () => {
    const scope = await getLiveScope(viewer.client, { camera: a1 }, now)
    expect(scope).toMatchObject({ kind: 'camera', title: 'Second' })
    expect(scope!.cameras).toHaveLength(1)
  })

  it('anything the person may not see, or that does not exist, looks the same: not found', async () => {
    for (const q of [
      { store: sB }, { store: sOff }, { camera: b1 }, { camera: foreign }, { camera: aOff }, { camera: off1 }, { group: '11111111-1111-4111-8111-111111111111' },
      { store: 'not-an-id' }, { camera: 'x' }, { group: 'y' }, {},
    ]) {
      expect(await getLiveScope(viewer.client, q, now), JSON.stringify(q)).toBeNull()
    }
    expect(await getLiveScope(nobody.client, { store: sA }, now)).toBeNull()
    expect(await getLiveScope(nobody.client, { group }, now)).toBeNull()
  })
})
