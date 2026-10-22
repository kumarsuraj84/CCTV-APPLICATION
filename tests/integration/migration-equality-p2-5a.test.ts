// P2-5a data migration (brief item 2, impact map 2.2 M4 and 4.4 items 21-23): every store with an NVR becomes a location with an NVR
// asset + recorders row, every camera gets a channel mapping, the 'nvr' monitoring history is re-keyed to ('recorder', recorder id),
// the vault secret is renamed in place (never re-encrypted or exposed), duplicate NVR addresses are moved into their own address space
// and reported. Nobody's access may change: for every legacy kind of person the effective CCTV camera sets (live and playback), the
// whole locations and the IT assets are compared before and after, against the legacy evaluator too (the old rules, P2-1 VA-18).
//
// The legacy shape is built with the normal fixtures (the transitional seam makes recorders), then turned back into the pre-P2-5a shape
// by the test-only inventory_unmigrate_org_test (also what the M4 rollback does), then the legacy oddities are added by hand.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, atAsset, atLocation, cleanupOrg, createCamera, createLocation, createOrg, createUser, grant, type Role, type TestUser } from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[] | null | undefined) => [...(a ?? [])].map(String).sort()
const CAPS = ['cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view', 'wifi.inventory.view'] as const

type Snapshot = { user_id: string; capability: string; cameras: string[]; locations: string[]; assets: string[] }[]
type Report = {
  recorders_created: number; devices_merged: number; address_conflicts: number; secrets_missing: number; secrets_dangling: number
  cameras_mapped: number; check_state_rekeyed: number; outages_rekeyed: number; locations_without_cluster: number
}
const snapshot = async (org: string): Promise<Map<string, Snapshot[number]>> => {
  const { data, error } = await admin().rpc('inventory_effective_snapshot', { p_org: org })
  if (error) throw new Error(error.message)
  return new Map((data as unknown as Snapshot).map((r) => [`${r.user_id}|${r.capability}`, { ...r, cameras: sorted(r.cameras), locations: sorted(r.locations), assets: sorted(r.assets) }]))
}
const fingerprints = async (org: string) => {
  const { data, error } = await admin().rpc('inventory_secret_fingerprint_test', { p_org: org })
  if (error) throw new Error(error.message)
  return data as unknown as { location_id: string; secret_id: string; name: string; ciphertext_sha256: string }[]
}
const rows = async (table: 'check_state' | 'outages', org: string) =>
  (await admin().from(table).select('id, target_type, target_id').eq('org_id', org).order('id')).data!
const count = async (table: 'access_grants' | 'access_migration_report' | 'admin_audit_log' | 'camera_group_items', org: string) =>
  (await admin().from(table).select('*', { count: 'exact', head: true }).eq('org_id', org)).count
const gaps = async () => (await admin().from('monitor_gaps').select('*', { count: 'exact', head: true })).count

describe('P2-5a migration: stores → locations + recorders, history re-keyed, access unchanged for everybody', () => {
  let orgId: string, orgB: string
  const L: Record<string, string> = {}
  const C: Record<string, string> = {}
  let dupDevice: string, plainDevice: string, dupDevice2: string, looseDevice: string
  const people: Record<string, TestUser> = {}
  let before: Map<string, Snapshot[number]>
  let fpBefore: Awaited<ReturnType<typeof fingerprints>>
  let stateBefore: Awaited<ReturnType<typeof rows>>, outagesBefore: Awaited<ReturnType<typeof rows>>
  let counts: Record<string, number | null>
  let gapsBefore: number | null
  let report: Report
  const uptimeAt = new Date().toISOString()
  let uptimeBefore: Map<string, number | null>

  const legacyOrg = async (prefix: string) => {
    const org = await createOrg()
    const map: Record<string, string> = {}
    map.M1 = await createLocation(org, { code: `${prefix}M1`, zone: 'Z', legacyNvr: { ip: '10.60.0.1', channels: 3 } })
    map.M2 = await createLocation(org, { code: `${prefix}M2`, zone: 'Z', legacyNvr: { ip: '10.60.0.1', channels: 2 } }) // the SAME NVR address as M1
    map.M3 = await createLocation(org, { code: `${prefix}M3`, zone: 'Y', legacyNvr: { ip: '10.60.0.3' } }) // no secret
    map.M4 = await createLocation(org, { code: `${prefix}M4`, zone: 'Y', isActive: false, legacyNvr: { ip: '10.60.0.4' } })
    map.M5 = await createLocation(org, { code: `${prefix}M5`, legacyNvr: { ip: '10.60.0.5' } }) // dangling secret pointer (below)
    for (const [k, pw] of [['M1', 'pw-1'], ['M2', 'pw-2'], ['M4', 'pw-4']] as const) {
      const { error } = await admin().rpc('nvr_store_credential', { p_store: map[k], p_secret: pw })
      if (error) throw new Error(error.message)
    }
    return { org, map }
  }

  beforeAll(async () => {
    const a = await legacyOrg('A')
    orgId = a.org
    Object.assign(L, a.map)
    for (const [k, loc, ch] of [['m11', 'M1', 1], ['m12', 'M1', 2], ['m13', 'M1', 3], ['m21', 'M2', 1], ['m22', 'M2', 2], ['m31', 'M3', 1], ['m41', 'M4', 1], ['m51', 'M5', 1]] as const) {
      C[k] = await createCamera(orgId, { locationId: L[loc], channel: ch })
    }
    // Back to the pre-P2-5a shape: legacy NVR columns and nvr_secret_id on the location, 'nvr:<location>' vault names, no recorders.
    const un = await admin().rpc('inventory_unmigrate_org_test', { p_org: orgId })
    if (un.error) throw new Error(un.error.message)
    // Legacy oddities: an nvr-typed device duplicating M3's NVR, an ordinary device, a dangling secret pointer.
    dupDevice = (await admin().from('assets').insert({ org_id: orgId, location_id: L.M3, type: 'nvr', name: 'Old NVR record', ip: '10.60.0.3', tcp_port: 80 }).select('id').single()).data!.id
    plainDevice = (await admin().from('assets').insert({ org_id: orgId, location_id: L.M1, type: 'server', name: 'Back office PC', ip: '10.61.0.9', tcp_port: 3389 }).select('id').single()).data!.id
    // Review M13: a second nvr device of M3's NVR (another port: a duplicate record) and an nvr device without a location at M5's
    // address: neither is adopted; both are reported.
    dupDevice2 = (await admin().from('assets').insert({ org_id: orgId, location_id: L.M3, type: 'nvr', name: 'Old NVR record 2', ip: '10.60.0.3', tcp_port: 8000 }).select('id').single()).data!.id
    looseDevice = (await admin().from('assets').insert({ org_id: orgId, location_id: null, type: 'nvr', name: 'NVR without a location', ip: '10.60.0.5', tcp_port: 8080 }).select('id').single()).data!.id
    expect((await admin().from('locations').update({ nvr_secret_id: randomUUID() }).eq('id', L.M5)).error).toBeNull()
    // Legacy monitoring history: an NVR that is down now (open outage), an earlier closed NVR outage, a camera outage caused by it.
    const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
    for (const r of [
      { target_type: 'nvr', target_id: L.M1, status: 'down', down_since: t(30), last_checked_at: t(1), created_at: t(600) },
      { target_type: 'nvr', target_id: L.M2, status: 'up', last_checked_at: t(1), last_up_at: t(1), created_at: t(600) },
      { target_type: 'camera', target_id: C.m11, status: 'down', down_since: t(30), last_checked_at: t(1), created_at: t(600) },
      // The duplicate nvr device was also monitored as a device (review M2: forgotten when it becomes the recorder).
      { target_type: 'device', target_id: dupDevice, status: 'down', down_since: t(20), last_checked_at: t(1), created_at: t(600) },
    ]) expect((await admin().from('check_state').insert({ org_id: orgId, ...r })).error).toBeNull()
    for (const o of [
      { target_type: 'nvr', target_id: L.M1, started_at: t(30), ended_at: null },
      { target_type: 'nvr', target_id: L.M1, started_at: t(300), ended_at: t(240) },
      { target_type: 'nvr', target_id: L.M2, started_at: t(200), ended_at: t(100) },
      { target_type: 'camera', target_id: C.m11, started_at: t(30), ended_at: null, cause: 'nvr_down' },
      { target_type: 'device', target_id: dupDevice, started_at: t(20), ended_at: null },
    ]) expect((await admin().from('outages').insert({ org_id: orgId, ...o })).error).toBeNull()
    const group = (await admin().from('camera_groups').insert({ org_id: orgId, name: 'Legacy group' }).select('id').single()).data!.id
    for (const c of [C.m11, C.m22, C.m31]) await admin().from('camera_group_items').insert({ org_id: orgId, group_id: group, camera_id: c })

    // Every legacy kind of person (P2-1 VA-18), migrated to grants by the P2-1 migration itself.
    const make = async (key: string, role: Role, o: { home?: string; stores?: string[]; zones?: string[]; cameras?: string[]; mustReset?: boolean } = {}) => {
      const u = await createUser(orgId, role, { locationId: o.home ?? null, mustReset: o.mustReset })
      people[key] = u
      for (const s of o.stores ?? []) await admin().from('user_store_access').insert({ org_id: orgId, user_id: u.id, store_id: s })
      for (const z of o.zones ?? []) await admin().from('user_zone_access').insert({ org_id: orgId, user_id: u.id, zone: z })
      for (const c of o.cameras ?? []) await admin().from('user_camera_access').insert({ org_id: orgId, user_id: u.id, camera_id: c })
    }
    await make('storeOnly', 'user', { stores: [L.M1] })
    await make('zoneOnly', 'user', { zones: ['Z'] })
    await make('homeOnly', 'user', { home: L.M3 })
    await make('storePlusCam', 'user', { stores: [L.M1], cameras: [C.m12] })
    await make('zonePlusCam', 'user', { zones: ['Z'], cameras: [C.m21] })
    await make('camOnly', 'user', { cameras: [C.m11, C.m31] })
    await make('operator', 'operator', { stores: [L.M3] })
    await make('manager', 'manager', { stores: [L.M1] })
    await make('admin', 'admin')
    await make('owner', 'platform_owner')
    await make('inactiveStore', 'user', { stores: [L.M4] })
    await make('inactive', 'user', { stores: [L.M1] })
    await admin().from('profiles').update({ is_active: false }).eq('id', people.inactive.id)
    await make('mustReset', 'user', { zones: ['Y'], mustReset: true })
    await make('nobody', 'user')
    const mig = await admin().rpc('access_migrate_legacy_test', { p_run: randomUUID(), p_users: Object.values(people).map((p) => p.id) })
    if (mig.error) throw new Error(mig.error.message)
    // Two IT people with explicit grants (review I-1): the IT view of store M1, and an IT grant on the duplicate nvr DEVICE only.
    people.itStore = await createUser(orgId, 'user')
    await grant(orgId, people.itStore.id, ['it.inventory.view', 'it.monitoring.view'], atLocation(L.M1))
    people.nvrDeviceIt = await createUser(orgId, 'user')
    await grant(orgId, people.nvrDeviceIt.id, ['it.inventory.view', 'it.monitoring.view'], atAsset(dupDevice))

    // A second legacy organisation that must stay untouched while A migrates.
    const b = await legacyOrg('B')
    orgB = b.org
    await createCamera(orgB, { locationId: b.map.M1, channel: 1 })
    if ((await admin().rpc('inventory_unmigrate_org_test', { p_org: orgB })).error) throw new Error('unmigrate B')
    await admin().from('check_state').insert({ org_id: orgB, target_type: 'nvr', target_id: b.map.M1, status: 'up' })
    L.B1 = b.map.M1

    before = await snapshot(orgId)
    fpBefore = await fingerprints(orgId)
    stateBefore = await rows('check_state', orgId)
    outagesBefore = await rows('outages', orgId)
    counts = {
      grants: await count('access_grants', orgId), report: await count('access_migration_report', orgId),
      audit: await count('admin_audit_log', orgId), items: await count('camera_group_items', orgId),
    }
    gapsBefore = await gaps()
    const up = (await admin().rpc('targets_uptime', { p_org: orgId, p_type: 'nvr', p_ids: [L.M1, L.M2], p_window: '1 day', p_now: uptimeAt })).data ?? []
    uptimeBefore = new Map(up.map((u) => [u.target_id, u.uptime_pct]))

    const res = await admin().rpc('inventory_migrate_org_test', { p_org: orgId })
    if (res.error) throw new Error(res.error.message)
    report = res.data as unknown as Report
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(orgB)
  })

  it('the legacy shape was real: no recorders, legacy vault names, nvr history', async () => {
    expect(fpBefore.map((f) => f.name).sort()).toEqual([L.M1, L.M2, L.M4].map((l) => `nvr:${l}`).sort())
    expect(stateBefore.filter((s) => s.target_type === 'nvr')).toHaveLength(2)
    expect(outagesBefore.filter((s) => s.target_type === 'nvr')).toHaveLength(3)
  })

  it('reports what it did: recorders, the merged device, the shared address, missing and dangling secrets, mappings, history', async () => {
    expect(report).toEqual({
      // Five recorders: four new NVR assets and the adopted nvr device.
      recorders_created: 5, devices_merged: 1, address_conflicts: 1, secrets_missing: 1, secrets_dangling: 1, cameras_mapped: 8,
      check_state_rekeyed: 2, outages_rekeyed: 3, cameras_unmapped: 0, locations_without_cluster: 5, nvr_rows_left: 0,
      devices_unlocated: 1, devices_duplicate: 1, device_history_stopped: 1,
    })
    const r = (await admin().from('inventory_migration_report').select('kind, location_id, detail').eq('org_id', orgId)).data!
    expect(r.filter((x) => x.kind === 'address_conflict').map((x) => x.location_id)).toEqual([L.M2])
    expect(r.filter((x) => x.kind === 'device_merged').map((x) => x.location_id)).toEqual([L.M3])
    expect(r.filter((x) => x.kind === 'secret_missing').map((x) => x.location_id)).toEqual([L.M3])
    expect(r.filter((x) => x.kind === 'secret_dangling').map((x) => x.location_id)).toEqual([L.M5])
    expect(r.filter((x) => x.kind === 'device_duplicate').map((x) => [x.location_id, (x.detail as { asset_id: string }).asset_id])).toEqual([[L.M3, dupDevice2]])
    expect(r.filter((x) => x.kind === 'device_unlocated').map((x) => [x.location_id, (x.detail as { asset_id: string }).asset_id])).toEqual([[L.M5, looseDevice]])
    expect(r.filter((x) => x.kind === 'org_summary')).toHaveLength(1)
    // Neither was adopted; the adopted device's own monitoring as a device stopped (state forgotten, outage closed).
    expect((await admin().from('assets').select('id, location_id, is_recorder').in('id', [dupDevice2, looseDevice]).order('tcp_port')).data)
      .toEqual([{ id: dupDevice2, location_id: L.M3, is_recorder: false }, { id: looseDevice, location_id: null, is_recorder: false }])
    expect((await admin().from('check_state').select('id').eq('target_type', 'device').eq('target_id', dupDevice)).data).toEqual([])
    const devOut = (await admin().from('outages').select('ended_at').eq('target_type', 'device').eq('target_id', dupDevice)).data!
    expect(devOut).toHaveLength(1)
    expect(devOut[0].ended_at).not.toBeNull()
  })

  it('every person keeps exactly the same cameras and whole locations for every capability; assets gain only the new NVR assets of locations they already covered whole', async () => {
    const after = await snapshot(orgId)
    // The NVR of a location was visible as "the location's NVR" to whoever covered the location whole; it is now an asset of that
    // location, so exactly those people see it as an asset. Nothing else changes (and an adopted nvr device keeps its id).
    const created = (await admin().from('inventory_migration_report').select('location_id, recorder_id, detail').eq('org_id', orgId).eq('kind', 'recorder_created')).data!
      .filter((r) => (r.detail as { created_asset: boolean }).created_asset)
    expect(created).toHaveLength(4)
    for (const p of Object.values(people)) {
      for (const cap of CAPS) {
        const k = `${p.id}|${cap}`
        const b = before.get(k)!
        const a = after.get(k)!
        expect(a.cameras, `${k} cameras`).toEqual(b.cameras)
        expect(a.locations, `${k} locations`).toEqual(b.locations)
        const gained = created.filter((r) => b.locations.includes(r.location_id!)).map((r) => r.recorder_id!)
        expect(a.assets, `${k} assets`).toEqual(sorted([...b.assets, ...gained]))
      }
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    // A CCTV-only person never gains an asset.
    expect(after.get(`${people.storeOnly.id}|it.inventory.view`)!.assets).toEqual([])
  })

  it('…and the live and playback cameras still equal the old rules (legacy evaluator, status ignored)', async () => {
    for (const [key, p] of Object.entries(people)) {
      const legacy = sorted((await admin().rpc('access_legacy_camera_ids', { p_user: p.id, p_ignore_status: true })).data as unknown as string[])
      for (const cap of ['cctv.live', 'cctv.playback']) {
        const now = sorted((await admin().rpc('report_effective_camera_ids', { p_user: p.id, p_cap: cap, p_ignore_status: true })).data as unknown as string[])
        expect(now, `${key} ${cap}`).toEqual(legacy)
      }
    }
    // Through row security with the person's own sign-in.
    expect(sorted(((await people.storeOnly.client.from('cameras').select('id')).data ?? []).map((c) => c.id))).toEqual(sorted([C.m11, C.m12, C.m13]))
    expect(sorted(((await people.zonePlusCam.client.from('cameras').select('id')).data ?? []).map((c) => c.id))).toEqual(sorted([C.m11, C.m12, C.m13, C.m21]))
    expect((await people.nobody.client.from('cameras').select('id')).data).toEqual([])
  })

  // Review I-2: an oracle independent of the new functions. The expected sets below are written out by hand from the OLD rules
  // (P2-1 access functions over stores / devices, 20261021000009-0017): organisation = everything; a location = its cameras and
  // devices; a camera = itself; an asset = itself; live and playback = the P2-1 migration of store, zone, home and camera grants
  // (store / zone / home narrowed to the cameras granted inside it). Assets afterwards also hold the NVR assets the migration made
  // for locations the person covered whole (M1, M2, M4, M5; M3's NVR is the adopted device).
  it('the effective sets equal hand-written expectations from the OLD rules, before and after (independent oracle)', async () => {
    const recOf = async (loc: string) => (await admin().from('recorders').select('id').eq('location_id', loc).single()).data!.id
    const nvr = { M1: await recOf(L.M1), M2: await recOf(L.M2), M4: await recOf(L.M4), M5: await recOf(L.M5) }
    const cams = (...k: string[]) => sorted(k.map((x) => C[x]))
    const locs = (...k: string[]) => sorted(k.map((x) => L[x]))
    const ALL = cams('m11', 'm12', 'm13', 'm21', 'm22', 'm31', 'm41', 'm51')
    const ALL_LOCS = locs('M1', 'M2', 'M3', 'M4', 'M5')
    const DEVICES = sorted([dupDevice, plainDevice, dupDevice2, looseDevice])
    type Want = { live: string[]; liveLocs: string[]; export?: string[]; it?: string[]; itLocs?: string[] }
    const want: Record<string, Want> = {
      storeOnly: { live: cams('m11', 'm12', 'm13'), liveLocs: locs('M1') },
      zoneOnly: { live: cams('m11', 'm12', 'm13', 'm21', 'm22'), liveLocs: locs('M1', 'M2') },
      homeOnly: { live: cams('m31'), liveLocs: locs('M3') },
      storePlusCam: { live: cams('m12'), liveLocs: [] },
      zonePlusCam: { live: cams('m11', 'm12', 'm13', 'm21'), liveLocs: locs('M1') },
      camOnly: { live: cams('m11', 'm31'), liveLocs: [] },
      operator: { live: cams('m31'), liveLocs: locs('M3') },
      manager: { live: ALL, liveLocs: ALL_LOCS, it: DEVICES, itLocs: ALL_LOCS },
      admin: { live: ALL, liveLocs: ALL_LOCS, export: ALL, it: DEVICES, itLocs: ALL_LOCS },
      owner: { live: ALL, liveLocs: ALL_LOCS, export: ALL, it: DEVICES, itLocs: ALL_LOCS },
      inactiveStore: { live: cams('m41'), liveLocs: locs('M4') },
      inactive: { live: cams('m11', 'm12', 'm13'), liveLocs: locs('M1') },
      mustReset: { live: cams('m31', 'm41'), liveLocs: locs('M3', 'M4') },
      nobody: { live: [], liveLocs: [] },
      itStore: { live: [], liveLocs: [], it: [plainDevice], itLocs: locs('M1') },
      nvrDeviceIt: { live: [], liveLocs: [], it: [dupDevice], itLocs: [] },
    }
    expect(Object.keys(want).sort()).toEqual(Object.keys(people).sort())
    const after = await snapshot(orgId)
    for (const [key, w] of Object.entries(want)) {
      const id = people[key].id
      for (const [label, snap] of [['before', before], ['after', after]] as const) {
        const get = (cap: string) => snap.get(`${id}|${cap}`)!
        expect(get('cctv.live').cameras, `${label} ${key} live`).toEqual(w.live)
        expect(get('cctv.playback').cameras, `${label} ${key} playback`).toEqual(w.live)
        expect(get('cctv.live').locations, `${label} ${key} live locations`).toEqual(w.liveLocs)
        expect(get('cctv.export').cameras, `${label} ${key} export`).toEqual(w.export ?? [])
        expect(get('it.inventory.view').locations, `${label} ${key} IT locations`).toEqual(w.itLocs ?? [])
        const gained = label === 'after' ? (w.itLocs ?? []).flatMap((l) => Object.entries(nvr).filter(([k]) => L[k] === l).map(([, r]) => r)) : []
        expect(get('it.inventory.view').assets, `${label} ${key} IT assets`).toEqual(sorted([...(w.it ?? []), ...gained]))
      }
    }
  })

  it('recorder-level IT visibility after the migration equals the old store-NVR visibility, through the person\'s own sign-in (review I-1)', async () => {
    const r1 = (await admin().from('recorders').select('id').eq('location_id', L.M1).single()).data!.id
    const see = async (u: TestUser) => ({
      nvrEndpointsAt: ((await u.client.from('recorder_endpoints').select('location_id')).data ?? []).map((x) => x.location_id).sort(),
      cameraEndpoints: ((await u.client.from('camera_endpoints').select('camera_id')).data ?? []).map((x) => x.camera_id).sort(),
      mappings: ((await u.client.from('camera_channel_mappings').select('camera_id')).data ?? []).map((x) => x.camera_id).sort(),
      nvrStates: ((await u.client.from('check_state').select('target_type, target_id').in('target_type', ['recorder', 'nvr'])).data ?? []).map((x) => x.target_id).sort(),
      recorders: ((await u.client.from('recorders').select('id')).data ?? []).map((x) => x.id).sort(),
    })
    // Old: store_nvr_endpoints and camera_endpoints for the stores the IT view covers whole; 'nvr' states of those stores.
    expect(await see(people.itStore)).toEqual({
      nvrEndpointsAt: [L.M1], cameraEndpoints: sorted([C.m11, C.m12, C.m13]), mappings: sorted([C.m11, C.m12, C.m13]), nvrStates: [r1], recorders: [r1],
    })
    // Old: an asset grant on the nvr DEVICE showed that device row only — never the store's NVR login, camera addresses or NVR state.
    expect(await see(people.nvrDeviceIt)).toEqual({ nvrEndpointsAt: [], cameraEndpoints: [], mappings: [], nvrStates: [], recorders: [] })
    expect(((await people.nvrDeviceIt.client.from('assets').select('id')).data ?? []).map((x) => x.id)).toEqual([dupDevice])
    expect((await people.nvrDeviceIt.client.from('asset_endpoints').select('id')).data).toEqual([])
    // Organisation-wide IT (the manager): every store's NVR and every camera address, as before.
    const m = await see(people.manager)
    expect(m.nvrEndpointsAt).toEqual(sorted([L.M1, L.M2, L.M3, L.M4, L.M5]))
    expect(m.cameraEndpoints).toEqual(sorted(Object.values(C)))
    // A CCTV-only person: nothing of it.
    expect(await see(people.zoneOnly)).toEqual({ nvrEndpointsAt: [], cameraEndpoints: [], mappings: [], nvrStates: [], recorders: [] })
  })

  it('ids are kept: locations, cameras and devices; the duplicate nvr device became the recorder of its location', async () => {
    const cams = sorted(((await admin().from('cameras').select('id').eq('org_id', orgId)).data ?? []).map((c) => c.id))
    expect(cams).toEqual(sorted(Object.values(C)))
    const locs = sorted(((await admin().from('locations').select('id').eq('org_id', orgId)).data ?? []).map((c) => c.id))
    expect(locs).toEqual(sorted([L.M1, L.M2, L.M3, L.M4, L.M5]))
    const recs = (await admin().from('recorders').select('id, location_id, secret_id, migrated_from_location_id').eq('org_id', orgId)).data!
    expect(recs).toHaveLength(5)
    const byLoc = new Map(recs.map((r) => [r.location_id, r]))
    expect(byLoc.get(L.M3)!.id).toBe(dupDevice)
    expect(byLoc.get(L.M3)!.secret_id).toBeNull()
    expect(byLoc.get(L.M5)!.secret_id).toBeNull()
    expect((await admin().from('assets').select('id').eq('id', plainDevice)).data).toHaveLength(1)
    // Every camera is mapped to its location's recorder on its old channel; the cache columns equal the active mapping.
    const maps = (await admin().from('camera_channel_mappings').select('camera_id, recorder_id, channel').eq('org_id', orgId).is('valid_to', null)).data!
    expect(maps).toHaveLength(8)
    const camRows = (await admin().from('cameras').select('id, location_id, recorder_id, channel').eq('org_id', orgId)).data!
    for (const c of camRows) {
      const m = maps.find((x) => x.camera_id === c.id)!
      expect(m.recorder_id).toBe(byLoc.get(c.location_id)!.id)
      expect(c.recorder_id).toBe(m.recorder_id)
      expect(c.channel).toBe(m.channel)
    }
    // The inactive location's recorder is switched off; the shared address went to its own space.
    expect((await admin().from('assets').select('enabled').eq('id', byLoc.get(L.M4)!.id).single()).data).toEqual({ enabled: false })
    const m2Space = (await admin().from('assets').select('address_space_id').eq('id', byLoc.get(L.M2)!.id).single()).data!.address_space_id
    expect((await admin().from('address_spaces').select('kind, location_id').eq('id', m2Space!).single()).data).toEqual({ kind: 'location_nat', location_id: L.M2 })
  })

  it('monitoring history is re-keyed to the recorders with equal counts, one open outage per target, and equal uptime', async () => {
    const recOf = async (loc: string) => (await admin().from('recorders').select('id').eq('location_id', loc).single()).data!.id
    const r1 = await recOf(L.M1)
    const r2 = await recOf(L.M2)
    const st = await rows('check_state', orgId)
    const ou = await rows('outages', orgId)
    // Every row stays except the adopted device's own 'device' state (review M2: that box is monitored as the recorder now).
    expect(st.map((s) => s.id).sort()).toEqual(stateBefore.filter((s) => !(s.target_type === 'device' && s.target_id === dupDevice)).map((s) => s.id).sort())
    expect(ou.map((s) => s.id).sort()).toEqual(outagesBefore.map((s) => s.id).sort())
    expect(st.filter((s) => s.target_type === 'nvr')).toEqual([])
    expect(ou.filter((s) => s.target_type === 'nvr')).toEqual([])
    expect(st.filter((s) => s.target_type === 'recorder').map((s) => s.target_id).sort()).toEqual([r1, r2].sort())
    expect(ou.filter((s) => s.target_type === 'recorder' && s.target_id === r1)).toHaveLength(2)
    const open = (await admin().from('outages').select('target_id').eq('org_id', orgId).is('ended_at', null)).data!
    expect(new Set(open.map((o) => o.target_id)).size).toBe(open.length)
    expect((await admin().from('outages').select('cause').eq('target_id', C.m11)).data).toEqual([{ cause: 'nvr_down' }])
    const up = (await admin().rpc('targets_uptime', { p_org: orgId, p_type: 'recorder', p_ids: [r1, r2], p_window: '1 day', p_now: uptimeAt })).data ?? []
    expect(new Map(up.map((u) => [u.target_id, u.uptime_pct]))).toEqual(new Map([[r1, uptimeBefore.get(L.M1)], [r2, uptimeBefore.get(L.M2)]]))
  })

  it('vault secrets: same row, same ciphertext, renamed recorder:<id>, still readable by the server; nothing else changed', async () => {
    const after = await fingerprints(orgId)
    for (const f of fpBefore) {
      const a = after.find((x) => x.secret_id === f.secret_id)!
      expect(a, f.name).toBeDefined()
      expect(a.ciphertext_sha256).toBe(f.ciphertext_sha256)
      expect(a.location_id).toBe(f.location_id)
      const rec = (await admin().from('recorders').select('id').eq('location_id', f.location_id).single()).data!.id
      expect(a.name).toBe(`recorder:${rec}`)
    }
    const read = async (loc: string) => {
      const rec = (await admin().from('recorders').select('id').eq('location_id', loc).single()).data!.id
      return (await admin().rpc('recorder_read_credential', { p_recorder: rec })).data
    }
    expect(await read(L.M1)).toBe('pw-1')
    expect(await read(L.M2)).toBe('pw-2')
    expect(await read(L.M4)).toBe('pw-4')
    expect((await admin().rpc('nvr_read_credential', { p_store: L.M1 })).data).toBe('pw-1')
    expect((await admin().from('locations').select('nvr_secret_id').eq('org_id', orgId).not('nvr_secret_id', 'is', null)).data).toEqual([])
    expect({
      grants: await count('access_grants', orgId), report: await count('access_migration_report', orgId),
      audit: await count('admin_audit_log', orgId), items: await count('camera_group_items', orgId),
    }).toEqual(counts)
    expect(await gaps()).toBe(gapsBefore)
  })

  it('a second run changes nothing; the other organisation was not touched', async () => {
    const snap = await snapshot(orgId)
    const again = (await admin().rpc('inventory_migrate_org_test', { p_org: orgId })).data as unknown as Report
    expect(again).toMatchObject({ recorders_created: 0, devices_merged: 0, cameras_mapped: 0, check_state_rekeyed: 0, outages_rekeyed: 0 })
    expect(await snapshot(orgId)).toEqual(snap)
    expect((await admin().from('recorders').select('id').eq('org_id', orgId)).data).toHaveLength(5)
    expect((await admin().from('recorders').select('id').eq('org_id', orgB)).data).toEqual([])
    expect((await admin().from('check_state').select('target_type').eq('org_id', orgB)).data).toEqual([{ target_type: 'nvr' }])
    expect((await fingerprints(orgB)).every((f) => f.name.startsWith('nvr:'))).toBe(true)
  })

  it('a failure in the middle of a run leaves the organisation exactly as it was (one transaction)', async () => {
    const fp = await fingerprints(orgB)
    const r = await admin().rpc('inventory_migrate_org_test', { p_org: orgB, p_fail_at: 'after_rekey' })
    expect(r.error?.message).toMatch(/injected failure/)
    expect((await admin().from('recorders').select('id').eq('org_id', orgB)).data).toEqual([])
    expect((await admin().from('check_state').select('target_type, target_id').eq('org_id', orgB)).data).toEqual([{ target_type: 'nvr', target_id: L.B1 }])
    expect(await fingerprints(orgB)).toEqual(fp)
    // The test helpers refuse every organisation that was not made by the tests.
    const real = (await admin().from('organizations').select('id').not('slug', 'like', 'test-%').limit(1)).data
    if (real?.length) {
      expect((await admin().rpc('inventory_migrate_org_test', { p_org: real[0].id })).error?.code).toBe('42501')
      expect((await admin().rpc('inventory_unmigrate_org_test', { p_org: real[0].id })).error?.code).toBe('42501')
    }
  })

  it('no function body still names the old tables or columns (except the listed legacy and seam functions)', async () => {
    const { data, error } = await admin().rpc('inventory_stale_name_scan')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
