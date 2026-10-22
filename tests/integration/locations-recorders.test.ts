import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  adminClient, atCamera, atLocation, atRecorder, cleanupOrg, createAsset, createCamera, createLocation, createOrg, createRecorder, createUser,
  grant, mapCamera, ORG_SCOPE, type TestUser,
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
    // Refused by the partial unique (23505) or the no-overlap exclusion (23P01), whichever PostgreSQL checks first.
    const twice = await admin().from('camera_channel_mappings').insert({ org_id: orgId, camera_id: cams.A1, recorder_id: recB, channel: 9 })
    expect(['23505', '23P01']).toContain(twice.error?.code)
    const taken = await admin().from('camera_channel_mappings').insert({ org_id: orgId, camera_id: cams.C3, recorder_id: recA, channel: 1 })
    expect(['23505', '23P01']).toContain(taken.error?.code)
    // A second camera on an occupied channel through the camera row is refused the same way, and leaves no camera behind.
    const dup = await admin().from('cameras').insert({ org_id: orgId, location_id: store, recorder_id: recA, channel: 2, name: 'dup' })
    expect(['23505', '23P01']).toContain(dup.error?.code)
    expect((await admin().from('cameras').select('id').eq('name', 'dup').eq('org_id', orgId)).data).toEqual([])
    expect((await admin().from('camera_channel_mappings').select('camera_id').eq('org_id', orgId).is('valid_to', null)).data).toHaveLength(9)
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
    expect((await viewer.client.rpc('status_reasons', { p_type: 'camera', p_ids: [cams.C2] })).data).toEqual([{ target_id: cams.C2, reason: null }])
    expect((await viewer.client.from('outages').select('cause').eq('target_id', cams.C2)).data).toEqual([{ cause: 'nvr_down' }])
  })

  it('a head office without an NVR is a normal location: listed, zero recorders, and no monitoring error', async () => {
    const st = (await viewer.client.from('location_status').select('*').eq('location_id', ho).single())
    expect(st.error).toBeNull()
    expect(st.data).toMatchObject({ cameras_total: 0, recorders_total: 0, nvr_status: null })
    expect((await viewer.client.from('locations').select('id, kind').eq('id', ho).single()).data).toEqual({ id: ho, kind: 'head_office' })
    // An old-style 'nvr' result is ignored (P2-5b: the kind no longer exists).
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
      expect((await c.rpc('recorder_delete_credential', { p_recorder: recA })).error?.code).toBe('42501')
    }
    // No secret pointer is readable by signed-in people, even with the IT view.
    expect((await itPerson.client.from('recorders').select('secret_id').limit(1)).error?.code).toBe('42501')
    expect((await itPerson.client.from('recorder_endpoints').select('*').eq('recorder_id', recA).single()).data).toMatchObject({ recorder_id: recA, username: 'viewer' })
  })

  // P2-5b replaces "the old store-shaped write still works through the seam": the contract migration removed the seam.
  it('the seam is gone: no NVR columns on a location, no location-keyed wrappers, no \'nvr\' kind; a camera without a recorder maps only to a sole NVR', async () => {
    const legacy = await createLocation(orgId, { code: 'LEGACY' })
    const written = await admin().from('locations').update({ nvr_ip: '10.250.0.1' } as never).eq('id', legacy)
    expect(written.error?.code).toBe('PGRST204') // the column does not exist any more
    expect((await admin().from('recorders').select('id').eq('location_id', legacy)).data).toEqual([])
    for (const [fn, args] of [['nvr_store_credential', { p_store: legacy, p_secret: 'x' }], ['nvr_read_credential', { p_store: legacy }], ['recorder_seam_of', { p_location: legacy }]] as const) {
      expect((await admin().rpc(fn as never, args as never)).error?.code, fn).toBe('PGRST202')
    }
    // The old ('nvr', location) result is ignored, and the kind cannot be stored at all.
    const only = await createRecorder(orgId, legacy, { host: '10.250.0.1' })
    await apply(orgId, [{ type: 'nvr', id: legacy, ok: true, at: ago(1) }])
    expect((await admin().from('check_state').select('id').in('target_id', [legacy, only])).data).toEqual([])
    expect((await admin().from('check_state').insert({ org_id: orgId, target_type: 'nvr', target_id: legacy })).error?.code).toBe('23514')
    expect((await admin().from('outages').insert({ org_id: orgId, target_type: 'nvr', target_id: legacy, started_at: ago(1) })).error?.code).toBe('23514')
    // A camera written the old way (location + channel) is mapped to the location's ONLY NVR; with two NVRs it stays unmapped.
    const cam = await createCamera(orgId, { locationId: legacy, channel: 2 })
    expect((await admin().from('cameras').select('recorder_id').eq('id', cam).single()).data).toEqual({ recorder_id: only })
    await createRecorder(orgId, legacy, { host: '10.250.0.2' })
    const loose = await createCamera(orgId, { locationId: legacy, channel: 3 })
    expect((await admin().from('cameras').select('recorder_id').eq('id', loose).single()).data).toEqual({ recorder_id: null })
    expect((await admin().from('camera_channel_mappings').select('id').eq('camera_id', loose)).data).toEqual([])
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
    const audit = (await admin().from('admin_audit_log').select('action, detail').eq('org_id', orgId).eq('entity_id', rec).neq('action', 'recorder_created')).data!
    expect(audit).toEqual([{ action: 'recorder_monitoring_disabled', detail: { reason: 'Real NVR, do not contact', was_enabled: true } }])
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
    const eps = (await admin().from('asset_endpoints').select('asset_id, address_space_id').eq('org_id', orgId).eq('host', '10.77.0.5').is('retired_at', null)).data!
    expect(eps.find((e) => e.asset_id === other)?.address_space_id).toBe(space)
    expect(eps).toHaveLength(2)
    expect(new Set(eps.map((e) => e.address_space_id)).size).toBe(2)
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
    const conflicts = (await admin().rpc('network_address_conflicts', { p_org: orgId })).data as { asset_id: string; location_id: string; status: string }[]
    expect(conflicts.filter((c) => c.location_id === shop).map((c) => [c.asset_id, c.status])).toEqual([[outside, 'outside_location_network']])
    expect(conflicts.filter((c) => c.location_id === bare)).toEqual([])
    // A malformed network is refused.
    expect((await admin().from('network_definitions').insert({ org_id: orgId, location_id: bare, management_cidr: 'not-a-network' })).error?.code).toBe('22P02')
  })

  it('asset dependencies: a cycle (and a self-dependency) is refused', async () => {
    const wan = await createAsset(orgId, { locationId: store, type: 'sdwan_edge', name: 'SD-WAN' })
    const sw = await createAsset(orgId, { locationId: store, type: 'switch', name: 'Core switch' })
    const nvrAsset = recA
    const dep = (child: string, parent: string, kind = 'network') => admin().from('asset_dependencies').insert({ org_id: orgId, child_asset_id: child, parent_asset_id: parent, kind })
    expect((await dep(sw, wan)).error).toBeNull()
    expect((await dep(nvrAsset, sw)).error).toBeNull()
    expect((await dep(wan, nvrAsset)).error?.code).toBe('DR005')
    expect((await dep(wan, wan)).error?.code).toBe('DR005') // the cycle trigger (BEFORE) refuses it before the CHECK is reached
    expect((await dep(sw, wan, 'magic')).error?.code).toBe('23514')
    expect((await admin().from('asset_dependencies').select('child_asset_id, parent_asset_id').eq('org_id', orgId).order('created_at')).data)
      .toEqual([{ child_asset_id: sw, parent_asset_id: wan }, { child_asset_id: nvrAsset, parent_asset_id: sw }])
  })

  it('the Wi-Fi capability matrix is seeded from the research with a source for every row, and nothing is lab-validated', async () => {
    const { data, error } = await admin().from('device_capabilities').select('*')
    expect(error).toBeNull()
    expect((data ?? []).length).toBe(65) // every sourced cell of docs/drishti/wifi-capability-research.md, nothing else
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

  it('privileges: nothing new is open to anon or to a CCTV-only viewer; privilege_violations stays empty (fix round 1: exact)', async () => {
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

// ── P2-5a review, fix round 1 (I-1, M2..M15) ────────────────────────────────────────────────────────────────────────────────────
describe('P2-5a review fix round 1', () => {
  let orgId: string, other: string
  let region: string, cluster: string, loc: string, seam: string, recX: string, sw: string
  let camX: string, camS: string
  let assetOnX: TestUser, recOnX: TestUser, camOnly: TestUser, recOnly: TestUser, assetOnly: TestUser, locHolder: TestUser, orgWide: TestUser
  const readAll = async (u: TestUser) => ({
    assets: ids((await u.client.from('assets').select('id')).data),
    recorders: ids((await u.client.from('recorders').select('id')).data),
    endpoints: ((await u.client.from('recorder_endpoints').select('recorder_id')).data ?? []).map((r) => r.recorder_id).sort(),
    cameraEndpoints: ((await u.client.from('camera_endpoints').select('camera_id')).data ?? []).map((r) => r.camera_id).sort(),
    mappings: ((await u.client.from('camera_channel_mappings').select('camera_id')).data ?? []).map((r) => r.camera_id).sort(),
    assetEndpoints: ((await u.client.from('asset_endpoints').select('asset_id, purpose')).data ?? []).map((r) => `${r.asset_id}:${r.purpose}`).sort(),
    states: ((await u.client.from('check_state').select('target_type, target_id')).data ?? []).map((r) => `${r.target_type}:${r.target_id}`).sort(),
    outages: ((await u.client.from('outages').select('target_type, target_id')).data ?? []).map((r) => `${r.target_type}:${r.target_id}`).sort(),
    recorderStatus: ((await u.client.from('recorder_status').select('recorder_id')).data ?? []).map((r) => r.recorder_id).sort(),
  })
  const version = async (user: string) => (await admin().from('profiles').select('access_version').eq('id', user).single()).data!.access_version

  beforeAll(async () => {
    orgId = await createOrg()
    other = await createOrg()
    region = must(await admin().from('regions').insert({ org_id: orgId, code: 'RVR', name: 'Review region' }).select('id').single()).id
    cluster = must(await admin().from('clusters').insert({ org_id: orgId, region_id: region, code: 'RVC', name: 'Review cluster' }).select('id').single()).id
    loc = await createLocation(orgId, { code: 'RV1', clusterId: cluster })
    // P2-5b: the location's first NVR (it was made through the seam before the contract migration).
    seam = await createRecorder(orgId, loc, { host: '10.91.0.1' })
    recX = await createRecorder(orgId, loc, { name: 'NVR X', secret: 'pass-X' })
    camX = await createCamera(orgId, { locationId: loc, recorderId: recX, channel: 1 })
    camS = await createCamera(orgId, { locationId: loc, recorderId: seam, channel: 1 })
    sw = await createAsset(orgId, { locationId: loc, type: 'switch', name: 'RV switch' })
    assetOnX = await createUser(orgId, 'user')
    recOnX = await createUser(orgId, 'user')
    camOnly = await createUser(orgId, 'user')
    recOnly = await createUser(orgId, 'user')
    assetOnly = await createUser(orgId, 'user')
    locHolder = await createUser(orgId, 'user')
    orgWide = await createUser(orgId, 'user')
    await grant(orgId, assetOnX.id, ['it.inventory.view', 'it.monitoring.view'], { kind: 'asset', id: recX })
    await grant(orgId, recOnX.id, ['it.inventory.view', 'it.monitoring.view'], atRecorder(recX))
    await grant(orgId, camOnly.id, 'cctv.live', atCamera(camX))
    await grant(orgId, recOnly.id, 'cctv.live', atRecorder(recX))
    await grant(orgId, assetOnly.id, 'it.inventory.view', { kind: 'asset', id: sw })
    await grant(orgId, locHolder.id, 'cctv.live', atLocation(loc))
    await grant(orgId, orgWide.id, ['cctv.live', 'it.monitoring.view'], ORG_SCOPE)
    await apply(orgId, [{ type: 'recorder', id: recX, ok: false, at: ago(3), error: 'Login refused by NVR X' }, { type: 'recorder', id: recX, ok: false, at: ago(2), error: 'Login refused by NVR X' }])
    await apply(orgId, [{ type: 'camera', id: camX, ok: true, at: ago(1) }])
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(other)
  })

  it('I-1: an IT grant on the NVR\'s ASSET shows only the asset row — no logins, camera addresses, mappings, recorder states or reasons', async () => {
    expect(await readAll(assetOnX)).toEqual({
      assets: [recX], recorders: [], endpoints: [], cameraEndpoints: [], mappings: [], assetEndpoints: [], states: [], outages: [], recorderStatus: [],
    })
    expect((await assetOnX.client.rpc('status_reasons', { p_type: 'recorder', p_ids: [recX] })).data).toEqual([])
    expect((await assetOnX.client.from('location_status').select('recorders_total, cameras_total').eq('location_id', loc).single()).data).toEqual({ recorders_total: 0, cameras_total: 0 })
    expect((await assetOnX.client.rpc('it_view_recorder_ids')).data).toEqual([])
    // The same capabilities at RECORDER scope show the recorder level (the narrowest scope that does).
    expect(await readAll(recOnX)).toEqual({
      assets: [recX], recorders: [recX], endpoints: [recX], cameraEndpoints: [camX], mappings: [camX],
      assetEndpoints: [`${recX}:management`, `${recX}:rtsp`], states: [`recorder:${recX}`], outages: [`recorder:${recX}`], recorderStatus: [recX],
    })
    expect((await recOnX.client.rpc('status_reasons', { p_type: 'recorder', p_ids: [recX] })).data).toEqual([{ target_id: recX, reason: 'Login refused by NVR X' }])
    // The organisation-wide IT view sees both NVRs of the location and both cameras' addresses.
    const all = await readAll(orgWide)
    expect({ recorders: all.recorders, cameraEndpoints: all.cameraEndpoints }).toEqual({ recorders: [recX, seam].sort(), cameraEndpoints: [camX, camS].sort() })
  })

  it('M15: region and cluster names only for grants at, above or a whole location below the node (impact map 1.9)', async () => {
    for (const u of [camOnly, recOnly, assetOnly, assetOnX, recOnX]) {
      expect(ids((await u.client.from('regions').select('id')).data), 'regions').toEqual([])
      expect(ids((await u.client.from('clusters').select('id')).data), 'clusters').toEqual([])
    }
    expect(ids((await locHolder.client.from('regions').select('id')).data)).toEqual([region])
    expect(ids((await locHolder.client.from('clusters').select('id')).data)).toEqual([cluster])
    // The location row itself stays visible for every grant inside it.
    for (const u of [camOnly, recOnly, assetOnly, locHolder]) expect(ids((await u.client.from('locations').select('id')).data)).toEqual([loc])
  })

  // P2-5b replaces "M3: the seam keeps writing to the location's legacy NVR only": the seam is gone (contract migration). Each NVR is
  // saved on its own (recorder_save); the location's first NVR is its primary for the legacy form and CSV, and no other NVR ever gets its
  // address or password. DR009 protected the legacy address on the location row, which no longer exists.
  it('M3 after the contract: every NVR keeps its own address and password; the first is the primary; any NVR without cameras can be archived', async () => {
    const shop = await createLocation(orgId, { code: 'RVSEAM' })
    const first = await createRecorder(orgId, shop, { host: '10.92.0.7', name: 'First', secret: 'first-pass' })
    const later = await createRecorder(orgId, shop, { host: '10.92.0.8', name: 'Later' })
    expect((await admin().rpc('recorder_primary_of', { p_location: shop })).data).toBe(first)
    // Changing the primary NVR changes it alone.
    expect((await admin().rpc('recorder_save', { p_org: orgId, p_location: shop, p_recorder: first, p_host: '10.92.0.9', p_http_port: 8081, p_rtsp_port: 8554, p_username: 'changed' })).error).toBeNull()
    expect(must(await admin().from('assets').select('ip').eq('id', first).single())).toEqual({ ip: '10.92.0.9' })
    expect(must(await admin().from('assets').select('ip').eq('id', later).single())).toEqual({ ip: '10.92.0.8' })
    expect(must(await admin().from('recorders').select('username').eq('id', later).single())).toEqual({ username: 'viewer' })
    expect((await admin().rpc('recorder_read_credential', { p_recorder: first })).data).toBe('first-pass')
    expect((await admin().rpc('recorder_read_credential', { p_recorder: later })).data).toBeNull()
    // recorder_save refuses an NVR of another location and an archived one.
    const elsewhere = await createLocation(orgId, { code: 'RVSEAM2' })
    expect((await admin().rpc('recorder_save', { p_org: orgId, p_location: elsewhere, p_recorder: later, p_host: '10.92.0.10', p_http_port: 80, p_rtsp_port: 554, p_username: 'x' })).error?.code).toBe('P0002')
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: first })).error).toBeNull()
    expect((await admin().rpc('recorder_primary_of', { p_location: shop })).data).toBe(later)
    expect((await admin().rpc('recorder_save', { p_org: orgId, p_location: shop, p_recorder: first, p_host: '10.92.0.11', p_http_port: 80, p_rtsp_port: 554, p_username: 'x' })).error?.code).toBe('P0002')
  })

  // P2-5b replaces the seam's address-match adoption (gone with the contract migration) by its guard, which stays: an nvr asset that
  // becomes a recorder stops being monitored as a device; recorder_save never adopts an existing asset by its address.
  it('M2/M13: an nvr asset that becomes a recorder forgets its device history; recorder_save never adopts a device by address', async () => {
    const shop = await createLocation(orgId, { code: 'RVADOPT' })
    const dev = must(await admin().from('assets').insert({ org_id: orgId, location_id: shop, type: 'nvr', name: 'Old NVR row', ip: '10.93.0.1', tcp_port: 80 }).select('id').single()).id
    await apply(orgId, [{ type: 'device', id: dev, ok: false, at: ago(2) }], 1)
    expect(must(await admin().from('outages').select('ended_at').eq('target_type', 'device').eq('target_id', dev))).toEqual([{ ended_at: null }])
    expect((await admin().from('recorders').insert({ id: dev, org_id: orgId, location_id: shop, username: 'u' })).error).toBeNull()
    expect((await admin().rpc('recorder_primary_of', { p_location: shop })).data).toBe(dev)
    expect(must(await admin().from('check_state').select('id').eq('target_type', 'device').eq('target_id', dev))).toEqual([])
    const outs = must(await admin().from('outages').select('ended_at').eq('target_type', 'device').eq('target_id', dev))
    expect(outs).toHaveLength(1)
    expect(outs[0].ended_at).not.toBeNull()
    // A device results for it are ignored from now on (it is a recorder).
    await apply(orgId, [{ type: 'device', id: dev, ok: false, at: ago(1) }], 1)
    expect(must(await admin().from('check_state').select('id').eq('target_type', 'device').eq('target_id', dev))).toEqual([])
    const loose = must(await admin().from('assets').insert({ org_id: orgId, location_id: null, type: 'nvr', name: 'NVR without a location', ip: '10.93.0.2', tcp_port: 8080 }).select('id').single()).id
    const shop2 = await createLocation(orgId, { code: 'RVLOOSE' })
    const rec2 = await createRecorder(orgId, shop2, { host: '10.93.0.2', httpPort: 8080 })
    expect(rec2).not.toBe(loose)
    expect(must(await admin().from('assets').select('location_id, is_recorder').eq('id', loose).single())).toEqual({ location_id: null, is_recorder: false })
  })

  it('M4/M15: a switched-off or disabled NVR is never contacted: no results, no password, its cameras count as switched off only', async () => {
    const shop = await createLocation(orgId, { code: 'RVOFF' })
    const off = await createRecorder(orgId, shop, { name: 'Disabled NVR', secret: 'pass-off' })
    const cam = await createCamera(orgId, { locationId: shop, recorderId: off, channel: 1 })
    const viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, 'cctv.live', atLocation(shop))
    expect((await admin().from('assets').update({ enabled: false }).eq('id', off)).error).toBeNull()
    await apply(orgId, [{ type: 'camera', id: cam, ok: true, at: ago(1) }, { type: 'recorder', id: off, ok: true, at: ago(1) }], 1)
    expect(must(await admin().from('check_state').select('id').in('target_id', [cam, off]))).toEqual([])
    expect((await viewer.client.rpc('cameras_monitoring_off', { p_ids: [cam] })).data).toEqual([cam])
    expect(must(await viewer.client.from('location_status').select('cameras_total, cameras_live, cameras_unknown, cameras_monitoring_off').eq('location_id', shop).single()))
      .toEqual({ cameras_total: 1, cameras_live: 0, cameras_unknown: 0, cameras_monitoring_off: 1 })
    // Monitoring switched off: the server will not even read the password.
    expect((await admin().from('assets').update({ enabled: true }).eq('id', off)).error).toBeNull()
    expect((await admin().rpc('recorder_read_credential', { p_recorder: off })).data).toBe('pass-off')
    expect((await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: off, p_enabled: false, p_reason: 'Do not contact' })).error).toBeNull()
    const read = await admin().rpc('recorder_read_credential', { p_recorder: off })
    expect(read.error?.code).toBe('55000')
    expect(read.data).toBeNull()
  })

  it('M6: remapping a camera onto a switched-off NVR forgets its state; a camera is never counted live AND switched off', async () => {
    const shop = await createLocation(orgId, { code: 'RVREMAP' })
    const on = await createRecorder(orgId, shop, { name: 'On' })
    const offRec = await createRecorder(orgId, shop, { name: 'Off' })
    const cam = await createCamera(orgId, { locationId: shop, recorderId: on, channel: 1 })
    await apply(orgId, [{ type: 'camera', id: cam, ok: true, at: ago(1) }])
    expect(must(await admin().from('check_state').select('status').eq('target_id', cam))).toEqual([{ status: 'up' }])
    await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: offRec, p_enabled: false, p_reason: 'Not ours' })
    await mapCamera(orgId, cam, offRec, 4)
    expect(must(await admin().from('check_state').select('id').eq('target_id', cam))).toEqual([])
    // Even a stale 'up' row (written behind the database's back) is shown as switched off, never also as live.
    expect((await admin().from('check_state').insert({ org_id: orgId, target_type: 'camera', target_id: cam, status: 'up', last_checked_at: ago(1) })).error).toBeNull()
    expect(must(await orgWide.client.from('location_status').select('cameras_total, cameras_live, cameras_down, cameras_stale, cameras_unknown, cameras_monitoring_off').eq('location_id', shop).single()))
      .toEqual({ cameras_total: 1, cameras_live: 0, cameras_down: 0, cameras_stale: 0, cameras_unknown: 0, cameras_monitoring_off: 1 })
    // The direct cache update path (cameras.recorder_id) takes the same rule.
    await mapCamera(orgId, cam, on, 2)
    await apply(orgId, [{ type: 'camera', id: cam, ok: true, at: ago(1) }])
    expect((await admin().from('cameras').update({ recorder_id: offRec, channel: 5 }).eq('id', cam)).error).toBeNull()
    expect(must(await admin().from('check_state').select('id').eq('target_id', cam))).toEqual([])
  })

  it('M5/M15: a restored camera comes back unmapped, with its old on/off state, and is not checked until it is mapped again', async () => {
    const shop = await createLocation(orgId, { code: 'RVREST' })
    const r = await createRecorder(orgId, shop)
    const on = await createCamera(orgId, { locationId: shop, recorderId: r, channel: 1 })
    const wasOff = await createCamera(orgId, { locationId: shop, recorderId: r, channel: 2, isActive: false })
    for (const c of [on, wasOff]) {
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: c })).error).toBeNull()
      expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: c })).error).toBeNull()
    }
    expect(must(await admin().from('cameras').select('id, is_active, recorder_id').in('id', [on, wasOff]).order('channel')))
      .toEqual([{ id: on, is_active: true, recorder_id: null }, { id: wasOff, is_active: false, recorder_id: null }])
    expect(must(await admin().from('camera_channel_mappings').select('id').in('camera_id', [on, wasOff]).is('valid_to', null))).toEqual([])
    await apply(orgId, [{ type: 'camera', id: on, ok: true, at: ago(1) }])
    expect(must(await admin().from('check_state').select('id').eq('target_id', on))).toEqual([])
    await mapCamera(orgId, on, r, 1)
    await apply(orgId, [{ type: 'camera', id: on, ok: true, at: ago(1) }])
    expect(must(await admin().from('check_state').select('status').eq('target_id', on))).toEqual([{ status: 'up' }])
    // An asset switched off before it was archived stays off after its restore.
    const dev = await createAsset(orgId, { locationId: shop, name: 'Was off' })
    await admin().from('assets').update({ enabled: false }).eq('id', dev)
    await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'asset', p_id: dev })
    await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'asset', p_id: dev })
    expect(must(await admin().from('assets').select('enabled, archived_at').eq('id', dev).single())).toEqual({ enabled: false, archived_at: null })
  })

  it('M8: archive, restore and remap raise the access version of exactly the people whose access changes', async () => {
    const shop = await createLocation(orgId, { code: 'RVVER' })
    const r1 = await createRecorder(orgId, shop)
    const r2 = await createRecorder(orgId, shop)
    const cam = await createCamera(orgId, { locationId: shop, recorderId: r1, channel: 1 })
    const atLoc = await createUser(orgId, 'user')
    const atR1 = await createUser(orgId, 'user')
    const atR2 = await createUser(orgId, 'user')
    const elsewhere = await createUser(orgId, 'user')
    await grant(orgId, atLoc.id, 'cctv.live', atLocation(shop))
    await grant(orgId, atR1.id, 'cctv.live', atRecorder(r1))
    await grant(orgId, atR2.id, 'cctv.live', atRecorder(r2))
    await grant(orgId, elsewhere.id, 'cctv.live', atLocation(loc))
    const people = [atLoc, atR1, atR2, elsewhere, orgWide]
    const snap = async () => Object.fromEntries(await Promise.all(people.map(async (p) => [p.id, await version(p.id)] as const)))
    const changed = (a: Record<string, number>, b: Record<string, number>) => people.filter((p) => b[p.id] > a[p.id]).map((p) => p.id).sort()

    let v = await snap()
    await mapCamera(orgId, cam, r2, 1) // only the two recorder holders gain or lose the camera
    let w = await snap()
    expect(changed(v, w)).toEqual([atR1.id, atR2.id].sort())
    v = w
    await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: cam })
    w = await snap()
    expect(changed(v, w)).toEqual([atLoc.id, atR2.id, orgWide.id].sort())
    v = w
    await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'camera', p_id: cam }) // unmapped: the recorder holder gets nothing back
    w = await snap()
    expect(changed(v, w)).toEqual([atLoc.id, orgWide.id].sort())
    v = w
    await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: r1 })
    w = await snap()
    expect(changed(v, w)).toEqual([atLoc.id, atR1.id, orgWide.id].sort())
    v = w
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: shop })).error).toBeNull()
    w = await snap()
    expect(changed(v, w)).toEqual([atLoc.id, atR2.id, orgWide.id].sort())
    v = w
    expect((await admin().rpc('inventory_restore', { p_org: orgId, p_kind: 'location', p_id: shop })).error).toBeNull()
    w = await snap()
    expect(changed(v, w)).toEqual([atLoc.id, atR2.id, orgWide.id].sort())
  })

  it('M9/M14: discovery ranges inside the network, same-organisation uplink, no parent cycle, address spaces of the right location', async () => {
    const shop = await createLocation(orgId, { code: 'RVNET' })
    const ok = await admin().from('network_definitions').insert({ org_id: orgId, location_id: shop, management_cidr: '10.30.0.0/24', discovery_ranges: ['10.30.0.0/25'] })
    expect(ok.error).toBeNull()
    const bad = await admin().from('network_definitions').update({ discovery_ranges: ['10.30.0.0/25', '10.31.0.0/24'] }).eq('location_id', shop)
    expect(bad.error?.code).toBe('22023')
    expect(bad.error?.message).toMatch(/discovery range 10\.31\.0\.0\/24 is outside the management network/)
    // The uplink is an asset of the same organisation.
    const foreign = await createAsset(other, { locationId: null, type: 'sdwan_edge', name: 'Other org edge' })
    expect((await admin().from('locations').update({ uplink_asset_id: foreign }).eq('id', shop)).error?.code).toBe('23503')
    const edge = await createAsset(orgId, { locationId: shop, type: 'sdwan_edge', name: 'Edge' })
    expect((await admin().from('locations').update({ uplink_asset_id: edge }).eq('id', shop)).error).toBeNull()
    // Parent locations never form a cycle.
    const a = await createLocation(orgId, { code: 'RVPA' })
    const b = await createLocation(orgId, { code: 'RVPB' })
    expect((await admin().from('locations').update({ parent_location_id: a }).eq('id', b)).error).toBeNull()
    const cyc = await admin().from('locations').update({ parent_location_id: b }).eq('id', a)
    expect(cyc.error?.code).toBe('DR008')
    // An asset may use a location's own address space only at that location.
    const space = must(await admin().from('address_spaces').insert({ org_id: orgId, name: 'RVNET own', kind: 'location_nat', location_id: shop }).select('id').single()).id
    const wrong = await admin().from('assets').insert({ org_id: orgId, location_id: a, type: 'switch', name: 'Wrong space', ip: '10.30.0.9', address_space_id: space })
    expect(wrong.error?.code).toBe('23514')
    expect((await admin().from('assets').insert({ org_id: orgId, location_id: shop, type: 'switch', name: 'Right space', ip: '10.30.0.9', address_space_id: space })).error).toBeNull()
  })

  it('M12: the test clean-up refuses an organisation that is not a test or demo organisation, before deleting anything', async () => {
    const realish = await createOrg()
    const l = await createLocation(realish, { code: 'KEEP' })
    await admin().from('admin_audit_log').insert({ org_id: realish, action: 'kept', entity_type: 'organization', entity_id: realish })
    expect((await admin().from('organizations').update({ slug: `real-${realish}` }).eq('id', realish)).error).toBeNull()
    try {
      await expect(cleanupOrg(realish)).rejects.toThrow(/refused: "real-/)
      expect(must(await admin().from('locations').select('id').eq('id', l))).toEqual([{ id: l }])
      expect(must(await admin().from('admin_audit_log').select('action').eq('org_id', realish))).toEqual([{ action: 'kept' }])
    } finally {
      await admin().from('organizations').update({ slug: `test-${realish}` }).eq('id', realish)
      await cleanupOrg(realish)
    }
  })
})

function must<T>(r: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (r.error || r.data === null || r.data === undefined) throw new Error(r.error?.message ?? 'no row')
  return r.data as NonNullable<T>
}
