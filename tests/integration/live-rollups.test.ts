import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDashboard, getStates } from '@/lib/queries/status'
import type { Database } from '@/types/database'
import {
  adminClient, atCamera, atCluster, atLocation, atRegion, CCTV_VIEW, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder,
  createRegion, createUser, grant, ORG_SCOPE, type TestUser,
} from '../setup/fixtures'

// P4-L1 brief item 1: roll-up counts per region, cluster and location from ONE database function, `status_rollups(p_cap)`, evaluated
// with the caller's own access (signed-in people only) and the masking of status_reasons: camera figures for the cameras the caller
// may see (any CCTV right, or exactly `p_cap`); recorder (NVR) figures only over the NVRs the caller has the IT view of, and NULL — not
// 0 — where they have none, so a CCTV-only viewer is never told how many NVRs a place has or how many are down. A camera whose NVR is
// down (the checker's method `nvr_down`) is counted as "recorder not reachable", never as a confirmed camera failure (directive:
// "unknown because a parent is unreachable"). Region and cluster rows only for nodes whose NAMES the caller may see (impact map 1.9,
// review M15: a camera or recorder grant shows no region or cluster). Archived and switched-off places and archived cameras vanish.

type Row = {
  level: 'region' | 'cluster' | 'location'; node_id: string
  cameras_total: number; cameras_live: number; cameras_stale: number; cameras_offline: number; cameras_recorder_unreachable: number
  cameras_not_checked: number; cameras_off: number
  recorders_total: number | null; recorders_up: number | null; recorders_down: number | null; recorders_not_checked: number | null
  recorders_stale: number | null; recorders_off: number | null
}
type Rpc = Parameters<ReturnType<typeof adminClient>['rpc']>[0]
async function rollups(u: TestUser, cap?: string | null): Promise<Row[]> {
  const { data, error } = await (u.client.rpc('status_rollups' as Rpc, (cap === undefined ? {} : { p_cap: cap }) as never) as unknown as PromiseLike<{ data: Row[] | null; error: { message: string } | null }>)
  if (error) throw new Error(error.message)
  return data ?? []
}
const byNode = (rows: Row[]) => new Map(rows.map((r) => [`${r.level}:${r.node_id}`, r]))
const cams = (r: Row | undefined) => r && {
  total: r.cameras_total, live: r.cameras_live, stale: r.cameras_stale, offline: r.cameras_offline, unreachable: r.cameras_recorder_unreachable,
  notChecked: r.cameras_not_checked, off: r.cameras_off,
}
const recs = (r: Row | undefined) => r && { total: r.recorders_total, up: r.recorders_up, down: r.recorders_down, notChecked: r.recorders_not_checked, stale: r.recorders_stale, off: r.recorders_off }
const NO_RECORDERS = { total: null, up: null, down: null, notChecked: null, stale: null, off: null }

describe('status_rollups (P4-L1 roll-ups by region, cluster and location)', () => {
  let orgId: string, otherOrg: string
  let RA: string, RB: string, CA1: string, CA2: string, CB1: string, L1: string, L2: string, L3: string, L0: string
  let N1: string, N2: string, N3: string, N4: string, N5: string
  let c1: string, c2: string, c3: string, c4: string, c5: string, c6: string, c7: string, c8: string, c9: string
  let owner: TestUser, orgAll: TestUser, clusterA1: TestUser, regionB: TestUser, camOnly: TestUser, itOnly: TestUser, playOnly: TestUser, locIt: TestUser
  let foreign: TestUser

  async function state(type: 'camera' | 'recorder', id: string, status: 'up' | 'down' | 'unknown', o: { minutesAgo?: number; method?: string; error?: string } = {}) {
    const at = new Date(Date.now() - (o.minutesAgo ?? 1) * 60_000).toISOString()
    const { error } = await adminClient().from('check_state').insert({
      org_id: orgId, target_type: type, target_id: id, status, last_checked_at: at, down_since: status === 'down' ? at : null, method: o.method ?? null, error: o.error ?? null,
    })
    if (error) throw new Error(error.message)
  }

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    RA = await createRegion(orgId)
    RB = await createRegion(orgId)
    CA1 = await createCluster(orgId, RA)
    CA2 = await createCluster(orgId, RA)
    CB1 = await createCluster(orgId, RB)
    L1 = await createLocation(orgId, { clusterId: CA1 })
    L2 = await createLocation(orgId, { clusterId: CA2 })
    L3 = await createLocation(orgId, { clusterId: CB1 })
    L0 = await createLocation(orgId) // no cluster (owner amendment to R-1): no bucket, no region or cluster row
    N1 = await createRecorder(orgId, L1, { name: 'NVR one' })
    N2 = await createRecorder(orgId, L1, { name: 'NVR two' })
    N3 = await createRecorder(orgId, L2)
    N4 = await createRecorder(orgId, L3, { monitoringOff: 'Shop being refitted' })
    N5 = await createRecorder(orgId, L0)
    c1 = await createCamera(orgId, { locationId: L1, recorderId: N1, channel: 1 })
    c2 = await createCamera(orgId, { locationId: L1, recorderId: N1, channel: 2 })
    c3 = await createCamera(orgId, { locationId: L1, recorderId: N2, channel: 1 })
    c4 = await createCamera(orgId, { locationId: L1, recorderId: N2, channel: 2 })
    c5 = await createCamera(orgId, { locationId: L2, recorderId: N3, channel: 1 })
    c6 = await createCamera(orgId, { locationId: L2, recorderId: N3, channel: 2 })
    c7 = await createCamera(orgId, { locationId: L2, recorderId: N3, channel: 3 })
    c8 = await createCamera(orgId, { locationId: L3, recorderId: N4, channel: 1 })
    c9 = await createCamera(orgId, { locationId: L0, recorderId: N5, channel: 1 })
    await state('camera', c1, 'up')
    await state('camera', c2, 'down', { method: 'rtsp', error: 'RTSP refused on 10.9.9.9 (login admin)' })
    await state('camera', c3, 'down', { method: 'nvr_down', error: 'The NVR is not reachable.' })
    await state('camera', c4, 'down', { method: 'nvr_down', error: 'The NVR is not reachable.' })
    await state('camera', c5, 'up')
    // c6: never checked
    await state('camera', c7, 'up', { minutesAgo: 90 }) // was live, not checked lately
    await state('camera', c9, 'up')
    await state('recorder', N1, 'up')
    await state('recorder', N2, 'down', { method: 'tcp', error: 'No answer from 10.9.9.10:80' })
    await state('recorder', N3, 'up')
    await state('recorder', N5, 'up', { minutesAgo: 90 })
    owner = await createUser(orgId, 'platform_owner') // the acting administrator of the archive steps
    orgAll = await createUser(orgId, 'manager')
    await grant(orgId, orgAll.id, ['cctv.live', 'cctv.playback', 'it.monitoring.view'], ORG_SCOPE)
    clusterA1 = await createUser(orgId, 'user')
    await grant(orgId, clusterA1.id, CCTV_VIEW, atCluster(CA1))
    regionB = await createUser(orgId, 'user')
    await grant(orgId, regionB.id, CCTV_VIEW, atRegion(RB))
    camOnly = await createUser(orgId, 'user')
    await grant(orgId, camOnly.id, CCTV_VIEW, atCamera(c5))
    itOnly = await createUser(orgId, 'user')
    await grant(orgId, itOnly.id, 'it.monitoring.view', ORG_SCOPE)
    playOnly = await createUser(orgId, 'user')
    await grant(orgId, playOnly.id, 'cctv.playback', atCluster(CA1))
    locIt = await createUser(orgId, 'operator')
    await grant(orgId, locIt.id, [...CCTV_VIEW, 'it.monitoring.view'], atLocation(L1))
    foreign = await createUser(otherOrg, 'manager')
    await grant(otherOrg, foreign.id, ['cctv.live', 'it.monitoring.view'], ORG_SCOPE)
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('a cluster viewer (CCTV only) gets exactly their cluster, its region and its location; NVR figures are hidden (null), never 0', async () => {
    const rows = await rollups(clusterA1)
    expect(rows.map((r) => `${r.level}:${r.node_id}`).sort()).toEqual([`cluster:${CA1}`, `location:${L1}`, `region:${RA}`].sort())
    const m = byNode(rows)
    const expected = { total: 4, live: 1, stale: 0, offline: 1, unreachable: 2, notChecked: 0, off: 0 }
    expect(cams(m.get(`location:${L1}`))).toEqual(expected)
    expect(cams(m.get(`cluster:${CA1}`))).toEqual(expected)
    // The region row counts only what this viewer may see in it (their one cluster), never the whole region.
    expect(cams(m.get(`region:${RA}`))).toEqual(expected)
    for (const r of rows) expect(recs(r), `${r.level}`).toEqual(NO_RECORDERS)
  })

  it('a camera whose NVR is down is "recorder not reachable", not offline: only the camera fault counts as offline', async () => {
    const l1 = byNode(await rollups(orgAll)).get(`location:${L1}`)
    expect(l1?.cameras_offline).toBe(1)
    expect(l1?.cameras_recorder_unreachable).toBe(2)
  })

  it('organisation-wide with the IT view: every node, NVR figures per node, and the switched-off NVR counted only as switched off', async () => {
    const m = byNode(await rollups(orgAll))
    expect([...m.keys()].sort()).toEqual([
      `cluster:${CA1}`, `cluster:${CA2}`, `cluster:${CB1}`, `location:${L0}`, `location:${L1}`, `location:${L2}`, `location:${L3}`, `region:${RA}`, `region:${RB}`,
    ].sort())
    expect(cams(m.get(`region:${RA}`))).toEqual({ total: 7, live: 2, stale: 1, offline: 1, unreachable: 2, notChecked: 1, off: 0 })
    expect(cams(m.get(`cluster:${CA2}`))).toEqual({ total: 3, live: 1, stale: 1, offline: 0, unreachable: 0, notChecked: 1, off: 0 })
    expect(cams(m.get(`region:${RB}`))).toEqual({ total: 1, live: 0, stale: 0, offline: 0, unreachable: 0, notChecked: 0, off: 1 })
    expect(cams(m.get(`location:${L0}`))).toEqual({ total: 1, live: 1, stale: 0, offline: 0, unreachable: 0, notChecked: 0, off: 0 })
    expect(recs(m.get(`location:${L1}`))).toEqual({ total: 2, up: 1, down: 1, notChecked: 0, stale: 0, off: 0 })
    expect(recs(m.get(`location:${L3}`))).toEqual({ total: 1, up: 0, down: 0, notChecked: 0, stale: 0, off: 1 })
    expect(recs(m.get(`location:${L0}`))).toEqual({ total: 1, up: 0, down: 0, notChecked: 0, stale: 1, off: 0 })
    expect(recs(m.get(`region:${RA}`))).toEqual({ total: 3, up: 2, down: 1, notChecked: 0, stale: 0, off: 0 })
  })

  // Review round 1, I-3 (MC-4): one rule on every screen — location_status (the Locations list) counts a camera of an unreachable NVR as
  // "recorder not reachable", not as down, exactly like the roll-ups: column by column equal.
  it('the camera figures equal location_status column by column (one rule for both: recorder not reachable is not down)', async () => {
    const m = byNode(await rollups(orgAll))
    const { data, error } = await orgAll.client.from('location_status')
      .select('location_id, cameras_total, cameras_live, cameras_down, cameras_recorder_unreachable, cameras_unknown, cameras_stale, cameras_monitoring_off')
    expect(error).toBeNull()
    expect((data ?? []).length).toBeGreaterThan(0)
    for (const s of (data ?? []) as Record<string, unknown>[]) {
      const r = m.get(`location:${s.location_id}`)
      expect(r, String(s.location_id)).toBeDefined()
      expect([r!.cameras_total, r!.cameras_live, r!.cameras_offline, r!.cameras_recorder_unreachable, r!.cameras_not_checked, r!.cameras_stale, r!.cameras_off])
        .toEqual([s.cameras_total, s.cameras_live, s.cameras_down, s.cameras_recorder_unreachable, s.cameras_unknown, s.cameras_stale, s.cameras_monitoring_off])
    }
    const l1 = ((data ?? []) as Record<string, unknown>[]).find((s) => s.location_id === L1)!
    expect([l1.cameras_down, l1.cameras_recorder_unreachable]).toEqual([1, 2])
  })

  it('a CCTV-only viewer reads the same location_status figures (camera words only; no NVR figure)', async () => {
    const { data, error } = await clusterA1.client.from('location_status').select('location_id, cameras_down, cameras_recorder_unreachable, recorders_total, recorders_down, nvr_status')
    expect(error).toBeNull()
    expect(data).toEqual([{ location_id: L1, cameras_down: 1, cameras_recorder_unreachable: 2, recorders_total: 0, recorders_down: 0, nvr_status: null }])
    // The Home dashboard and the Locations list read the same figures: 1 offline, 2 recorder not reachable.
    expect((await getDashboard(clusterA1.client)).cameras).toMatchObject({ total: 4, down: 1, unreachable: 2 })
    // And one camera's state, as every camera list shows it.
    const states = await getStates(clusterA1.client, 'camera', [c2, c3])
    expect([states.get(c2)?.status, states.get(c3)?.status]).toEqual(['down', 'unreachable'])
  })

  it('a camera-only viewer gets that camera\'s location only: no region or cluster row (their names stay hidden)', async () => {
    const rows = await rollups(camOnly)
    expect(rows.map((r) => `${r.level}:${r.node_id}`)).toEqual([`location:${L2}`])
    expect(cams(rows[0])).toEqual({ total: 1, live: 1, stale: 0, offline: 0, unreachable: 0, notChecked: 0, off: 0 })
    expect(recs(rows[0])).toEqual(NO_RECORDERS)
  })

  it('two people with different scopes see disjoint roll-ups', async () => {
    const a = (await rollups(clusterA1)).map((r) => r.node_id)
    const b = (await rollups(regionB)).map((r) => r.node_id)
    expect(b.sort()).toEqual([CB1, L3, RB].sort())
    expect(a.filter((id) => b.includes(id))).toEqual([])
  })

  it('a location grant with the IT view shows that location\'s NVRs, and its cluster and region rows count only them', async () => {
    const m = byNode(await rollups(locIt))
    expect([...m.keys()].sort()).toEqual([`cluster:${CA1}`, `location:${L1}`, `region:${RA}`].sort())
    expect(recs(m.get(`location:${L1}`))).toEqual({ total: 2, up: 1, down: 1, notChecked: 0, stale: 0, off: 0 })
    expect(recs(m.get(`region:${RA}`))).toEqual({ total: 2, up: 1, down: 1, notChecked: 0, stale: 0, off: 0 })
  })

  it('with a capability: only cameras usable with it, and only rows that have such a camera (the Live tree)', async () => {
    expect(await rollups(playOnly, 'cctv.live')).toEqual([])
    expect((await rollups(playOnly, 'cctv.playback')).map((r) => r.node_id).sort()).toEqual([CA1, L1, RA].sort())
    expect((await rollups(playOnly)).map((r) => r.node_id).sort()).toEqual([CA1, L1, RA].sort())
    // IT only: NVR figures without any camera; with cctv.live nothing at all.
    expect(await rollups(itOnly, 'cctv.live')).toEqual([])
    const it = byNode(await rollups(itOnly))
    expect(cams(it.get(`location:${L1}`))?.total).toBe(0)
    expect(recs(it.get(`location:${L1}`))?.total).toBe(2)
    // Anything but a CCTV capability gives nothing (never an error that tells what exists).
    expect(await rollups(orgAll, 'it.inventory.view')).toEqual([])
    expect(await rollups(orgAll, 'no.such.capability')).toEqual([])
  })

  it('nothing of another organisation, and nobody signed out or with nothing granted gets a row', async () => {
    const ids = new Set([RA, RB, CA1, CA2, CB1, L0, L1, L2, L3])
    expect((await rollups(foreign)).filter((r) => ids.has(r.node_id))).toEqual([])
    expect(await rollups(await createUser(orgId, 'user'))).toEqual([]) // nothing granted: nothing counted
    const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    const r = await (anon.rpc('status_rollups' as Rpc, {} as never) as unknown as PromiseLike<{ error: { code?: string } | null }>)
    expect(r.error?.code).toBe('42501')
  })

  it('archived cameras and archived or switched-off locations vanish at once', async () => {
    const admin = adminClient()
    expect((await admin.rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: c2, p_actor: owner.id })).error).toBeNull()
    expect(cams(byNode(await rollups(clusterA1)).get(`location:${L1}`))).toEqual({ total: 3, live: 1, stale: 0, offline: 0, unreachable: 2, notChecked: 0, off: 0 })
    expect((await admin.from('locations').update({ is_active: false }).eq('id', L2)).error).toBeNull()
    let m = byNode(await rollups(orgAll))
    expect(m.has(`location:${L2}`)).toBe(false)
    expect(m.has(`cluster:${CA2}`)).toBe(false) // nothing left in it to count: no row (the tree shows no empty bucket)
    expect(cams(m.get(`region:${RA}`))?.total).toBe(3)
    expect((await admin.rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: L0, p_actor: owner.id })).error).toBeNull()
    m = byNode(await rollups(orgAll))
    expect(m.has(`location:${L0}`)).toBe(false)
    // Review M-4: what is left still counts as before — the switched-off camera (c8) of L3 as switched off only; the never-checked c6
    // went with its location (L2 switched off); c9 with L0 (archived).
    expect(cams(m.get(`location:${L3}`))).toEqual({ total: 1, live: 0, stale: 0, offline: 0, unreachable: 0, notChecked: 0, off: 1 })
    const ids = new Set((await rollups(orgAll)).map((r) => r.node_id))
    expect([L2, L0].some((id) => ids.has(id))).toBe(false)
    // Nothing was ever written for the never-checked (c6) and the switched-off (c8) camera; c9 is archived with its location.
    expect((await admin.from('check_state').select('target_id').in('target_id', [c6, c8])).data).toEqual([])
    expect((await admin.from('cameras').select('archived_at').eq('id', c9).single()).data?.archived_at).not.toBeNull()
  })
})
