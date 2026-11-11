// P2-5c-1: the services behind the administration screens (regions, clusters, locations, NVRs, the mapping editor, reconciliation,
// merge, assets) and the review items N-1 / N-3 of P2-5b, against the local database with fake NVRs on loopback only.
// Every service checks the caller (administrative role, then admin.inventory for the organisation from the person's own summary),
// then only touches rows of the caller's organisation; ids of another organisation look like ids that do not exist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { addDependency, addEndpoint, removeDependency, retireEndpoint, saveAsset } from '@/lib/inventory/assets'
import { dismissFinding, linkFinding, listFindings } from '@/lib/inventory/findings'
import { applyProposals, hierarchyProposals, moveNode, previewMove, saveCluster, saveRegion } from '@/lib/inventory/hierarchy'
import { saveLocation, saveNetworkDefinition } from '@/lib/inventory/locations'
import { mappingHistory, mergeCameras, remapCamera } from '@/lib/inventory/mapping'
import { saveRecorder, setRecorderMonitoring, testRecorderConnection } from '@/lib/inventory/recorder-admin'
import { discoverAllRecorders, discoverRecorderCameras, MSG_LOCATION_OFF, MSG_NVR_ARCHIVED } from '@/lib/monitor/discovery'
import { startFakeGo2rtc } from '../helpers/fake-go2rtc'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import {
  adminClient, atCamera, atCluster, cleanupOrg, createAsset, createCamera, createCluster, createLocation, createOrg, createRecorder,
  createRegion, createUser, grant, READ_EVERYTHING, withRecorders, type TestUser,
} from '../setup/fixtures'
import { fenced } from '../setup/lease'

const admin = () => adminClient()
const DENIED = 'Only administrators can change locations, NVRs and assets.'
/** An NVR answer given directly (no network): the channel list only. */
const lists = (channels: { channel: number; name: string; ip: string | null }[], counter?: { n: number }) => () => {
  if (counter) counter.n++
  return { channelStatus: async () => new Map<number, boolean>(), channels: async () => channels }
}
const version = async (user: string) => Number((await admin().from('profiles').select('access_version').eq('id', user).single()).data!.access_version)
const mappingOf = async (camera: string) => (await admin().from('cameras').select('location_id, recorder_id, channel, archived_at').eq('id', camera).single()).data!

describe('P2-5c-1 services', () => {
  let orgId: string
  let otherOrg: string
  let me: TestUser
  let actor: Actor
  let plainAdmin: TestUser
  let operator: TestUser
  const c = (u: TestUser = me) => ({ admin: admin(), rls: u.client })
  const asPlainAdmin = (): Actor => ({ id: plainAdmin.id, orgId, role: 'admin' })

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, ['admin.inventory', 'cctv.live', 'it.inventory.view'])
    actor = { id: me.id, orgId, role: 'admin' }
    plainAdmin = await createUser(orgId, 'admin')
    await grant(orgId, plainAdmin.id, READ_EVERYTHING)
    operator = await createUser(orgId, 'operator')
    // Final fix Y (review A M-3, rule 7): an operator can no longer hold admin.inventory on any path; the refusals below stand.
    await expect(grant(orgId, operator.id, 'admin.inventory')).rejects.toThrow(/only for administrators/)
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  // ── Review N-1 (P2-5b re-review): a restored camera that has mapping history is still matched by discovery ──────────────────
  describe('N-1: discovery matches a restored camera on its last mapping', () => {
    it('a restored camera re-patched to another channel of its NVR (same address) gets that channel back: no second identity', async () => {
      const loc = await createLocation(orgId, { code: 'N1A' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'Back door', cameraIp: '192.0.2.33' })
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
      expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
      // The installer moved the cable: the NVR lists the camera (same address) on channel 5, and no channel 3.
      const r = await discoverRecorderCameras(c(), actor, rec, { nvr: lists([{ channel: 5, name: 'Back door', ip: '192.0.2.33' }]) })
      expect(r).toEqual({ ok: true, recorderId: rec, locationId: loc, cameras: 1, created: 0, updated: 0, mapped: 1, moved: 0, reconciliation: [] })
      expect(await mappingOf(cam)).toMatchObject({ recorder_id: rec, channel: 5, archived_at: null })
      expect((await admin().from('cameras').select('id').eq('location_id', loc).is('archived_at', null)).data).toEqual([{ id: cam }])
    })

    it('with only its chosen name the same, it is listed for a person to confirm and nothing is created', async () => {
      const loc = await createLocation(orgId, { code: 'N1B' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'Stock room' })
      await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })
      await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })
      const r = await discoverRecorderCameras(c(), actor, rec, { nvr: lists([{ channel: 6, name: 'Stock room', ip: null }]) })
      expect(r).toMatchObject({ ok: true, created: 0, mapped: 0, moved: 0 })
      expect(r.ok && r.reconciliation).toEqual([{ kind: 'possible_move', channel: 6, reportedName: 'Stock room', cameraId: cam, cameraName: 'Stock room', because: 'same_name' }])
      expect((await mappingOf(cam)).recorder_id).toBeNull()
    })

    it('a restored camera nothing points to is listed as not placed (review N-2), never silently left aside', async () => {
      const loc = await createLocation(orgId, { code: 'N1C' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 3, name: 'Camera 03', cameraIp: '192.168.254.3' })
      await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })
      await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })
      // PoE address and a made-up name: no evidence; channel 3 is not listed any more.
      const r = await discoverRecorderCameras(c(), actor, rec, { nvr: lists([{ channel: 1, name: 'Camera 01', ip: '192.168.254.2' }]) })
      expect(r).toMatchObject({ ok: true, created: 1 })
      expect(r.ok && r.reconciliation).toEqual([{ kind: 'unplaced', channel: 3, cameraId: cam, cameraName: 'Camera 03' }])
    })
  })

  // ── Review N-3: "Find cameras" refuses an NVR it must not contact ───────────────────────────────────────────────────────────
  describe('N-3: discovery never contacts an NVR of a switched-off location, an archived NVR or a switched-off NVR', () => {
    let nvr: FakeNvr
    beforeAll(async () => {
      nvr = await startFakeNvr({ channels: [{ channel: 1, name: 'Gate' }], statuses: { 1: true } })
    })
    afterAll(() => nvr.close())

    it('a location that is switched off: plain message, not a single request', async () => {
      const loc = await createLocation(orgId, { code: 'N3OFF', isActive: false })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
      const before = nvr.requests.length
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOCATION_OFF })
      expect(MSG_LOCATION_OFF).toBe('This location is switched off. Switch it on before looking for cameras.')
      expect(nvr.requests.length).toBe(before)
    })

    it('an archived NVR: plain message, not a single request', async () => {
      const loc = await createLocation(orgId, { code: 'N3ARC' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: rec })).error).toBeNull()
      const before = nvr.requests.length
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: MSG_NVR_ARCHIVED })
      expect(MSG_NVR_ARCHIVED).toBe('This NVR is archived. Restore it before looking for cameras.')
      expect(nvr.requests.length).toBe(before)
    })

    it('"find cameras for all" skips the NVRs of a switched-off location without asking them', async () => {
      const other = await createOrg()
      try {
        const boss = await createUser(other, 'admin')
        await grant(other, boss.id, 'admin.inventory')
        const off = await createLocation(other, { code: 'OFFALL', isActive: false })
        const offRec = await createRecorder(other, off, { host: '127.0.0.1', secret: 'secret-pass' })
        const on = await createLocation(other, { code: 'ONALL' })
        const onRec = await createRecorder(other, on, { host: '127.0.0.1', httpPort: 8081, secret: 'secret-pass' })
        const asked = { n: 0 }
        const r = await discoverAllRecorders({ admin: admin(), rls: boss.client }, { id: boss.id, orgId: other, role: 'admin' }, { deps: { nvr: lists([{ channel: 1, name: 'Door', ip: null }], asked) } })
        expect(r.ok).toBe(true)
        const items = r.ok ? r.items : []
        expect(items.find((i) => i.recorderId === offRec)).toMatchObject({ ok: false, error: MSG_LOCATION_OFF, skipped: 'location_off' })
        expect(items.find((i) => i.recorderId === onRec)).toMatchObject({ ok: true })
        expect(asked.n).toBe(1)
      } finally {
        await cleanupOrg(other)
      }
    })
  })

  // ── Reconciliation list (P2-5c brief item 3) ──────────────────────────────────────────────────────────────────────────────
  describe('reconciliation list', () => {
    it('keeps what the last discovery of each NVR could not place; a new discovery replaces it; a finding can be linked or dismissed', async () => {
      const loc = await createLocation(orgId, { code: 'RECON' })
      const rec = await createRecorder(orgId, loc, { name: 'Ground floor', host: '127.0.0.1', secret: 'secret-pass' })
      // A second NVR, so a camera added by hand stays unlinked (P2-5b: auto-mapping only at a location with exactly one NVR).
      await createRecorder(orgId, loc, { name: 'First floor', host: '127.0.0.1', httpPort: 8080, rtspPort: 8554, secret: 'secret-pass' })
      const gone = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 9, name: 'Old till' })
      const lone = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2, name: 'Entrance' })
      const answer = lists([{ channel: 2, name: 'Entrance', ip: null }])
      expect((await discoverRecorderCameras(c(), actor, rec, { nvr: answer })).ok).toBe(true)
      let open = await listFindings(admin(), orgId, { recorderId: rec })
      expect(open.map((f) => [f.kind, f.channel, f.cameraId, f.recorderName])).toEqual([['missing', 9, gone, 'Ground floor']])
      expect((await discoverRecorderCameras(c(), actor, rec, { nvr: answer })).ok).toBe(true)
      open = await listFindings(admin(), orgId, { recorderId: rec })
      expect(open).toHaveLength(1)
      const all = (await admin().from('discovery_findings').select('resolution').eq('recorder_id', rec).order('found_at')).data!
      expect(all.map((f) => f.resolution)).toEqual(['superseded', null])
      // Dismissed with a note: gone from the open list, kept as history.
      expect(await dismissFinding(c(), actor, open[0].id, 'Camera removed from the store')).toEqual({ ok: true })
      expect(await listFindings(admin(), orgId, { recorderId: rec })).toEqual([])
      // A possible move is linked by a person: the existing camera takes the listed channel (identity kept).
      await admin().from('cameras').update({ name: 'Back door' }).eq('id', lone)
      const moved = await createCamera(orgId, { locationId: loc, recorderId: null, channel: 7, name: 'Loading bay' })
      expect((await discoverRecorderCameras(c(), actor, rec, { nvr: lists([{ channel: 2, name: 'Back door', ip: null }, { channel: 8, name: 'Loading bay', ip: null }]) })).ok).toBe(true)
      const possible = (await listFindings(admin(), orgId, { recorderId: rec })).find((f) => f.kind === 'possible_move')!
      expect(possible).toMatchObject({ channel: 8, cameraId: moved })
      expect(await linkFinding(c(), actor, possible.id)).toEqual({ ok: true })
      expect(await mappingOf(moved)).toMatchObject({ recorder_id: rec, channel: 8 })
      expect((await admin().from('discovery_findings').select('resolution').eq('id', possible.id).single()).data?.resolution).toBe('linked')
    })

    it('findings are only for administrators with admin.inventory, and only of the own organisation', async () => {
      const loc = await createLocation(orgId, { code: 'RECON2' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', secret: 'secret-pass' })
      await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 4, name: 'Gone' })
      await discoverRecorderCameras(c(), actor, rec, { nvr: lists([{ channel: 1, name: 'Here', ip: null }]) })
      const f = (await listFindings(admin(), orgId, { recorderId: rec }))[0]
      expect(await dismissFinding(c(plainAdmin), asPlainAdmin(), f.id, 'no')).toEqual({ ok: false, error: DENIED })
      expect(await dismissFinding(c(operator), { id: operator.id, orgId, role: 'operator' }, f.id, 'no')).toEqual({ ok: false, error: DENIED })
      expect(await dismissFinding(c(), { ...actor, orgId: otherOrg }, f.id, 'no')).toMatchObject({ ok: false })
      expect(await listFindings(admin(), otherOrg)).toEqual([])
      expect(await dismissFinding(c(), actor, f.id, '')).toEqual({ ok: false, error: 'Give a short note (at least three characters).' })
    })
  })

  // ── Mapping editor and merge (brief item 3; P2-5b re-review correction (a)) ──────────────────────────────────────────────
  describe('mapping editor, history and merge', () => {
    it('moves a camera to another NVR and channel of its location, keeps its id and history, and removes its old live streams (M-4)', async () => {
      const loc = await createLocation(orgId, { code: 'MAPED' })
      const a = await createRecorder(orgId, loc, { name: 'A', host: '127.0.0.1', secret: 'secret-pass' })
      const b = await createRecorder(orgId, loc, { name: 'B', host: '127.0.0.1', httpPort: 8080, rtspPort: 8554, secret: 'secret-pass' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 1, name: 'Till' })
      const other = await createCamera(orgId, { locationId: loc, recorderId: b, channel: 2, name: 'Door' })
      const go2rtc = await startFakeGo2rtc()
      try {
        go2rtc.streams.set(`cam_${cam}_main`, 'rtsp://a/1')
        go2rtc.streams.set(`cam_${cam}_sub`, 'rtsp://a/1s')
        go2rtc.streams.set(`cam_${other}_main`, 'rtsp://b/2')
        const r = await remapCamera({ ...c(), go2rtc: go2rtc.client }, actor, { cameraId: cam, recorderId: b, channel: 4 })
        expect(r.ok).toBe(true)
        expect(await mappingOf(cam)).toMatchObject({ recorder_id: b, channel: 4 })
        expect(go2rtc.streams.has(`cam_${cam}_main`)).toBe(false)
        expect(go2rtc.streams.has(`cam_${cam}_sub`)).toBe(false)
        expect(go2rtc.streams.has(`cam_${other}_main`)).toBe(true)
      } finally {
        await go2rtc.close()
      }
      const history = await mappingHistory(admin(), orgId, cam)
      expect(history.map((h) => [h.recorderName, h.channel, h.validTo === null])).toEqual([['B', 4, true], ['A', 1, false]])
      // A channel that has a camera, and an NVR of another location: plain refusals, nothing changes.
      expect(await remapCamera(c(), actor, { cameraId: cam, recorderId: b, channel: 2 })).toEqual({ ok: false, error: 'Channel 2 of this NVR already has a camera. Move that camera first, or merge the two cameras.' })
      const elsewhere = await createRecorder(orgId, await createLocation(orgId, { code: 'MAPED2' }), { host: '127.0.0.1' })
      expect(await remapCamera(c(), actor, { cameraId: cam, recorderId: elsewhere, channel: 1 })).toEqual({ ok: false, error: 'Choose an NVR of the camera’s own location.' })
      expect(await remapCamera(c(), actor, { cameraId: cam, recorderId: b, channel: 0 })).toEqual({ ok: false, error: 'Enter a channel number from 1 to 999.' })
      expect(await mappingOf(cam)).toMatchObject({ recorder_id: b, channel: 4 })
      expect(await remapCamera(c(plainAdmin), asPlainAdmin(), { cameraId: cam, recorderId: a, channel: 1 })).toEqual({ ok: false, error: DENIED })
    })

    it('a camera physically moved to another NVR: a plain remap is refused because the new camera holds the channel; merge keeps the old identity', async () => {
      const loc = await createLocation(orgId, { code: 'MERGE' })
      const a = await createRecorder(orgId, loc, { name: 'A', host: '127.0.0.1', secret: 'secret-pass' })
      const b = await createRecorder(orgId, loc, { name: 'B', host: '127.0.0.1', httpPort: 8080, rtspPort: 8554, secret: 'secret-pass' })
      const old = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 3, name: 'Cash office', cameraIp: '192.0.2.3' })
      const viewer = await createUser(orgId, 'user')
      await grant(orgId, viewer.id, 'cctv.live', atCamera(old))
      await admin().rpc('monitor_apply_results', { ...(await fenced()), p_org: orgId, p_results: await withRecorders([{ type: 'camera', id: old, ok: true, at: new Date().toISOString() }]), p_threshold: 1 })
      const history = (await admin().from('check_state').select('id').eq('target_id', old).single()).data!.id
      const g1 = (await admin().from('camera_groups').insert({ org_id: orgId, name: `Cash ${old.slice(0, 6)}` }).select('id').single()).data!.id
      await admin().from('camera_group_items').insert({ org_id: orgId, group_id: g1, camera_id: old })
      // The camera now hangs on NVR B channel 2; discovery of A lists it missing, discovery of B (no evidence: I-2) makes a new camera.
      await discoverRecorderCameras(c(), actor, a, { nvr: lists([{ channel: 1, name: 'Front', ip: null }]) })
      await discoverRecorderCameras(c(), actor, b, { nvr: lists([{ channel: 2, name: 'Cash office', ip: '192.0.2.3' }]) })
      const dup = (await admin().from('cameras').select('id').eq('recorder_id', b).eq('channel', 2).single()).data!.id
      expect(dup).not.toBe(old)
      const g2 = (await admin().from('camera_groups').insert({ org_id: orgId, name: `New ${dup.slice(0, 6)}` }).select('id').single()).data!.id
      await admin().from('camera_group_items').insert({ org_id: orgId, group_id: g2, camera_id: dup })
      // The report of P2-5b said the old camera could simply be remapped: it cannot, the channel is taken.
      expect(await remapCamera(c(), actor, { cameraId: old, recorderId: b, channel: 2 })).toMatchObject({ ok: false })
      const go2rtc = await startFakeGo2rtc()
      try {
        go2rtc.streams.set(`cam_${old}_main`, 'rtsp://a/3')
        go2rtc.streams.set(`cam_${dup}_sub`, 'rtsp://b/2')
        const before = await version(viewer.id)
        const r = await mergeCameras({ ...c(), go2rtc: go2rtc.client }, actor, { keepId: old, duplicateId: dup })
        expect(r).toEqual({ ok: true, recorderId: b, channel: 2, groupsCopied: 1, duplicateCameraGrants: 0 })
        expect(await version(viewer.id)).toBeGreaterThan(before)
        expect(go2rtc.streams.has(`cam_${old}_main`)).toBe(false)
        expect(go2rtc.streams.has(`cam_${dup}_sub`)).toBe(false)
      } finally {
        await go2rtc.close()
      }
      expect(await mappingOf(old)).toMatchObject({ recorder_id: b, channel: 2, archived_at: null })
      expect((await mappingOf(dup)).archived_at).not.toBeNull()
      expect((await admin().from('check_state').select('id').eq('target_id', old).single()).data?.id).toBe(history)
      expect((await admin().from('access_grants').select('scope_id').eq('user_id', viewer.id).is('revoked_at', null)).data).toEqual([{ scope_id: old }])
      expect((await admin().from('camera_group_items').select('group_id').eq('camera_id', old).order('group_id')).data!.map((x) => x.group_id).sort()).toEqual([g1, g2].sort())
      expect((await viewer.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'camera', p_id: old })).data).toBe(true)
      expect((await mappingHistory(admin(), orgId, old)).map((h) => [h.recorderName, h.channel])).toEqual([['B', 2], ['A', 3]])
      // The findings about either camera are closed as merged.
      const merged = (await admin().from('discovery_findings').select('resolution').eq('camera_id', old)).data!
      expect(merged.length).toBeGreaterThan(0)
      expect(merged.every((f) => f.resolution !== null)).toBe(true)
      const audit = (await admin().from('admin_audit_log').select('detail').eq('org_id', orgId).eq('action', 'camera_merged').eq('entity_id', old)).data!
      expect(audit).toHaveLength(1)
      expect(audit[0].detail).toMatchObject({ duplicate: dup, recorder_id: b, channel: 2 })
    })

    it('merges across locations (a camera moved to another location’s NVR), and counts the camera grants that end with the duplicate', async () => {
      const l1 = await createLocation(orgId, { code: 'MERGEX1' })
      const a = await createRecorder(orgId, l1, { host: '127.0.0.1' })
      const old = await createCamera(orgId, { locationId: l1, recorderId: a, channel: 1, name: 'Gate' })
      const l2 = await createLocation(orgId, { code: 'MERGEX2' })
      const b = await createRecorder(orgId, l2, { host: '127.0.0.1', httpPort: 8080 })
      const dup = await createCamera(orgId, { locationId: l2, recorderId: b, channel: 5, name: 'Gate' })
      const holder = await createUser(orgId, 'user')
      await grant(orgId, holder.id, 'cctv.live', atCamera(dup))
      const r = await mergeCameras(c(), actor, { keepId: old, duplicateId: dup })
      expect(r).toEqual({ ok: true, recorderId: b, channel: 5, groupsCopied: 0, duplicateCameraGrants: 1 })
      expect(await mappingOf(old)).toMatchObject({ location_id: l2, recorder_id: b, channel: 5 })
    })

    it('merge refusals are plain; nothing changes', async () => {
      const loc = await createLocation(orgId, { code: 'MERGER' })
      const a = await createRecorder(orgId, loc, { host: '127.0.0.1' })
      const x = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 1 })
      const y = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 2 })
      expect(await mergeCameras(c(), actor, { keepId: x, duplicateId: x })).toEqual({ ok: false, error: 'Choose two different cameras.' })
      expect(await mergeCameras(c(plainAdmin), asPlainAdmin(), { keepId: x, duplicateId: y })).toEqual({ ok: false, error: DENIED })
      expect(await mergeCameras(c(operator), { id: operator.id, orgId, role: 'operator' }, { keepId: x, duplicateId: y })).toEqual({ ok: false, error: DENIED })
      const foreignLoc = await createLocation(otherOrg, { code: 'MERGEF' })
      const foreign = await createCamera(otherOrg, { locationId: foreignLoc, recorderId: await createRecorder(otherOrg, foreignLoc, { host: '127.0.0.1' }), channel: 1 })
      expect(await mergeCameras(c(), actor, { keepId: x, duplicateId: foreign })).toEqual({ ok: false, error: 'Camera not found.' })
      await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: x })
      expect(await mergeCameras(c(), actor, { keepId: x, duplicateId: y })).toEqual({ ok: false, error: 'Restore the camera to keep first.' })
      expect(await mappingOf(y)).toMatchObject({ recorder_id: a, channel: 2, archived_at: null })
    })
  })

  // ── Regions, clusters, moves with their effect on access, zone → cluster proposals (brief items 1 and 7) ───────────────────
  describe('regions, clusters and moves', () => {
    it('creates and renames regions and clusters (codes upper case, kept on rename) and refuses a code in use plainly', async () => {
      const r = await saveRegion(c(), actor, { code: 'east-1', name: 'East' })
      expect(r.ok).toBe(true)
      const regionId = r.ok ? r.id : ''
      expect((await admin().from('regions').select('code, name').eq('id', regionId).single()).data).toEqual({ code: 'EAST-1', name: 'East' })
      expect(await saveRegion(c(), actor, { code: 'EAST-1', name: 'Another' })).toEqual({ ok: false, error: 'That code is already used by another region.' })
      expect(await saveRegion(c(), actor, { id: regionId, code: 'EAST-1', name: 'East India' })).toEqual({ ok: true, id: regionId })
      const cl = await saveCluster(c(), actor, { code: 'pat', name: 'Patna', regionId })
      expect(cl.ok).toBe(true)
      expect(await saveCluster(c(), actor, { code: 'PAT', name: 'Again', regionId: null })).toEqual({ ok: false, error: 'That code is already used by another cluster.' })
      expect(await saveCluster(c(), actor, { code: '', name: 'X', regionId: null })).toEqual({ ok: false, error: 'Enter a code: letters, numbers and dashes, up to 50.' })
      expect(await saveRegion(c(plainAdmin), asPlainAdmin(), { code: 'NOPE', name: 'Nope' })).toEqual({ ok: false, error: DENIED })
      expect(await saveCluster(c(), actor, { code: 'FOREIGNR', name: 'X', regionId: await createRegion(otherOrg) })).toEqual({ ok: false, error: 'Region not found.' })
    })

    it('moving a location to another cluster: the preview names who gains and who loses, the move changes access at once and is audited', async () => {
      const r = await createRegion(orgId)
      const c1 = await createCluster(orgId, r)
      const c2 = await createCluster(orgId, r)
      const loc = await createLocation(orgId, { code: 'MOVE1', clusterId: c1 })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1' })
      await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
      await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2 })
      const loser = await createUser(orgId, 'user')
      await grant(orgId, loser.id, 'cctv.live', atCluster(c1))
      const gainer = await createUser(orgId, 'user')
      await grant(orgId, gainer.id, 'cctv.live', atCluster(c2))
      const p = await previewMove(c(), actor, { kind: 'location', id: loc, to: c2 })
      expect(p.ok).toBe(true)
      if (!p.ok) return
      expect(p.locations).toBe(1)
      expect(p.affected).toBe(2)
      expect(p.people.map((x) => [x.userId, x.capability, x.before, x.after]).sort()).toEqual([[gainer.id, 'cctv.live', 0, 2], [loser.id, 'cctv.live', 2, 0]].sort())
      expect(p.people.every((x) => x.name === 'Test User')).toBe(true)
      const v = await version(loser.id)
      expect(await moveNode(c(), actor, { kind: 'location', id: loc, to: c2 })).toEqual({ ok: true, from: c1, to: c2 })
      expect((await gainer.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: loc })).data).toBe(true)
      expect((await loser.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: loc })).data).toBe(false)
      expect(await version(loser.id)).toBeGreaterThan(v)
      expect((await admin().from('admin_audit_log').select('actor_id').eq('action', 'hierarchy_moved').eq('entity_id', loc)).data).toEqual([{ actor_id: me.id }])
      // "No cluster" is a real choice (owner amendment to R-1): the cluster holder loses it.
      expect(await moveNode(c(), actor, { kind: 'location', id: loc, to: null })).toEqual({ ok: true, from: c2, to: null })
      expect((await gainer.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: loc })).data).toBe(false)
      expect(await moveNode(c(), actor, { kind: 'location', id: loc, to: await createCluster(otherOrg, null) })).toEqual({ ok: false, error: 'Cluster not found.' })
      expect(await moveNode(c(plainAdmin), asPlainAdmin(), { kind: 'location', id: loc, to: c1 })).toEqual({ ok: false, error: DENIED })
    })

    it('moving a cluster to another region (preview and move)', async () => {
      const r1 = await createRegion(orgId)
      const r2 = await createRegion(orgId)
      const cl = await createCluster(orgId, r1)
      const loc = await createLocation(orgId, { code: 'MOVE2', clusterId: cl })
      await createCamera(orgId, { locationId: loc, recorderId: await createRecorder(orgId, loc, { host: '127.0.0.1' }), channel: 1 })
      const holder = await createUser(orgId, 'user')
      await grant(orgId, holder.id, 'cctv.playback', { kind: 'region', id: r2 })
      const p = await previewMove(c(), actor, { kind: 'cluster', id: cl, to: r2 })
      expect(p.ok && p.people.map((x) => [x.capability, x.before, x.after])).toEqual([['cctv.playback', 0, 1]])
      expect(await moveNode(c(), actor, { kind: 'cluster', id: cl, to: r2 })).toEqual({ ok: true, from: r1, to: r2 })
      expect((await holder.client.rpc('has_capability_for', { p_cap: 'cctv.playback', p_kind: 'location', p_id: loc })).data).toBe(true)
    })

    it('zone → cluster proposals: suggested from zone and state, applied only for the rows the administrator confirms', async () => {
      const other = await createOrg()
      try {
        const boss = await createUser(other, 'admin')
        await grant(other, boss.id, 'admin.inventory')
        const bossActor: Actor = { id: boss.id, orgId: other, role: 'admin' }
        const a = await createLocation(other, { code: 'PZA', zone: 'Bihar North', state: 'BR' })
        const b = await createLocation(other, { code: 'PZB', zone: 'Bihar North', state: 'BR' })
        const n = await createLocation(other, { code: 'PZC', zone: 'Assam', state: 'AS' })
        const list = await hierarchyProposals({ admin: admin(), rls: boss.client }, bossActor)
        expect(list.ok && list.rows.map((x) => [x.code, x.proposedClusterCode, x.proposedRegionCode])).toEqual([['PZA', 'BIHAR-NORTH', 'BR'], ['PZB', 'BIHAR-NORTH', 'BR'], ['PZC', 'ASSAM', 'AS']])
        const applied = await applyProposals({ admin: admin(), rls: boss.client }, bossActor, [
          { locationId: a, clusterCode: 'BIHAR-NORTH', regionCode: 'BR' }, { locationId: b, clusterCode: 'BIHAR-NORTH', regionCode: 'BR' },
        ])
        expect(applied).toEqual({ ok: true, moved: 2, regionsCreated: 1, clustersCreated: 1 })
        const rows = (await admin().from('locations').select('id, cluster_id').in('id', [a, b, n])).data!
        const cluster = rows.find((x) => x.id === a)!.cluster_id
        expect(cluster).not.toBeNull()
        expect(rows.find((x) => x.id === b)!.cluster_id).toBe(cluster)
        expect(rows.find((x) => x.id === n)!.cluster_id).toBeNull()
        expect((await admin().from('clusters').select('code, regions(code)').eq('id', cluster!).single()).data).toEqual({ code: 'BIHAR-NORTH', regions: { code: 'BR' } })
        // Nothing is ever applied without a confirmed row, and the plain administrator cannot apply anything.
        expect(await applyProposals({ admin: admin(), rls: boss.client }, bossActor, [])).toEqual({ ok: false, error: 'Tick at least one location to apply.' })
        expect(await applyProposals(c(), actor, [{ locationId: n, clusterCode: 'ASSAM', regionCode: 'AS' }])).toEqual({ ok: false, error: 'Location not found.' })
      } finally {
        await cleanupOrg(other)
      }
    })
  })

  // ── Locations and their network definitions (brief item 1) ─────────────────────────────────────────────────────────────
  describe('locations', () => {
    it('creates a head office without any NVR, renames it keeping its id, refuses a code in use and an unknown kind', async () => {
      const r = await saveLocation(c(), actor, { code: 'ho-pat', kind: 'head_office', name: 'HO-PAT - Patna', city: 'Patna', address: 'Boring Road' })
      expect(r.ok).toBe(true)
      const id = r.ok ? r.locationId : ''
      expect((await admin().from('locations').select('code, kind, name, city, cluster_id, is_active').eq('id', id).single()).data).toEqual({ code: 'HO-PAT', kind: 'head_office', name: 'HO-PAT - Patna', city: 'Patna', cluster_id: null, is_active: true })
      expect((await admin().from('recorders').select('id').eq('location_id', id)).data).toEqual([])
      expect(await saveLocation(c(), actor, { id, kind: 'head_office', name: 'Head office, Patna', isActive: true })).toEqual({ ok: true, locationId: id })
      expect((await admin().from('locations').select('code, name').eq('id', id).single()).data).toEqual({ code: 'HO-PAT', name: 'Head office, Patna' })
      expect(await saveLocation(c(), actor, { code: 'HO-PAT', kind: 'store', name: 'Clash' })).toEqual({ ok: false, error: 'That code is already used by another location.' })
      expect(await saveLocation(c(), actor, { code: 'ZZ1', kind: 'castle', name: 'Odd' })).toEqual({ ok: false, error: 'Choose what kind of location this is.' })
      expect(await saveLocation(c(plainAdmin), asPlainAdmin(), { code: 'ZZ2', kind: 'store', name: 'No' })).toEqual({ ok: false, error: DENIED })
      expect(await saveLocation(c(), actor, { id: await createLocation(otherOrg), kind: 'store', name: 'Foreign' })).toEqual({ ok: false, error: 'Location not found.' })
    })

    it('saves the network definition and explains a definition the database refuses', async () => {
      const loc = await createLocation(orgId, { code: 'NET1' })
      expect(await saveNetworkDefinition(c(), actor, loc, {
        managementCidr: '10.20.0.0/24', gateway: '10.20.0.1', dns: '10.0.0.53, 10.0.0.54', managementVlan: '10', vlanStaff: '20', vlanGuest: '30', vlanDevice: '',
        discoveryRanges: '10.20.0.0/25', sdwanContext: 'Store broadband link',
      })).toEqual({ ok: true })
      const row = (await admin().from('network_definitions').select('management_cidr, gateway, dns, management_vlan, vlan_map, discovery_ranges, sdwan_context').eq('location_id', loc).single()).data
      expect(row).toEqual({ management_cidr: '10.20.0.0/24', gateway: '10.20.0.1', dns: ['10.0.0.53', '10.0.0.54'], management_vlan: 10, vlan_map: { staff: 20, guest: 30 }, discovery_ranges: ['10.20.0.0/25'], sdwan_context: 'Store broadband link' })
      expect(await saveNetworkDefinition(c(), actor, loc, { managementCidr: '10.20.0.0/24', discoveryRanges: '10.30.0.0/24' })).toEqual({ ok: false, error: 'Every discovery range must be inside the management network.' })
      expect(await saveNetworkDefinition(c(), actor, loc, { managementCidr: '10.20.0.0/24', gateway: '10.99.0.1' })).toEqual({ ok: false, error: 'The gateway must be inside the management network.' })
      expect(await saveNetworkDefinition(c(), actor, loc, { managementCidr: 'nonsense' })).toEqual({ ok: false, error: 'Enter the management network like 192.168.10.0/24.' })
      expect(await saveNetworkDefinition(c(), actor, loc, { managementCidr: '10.20.0.0/24', vlanGuest: '5000' })).toEqual({ ok: false, error: 'VLAN numbers are whole numbers from 1 to 4094.' })
      // Emptying the management network removes the definition.
      expect(await saveNetworkDefinition(c(), actor, loc, { managementCidr: '' })).toEqual({ ok: true, removed: true })
      expect((await admin().from('network_definitions').select('id').eq('location_id', loc)).data).toEqual([])
    })
  })

  // ── NVRs of a location (brief item 2) ──────────────────────────────────────────────────────────────────────────────────
  describe('NVRs (recorders)', () => {
    let nvr: FakeNvr
    beforeAll(async () => {
      nvr = await startFakeNvr({ channels: [{ channel: 1, name: 'A' }, { channel: 2, name: 'B' }], statuses: { 1: true, 2: false } })
    })
    afterAll(() => nvr.close())

    it('adds a further NVR only with its password; the password is written to the vault and never returned or audited', async () => {
      const loc = await createLocation(orgId, { code: 'NVR1' })
      const first = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 9001, secret: 'secret-pass' })
      const input = { name: 'First floor', host: '127.0.0.1', httpPort: nvr.port, rtspPort: 8554, username: 'viewer', password: '', expectedChannels: 0, clockOffsetSec: '' }
      expect(await saveRecorder(c(), actor, loc, input)).toEqual({ ok: false, error: 'Enter the NVR password.' })
      const r = await saveRecorder(c(), actor, loc, { ...input, password: 'secret-pass', clockOffsetSec: '120' })
      expect(r.ok).toBe(true)
      const id = r.ok ? r.recorderId : ''
      expect(id).not.toBe(first)
      expect(JSON.stringify(r)).not.toContain('secret-pass')
      expect((await admin().rpc('recorder_credential_status', { p_org: orgId, p_recorder: id })).data).toMatchObject({ set: true })
      expect((await admin().from('recorders').select('clock_offset_sec, clock_offset_source, http_port, rtsp_port, username').eq('id', id).single()).data).toEqual({ clock_offset_sec: 120, clock_offset_source: 'manual', http_port: nvr.port, rtsp_port: 8554, username: 'viewer' })
      expect((await admin().from('assets').select('name, ip').eq('id', id).single()).data).toEqual({ name: 'First floor', ip: '127.0.0.1' })
      const audit = (await admin().from('admin_audit_log').select('detail').eq('org_id', orgId)).data!
      expect(JSON.stringify(audit)).not.toContain('secret-pass')
      // Changing it without a password keeps the saved one; an empty offset means "use the default".
      expect(await saveRecorder(c(), actor, loc, { ...input, id, name: 'First floor NVR', clockOffsetSec: '' })).toEqual({ ok: true, recorderId: id })
      expect((await admin().rpc('recorder_credential_status', { p_org: orgId, p_recorder: id })).data).toMatchObject({ set: true })
      expect((await admin().from('recorders').select('clock_offset_sec').eq('id', id).single()).data).toEqual({ clock_offset_sec: null })
      // The same address and web port as another NVR of the same location: refused (DR010).
      expect(await saveRecorder(c(), actor, loc, { ...input, name: 'Twin', httpPort: 9001, password: 'x-pass' })).toEqual({ ok: false, error: 'Another NVR of this location already has this address.' })
      expect(await saveRecorder(c(), actor, loc, { ...input, id, clockOffsetSec: '999999' })).toEqual({ ok: false, error: 'The clock offset must be a whole number of seconds from -86400 to 86400.' })
      expect(await saveRecorder(c(plainAdmin), asPlainAdmin(), loc, { ...input, password: 'secret-pass' })).toEqual({ ok: false, error: DENIED })
      expect(await saveRecorder(c(), actor, await createLocation(otherOrg), { ...input, password: 'secret-pass' })).toEqual({ ok: false, error: 'Location not found.' })
    })

    it('switches monitoring off and on with a reason (audited)', async () => {
      const loc = await createLocation(orgId, { code: 'NVR2' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1' })
      expect(await setRecorderMonitoring(c(), actor, rec, { enabled: false, reason: 'x' })).toEqual({ ok: false, error: 'Give a reason (at least three characters).' })
      expect(await setRecorderMonitoring(c(), actor, rec, { enabled: false, reason: 'Store closed for repairs' })).toEqual({ ok: true })
      expect((await admin().from('recorders').select('monitoring_enabled, monitoring_disabled_reason').eq('id', rec).single()).data).toEqual({ monitoring_enabled: false, monitoring_disabled_reason: 'Store closed for repairs' })
      expect(await setRecorderMonitoring(c(), actor, rec, { enabled: true, reason: 'Open again' })).toEqual({ ok: true })
      expect((await admin().from('admin_audit_log').select('action').eq('entity_id', rec).in('action', ['recorder_monitoring_disabled', 'recorder_monitoring_enabled'])).data).toHaveLength(2)
    })

    it('tests the connection read-only through the saved login; after a refused login it waits (back-off) and asks nothing until the login changes', async () => {
      const loc = await createLocation(orgId, { code: 'NVR3' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, username: 'viewer', secret: 'secret-pass' })
      const before = nvr.requests.length
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: true, channels: 2, message: 'The NVR answered and accepted the login. It reports 2 cameras.' })
      expect(nvr.requests.slice(before).every((r) => r.startsWith('GET '))).toBe(true)
      const loc2 = await createLocation(orgId, { code: 'NVR3B' })
      const wrong = await createRecorder(orgId, loc2, { name: 'Wrong', host: '127.0.0.1', httpPort: nvr.port, rtspPort: 8554, username: 'viewer', secret: 'not-the-password' })
      expect(await testRecorderConnection(c(), actor, wrong)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
      const asked = nvr.requests.length
      expect(await testRecorderConnection(c(), actor, wrong)).toEqual({ ok: false, error: 'The NVR refused this login a short while ago. To protect its account it is not asked again for a while; check the saved user name and password.' })
      expect(nvr.requests.length).toBe(asked)
      // A new password ends the wait.
      expect((await saveRecorder(c(), actor, loc2, { id: wrong, name: 'Wrong', host: '127.0.0.1', httpPort: nvr.port, rtspPort: 8554, username: 'viewer', password: 'secret-pass', expectedChannels: 0, clockOffsetSec: '' })).ok).toBe(true)
      expect(await testRecorderConnection(c(), actor, wrong)).toMatchObject({ ok: true, channels: 2 })
    })

    it('never contacts an NVR that is switched off, archived, or at a switched-off location', async () => {
      const loc = await createLocation(orgId, { code: 'NVR4' })
      const off = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass', monitoringOff: 'Real NVR' })
      const before = nvr.requests.length
      expect(await testRecorderConnection(c(), actor, off)).toEqual({ ok: false, error: 'Monitoring is switched off for this NVR.' })
      const quiet = await createLocation(orgId, { code: 'NVR5', isActive: false })
      const there = await createRecorder(orgId, quiet, { host: '127.0.0.1', httpPort: nvr.port, secret: 'secret-pass' })
      expect(await testRecorderConnection(c(), actor, there)).toEqual({ ok: false, error: 'This location is switched off. Switch it on before testing its NVRs.' })
      const archived = await createRecorder(orgId, loc, { name: 'Gone', host: '127.0.0.1', httpPort: 9100, rtspPort: 9101, secret: 'secret-pass' })
      await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: archived })
      expect(await testRecorderConnection(c(), actor, archived)).toEqual({ ok: false, error: 'This NVR is archived. Restore it first.' })
      expect(await testRecorderConnection(c(plainAdmin), asPlainAdmin(), there)).toEqual({ ok: false, error: DENIED })
      expect(nvr.requests.length).toBe(before)
    })
  })

  // ── Assets inventory (brief item 4) ──────────────────────────────────────────────────────────────────────────────────────
  describe('assets', () => {
    it('saves an asset with the new attributes, refuses a wrong MAC and an NVR asset plainly', async () => {
      const loc = await createLocation(orgId, { code: 'AST1' })
      const base = {
        name: 'Core switch', type: 'switch', locationId: loc, ip: '10.40.0.2', tcpPort: '', serial: 'SN-001', mac: 'aa:bb:cc:dd:ee:ff', vendor: 'NETGEAR',
        model: 'GS108', firmware: '1.0.2', role: 'switch', owner: 'IT team', criticality: 'high', lifecycleState: 'active', warrantyUntil: '2027-03-31',
        managementMode: 'standalone', notes: '', enabled: true,
      }
      const r = await saveAsset(c(), actor, base)
      expect(r.ok).toBe(true)
      const id = r.ok ? r.assetId : ''
      expect((await admin().from('assets').select('type, serial, mac, vendor, model, firmware, role, owner, criticality, lifecycle_state, warranty_until, management_mode, location_id').eq('id', id).single()).data).toEqual({
        type: 'switch', serial: 'SN-001', mac: 'aa:bb:cc:dd:ee:ff', vendor: 'NETGEAR', model: 'GS108', firmware: '1.0.2', role: 'switch', owner: 'IT team', criticality: 'high',
        lifecycle_state: 'active', warranty_until: '2027-03-31', management_mode: 'standalone', location_id: loc,
      })
      expect(await saveAsset(c(), actor, { ...base, id, mac: 'not-a-mac' })).toEqual({ ok: false, error: 'Enter the MAC address like aa:bb:cc:dd:ee:ff.' })
      expect(await saveAsset(c(), actor, { ...base, type: 'nvr' })).toEqual({ ok: false, error: 'Add an NVR on its location’s page, not here.' })
      const rec = await createRecorder(orgId, loc, { host: '10.40.0.9' })
      expect(await saveAsset(c(), actor, { ...base, id: rec })).toEqual({ ok: false, error: 'This is an NVR. Change it on its location’s NVR page.' })
      expect(await saveAsset(c(plainAdmin), asPlainAdmin(), base)).toEqual({ ok: false, error: DENIED })
      expect(await saveAsset(c(), actor, { ...base, locationId: await createLocation(otherOrg) })).toEqual({ ok: false, error: 'Location not found.' })
    })

    it('records dependencies and refuses a loop plainly (DR005)', async () => {
      const loc = await createLocation(orgId, { code: 'AST2' })
      const sw = await createAsset(orgId, { locationId: loc, type: 'switch', name: 'Switch' })
      const ap = await createAsset(orgId, { locationId: loc, type: 'access_point', name: 'AP' })
      const ups = await createAsset(orgId, { locationId: loc, type: 'ups', name: 'UPS' })
      const d1 = await addDependency(c(), actor, { childId: ap, parentId: sw, kind: 'network' })
      expect(d1.ok).toBe(true)
      expect((await addDependency(c(), actor, { childId: sw, parentId: ups, kind: 'power' })).ok).toBe(true)
      expect(await addDependency(c(), actor, { childId: ups, parentId: ap, kind: 'network' })).toEqual({ ok: false, error: 'That would make a loop: the chosen asset already depends on this one (directly or through other assets).' })
      expect(await addDependency(c(), actor, { childId: ap, parentId: sw, kind: 'network' })).toEqual({ ok: false, error: 'This dependency is already recorded.' })
      expect(await addDependency(c(), actor, { childId: ap, parentId: ap, kind: 'network' })).toEqual({ ok: false, error: 'An asset cannot depend on itself.' })
      expect(await removeDependency(c(), actor, d1.ok ? d1.id : '')).toEqual({ ok: true })
      expect((await admin().from('asset_dependencies').select('id').eq('child_asset_id', ap)).data).toEqual([])
      expect(await addDependency(c(), actor, { childId: ap, parentId: await createAsset(otherOrg, { locationId: null }), kind: 'network' })).toEqual({ ok: false, error: 'Asset not found.' })
    })

    it('adds and retires extra endpoints per address space; the management address follows the asset itself', async () => {
      const loc = await createLocation(orgId, { code: 'AST3' })
      const ap = await createAsset(orgId, { locationId: loc, type: 'access_point', name: 'AP', ip: '10.41.0.5' })
      const other = await createAsset(orgId, { locationId: loc, type: 'switch', name: 'SW', ip: '10.41.0.6' })
      const space = (await admin().from('address_spaces').select('id').eq('org_id', orgId).eq('kind', 'global').single()).data!.id
      const e = await addEndpoint(c(), actor, ap, { spaceId: space, host: '10.41.0.5', port: '161', purpose: 'snmp' })
      expect(e.ok).toBe(true)
      expect(await addEndpoint(c(), actor, other, { spaceId: space, host: '10.41.0.5', port: '161', purpose: 'snmp' })).toEqual({ ok: false, error: 'This address is already used by another asset in that address space.' })
      expect(await addEndpoint(c(), actor, ap, { spaceId: space, host: 'bad host!', port: '', purpose: 'other' })).toEqual({ ok: false, error: 'Enter an IP address or a host name.' })
      expect(await retireEndpoint(c(), actor, e.ok ? e.id : '')).toEqual({ ok: true })
      expect((await admin().from('asset_endpoints').select('retired_at').eq('id', e.ok ? e.id : '').single()).data?.retired_at).not.toBeNull()
      const management = (await admin().from('asset_endpoints').select('id').eq('asset_id', ap).eq('purpose', 'management').is('retired_at', null).single()).data!.id
      expect(await retireEndpoint(c(), actor, management)).toEqual({ ok: false, error: 'The management address changes with the asset’s own address.' })
    })
  })
})
