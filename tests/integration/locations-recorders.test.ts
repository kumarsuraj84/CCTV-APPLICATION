import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  adminClient, atCamera, atLocation, atRecorder, cleanupOrg, createAsset, createCamera, createLocation, createOrg, createRecorder, createUser,
  grant, mapCamera, ORG_SCOPE, primaryRecorderOf, type TestUser,
} from '../setup/fixtures'

// P2-5a (brief item 3, decision D-4, ruling C-1, directive "Asset and location model"): locations of any kind with several NVRs,
// recorders as explicit records with their own address and vault login, cameras with a stable identity and explicit recorder/channel
// mappings, archive instead of delete, address uniqueness per address space, per-location network definitions, asset dependencies and
// the Wi-Fi capability matrix. Negative checks use real signed-in people (their own JWT) through row security.

const admin = () => adminClient()
const anon = () => createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const apply = async (orgId: string, results: object[], threshold = 2) => {
  const { error } = await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: results as never, p_threshold: threshold })
  if (error) throw new Error(error.message)
}
const ids = (rows: { id: string }[] | null) => (rows ?? []).map((r) => r.id).sort()

describe('locations, recorders and channel mappings (P2-5a)', () => {
  let orgId: string
  let store: string, ho: string, recA: string, recB: string, recC: string
  const cams: Record<string, string> = {}
  let viewer: TestUser, itPerson: TestUser, onlyA: TestUser, onlyB: TestUser, oneCamera: TestUser, nobody: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    // A store with THREE NVRs (owner: "some locations have 2–3 NVRs"), the same channel numbers on each.
    store = await createLocation(orgId, { code: 'MULTI', kind: 'store' })
    recA = await createRecorder(orgId, store, { name: 'NVR A', secret: 'pass-A' })
    recB = await createRecorder(orgId, store, { name: 'NVR B' })
    recC = await createRecorder(orgId, store, { name: 'NVR C' })
    for (const [r, tag] of [[recA, 'A'], [recB, 'B'], [recC, 'C']] as const) {
      for (const ch of [1, 2, 3]) cams[`${tag}${ch}`] = await createCamera(orgId, { locationId: store, recorderId: r, channel: ch, name: `${tag}-${ch}` })
    }
    // A head office without any NVR, with assets only.
    ho = await createLocation(orgId, { code: 'HO', kind: 'head_office' })
    await createAsset(orgId, { locationId: ho, type: 'server', name: 'HO server' })
    viewer = await createUser(orgId, 'user')
    itPerson = await createUser(orgId, 'user')
    onlyA = await createUser(orgId, 'user')
    onlyB = await createUser(orgId, 'user')
    oneCamera = await createUser(orgId, 'user')
    nobody = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live', 'cctv.playback'], [atLocation(store), atLocation(ho)])
    await grant(orgId, itPerson.id, ['it.inventory.view', 'it.monitoring.view'], ORG_SCOPE)
    await grant(orgId, onlyA.id, 'cctv.live', atRecorder(recA))
    await grant(orgId, onlyB.id, 'cctv.live', atRecorder(recB))
    await grant(orgId, oneCamera.id, 'cctv.live', atCamera(cams.A3))
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
  })

  it('a location with three NVRs: the same channel numbers coexist, and a location grant shows every camera of every recorder', async () => {
    const { data: maps } = await admin().from('camera_channel_mappings').select('camera_id, recorder_id, channel').eq('org_id', orgId).is('valid_to', null)
    expect(maps).toHaveLength(9)
    expect(new Set((maps ?? []).map((m) => `${m.recorder_id}:${m.channel}`)).size).toBe(9)
    expect((maps ?? []).filter((m) => m.channel === 1)).toHaveLength(3)
    const seen = await viewer.client.from('cameras').select('id').eq('location_id', store)
    expect(seen.error).toBeNull()
    expect(ids(seen.data)).toEqual(Object.values(cams).sort())
    // The recorder is not shown to a CCTV viewer (ruling C-1): the column is not readable and recorders are not visible.
    expect((await viewer.client.from('cameras').select('recorder_id').limit(1)).error?.code).toBe('42501')
    expect((await viewer.client.from('recorders').select('id')).data ?? []).toEqual([])
    expect(ids((await itPerson.client.from('recorders').select('id').eq('location_id', store)).data)).toEqual([recA, recB, recC].sort())
  })

  it('a camera has at most one active mapping, and a recorder channel at most one active camera', async () => {
    const twice = await admin().from('camera_channel_mappings').insert({ org_id: orgId, camera_id: cams.A1, recorder_id: recB, channel: 9 })
    expect(twice.error).not.toBeNull()
    const taken = await admin().from('camera_channel_mappings').insert({ org_id: orgId, camera_id: cams.C3, recorder_id: recA, channel: 1 })
    expect(taken.error).not.toBeNull()
    // A second camera on an occupied channel through the camera row is refused the same way.
    expect((await admin().from('cameras').insert({ org_id: orgId, location_id: store, recorder_id: recA, channel: 2, name: 'dup' })).error).not.toBeNull()
  })

  it('recorder scope: only that NVR\'s cameras; it never covers the whole location', async () => {
    expect(ids((await onlyA.client.from('cameras').select('id')).data)).toEqual([cams.A1, cams.A2, cams.A3].sort())
    expect(ids((await onlyB.client.from('cameras').select('id')).data)).toEqual([cams.B1, cams.B2, cams.B3].sort())
    expect((await onlyA.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'recorder', p_id: recA })).data).toBe(true)
    expect((await onlyA.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'recorder', p_id: recB })).data).toBe(false)
    expect((await onlyA.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'location', p_id: store })).data).toBe(false)
    expect((await onlyA.client.rpc('has_capability_for', { p_cap: 'cctv.playback', p_kind: 'camera', p_id: cams.A1 })).data).toBe(false)
    // The location row is visible (a grant inside it), its cameras of other recorders are not.
    expect(ids((await onlyA.client.from('locations').select('id')).data)).toEqual([store])
    expect((await onlyA.client.from('assets').select('id')).data ?? []).toEqual([])
  })

  it('moving a camera to another recorder and channel keeps its id, grants, group membership and history', async () => {
    const cam = cams.A3
    const group = (await admin().from('camera_groups').insert({ org_id: orgId, name: 'Entrance' }).select('id').single()).data!.id
    await admin().from('camera_group_items').insert({ org_id: orgId, group_id: group, camera_id: cam })
    await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: ago(10) }], 1)
    const outageBefore = (await admin().from('outages').select('id').eq('target_id', cam).eq('target_type', 'camera')).data!
    const stateBefore = (await admin().from('check_state').select('id').eq('target_id', cam).eq('target_type', 'camera')).data!
    expect(outageBefore).toHaveLength(1)

    await mapCamera(orgId, cam, recB, 7)

    const row = (await admin().from('cameras').select('id, location_id, recorder_id, channel').eq('id', cam).single()).data!
    expect(row).toEqual({ id: cam, location_id: store, recorder_id: recB, channel: 7 })
    const history = (await admin().from('camera_channel_mappings').select('recorder_id, channel, valid_from, valid_to').eq('camera_id', cam).order('valid_from')).data!
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ recorder_id: recA, channel: 3 })
    expect(history[0].valid_to).not.toBeNull()
    expect(history[1]).toMatchObject({ recorder_id: recB, channel: 7, valid_to: null })
    // Grants, group items and monitoring history are untouched.
    expect((await oneCamera.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'camera', p_id: cam })).data).toBe(true)
    expect((await admin().from('camera_group_items').select('camera_id').eq('group_id', group)).data).toEqual([{ camera_id: cam }])
    expect((await admin().from('outages').select('id').eq('target_id', cam).eq('target_type', 'camera')).data).toEqual(outageBefore)
    expect((await admin().from('check_state').select('id').eq('target_id', cam).eq('target_type', 'camera')).data).toEqual(stateBefore)
    // Recorder-scope holders follow the mapping: A loses it, B gains it.
    expect(ids((await onlyA.client.from('cameras').select('id')).data)).toEqual([cams.A1, cams.A2].sort())
    expect(ids((await onlyB.client.from('cameras').select('id')).data)).toEqual([cams.B1, cams.B2, cams.B3, cam].sort())
    // The freed channel can be used again.
    const again = await createCamera(orgId, { locationId: store, recorderId: recA, channel: 3, name: 'A-3 new' })
    expect(again).not.toBe(cam)
  })

  it('a camera can only be mapped to a recorder at its own location', async () => {
    const otherStore = await createLocation(orgId, { code: 'OTHERLOC' })
    const otherRec = await createRecorder(orgId, otherStore)
    const r = await admin().rpc('camera_remap', { p_org: orgId, p_camera: cams.C1, p_recorder: otherRec, p_channel: 5 })
    expect(r.error?.code).toBe('DR006')
    expect((await admin().from('cameras').select('recorder_id, channel').eq('id', cams.C1).single()).data).toEqual({ recorder_id: recC, channel: 1 })
  })

  it('one NVR down: only that recorder is down, the location view counts recorders, and viewers see no recorder status', async () => {
    await apply(orgId, [{ type: 'recorder', id: recC, ok: false, at: ago(3) }, { type: 'recorder', id: recC, ok: false, at: ago(2) }])
    await apply(orgId, [{ type: 'recorder', id: recA, ok: true, at: ago(1) }, { type: 'recorder', id: recB, ok: true, at: ago(1) }])
    await apply(orgId, [{ type: 'camera', id: cams.C2, ok: false, at: ago(2), cause: 'nvr_down' }], 1)
    const it = (await itPerson.client.from('location_status').select('*').eq('location_id', store).single()).data!
    expect(it).toMatchObject({ recorders_total: 3, recorders_up: 2, recorders_down: 1, nvr_status: 'down' })
    const v = (await viewer.client.from('location_status').select('*').eq('location_id', store).single()).data!
    expect(v).toMatchObject({ recorders_total: 0, nvr_status: null })
    expect((await viewer.client.from('check_state').select('target_id').eq('target_type', 'recorder')).data).toEqual([])
    const per = (await itPerson.client.from('recorder_status').select('recorder_id, status').eq('location_id', store)).data!
    expect(new Map(per.map((r) => [r.recorder_id, r.status]))).toEqual(new Map([[recA, 'up'], [recB, 'up'], [recC, 'down']]))
    expect((await viewer.client.rpc('status_reasons', { p_type: 'camera', p_ids: [cams.C2] })).error).toBeNull()
    expect((await viewer.client.from('outages').select('cause').eq('target_id', cams.C2)).data).toEqual([{ cause: 'nvr_down' }])
  })

  it('a head office without an NVR is a normal location: listed, zero recorders, and no monitoring error', async () => {
    const st = (await viewer.client.from('location_status').select('*').eq('location_id', ho).single())
    expect(st.error).toBeNull()
    expect(st.data).toMatchObject({ cameras_total: 0, recorders_total: 0, nvr_status: null })
    expect((await viewer.client.from('locations').select('id, kind').eq('id', ho).single()).data).toEqual({ id: ho, kind: 'head_office' })
    // An old-style 'nvr' result for a location without a recorder is ignored (nothing to check).
    await apply(orgId, [{ type: 'nvr', id: ho, ok: false, at: ago(1) }], 1)
    expect((await admin().from('check_state').select('id').eq('org_id', orgId).eq('target_id', ho)).data).toEqual([])
    // A CCTV grant at the head office shows no IT assets.
    expect((await viewer.client.from('assets').select('id')).data ?? []).toEqual([])
  })

  it('recorder logins are kept in the vault as recorder:<id> and readable only by the server, keyed by recorder', async () => {
    expect((await admin().rpc('recorder_read_credential', { p_recorder: recA })).data).toBe('pass-A')
    expect((await admin().rpc('recorder_read_credential', { p_recorder: recB })).data).toBeNull()
    const info = (await admin().rpc('recorder_credential_status', { p_org: orgId, p_recorder: recA })).data as { set: boolean; name: string }
    expect(info).toEqual({ set: true, name: `recorder:${recA}` })
    expect(JSON.stringify(info)).not.toContain('pass-A')
    for (const c of [viewer.client, itPerson.client, anon()]) {
      expect((await c.rpc('recorder_read_credential', { p_recorder: recA })).error?.code).toBe('42501')
      expect((await c.rpc('recorder_store_credential', { p_recorder: recA, p_secret: 'x' })).error?.code).toBe('42501')
      expect((await c.rpc('nvr_read_credential', { p_store: store })).error?.code).toBe('42501')
    }
    // No secret pointer is readable by signed-in people, even with the IT view.
    expect((await itPerson.client.from('recorders').select('secret_id').limit(1)).error?.code).toBe('42501')
    expect((await itPerson.client.from('recorder_endpoints').select('*').eq('recorder_id', recA).single()).data).toMatchObject({ recorder_id: recA, username: 'viewer' })
  })

  it('the old store-shaped write still works through the seam: one primary recorder, wrappers keyed by location', async () => {
    const legacy = await createLocation(orgId, { code: 'LEGACY', legacyNvr: { ip: '10.250.0.1', username: 'olduser', rtspPort: 8554, httpPort: 8081, channels: 4 } })
    const primary = await primaryRecorderOf(legacy)
    const rec = (await admin().from('recorders').select('location_id, http_port, rtsp_port, username, expected_channels').eq('id', primary).single()).data
    expect(rec).toEqual({ location_id: legacy, http_port: 8081, rtsp_port: 8554, username: 'olduser', expected_channels: 4 })
    expect((await admin().from('assets').select('type, ip, tcp_port').eq('id', primary).single()).data).toEqual({ type: 'nvr', ip: '10.250.0.1', tcp_port: 8081 })
    await admin().from('locations').update({ nvr_username: 'newuser', http_port: 8082 }).eq('id', legacy)
    expect((await admin().from('recorders').select('username, http_port').eq('id', primary).single()).data).toEqual({ username: 'newuser', http_port: 8082 })
    expect((await admin().from('recorders').select('id').eq('location_id', legacy)).data).toHaveLength(1)
    // A camera written the old way (location + channel) is mapped to the primary recorder.
    const cam = await createCamera(orgId, { locationId: legacy, channel: 2 })
    expect((await admin().from('cameras').select('recorder_id').eq('id', cam).single()).data).toEqual({ recorder_id: primary })
    // nvr_store_credential(p_store) is a wrapper over the recorder function.
    expect((await admin().rpc('nvr_store_credential', { p_store: legacy, p_secret: 'legacy-pass' })).error).toBeNull()
    expect((await admin().rpc('recorder_read_credential', { p_recorder: primary })).data).toBe('legacy-pass')
    expect((await admin().rpc('nvr_read_credential', { p_store: legacy })).data).toBe('legacy-pass')
    // monitor_apply_results('nvr', location) writes the primary recorder's state.
    await apply(orgId, [{ type: 'nvr', id: legacy, ok: true, at: ago(1) }])
    expect((await admin().from('check_state').select('target_type, status').eq('target_id', primary).single()).data).toEqual({ target_type: 'recorder', status: 'up' })
    expect((await admin().from('check_state').select('id').eq('target_type', 'nvr').eq('target_id', legacy)).data).toEqual([])
  })

  it('archive keeps history and grants, removes the camera from active views; delete is refused; restore brings it back', async () => {
    const cam = cams.B1
    await apply(orgId, [{ type: 'camera', id: cam, ok: false, at: ago(5) }], 1)
    const grantRows = await grant(orgId, nobody.id, 'cctv.live', atCamera(cam))
    expect((await nobody.client.from('cameras').select('id')).data).toEqual([{ id: cam }])
    for (const t of ['cameras', 'locations', 'assets', 'recorders'] as const) {
      const del = await admin().from(t).delete().eq('id', t === 'cameras' ? cam : t === 'locations' ? store : recA)
      expect(del.error?.code, t).toBe('DR003')
    }
    const r = await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })
    expect(r.error).toBeNull()
    expect((await nobody.client.from('cameras').select('id')).data).toEqual([])
    expect((await nobody.client.rpc('has_capability_for', { p_cap: 'cctv.live', p_kind: 'camera', p_id: cam })).data).toBe(false)
    expect((await viewer.client.from('cameras').select('id').eq('id', cam)).data).toEqual([])
    // History stays: the outage is closed (deactivation closes outages), the grant is not revoked, the mapping is closed.
    const o = (await admin().from('outages').select('ended_at').eq('target_id', cam)).data!
    expect(o).toHaveLength(1)
    expect(o[0].ended_at).not.toBeNull()
    expect((await admin().from('access_grants').select('revoked_at').eq('id', grantRows[0]).single()).data).toEqual({ revoked_at: null })
    expect((await admin().from('camera_channel_mappings').select('id').eq('camera_id', cam).is('valid_to', null)).data).toEqual([])
    expect((await admin().from('cameras').select('archived_at, is_active').eq('id', cam).single()).data!.archived_at).not.toBeNull()
    // Restore: access comes back; the camera has no mapping until it is mapped again.
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam })).error).toBeNull()
    expect((await nobody.client.from('cameras').select('id')).data).toEqual([{ id: cam }])
  })

  it('archiving a recorder that still has cameras is refused; after its cameras are moved it is allowed and keeps its secret', async () => {
    const extra = await createRecorder(orgId, store, { name: 'NVR D', secret: 'pass-D' })
    const cam = await createCamera(orgId, { locationId: store, recorderId: extra, channel: 1 })
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: extra })).error?.code).toBe('DR004')
    await mapCamera(orgId, cam, recC, 11)
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: extra })).error).toBeNull()
    expect((await admin().from('assets').select('enabled, archived_at').eq('id', extra).single()).data!.enabled).toBe(false)
    expect((await admin().rpc('recorder_read_credential', { p_recorder: extra })).data).toBe('pass-D')
    expect((await itPerson.client.from('recorders').select('id').eq('id', extra)).data).toEqual([])
    // A result for an archived recorder is ignored.
    await apply(orgId, [{ type: 'recorder', id: extra, ok: false, at: ago(1) }], 1)
    expect((await admin().from('check_state').select('id').eq('target_id', extra)).data).toEqual([])
  })

  it('monitoring can be switched off per NVR (owner addition: real estate imported locally must not be contacted)', async () => {
    const shop = await createLocation(orgId, { code: 'OFFNVR' })
    const rec = await createRecorder(orgId, shop, { name: 'Real NVR' })
    const cam = await createCamera(orgId, { locationId: shop, recorderId: rec, channel: 1 })
    // Default: on, for every recorder (existing and demo data included).
    expect((await admin().from('recorders').select('monitoring_enabled').eq('id', rec).single()).data).toEqual({ monitoring_enabled: true })
    await apply(orgId, [{ type: 'recorder', id: rec, ok: false, at: ago(5) }, { type: 'camera', id: cam, ok: false, at: ago(5), cause: 'nvr_down' }], 1)
    const actor = await createUser(orgId, 'admin')
    const plainAdmin = await createUser(orgId, 'admin')
    await grant(orgId, actor.id, ['admin.inventory'], ORG_SCOPE)
    const set = (by: string, enabled: boolean, reason: string) =>
      admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: enabled, p_reason: reason, p_actor: by })
    // Only super administrators or holders of admin.inventory, always with a reason.
    expect((await set(plainAdmin.id, false, 'Real NVR, do not contact')).error?.code).toBe('42501')
    expect((await set(actor.id, false, '')).error?.code).toBe('22023')
    expect((await set(actor.id, false, 'Real NVR, do not contact')).error).toBeNull()
    const row = (await admin().from('recorders').select('monitoring_enabled, monitoring_disabled_reason, monitoring_disabled_by, monitoring_disabled_at').eq('id', rec).single()).data!
    expect(row).toMatchObject({ monitoring_enabled: false, monitoring_disabled_reason: 'Real NVR, do not contact', monitoring_disabled_by: actor.id })
    expect(row.monitoring_disabled_at).not.toBeNull()
    const audit = (await admin().from('admin_audit_log').select('action, detail').eq('org_id', orgId).eq('entity_id', rec)).data!
    expect(audit.map((a) => a.action)).toContain('recorder_monitoring_disabled')
    // Switched off: open outages closed, no state, results ignored; the recorder and its cameras show "switched off", not offline.
    for (const [type, id] of [['recorder', rec], ['camera', cam]] as const) {
      expect((await admin().from('outages').select('ended_at').eq('target_type', type).eq('target_id', id)).data!.every((o) => o.ended_at !== null)).toBe(true)
    }
    await apply(orgId, [{ type: 'recorder', id: rec, ok: false, at: ago(1) }, { type: 'camera', id: cam, ok: false, at: ago(1) }], 1)
    expect((await admin().from('check_state').select('id').in('target_id', [rec, cam])).data).toEqual([])
    expect((await itPerson.client.from('recorder_status').select('monitoring_enabled, status').eq('recorder_id', rec).single()).data).toEqual({ monitoring_enabled: false, status: null })
    expect((await itPerson.client.from('location_status').select('recorders_total, recorders_monitoring_off, nvr_status').eq('location_id', shop).single()).data)
      .toEqual({ recorders_total: 1, recorders_monitoring_off: 1, nvr_status: null })
    // A CCTV viewer of the location sees its cameras as switched off (a count and per camera), never the recorder itself.
    const viewerOff = await createUser(orgId, 'user')
    await grant(orgId, viewerOff.id, 'cctv.live', atLocation(shop))
    expect((await viewerOff.client.from('location_status').select('cameras_total, cameras_monitoring_off, cameras_unknown, recorders_total').eq('location_id', shop).single()).data)
      .toEqual({ cameras_total: 1, cameras_monitoring_off: 1, cameras_unknown: 0, recorders_total: 0 })
    expect((await viewerOff.client.rpc('cameras_monitoring_off', { p_ids: [cam, cams.A1] })).data).toEqual([cam])
    // Switched on again: monitoring resumes (starts as not checked yet).
    expect((await set(actor.id, true, 'Lab NVR, allowed')).error).toBeNull()
    await apply(orgId, [{ type: 'recorder', id: rec, ok: true, at: ago(1) }])
    expect((await admin().from('check_state').select('status').eq('target_id', rec).single()).data).toEqual({ status: 'up' })
    expect((await admin().from('recorders').select('monitoring_enabled, monitoring_disabled_reason').eq('id', rec).single()).data).toEqual({ monitoring_enabled: true, monitoring_disabled_reason: null })
  })

  it('addresses are unique within an address space only', async () => {
    await createAsset(orgId, { locationId: store, name: 'Switch 1', ip: '10.77.0.5', port: 22 })
    const dup = await admin().from('assets').insert({ org_id: orgId, location_id: store, type: 'switch', name: 'Switch 2', ip: '10.77.0.5', tcp_port: 22 })
    expect(dup.error?.code).toBe('23505')
    const space = (await admin().from('address_spaces').insert({ org_id: orgId, name: 'Store LAN behind NAT', kind: 'location_nat', location_id: store }).select('id').single()).data!.id
    const other = await createAsset(orgId, { locationId: store, name: 'Switch 3', ip: '10.77.0.5', port: 22, addressSpaceId: space })
    expect(other).toBeTruthy()
    // Exactly one global space per organisation, created with the organisation.
    expect((await admin().from('address_spaces').select('id').eq('org_id', orgId).eq('kind', 'global')).data).toHaveLength(1)
  })

  it('network definitions: an address outside the location\'s management network is flagged, and the head office network is never applied to a store', async () => {
    const shop = await createLocation(orgId, { code: 'NETSHOP' })
    const bare = await createLocation(orgId, { code: 'NETBARE' })
    expect((await admin().from('network_definitions').insert({ org_id: orgId, location_id: ho, management_cidr: '10.10.0.0/24', gateway: '10.10.0.1', dns: ['10.10.0.2'] })).error).toBeNull()
    expect((await admin().from('network_definitions').insert({ org_id: orgId, location_id: shop, management_cidr: '10.20.0.0/24', vlan_map: { staff: 10, guest: 20, device: 30 } })).error).toBeNull()
    const inside = await createAsset(orgId, { locationId: shop, type: 'access_point', name: 'AP in', ip: '10.20.0.9' })
    const outside = await createAsset(orgId, { locationId: shop, type: 'access_point', name: 'AP HO address', ip: '10.10.0.5' })
    const none = await createAsset(orgId, { locationId: bare, type: 'access_point', name: 'AP no network', ip: '10.10.0.6' })
    const check = async (asset: string, host: string) =>
      (await admin().rpc('network_validate_address', { p_org: orgId, p_asset: asset, p_host: host })).data
    expect(await check(inside, '10.20.0.9')).toBe('ok')
    expect(await check(outside, '10.10.0.5')).toBe('outside_location_network')
    expect(await check(none, '10.10.0.6')).toBe('no_network_defined')
    const conflicts = (await admin().rpc('network_address_conflicts', { p_org: orgId })).data as { asset_id: string; status: string }[]
    expect(conflicts.map((c) => c.asset_id)).toContain(outside)
    expect(conflicts.map((c) => c.asset_id)).not.toContain(inside)
    expect(conflicts.find((c) => c.asset_id === outside)?.status).toBe('outside_location_network')
    // A malformed network is refused.
    expect((await admin().from('network_definitions').insert({ org_id: orgId, location_id: bare, management_cidr: 'not-a-network' })).error).not.toBeNull()
  })

  it('asset dependencies: a cycle (and a self-dependency) is refused', async () => {
    const wan = await createAsset(orgId, { locationId: store, type: 'sdwan_edge', name: 'SD-WAN' })
    const sw = await createAsset(orgId, { locationId: store, type: 'switch', name: 'Core switch' })
    const nvrAsset = recA
    const dep = (child: string, parent: string, kind = 'network') => admin().from('asset_dependencies').insert({ org_id: orgId, child_asset_id: child, parent_asset_id: parent, kind })
    expect((await dep(sw, wan)).error).toBeNull()
    expect((await dep(nvrAsset, sw)).error).toBeNull()
    expect((await dep(wan, nvrAsset)).error?.code).toBe('DR005')
    expect((await dep(wan, wan)).error).not.toBeNull()
    expect((await dep(sw, wan, 'magic')).error).not.toBeNull()
  })

  it('the Wi-Fi capability matrix is seeded from the research with a source for every row, and nothing is lab-validated', async () => {
    const { data, error } = await admin().from('device_capabilities').select('*')
    expect(error).toBeNull()
    expect((data ?? []).length).toBeGreaterThan(20)
    for (const r of data ?? []) {
      expect(r.source_ref, `${r.vendor} ${r.model} ${r.operation}`).toMatch(/^(S|I)\d+/)
      expect(['supported', 'unsupported', 'unverified']).toContain(r.support)
      expect(r.adapter_state).not.toBe('lab_validated')
    }
    const wax610Acl = (data ?? []).find((r) => r.model === 'WAX610' && r.management_mode === 'standalone' && r.operation === 'mac_acl')
    expect(wax610Acl).toMatchObject({ vendor: 'NETGEAR', support: 'supported', source_ref: 'S9' })
    const wax615Ssid = (data ?? []).find((r) => r.model === 'WAX615' && r.management_mode === 'standalone' && r.operation === 'ssid_security')
    expect(wax615Ssid?.support).toBe('unverified')
    const telnet = (data ?? []).find((r) => r.model === 'WAC510' && r.operation === 'telnet')
    expect(telnet?.support).toBe('unsupported')
  })

  it('privileges: nothing new is open to anon or to a CCTV-only viewer; privilege_violations stays empty', async () => {
    expect((await admin().rpc('privilege_violations')).data).toEqual([])
    const tables = ['regions', 'clusters', 'locations', 'assets', 'recorders', 'camera_channel_mappings', 'address_spaces', 'asset_endpoints',
      'network_definitions', 'asset_dependencies', 'device_capabilities', 'location_status', 'recorder_status', 'recorder_endpoints',
      'camera_endpoints', 'location_hierarchy', 'inventory_migration_report'] as const
    for (const t of tables) {
      expect((await anon().from(t as 'regions').select('*').limit(1)).error?.code, `anon ${t}`).toBe('42501')
    }
    for (const t of ['recorders', 'camera_channel_mappings', 'asset_endpoints', 'address_spaces', 'network_definitions', 'asset_dependencies', 'recorder_status', 'recorder_endpoints'] as const) {
      const r = await viewer.client.from(t as 'regions').select('*').limit(5)
      expect(r.error === null ? r.data : [], `viewer ${t}`).toEqual([])
    }
    for (const t of ['device_capabilities', 'inventory_migration_report'] as const) {
      expect((await viewer.client.from(t).select('*').limit(1)).error?.code, `viewer ${t}`).toBe('42501')
    }
    // Signed-in people never write inventory.
    expect((await itPerson.client.from('recorders').update({ username: 'x' }).eq('id', recA).select('id')).error?.code).toBe('42501')
    expect((await itPerson.client.from('camera_channel_mappings').insert({ org_id: orgId, camera_id: cams.A1, recorder_id: recA, channel: 50 })).error?.code).toBe('42501')
  })
})
