// P2-5c-1 review round 1 (.superpowers/sdd/drishti/p2-5c-1-review.md): one test (or more) per finding, against the local database with
// fake NVRs on loopback only. Real NVRs are never contacted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { saveAsset } from '@/lib/inventory/assets'
import { linkFinding, listFindings } from '@/lib/inventory/findings'
import { previewProposals } from '@/lib/inventory/hierarchy'
import { mappingHistories, mappingHistory, mergeCameras, previewMerge, searchCameras } from '@/lib/inventory/mapping'
import { MSG_PASSWORD_AGAIN, saveRecorder, testRecorderConnection } from '@/lib/inventory/recorder-admin'
import { updateStore } from '@/lib/inventory/stores'
import { addGroupRule, createGroup } from '@/lib/groups/service'
import { discoverAllRecorders, discoverRecorderCameras } from '@/lib/monitor/discovery'
import { MSG_LOGIN_BACKOFF } from '@/lib/monitor/login-backoff'
import { getLiveScope } from '@/lib/queries/live'
import { getVisibleGroup, listVisibleGroups } from '@/lib/queries/groups'
import { readCapabilities } from '@/lib/auth/capabilities'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import {
  adminClient, atCamera, atCluster, atLocation, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion, createSite, createUser, grant,
  type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const lists = (channels: { channel: number; name: string; ip: string | null }[]) => () => ({ channelStatus: async () => new Map<number, boolean>(), channels: async () => channels })
const mappingOf = async (camera: string) => (await admin().from('cameras').select('location_id, recorder_id, channel, archived_at').eq('id', camera).single()).data!

describe('P2-5c-1 review round 1', () => {
  let orgId: string
  let me: TestUser
  let actor: Actor
  const c = (u: TestUser = me) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, ['admin.inventory', 'cctv.live', 'cctv.playback', 'it.inventory.view'])
    actor = { id: me.id, orgId, role: 'admin' }
  })
  afterAll(() => cleanupOrg(orgId))

  it('I-2: an "unplaced" finding cannot be linked to its old channel (the NVR no longer lists it); it stays unlinked', async () => {
    const loc = await createLocation(orgId, { code: 'FXI2' })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'Camera 03', cameraIp: '192.168.254.3' })
    await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })
    await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })
    await discoverRecorderCameras(c(), actor, rec, { nvr: lists([{ channel: 1, name: 'Camera 01', ip: '192.168.254.2' }]) })
    const f = (await listFindings(admin(), orgId, { recorderId: rec })).find((x) => x.kind === 'unplaced')!
    expect(await linkFinding(c(), actor, f.id)).toEqual({ ok: false, error: 'The NVR no longer lists this camera’s old channel. Merge it with the camera the NVR shows now, link it to a channel in the mapping editor, or take it off the list.' })
    expect((await mappingOf(cam)).recorder_id).toBeNull()
    expect((await listFindings(admin(), orgId, { recorderId: rec })).map((x) => x.id)).toContain(f.id)
  })

  describe('I-3: one login back-off shared by the connection test and every discovery path', () => {
    let nvr: FakeNvr
    beforeAll(async () => {
      nvr = await startFakeNvr({ channels: [{ channel: 1, name: 'A' }], statuses: { 1: true } })
    })
    afterAll(() => nvr.close())

    it('a refused connection test stops "Find cameras" (and "find cameras for all") from asking the NVR', async () => {
      const loc = await createLocation(orgId, { code: 'FXI3A' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, secret: 'not-the-password' })
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
      const asked = nvr.requests.length
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOGIN_BACKOFF })
      // The other NVRs of this test organisation get a fake answer (no network); the backed-off one must not even reach it.
      const all = await discoverAllRecorders(c(), actor, { deps: { nvr: lists([{ channel: 1, name: 'A', ip: null }]) } })
      expect(all.ok && all.items.find((i) => i.recorderId === rec)).toMatchObject({ ok: false, error: MSG_LOGIN_BACKOFF })
      expect(nvr.requests.length).toBe(asked)
    })

    it('a refused "Find cameras" stops the connection test from asking; a new password ends the wait', async () => {
      const loc = await createLocation(orgId, { code: 'FXI3B' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, secret: 'not-the-password' })
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
      const asked = nvr.requests.length
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOGIN_BACKOFF })
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOGIN_BACKOFF })
      expect(nvr.requests.length).toBe(asked)
      expect((await admin().rpc('recorder_store_credential', { p_recorder: rec, p_secret: 'secret-pass' })).error).toBeNull()
      expect(await discoverRecorderCameras(c(), actor, rec)).toMatchObject({ ok: true, created: 1 })
    })
  })

  it('I-4: changing the address or web port of an NVR needs its password again (the saved one is never sent to a new host)', async () => {
    const loc = await createLocation(orgId, { code: 'FXI4' })
    const r = await saveRecorder(c(), actor, loc, { name: 'NVR', host: '127.0.0.1', httpPort: 9301, rtspPort: 9401, username: 'viewer', password: 'secret-pass', expectedChannels: 0, clockOffsetSec: '' })
    const id = r.ok ? r.recorderId : ''
    const base = { id, name: 'NVR', host: '127.0.0.1', httpPort: 9301, rtspPort: 9401, username: 'viewer', password: '', expectedChannels: 0, clockOffsetSec: '' }
    expect(await saveRecorder(c(), actor, loc, { ...base, host: '127.0.0.2' })).toEqual({ ok: false, error: MSG_PASSWORD_AGAIN })
    expect(await saveRecorder(c(), actor, loc, { ...base, httpPort: 9302 })).toEqual({ ok: false, error: MSG_PASSWORD_AGAIN })
    expect(MSG_PASSWORD_AGAIN).toBe('The address or web port changed: enter the NVR password again (the saved one is only used for the address it was saved for).')
    expect((await admin().from('assets').select('ip, tcp_port').eq('id', id).single()).data).toEqual({ ip: '127.0.0.1', tcp_port: 9301 })
    // Name, video port and the rest may change without it; a new address with the password is fine.
    expect(await saveRecorder(c(), actor, loc, { ...base, name: 'Ground floor', rtspPort: 9402 })).toEqual({ ok: true, recorderId: id })
    expect((await saveRecorder(c(), actor, loc, { ...base, host: '127.0.0.2', password: 'secret-pass' })).ok).toBe(true)
  })

  it('I-4: the old store form refuses a changed NVR address without the password too', async () => {
    const site = await createSite(orgId, { code: 'FXI4S', host: '127.0.0.1', httpPort: 9310, username: 'viewer', secret: 'secret-pass' })
    const form = { name: 'Store', city: 'Patna', ip: '127.0.0.1', rtsp_port: 554, http_port: 9310, nvr_user: 'viewer', nvr_password: null, channels: 0, is_active: true }
    expect(await updateStore(admin(), actor, site.locationId, { ...form, ip: '127.0.0.3' })).toEqual({ ok: false, error: MSG_PASSWORD_AGAIN })
    expect(await updateStore(admin(), actor, site.locationId, { ...form, http_port: 9311 })).toEqual({ ok: false, error: MSG_PASSWORD_AGAIN })
    expect((await admin().from('assets').select('ip, tcp_port').eq('id', site.recorderId).single()).data).toEqual({ ip: '127.0.0.1', tcp_port: 9310 })
    expect(await updateStore(admin(), actor, site.locationId, form)).toEqual({ ok: true })
  })

  it('I-5 / M-3: the merge preview names both cameras, the duplicate\'s NVR and channel, and how many people lose access', async () => {
    const loc = await createLocation(orgId, { code: 'FXI5' })
    const a = await createRecorder(orgId, loc, { name: 'Ground', host: '127.0.0.1', httpPort: 9320 })
    const b = await createRecorder(orgId, loc, { name: 'First floor', host: '127.0.0.1', httpPort: 9321, rtspPort: 9421 })
    const keep = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 1, name: 'Cash office' })
    const dup = await createCamera(orgId, { locationId: loc, recorderId: b, channel: 2, name: 'Cash office (new)' })
    for (const role of ['user', 'user'] as const) {
      const p = await createUser(orgId, role)
      await grant(orgId, p.id, ['cctv.live', 'cctv.playback'], atCamera(dup))
    }
    expect(await previewMerge(c(), actor, { keepId: keep, duplicateId: dup })).toEqual({
      // Fix round 2 (A-N1 / A-N2): the preview also names the exact pair and whether the duplicate shows an NVR channel.
      ok: true, keepId: keep, duplicateId: dup, keepName: 'Cash office', duplicateName: 'Cash office (new)', duplicatePlace: 'FXI5 · First floor, channel 2', duplicateLinked: true, peopleLosing: 2,
    })
    expect((await mappingOf(dup)).archived_at).toBeNull() // a preview writes nothing
  })

  it('M-4: merging into a camera of another location needs a linked duplicate (else the kept camera would end up unlinked)', async () => {
    const l1 = await createLocation(orgId, { code: 'FXM4A' })
    const keep = await createCamera(orgId, { locationId: l1, recorderId: await createRecorder(orgId, l1, { host: '127.0.0.1', httpPort: 9330 }), channel: 1 })
    const l2 = await createLocation(orgId, { code: 'FXM4B' })
    await createRecorder(orgId, l2, { host: '127.0.0.1', httpPort: 9331 })
    await createRecorder(orgId, l2, { host: '127.0.0.1', httpPort: 9332, rtspPort: 9432 })
    const dup = await createCamera(orgId, { locationId: l2, recorderId: null, channel: 4 })
    expect(await mergeCameras(c(), actor, { keepId: keep, duplicateId: dup })).toEqual({ ok: false, error: 'A camera of another location can only be merged into this one when it shows an NVR channel. Link it to its channel first.' })
    expect(await mappingOf(keep)).toMatchObject({ location_id: l1, channel: 1 })
    expect((await mappingOf(dup)).archived_at).toBeNull()
  })

  it('M-2: merge candidates for a camera that moved to another location can be found across the organisation', async () => {
    const other = await createLocation(orgId, { code: 'FXM2' })
    const cam = await createCamera(orgId, { locationId: other, recorderId: await createRecorder(orgId, other, { host: '127.0.0.1', httpPort: 9340 }), channel: 7, name: 'Loading dock east' })
    const r = await searchCameras(c(), actor, 'dock east')
    expect(r.ok && r.cameras.map((x) => [x.id, x.label])).toEqual([[cam, 'Loading dock east (FXM2 · NVR, channel 7)']])
    expect(await searchCameras(c(), actor, 'x')).toEqual({ ok: false, error: 'Type at least two letters.' })
  })

  it('M-6: the mapping history of many cameras in one read equals the one-by-one history', async () => {
    const loc = await createLocation(orgId, { code: 'FXM6' })
    const a = await createRecorder(orgId, loc, { name: 'A', host: '127.0.0.1', httpPort: 9350 })
    const x = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 1 })
    const y = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 2 })
    await admin().rpc('camera_remap', { p_org: orgId, p_camera: x, p_recorder: a, p_channel: 5 })
    const all = await mappingHistories(admin(), orgId, [x, y])
    expect(all.get(x)).toEqual(await mappingHistory(admin(), orgId, x))
    expect(all.get(y)).toEqual(await mappingHistory(admin(), orgId, y))
  })

  it('M-8: moving an asset to another location is saved with a warning about who gains and loses it', async () => {
    const l1 = await createLocation(orgId, { code: 'FXM8A' })
    const l2 = await createLocation(orgId, { code: 'FXM8B' })
    const base = { name: 'Switch', type: 'switch', locationId: l1, ip: '10.88.0.2', enabled: true }
    const r = await saveAsset(c(), actor, base)
    const id = r.ok ? r.assetId : ''
    expect(await saveAsset(c(), actor, { ...base, id, name: 'Switch 1' })).toEqual({ ok: true, assetId: id })
    expect(await saveAsset(c(), actor, { ...base, id, locationId: l2 })).toEqual({
      ok: true, assetId: id, warning: 'The asset moved to another location: people with IT or Wi-Fi rights for the old location no longer see it, and those for the new location do.',
    })
  })

  it('M-10: a rule\'s word is unique per group whatever its spaces and capitals (the same rule as its resolution)', async () => {
    const g = (await admin().from('camera_groups').insert({ org_id: orgId, name: `M10 ${Date.now()}` }).select('id').single()).data!.id
    expect((await admin().from('camera_group_rules').insert({ org_id: orgId, group_id: g, kind: 'name', name_contains: 'Till' })).error).toBeNull()
    expect((await admin().from('camera_group_rules').insert({ org_id: orgId, group_id: g, kind: 'name', name_contains: ' till ' })).error?.code).toBe('23505')
  })

  it('M-1: the proposal preview says who gains access and when an existing cluster sits in another region than proposed', async () => {
    const r1 = await createRegion(orgId, { code: 'FXR1' })
    const existing = await createCluster(orgId, r1, { code: 'FXC1' })
    const holder = await createUser(orgId, 'user')
    await grant(orgId, holder.id, 'cctv.live', atCluster(existing))
    const loc = await createLocation(orgId, { code: 'FXM1', zone: 'FXC1', state: 'FXR2' })
    await createCamera(orgId, { locationId: loc, recorderId: await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 9360 }), channel: 1 })
    const p = await previewProposals(c(), actor, [{ locationId: loc, clusterCode: 'FXC1', regionCode: 'FXR2' }])
    expect(p).toEqual({
      ok: true, affected: 1, people: [{ userId: holder.id, name: 'Test User', capability: 'cctv.live', before: 0, after: 1 }],
      newClusters: [], newRegions: ['FXR2'], regionMismatches: [{ clusterCode: 'FXC1', proposedRegion: 'FXR2', actualRegion: 'FXR1' }],
    })
    expect((await admin().from('locations').select('cluster_id').eq('id', loc).single()).data?.cluster_id).toBeNull()
  })

  describe('dynamic groups (I-6, I-7, M-11)', () => {
    let L1: string, L2: string
    let l1cam: string, l2till: string
    let op: TestUser
    let liveOnly: TestUser, playbackOnly: TestUser
    beforeAll(async () => {
      L1 = (await createSite(orgId, { code: 'FXG1', host: '127.0.0.1', httpPort: 9370 })).locationId
      L2 = (await createSite(orgId, { code: 'FXG2', host: '127.0.0.1', httpPort: 9371 })).locationId
      l1cam = await createCamera(orgId, { locationId: L1, channel: 1, name: 'FXG1 Entrance' })
      l2till = await createCamera(orgId, { locationId: L2, channel: 1, name: 'FXG2 Till' })
      await createCamera(orgId, { locationId: L2, channel: 2, name: 'FXG2 Door' })
      op = await createUser(orgId, 'operator')
      await grant(orgId, op.id, 'cctv.live', atLocation(L1))
      liveOnly = await createUser(orgId, 'user')
      await grant(orgId, liveOnly.id, 'cctv.live', atLocation(L2))
      playbackOnly = await createUser(orgId, 'user')
      await grant(orgId, playbackOnly.id, 'cctv.playback', atLocation(L2))
    })

    it('I-6: a name rule that matches only cameras the maker cannot see never hides the group from its maker (no probing of names)', async () => {
      const opActor: Actor = { id: op.id, orgId, role: 'operator' }
      const g1 = await createGroup(c(op), opActor, `I6 hits ${Date.now()}`)
      const g2 = await createGroup(c(op), opActor, `I6 none ${Date.now()}`)
      const hit = g1.ok ? g1.groupId : ''
      const none = g2.ok ? g2.groupId : ''
      expect((await addGroupRule(c(op), opActor, hit, { kind: 'name', nameContains: 'FXG2 Till' })).ok).toBe(true)
      expect((await addGroupRule(c(op), opActor, none, { kind: 'name', nameContains: 'no camera has this name' })).ok).toBe(true)
      // Both look exactly alike to the maker: visible, no cameras.
      expect(await getVisibleGroup(op.client, hit)).toMatchObject({ id: hit, cameras: [] })
      expect(await getVisibleGroup(op.client, none)).toMatchObject({ id: none, cameras: [] })
      // A reader who may see the matching camera sees it through the group.
      expect((await getVisibleGroup(liveOnly.client, hit))?.cameras.map((x) => x.id)).toEqual([l2till])
    })

    it('I-7: the group list counts members in the database, per capability (no member rows pulled into the page)', async () => {
      const g = await createGroup(c(), actor, `I7 ${Date.now()}`)
      const id = g.ok ? g.groupId : ''
      expect((await addGroupRule(c(), actor, id, { kind: 'location', refId: L2 })).ok).toBe(true)
      const { data, error } = await liveOnly.client.rpc('group_member_counts', { p_cap: 'cctv.live' })
      expect(error).toBeNull()
      expect((data ?? []).find((r: { group_id: string }) => r.group_id === id)).toEqual({ group_id: id, cameras: 2 })
      const pb = await playbackOnly.client.rpc('group_member_counts', { p_cap: 'cctv.live' })
      expect((pb.data ?? []).find((r: { group_id: string }) => r.group_id === id)).toEqual({ group_id: id, cameras: 0 })
      const counted = await listVisibleGroups(liveOnly.client, { capabilities: await readCapabilities(liveOnly.client), capability: 'cctv.live' })
      expect(counted.find((x) => x.id === id)?.camera_count).toBe(2)
      expect((await listVisibleGroups(playbackOnly.client)).find((x) => x.id === id)?.camera_count).toBe(2)
    })

    it('M-11: a dynamic group on the live wall gives a live-only reader its cameras and a playback-only reader none (and the reverse on playback)', async () => {
      const g = await createGroup(c(), actor, `M11 ${Date.now()}`)
      const id = g.ok ? g.groupId : ''
      expect((await addGroupRule(c(), actor, id, { kind: 'location', refId: L2 })).ok).toBe(true)
      expect((await getLiveScope(liveOnly.client, { group: id }, 'cctv.live'))?.cameras.map((x) => x.id).sort()).toHaveLength(2)
      expect((await getLiveScope(playbackOnly.client, { group: id }, 'cctv.live'))?.cameras).toEqual([])
      expect((await getLiveScope(playbackOnly.client, { group: id }, 'cctv.playback'))?.cameras).toHaveLength(2)
      expect((await getLiveScope(op.client, { group: id }, 'cctv.live'))).toBeNull() // op sees nothing of L2: group hidden
      void l1cam
    })
  })
})
