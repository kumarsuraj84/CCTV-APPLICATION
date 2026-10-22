import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { archiveInventory, restoreInventory } from '@/lib/inventory/archive'
import { startFakeGo2rtc } from '../helpers/fake-go2rtc'
import { adminClient, atCamera, atRecorder, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const version = async (user: string) => (await admin().from('profiles').select('access_version').eq('id', user).single()).data!.access_version

// P2-5b (5a carry-forward): the archive / restore services the P2-5c screens will call. The database does the work and the access
// version signalling (inventory_affected_people → access_bump_versions); the services check the caller and speak plainly.
describe('archive and restore services', () => {
  let orgId: string
  let otherOrg: string
  let loc: string, rec: string, cam: string, other: string
  let me: TestUser, plainAdmin: TestUser, camHolder: TestUser, recHolder: TestUser
  let actor: Actor
  const clients = (u: TestUser) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    loc = await createLocation(orgId, { code: 'ARC' })
    rec = await createRecorder(orgId, loc, { host: '10.77.0.1' })
    cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
    other = await createLocation(otherOrg, { code: 'ARX' })
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, 'admin.inventory')
    actor = { id: me.id, orgId, role: 'admin' }
    plainAdmin = await createUser(orgId, 'admin')
    await grant(orgId, plainAdmin.id, READ_EVERYTHING)
    camHolder = await createUser(orgId, 'user')
    await grant(orgId, camHolder.id, 'cctv.live', atCamera(cam))
    recHolder = await createUser(orgId, 'user')
    await grant(orgId, recHolder.id, 'cctv.live', atRecorder(rec))
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('refuses an NVR that still has cameras, in plain words, and changes nothing', async () => {
    expect(await archiveInventory(clients(me), actor, 'recorder', rec)).toEqual({ ok: false, error: 'Move or archive the cameras of this NVR first.' })
    expect((await admin().from('assets').select('archived_at').eq('id', rec).single()).data?.archived_at).toBeNull()
  })

  it('archives a camera (its holders\' access version goes up), restores it unmapped, and audits the person', async () => {
    const before = await version(camHolder.id)
    expect(await archiveInventory(clients(me), actor, 'camera', cam)).toEqual({ ok: true })
    expect(await version(camHolder.id)).toBeGreaterThan(before)
    expect((await camHolder.client.from('cameras').select('id')).data).toEqual([])
    const mid = await version(camHolder.id)
    expect(await restoreInventory(clients(me), actor, 'camera', cam)).toEqual({ ok: true })
    expect(await version(camHolder.id)).toBeGreaterThan(mid)
    expect((await admin().from('cameras').select('recorder_id, archived_at').eq('id', cam).single()).data).toEqual({ recorder_id: null, archived_at: null })
    const audit = (await admin().from('admin_audit_log').select('action, actor_id').eq('entity_id', cam).order('created_at')).data!
    expect(audit.map((a) => [a.action, a.actor_id])).toEqual([['inventory_archived', me.id], ['inventory_restored', me.id]])
  })

  it('an NVR without cameras can be archived and restored; recorder-grant holders are signalled', async () => {
    const before = await version(recHolder.id)
    expect(await archiveInventory(clients(me), actor, 'recorder', rec)).toEqual({ ok: true }) // its camera is unmapped since the restore
    expect(await version(recHolder.id)).toBeGreaterThan(before)
    expect(await restoreInventory(clients(me), actor, 'recorder', rec)).toEqual({ ok: true })
    expect((await admin().from('assets').select('archived_at, enabled').eq('id', rec).single()).data).toEqual({ archived_at: null, enabled: true })
  })

  it('archives and restores a location; a second archive is "not found"', async () => {
    expect(await archiveInventory(clients(me), actor, 'location', loc)).toEqual({ ok: true })
    expect(await archiveInventory(clients(me), actor, 'location', loc)).toEqual({ ok: false, error: 'Not found.' })
    expect(await restoreInventory(clients(me), actor, 'location', loc)).toEqual({ ok: true })
    expect((await admin().from('locations').select('archived_at, is_active').eq('id', loc).single()).data).toEqual({ archived_at: null, is_active: true })
  })

  it('review M-4: archiving a camera, or a location with its cameras, removes their live video streams from the video server', async () => {
    const site = await createLocation(orgId, { code: 'ARCS' })
    const nvr = await createRecorder(orgId, site, { host: '10.77.0.2' })
    const one = await createCamera(orgId, { locationId: site, recorderId: nvr, channel: 1 })
    const two = await createCamera(orgId, { locationId: site, recorderId: nvr, channel: 2 })
    const go2rtc = await startFakeGo2rtc()
    try {
      for (const id of [one, two, cam]) for (const kind of ['sub', 'main']) go2rtc.streams.set(`cam_${id}_${kind}`, `rtsp://old/${id}`)
      expect(await archiveInventory({ ...clients(me), go2rtc: go2rtc.client }, actor, 'camera', one)).toEqual({ ok: true })
      expect([...go2rtc.streams.keys()].filter((n) => n.includes(one))).toEqual([])
      expect(go2rtc.streams.has(`cam_${two}_main`)).toBe(true)
      expect(await archiveInventory({ ...clients(me), go2rtc: go2rtc.client }, actor, 'location', site)).toEqual({ ok: true })
      expect([...go2rtc.streams.keys()].sort()).toEqual([`cam_${cam}_main`, `cam_${cam}_sub`])
      // The video server not answering never undoes or fails the archive (the stream ends with the token anyway).
      go2rtc.failAll = true
      const three = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3 })
      expect(await archiveInventory({ ...clients(me), go2rtc: go2rtc.client }, actor, 'camera', three)).toEqual({ ok: true })
    } finally {
      await go2rtc.close()
    }
  })

  it('only administrators with admin.inventory, only their own organisation, only real kinds and ids', async () => {
    expect(await archiveInventory(clients(plainAdmin), { id: plainAdmin.id, orgId, role: 'admin' }, 'camera', cam)).toEqual({ ok: false, error: 'Only administrators can archive or restore.' })
    expect(await archiveInventory(clients(camHolder), { id: camHolder.id, orgId, role: 'user' }, 'camera', cam)).toEqual({ ok: false, error: 'Only administrators can archive or restore.' })
    expect(await archiveInventory(clients(me), actor, 'location', other)).toEqual({ ok: false, error: 'Not found.' })
    expect(await archiveInventory(clients(me), actor, 'everything' as never, loc)).toEqual({ ok: false, error: 'Not found.' })
    expect(await restoreInventory(clients(me), actor, 'camera', 'not-an-id')).toEqual({ ok: false, error: 'Not found.' })
    expect((await admin().from('locations').select('archived_at').eq('id', other).single()).data?.archived_at).toBeNull()
  })
})
