import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCapabilities } from '@/lib/auth/capabilities'
import { storesForCapability } from '@/lib/queries/access'
import { listVisibleGroups } from '@/lib/queries/groups'
import { adminClient, atCamera, atLocation, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P2-2: the index lists of the Live and Playback screens show only stores (and counts) where the person holds that capability, and the
// live index's camera groups count only cameras the person may watch live. These are display decisions from the request's summary;
// opening anything is checked again by the database.

const admin = () => adminClient()

describe('lists per capability', () => {
  let orgId: string
  let s1: string, s2: string, s3: string
  let c11: string, c12: string, c21: string, c22: string, c31: string
  let group: string
  let liveStore: TestUser, liveCamera: TestUser, playbackOnly: TestUser, orgWide: TestUser, itOnly: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    const store = async (code: string) => (await admin().from('locations').insert({ org_id: orgId, code, name: code, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    const camera = async (s: string, ch: number) => (await admin().from('cameras').insert({ org_id: orgId, location_id: s, channel: ch, name: `cam ${ch}` }).select('id').single()).data!.id
    s1 = await store('P1')
    s2 = await store('P2')
    s3 = await store('P3')
    c11 = await camera(s1, 1)
    c12 = await camera(s1, 2)
    c21 = await camera(s2, 1)
    c22 = await camera(s2, 2)
    c31 = await camera(s3, 1)
    liveStore = await createUser(orgId, 'user')
    liveCamera = await createUser(orgId, 'user')
    playbackOnly = await createUser(orgId, 'user')
    orgWide = await createUser(orgId, 'user')
    itOnly = await createUser(orgId, 'user')
    await grant(orgId, liveStore.id, 'cctv.live', atLocation(s1))
    await grant(orgId, liveStore.id, 'cctv.playback', atLocation(s2))
    await grant(orgId, liveCamera.id, 'cctv.live', [atCamera(c21), atCamera(c31)])
    await grant(orgId, liveCamera.id, 'cctv.live', atLocation(s3))
    await grant(orgId, playbackOnly.id, 'cctv.playback', atLocation(s1))
    await grant(orgId, orgWide.id, 'cctv.live', ORG_SCOPE)
    await grant(orgId, itOnly.id, 'it.inventory.view', ORG_SCOPE)
    group = (await admin().from('camera_groups').insert({ org_id: orgId, name: 'Doors', created_by: orgWide.id }).select('id').single()).data!.id
    await admin().from('camera_group_items').insert([c11, c12, c21, c22].map((camera_id) => ({ org_id: orgId, group_id: group, camera_id })))
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
  })

  const stores = async (u: TestUser, cap: 'cctv.live' | 'cctv.playback') =>
    (await storesForCapability(u.client, await readCapabilities(u.client), cap)).map((s) => [s.code, s.camera_count])

  it('a store grant: that store with all its cameras, only for the capability granted there', async () => {
    expect(await stores(liveStore, 'cctv.live')).toEqual([['P1', 2]])
    expect(await stores(liveStore, 'cctv.playback')).toEqual([['P2', 2]])
  })

  it('camera grants count only those cameras; a store covered whole counts all of them', async () => {
    expect(await stores(liveCamera, 'cctv.live')).toEqual([['P2', 1], ['P3', 1]])
  })

  it('playback-only: nothing on the live index; organisation-wide: every store', async () => {
    expect(await stores(playbackOnly, 'cctv.live')).toEqual([])
    expect(await stores(orgWide, 'cctv.live')).toEqual([['P1', 2], ['P2', 2], ['P3', 1]])
    expect(await stores(itOnly, 'cctv.live')).toEqual([])
  })

  it('group counts can be limited to cameras open for one capability', async () => {
    const count = async (u: TestUser) => {
      const list = await listVisibleGroups(u.client, { capabilities: await readCapabilities(u.client), capability: 'cctv.live' })
      return list.map((g) => [g.name, g.camera_count])
    }
    expect(await count(orgWide)).toEqual([['Doors', 4]])
    expect(await count(liveStore)).toEqual([['Doors', 2]]) // sees four (live on P1, playback on P2) but may watch two
    expect(await count(liveCamera)).toEqual([['Doors', 1]])
    expect(await count(playbackOnly)).toEqual([['Doors', 0]])
    // Without a capability the count is every camera the person may see.
    expect((await listVisibleGroups(liveStore.client)).map((g) => g.camera_count)).toEqual([4])
  })
})
