// P2-1 acceptance tests for the capability access model (docs/drishti/access-model.md).
// Each test is one requirement of the brief (VA-n) and names the directive requirement it proves (AC-n).
// Every positive and negative case goes through PostgREST with the person's own JWT; the service role only builds fixtures.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { createGroup, MSG_NAME_TAKEN } from '@/lib/groups/service'
import type { Database } from '@/types/database'
import { fenced } from '../setup/lease'
import {
  adminClient,
  atCamera,
  atLocation,
  atAsset,
  CCTV_VIEW,
  cleanupOrg,
  createOrg,
  createRecorder,
  createUser,
  grant,
  ORG_SCOPE,
  primaryRecorderOf,
  READ_EVERYTHING,
  withRecorders,
  type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[]) => [...a].sort()
const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

type Fn = keyof Database['public']['Functions']

// P2-5b: a store is a location with its NVR (a recorder of its own; the location row holds no NVR data).
async function addStore(orgId: string, code: string, zone: string | null = null): Promise<string> {
  const { data, error } = await admin().from('locations').insert({ org_id: orgId, code, name: `Store ${code}`, zone }).select('id').single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  await createRecorder(orgId, data.id, { host: '192.0.2.10', username: 'viewer' })
  return data.id
}
async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, location_id: storeId, channel, name: `Camera ${channel}`, camera_ip: `192.0.2.${100 + channel}` }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}
let port = 20
async function addDevice(orgId: string, storeId: string | null, name: string): Promise<string> {
  const { data, error } = await admin().from('assets').insert({ org_id: orgId, location_id: storeId, type: 'server', name, ip: '192.0.2.50', tcp_port: port++ }).select('id').single()
  if (error || !data) throw new Error(`addDevice: ${error?.message}`)
  return data.id
}

/** A set-returning function called as the person: the ids, sorted. */
async function ids(u: TestUser, fn: Fn, args: Record<string, unknown> = {}): Promise<string[]> {
  const { data, error } = await u.client.rpc(fn, args as never)
  expect(error, `${fn}`).toBeNull()
  return sorted((data as unknown as string[]) ?? [])
}
async function can(u: TestUser, cap: string): Promise<boolean> {
  const { data, error } = await u.client.rpc('has_capability', { p_cap: cap })
  expect(error).toBeNull()
  return data as boolean
}
async function canFor(u: TestUser, cap: string, kind: 'camera' | 'location' | 'asset', id: string): Promise<boolean> {
  const { data, error } = await u.client.rpc('has_capability_for', { p_cap: cap, p_kind: kind, p_id: id })
  expect(error).toBeNull()
  return data as boolean
}
// P2-5a: stores → locations, devices → assets. A location's NVR is an asset too (a recorder). Review I-2: every asset row the person
// can read is counted (NVR recorder assets included), so an "is empty" check can never be satisfied by a filter.
async function rows(u: TestUser, table: 'locations' | 'cameras' | 'assets' | 'camera_groups' | 'profiles' | 'admin_audit_log'): Promise<string[]> {
  const { data, error } = await u.client.from(table).select('id')
  expect(error, table).toBeNull()
  return sorted((data ?? []).map((r) => r.id))
}
async function token(u: TestUser): Promise<string> {
  return (await u.client.auth.getSession()).data.session!.access_token
}

describe('capability access model (P2-1)', () => {
  let orgA: string, orgB: string
  let L1: string, L2: string, L3: string, LB: string
  let c11: string, c12: string, c13: string, c21: string, c22: string, c31: string, cB: string
  let d1: string, d2: string, d0: string, dB: string
  let n1: string, n2: string, n3: string, nB: string // the locations' NVR recorder assets (made by the seam)

  beforeAll(async () => {
    orgA = await createOrg()
    orgB = await createOrg()
    L1 = await addStore(orgA, 'L1', 'N')
    L2 = await addStore(orgA, 'L2', 'N')
    L3 = await addStore(orgA, 'L3', 'S')
    LB = await addStore(orgB, 'LB', 'N')
    c11 = await addCamera(orgA, L1, 1)
    c12 = await addCamera(orgA, L1, 2)
    c13 = await addCamera(orgA, L1, 3)
    c21 = await addCamera(orgA, L2, 1)
    c22 = await addCamera(orgA, L2, 2)
    c31 = await addCamera(orgA, L3, 1)
    cB = await addCamera(orgB, LB, 1)
    d1 = await addDevice(orgA, L1, 'L1 server')
    d2 = await addDevice(orgA, L2, 'L2 server')
    d0 = await addDevice(orgA, null, 'Head office')
    dB = await addDevice(orgB, LB, 'Other org server')
    ;[n1, n2, n3, nB] = await Promise.all([L1, L2, L3, LB].map((l) => primaryRecorderOf(l)))
  })
  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('VA-1 (AC-2): a live-only person is denied playback and export', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, 'cctv.live', atLocation(L1))
    expect(await can(p, 'cctv.live')).toBe(true)
    expect(await can(p, 'cctv.playback')).toBe(false)
    expect(await can(p, 'cctv.export')).toBe(false)
    expect(await canFor(p, 'cctv.live', 'camera', c11)).toBe(true)
    expect(await canFor(p, 'cctv.playback', 'camera', c11)).toBe(false)
    expect(await canFor(p, 'cctv.export', 'camera', c11)).toBe(false)
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })).toEqual(sorted([c11, c12, c13]))
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.playback' })).toEqual([])
    expect(await ids(p, 'cameras_with_capability', { p_cap: 'cctv.playback', p_ids: [c11, c12] })).toEqual([])
    expect(await ids(p, 'cameras_with_capability', { p_cap: 'cctv.live', p_ids: [c11, c21] })).toEqual([c11])
  })

  it('VA-2 (AC-2): export is denied even with live and playback', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, CCTV_VIEW, [atLocation(L1), atLocation(L2)])
    expect(await can(p, 'cctv.playback')).toBe(true)
    expect(await can(p, 'cctv.export')).toBe(false)
    expect(await canFor(p, 'cctv.export', 'camera', c21)).toBe(false)
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.export' })).toEqual([])
  })

  it('VA-3 (AC-4): a CCTV store grant shows no devices, no IT status and no NVR status, but camera status', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, CCTV_VIEW, atLocation(L1))
    const at = new Date().toISOString()
    const applied = await admin().rpc('monitor_apply_results', {
      // P2-7: every worker write carries a lease and its fencing token (a test lease here); the threshold is no longer optional.
      ...(await fenced()),
      p_threshold: 2,
      p_org: orgA,
      // P2-6: camera results name their recorder (required), as the worker sends them.
      p_results: await withRecorders([
        { type: 'camera', id: c11, ok: true, at },
        { type: 'device', id: d1, ok: true, at },
        { type: 'recorder', id: n1, ok: true, at },
      ]),
    })
    expect(applied.error).toBeNull()
    await admin().from('outages').insert([
      { org_id: orgA, target_type: 'device', target_id: d1, started_at: at, ended_at: at },
      { org_id: orgA, target_type: 'recorder', target_id: n1, started_at: at, ended_at: at },
      { org_id: orgA, target_type: 'camera', target_id: c11, started_at: at, ended_at: at },
    ])
    expect(await rows(p, 'assets')).toEqual([])
    const states = await p.client.from('check_state').select('target_type, target_id')
    expect(states.error).toBeNull()
    expect(states.data).toEqual([{ target_type: 'camera', target_id: c11 }])
    const outs = await p.client.from('outages').select('target_type')
    expect(outs.data).toEqual([{ target_type: 'camera' }])
    const status = await p.client.from('location_status').select('location_id, cameras_total, nvr_status, recorders_total')
    expect(status.data).toEqual([{ location_id: L1, cameras_total: 3, nvr_status: null, recorders_total: 0 }])
    for (const cap of ['it.inventory.view', 'it.monitoring.view']) {
      expect(await can(p, cap)).toBe(false)
      expect(await ids(p, 'capability_asset_ids', { p_cap: cap })).toEqual([])
    }

    // The same location with it.monitoring.view shows the devices and their status (and nothing of CCTV). The NVR status is the
    // location's recorder's ('recorder' rows; P2-5b: the old 'nvr' kind no longer exists).
    const it_ = await createUser(orgA, 'user')
    await grant(orgA, it_.id, 'it.monitoring.view', atLocation(L1))
    expect(await rows(it_, 'assets')).toEqual(sorted([d1, n1]))
    expect(await rows(it_, 'cameras')).toEqual([])
    const itStates = await it_.client.from('check_state').select('target_type').order('target_type')
    expect(itStates.data).toEqual([{ target_type: 'device' }, { target_type: 'recorder' }])
    // An asset grant shows exactly that asset; a device without a location needs an organisation or asset grant.
    const one = await createUser(orgA, 'user')
    await grant(orgA, one.id, 'it.inventory.view', atAsset(d0))
    expect(await rows(one, 'assets')).toEqual([d0])
  })

  it('VA-4 (AC-5): selected-camera grants across two locations, with live different from playback', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, 'cctv.live', [atCamera(c11), atCamera(c21)])
    await grant(orgA, p.id, 'cctv.playback', [atCamera(c12), atCamera(c21)])
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })).toEqual(sorted([c11, c21]))
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.playback' })).toEqual(sorted([c12, c21]))
    expect(await ids(p, 'any_cctv_camera_ids')).toEqual(sorted([c11, c12, c21]))
    expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c21]))
    expect(await rows(p, 'locations')).toEqual(sorted([L1, L2]))
    expect(await canFor(p, 'cctv.live', 'location', L1)).toBe(false) // one camera is not the whole location
    expect(await canFor(p, 'cctv.playback', 'camera', c11)).toBe(false)
  })

  it('VA-5 (AC-6): adding camera grants to a location grant never narrows it', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, CCTV_VIEW, atLocation(L1))
    const before = await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })
    expect(before).toEqual(sorted([c11, c12, c13]))
    await grant(orgA, p.id, 'cctv.live', [atCamera(c11), atCamera(c21)])
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })).toEqual(sorted([c11, c12, c13, c21]))
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.playback' })).toEqual(sorted([c11, c12, c13]))
    expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c13, c21]))
    // A location grant includes cameras added later.
    const later = await addCamera(orgA, L1, 9)
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.playback' })).toEqual(sorted([c11, c12, c13, later]))
    // (P2-5a: cameras are archived, never deleted.)
    await admin().rpc('inventory_archive', { p_org: orgA, p_kind: 'camera', p_id: later })
  })

  it('VA-6 (AC-7): a home store on the profile grants nothing', async () => {
    const p = await createUser(orgA, 'user', { storeId: L1 })
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await rows(p, t)).toEqual([])
    expect(await can(p, 'cctv.live')).toBe(false)
    expect(await canFor(p, 'cctv.live', 'location', L1)).toBe(false)
    // The column stays, as information only.
    const own = await p.client.from('profiles').select('location_id').eq('id', p.id).single()
    expect(own.data?.location_id).toBe(L1)
  })

  it('VA-7 (AC-8): a manager without grants sees nothing but their own profile; admin.users opens the profiles', async () => {
    const m = await createUser(orgA, 'manager')
    await createUser(orgA, 'user')
    for (const t of ['locations', 'cameras', 'assets', 'camera_groups', 'admin_audit_log'] as const) expect(await rows(m, t)).toEqual([])
    expect((await m.client.from('check_state').select('id')).data).toEqual([])
    expect((await m.client.from('outages').select('id')).data).toEqual([])
    expect((await m.client.from('location_status').select('location_id')).data).toEqual([])
    expect(await rows(m, 'profiles')).toEqual([m.id])

    // Final fix Y (review A M-3, ruling E-1 / rule 7): admin.* is refused for a non-administrator on every path now (before: a manager
    // could be given admin.users by the service key and then read every profile). The manager keeps reading only their own profile.
    await expect(grant(orgA, m.id, 'admin.users')).rejects.toThrow(/only for administrators/)
    expect(await rows(m, 'profiles')).toEqual([m.id])
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await rows(m, t)).toEqual([])

    // P2-2 fix M-2: no role literal any more: an administrator reads only their own profile until granted admin.users, and no data.
    const a = await createUser(orgA, 'admin')
    expect(await rows(a, 'profiles')).toEqual([a.id])
    await grant(orgA, a.id, 'admin.users')
    expect((await rows(a, 'profiles')).length).toBeGreaterThan(2)
    for (const t of ['locations', 'cameras', 'assets', 'admin_audit_log'] as const) expect(await rows(a, t)).toEqual([])
    await grant(orgA, a.id, 'admin.audit.read')
    const { data: mine } = await admin().from('admin_audit_log').insert({ org_id: orgA, actor_id: a.id, action: 'test' }).select('id').single()
    // (Other rows of the organisation, such as the P2-5a archive record of VA-5, are visible too: admin.audit.read is organisation-wide.)
    const all = sorted(((await admin().from('admin_audit_log').select('id').eq('org_id', orgA)).data ?? []).map((r) => r.id))
    expect(all).toContain(mine!.id)
    expect(await rows(a, 'admin_audit_log')).toEqual(all)
    expect(await rows(m, 'admin_audit_log')).toEqual([])
  })

  it('VA-8 (AC-6): overlapping grants are a predictable union, and granting the same thing twice is idempotent', async () => {
    const p = await createUser(orgA, 'user')
    const first = await grant(orgA, p.id, 'cctv.live', [atLocation(L1), atCamera(c11)])
    const version = (await admin().from('profiles').select('access_version').eq('id', p.id).single()).data!.access_version
    const again = await grant(orgA, p.id, 'cctv.live', [atLocation(L1), atCamera(c11)])
    expect(again).toEqual(first)
    expect((await admin().from('profiles').select('access_version').eq('id', p.id).single()).data!.access_version).toBe(version)
    const active = await admin().from('access_grants').select('id').eq('user_id', p.id).is('revoked_at', null)
    expect(active.data).toHaveLength(2)
    await grant(orgA, p.id, 'cctv.playback', atCamera(c21))
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })).toEqual(sorted([c11, c12, c13]))
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.playback' })).toEqual([c21])
    expect(await ids(p, 'any_cctv_camera_ids')).toEqual(sorted([c11, c12, c13, c21]))
  })

  // Review fix I-1 (AC-6 union rule): granting is monotonic. A grant never shortens or narrows an existing one; only revoke_grant takes away.
  describe('fix I-1: granting never narrows (monotonic windows), and the preview says exactly what the write does', () => {
    const hour = 3_600_000
    const iso = (ms: number) => new Date(ms).toISOString()
    const liveRows = async (userId: string) =>
      (await admin().from('access_grants').select('id, valid_from, valid_until, revoked_at, revoke_reason').eq('user_id', userId).eq('capability', 'cctv.live')).data ?? []
    const versionOf = async (userId: string) => (await admin().from('profiles').select('access_version').eq('id', userId).single()).data!.access_version
    const previewCounts = async (userId: string, changes: unknown[], at?: string) => {
      const { data, error } = await admin().rpc('preview_access_change', { p_org: orgA, p_user: userId, p_changes: changes as never, ...(at ? { p_at: at } : {}) })
      expect(error).toBeNull()
      const c = (data as { capabilities: Record<string, { added_count: number; removed_count: number }> }).capabilities['cctv.live']
      return { added: c?.added_count ?? 0, removed: c?.removed_count ?? 0 }
    }
    const effectiveAt = async (userId: string, at: string) => {
      const { data, error } = await admin().rpc('report_effective_camera_ids', { p_user: userId, p_cap: 'cctv.live', p_at: at })
      expect(error).toBeNull()
      return sorted((data as unknown as string[]) ?? [])
    }

    it('a dated grant over a permanent one leaves the permanent one as it is', async () => {
      const p = await createUser(orgA, 'user')
      const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L1))
      const v = await versionOf(p.id)
      const change = { op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L1, valid_until: iso(Date.now() + hour) }
      expect(await previewCounts(p.id, [change], iso(Date.now() + 2 * hour))).toEqual({ added: 0, removed: 0 })
      const [again] = await grant(orgA, p.id, 'cctv.live', atLocation(L1), { validUntil: iso(Date.now() + hour) })
      expect(again).toBe(g)
      expect(await versionOf(p.id)).toBe(v)
      const rowsNow = await liveRows(p.id)
      expect(rowsNow).toHaveLength(1)
      expect(rowsNow[0]).toMatchObject({ id: g, valid_until: null, revoked_at: null })
      expect(await effectiveAt(p.id, iso(Date.now() + 2 * hour))).toEqual(sorted([c11, c12, c13]))
    })

    it('a future-dated grant over a live one does not take today’s access away', async () => {
      const p = await createUser(orgA, 'user')
      const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L1))
      const future = { validFrom: iso(Date.now() + 24 * hour), validUntil: iso(Date.now() + 48 * hour) }
      expect(await previewCounts(p.id, [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L1, valid_from: future.validFrom, valid_until: future.validUntil }])).toEqual({ added: 0, removed: 0 })
      const [again] = await grant(orgA, p.id, 'cctv.live', atLocation(L1), future)
      expect(again).toBe(g)
      expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c13]))
    })

    it('a later window over a dated live grant widens it to the union of both, and the preview counts match the write', async () => {
      const p = await createUser(orgA, 'user')
      const start = Date.now() - hour
      const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L1), { validFrom: iso(start), validUntil: iso(Date.now() + 2 * hour) })
      const later = { validFrom: iso(Date.now() + 24 * hour), validUntil: iso(Date.now() + 48 * hour) }
      const at = iso(Date.now() + 3 * hour) // between the two windows: the union covers it
      const before = await effectiveAt(p.id, iso(Date.now()))
      const predicted = await previewCounts(p.id, [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L1, valid_from: later.validFrom, valid_until: later.validUntil }], at)
      expect(predicted).toEqual({ added: 0, removed: 0 })
      await grant(orgA, p.id, 'cctv.live', atLocation(L1), later)
      const after = await effectiveAt(p.id, at)
      expect({ added: after.filter((x) => !before.includes(x)).length, removed: before.filter((x) => !after.includes(x)).length }).toEqual(predicted)
      const all = await liveRows(p.id)
      const old = all.find((r) => r.id === g)!
      expect(old.revoked_at).not.toBeNull()
      expect(old.revoke_reason).toMatch(/wider/i)
      const merged = all.find((r) => r.revoked_at === null)!
      expect(new Date(merged.valid_from).getTime()).toBe(new Date(iso(start)).getTime())
      expect(new Date(merged.valid_until!).getTime()).toBe(new Date(later.validUntil).getTime())
      expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c13])) // today's access never stopped
    })

    it('an open-ended grant over a dated one becomes open-ended; only revoke_grant takes access away', async () => {
      const p = await createUser(orgA, 'user')
      await grant(orgA, p.id, 'cctv.live', atLocation(L2), { validUntil: iso(Date.now() + hour) })
      const predicted = await previewCounts(p.id, [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L2 }], iso(Date.now() + 2 * hour))
      expect(predicted).toEqual({ added: 0, removed: 0 }) // at +2 h: open-ended, so still the two cameras
      const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L2))
      expect((await liveRows(p.id)).find((r) => r.id === g)?.valid_until).toBeNull()
      expect(await effectiveAt(p.id, iso(Date.now() + 2 * hour))).toEqual(sorted([c21, c22]))
    })
  })

  it('minor 3: grant, revoke and replace refuse an acting administrator of another organisation', async () => {
    const p = await createUser(orgA, 'user')
    const mine = await createUser(orgA, 'admin')
    // P2-3 grant rule (docs/drishti/access-model.md "Who may grant what", brief item 6): an acting administrator must hold admin.access
    // and the right they give. Before P2-3 any administrator of the organisation could give anything; that is what the directive forbids.
    await grant(orgA, mine.id, ['admin.access', 'cctv.live'])
    const stranger = await createUser(orgB, 'admin')
    const spec = [{ capability: 'cctv.live', scope_kind: 'location', scope_id: L1 }]
    const refused = await admin().rpc('grant_access', { p_org: orgA, p_user: p.id, p_grants: spec, p_actor: stranger.id })
    expect(refused.error?.message).toMatch(/actor/i)
    const ok = await admin().rpc('grant_access', { p_org: orgA, p_user: p.id, p_grants: spec, p_actor: mine.id })
    expect(ok.error).toBeNull()
    const [g] = (ok.data as { grant_ids: string[] }).grant_ids
    expect((await admin().rpc('revoke_grant', { p_org: orgA, p_user: p.id, p_grant_ids: [g], p_actor: stranger.id })).error?.message).toMatch(/actor/i)
    expect((await admin().rpc('replace_user_grants', { p_org: orgA, p_user: p.id, p_capabilities: ['cctv.live'], p_scope_kinds: ['location'], p_grants: [], p_actor: stranger.id })).error?.message).toMatch(/actor/i)
    expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c13]))
    const { data: row } = await admin().from('access_grants').select('granted_by').eq('id', g).single()
    expect(row?.granted_by).toBe(mine.id)
  })

  it('minor 4: grants outlive their person (history), and give a deleted person nothing', async () => {
    const p = await createUser(orgA, 'user')
    const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L1))
    expect((await admin().from('profiles').delete().eq('id', p.id)).error).toBeNull()
    expect((await admin().auth.admin.deleteUser(p.id)).error).toBeNull()
    const { data } = await admin().from('access_grants').select('id, user_id').eq('id', g)
    expect(data).toEqual([{ id: g, user_id: p.id }])
    expect((await admin().rpc('report_effective_camera_ids', { p_user: p.id, p_cap: 'cctv.live', p_ignore_status: true })).data).toEqual([])
    // A grant for somebody who is not a person of the organisation is refused.
    const nobodyHere = await admin().rpc('grant_access', { p_org: orgA, p_user: p.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'organization' }] })
    expect(nobodyHere.error).not.toBeNull()
  })

  it('minor 2: requires_mfa capabilities count only in an aal2 session once MFA is enforced (crafted claims)', async () => {
    // Final fix Y (review A M-3, ruling E-1): export is held only by administrators, on every path (was a 'user' here).
    const p = await createUser(orgA, 'admin')
    await grant(orgA, p.id, ['cctv.live', 'cctv.export'], atLocation(L1))
    const caps = async (claims: object, mfa: boolean) => {
      const { data, error } = await admin().rpc('access_session_capabilities', { p_user: p.id, p_claims: claims as never, p_mfa_enforced: mfa })
      expect(error).toBeNull()
      return sorted((data as unknown as string[]) ?? [])
    }
    expect(await caps({ sub: p.id, aal: 'aal1' }, true)).toEqual(['cctv.live'])
    expect(await caps({ sub: p.id }, true)).toEqual(['cctv.live'])
    expect(await caps({ sub: p.id, aal: 'aal2' }, true)).toEqual(['cctv.export', 'cctv.live'])
    expect(await caps({ sub: p.id, aal: 'aal1' }, false)).toEqual(['cctv.export', 'cctv.live'])
    // With MFA not enforced (until P3), the real aal1 session of the person keeps export.
    expect(await can(p, 'cctv.export')).toBe(true)
    // The diagnostic is for the server only.
    expect((await p.client.rpc('access_session_capabilities', { p_user: p.id, p_claims: { aal: 'aal2' }, p_mfa_enforced: false })).error?.code).toBe('42501')
  })

  it('VA-9 (AC-12): grants count only between valid_from and valid_until', async () => {
    const p = await createUser(orgA, 'user')
    const hour = 3_600_000
    const now = Date.now()
    await grant(orgA, p.id, 'cctv.live', atLocation(L1), { validFrom: new Date(now - 2 * hour).toISOString(), validUntil: new Date(now - hour).toISOString() }) // over
    await grant(orgA, p.id, 'cctv.live', atLocation(L2), { validFrom: new Date(now + hour).toISOString() }) // not yet
    await grant(orgA, p.id, 'cctv.live', atLocation(L3), { validUntil: new Date(now + hour).toISOString() }) // now, for one hour
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })).toEqual([c31])
    expect(await rows(p, 'cameras')).toEqual([c31])
    expect(await canFor(p, 'cctv.live', 'camera', c11)).toBe(false)
    expect(await canFor(p, 'cctv.live', 'camera', c21)).toBe(false)
    const soon = await admin().rpc('access_expiring', { p_org: orgA, p_within: '2 hours' })
    expect(soon.error).toBeNull()
    const mine = (soon.data ?? []).filter((g) => g.user_id === p.id)
    expect(mine.map((g) => g.scope_id)).toEqual([L3])
    // Minor 11: organisation-scoped.
    const other = await admin().rpc('access_expiring', { p_org: orgB, p_within: '2 hours' })
    expect((other.data ?? []).some((g) => g.user_id === p.id)).toBe(false)
  })

  it('VA-10 (AC-12): a revoked grant stops access at once and stays in the history', async () => {
    const p = await createUser(orgA, 'user')
    const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L1))
    expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c13]))
    const res = await admin().rpc('revoke_grant', { p_org: orgA, p_user: p.id, p_grant_ids: [g], p_reason: 'test' })
    expect(res.error).toBeNull()
    expect(await rows(p, 'cameras')).toEqual([])
    expect(await can(p, 'cctv.live')).toBe(false)
    const row = await admin().from('access_grants').select('revoked_at, revoke_reason, capability, scope_id').eq('id', g).single()
    expect(row.data?.revoked_at).not.toBeNull()
    expect(row.data).toMatchObject({ revoke_reason: 'test', capability: 'cctv.live', scope_id: L1 })
    // History is append-only: nobody changes or deletes a grant row, not even the service role.
    const undo = await admin().from('access_grants').update({ revoked_at: null }).eq('id', g)
    expect(undo.error?.code).toBe('42501')
    const del = await admin().from('access_grants').delete().eq('id', g)
    expect(del.error?.code).toBe('42501')
    // Granting again makes a new row.
    const [g2] = await grant(orgA, p.id, 'cctv.live', atLocation(L1))
    expect(g2).not.toBe(g)
    expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c13]))
  })

  it('VA-11 (AC-13): a deactivated person, or one who must choose a password, has nothing', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, READ_EVERYTHING)
    expect((await rows(p, 'cameras')).length).toBe(6)
    await admin().from('profiles').update({ is_active: false }).eq('id', p.id)
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await rows(p, t)).toEqual([])
    expect(await can(p, 'cctv.live')).toBe(false)
    expect(await ids(p, 'any_cctv_camera_ids')).toEqual([])
    await admin().from('profiles').update({ is_active: true }).eq('id', p.id)
    expect((await rows(p, 'cameras')).length).toBe(6)
    expect(await rows(p, 'assets')).toEqual(sorted([d0, d1, d2, n1, n2, n3]))

    const r = await createUser(orgA, 'user', { mustReset: true })
    await grant(orgA, r.id, READ_EVERYTHING)
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await rows(r, t)).toEqual([])
    expect(await can(r, 'cctv.live')).toBe(false)
  })

  it('VA-12: organisations are isolated, and grants cannot point across them', async () => {
    const a = await createUser(orgA, 'user')
    await grant(orgA, a.id, READ_EVERYTHING)
    const b = await createUser(orgB, 'user')
    await grant(orgB, b.id, READ_EVERYTHING)
    expect(await rows(b, 'locations')).toEqual([LB])
    expect(await rows(b, 'cameras')).toEqual([cB])
    expect(await rows(b, 'assets')).toEqual(sorted([dB, nB]))
    expect(await canFor(a, 'cctv.live', 'camera', cB)).toBe(false)
    expect(await ids(a, 'cameras_with_capability', { p_cap: 'cctv.live', p_ids: [cB, c11] })).toEqual([c11])

    const g = admin()
    const cross = [
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'location', scope_id: LB }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'camera', scope_id: cB }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'it.inventory.view', scope_kind: 'asset', scope_id: dB }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: b.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'organization' }] }),
    ]
    for (const res of await Promise.all(cross)) expect(res.error).not.toBeNull()
    // Wrong scope kinds and unknown capabilities are refused too.
    const bad = [
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'asset', scope_id: d1 }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'it.inventory.view', scope_kind: 'camera', scope_id: c11 }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'admin.users', scope_kind: 'location', scope_id: L1 }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'cctv.everything', scope_kind: 'organization' }] }),
      g.rpc('grant_access', { p_org: orgA, p_user: a.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'organization', scope_id: L1 }] }),
    ]
    for (const res of await Promise.all(bad)) expect(res.error).not.toBeNull()
  })

  it('VA-13 (AC-11): camera groups never expand access and hide names without a visible member, also for their creator', async () => {
    const creator = await createUser(orgA, 'operator')
    const [creatorGrant] = await grant(orgA, creator.id, 'cctv.live', atLocation(L1))
    const viewerL2 = await createUser(orgA, 'user')
    await grant(orgA, viewerL2.id, 'cctv.playback', atLocation(L2))
    const itOnly = await createUser(orgA, 'user')
    await grant(orgA, itOnly.id, ['it.inventory.view', 'it.monitoring.view'])
    const name = `Hidden ${randomUUID()}`
    const { data: grp } = await admin().from('camera_groups').insert({ org_id: orgA, name, created_by: creator.id }).select('id').single()
    await admin().from('camera_group_items').insert([
      { org_id: orgA, group_id: grp!.id, camera_id: c11 },
      { org_id: orgA, group_id: grp!.id, camera_id: c21 },
    ])
    const { data: empty } = await admin().from('camera_groups').insert({ org_id: orgA, name: `Empty ${randomUUID()}`, created_by: creator.id }).select('id').single()

    expect(await rows(viewerL2, 'camera_groups')).toEqual([grp!.id])
    const items = await viewerL2.client.from('camera_group_items').select('camera_id').eq('group_id', grp!.id)
    expect(items.data).toEqual([{ camera_id: c21 }])
    expect(await rows(viewerL2, 'cameras')).toEqual(sorted([c21, c22])) // c11 is not reachable through the group
    expect(await canFor(viewerL2, 'cctv.playback', 'camera', c11)).toBe(false)
    expect(await rows(itOnly, 'camera_groups')).toEqual([])
    expect(sorted(await rows(creator, 'camera_groups'))).toEqual(sorted([grp!.id, empty!.id])) // an empty group only for its creator

    // The creator loses the grant: the group with members disappears for them; no creator exception.
    await admin().rpc('revoke_grant', { p_org: orgA, p_user: creator.id, p_grant_ids: [creatorGrant] })
    expect(await rows(creator, 'camera_groups')).toEqual([empty!.id])

    // Trying the hidden group's name gives the same plain answer as any other taken name, and never its name.
    const other = await createUser(orgA, 'operator')
    // P2-2: making a group needs cctv.live somewhere; here for a camera outside the hidden group, which therefore stays hidden.
    await grant(orgA, other.id, 'cctv.live', atCamera(c22))
    expect(await rows(other, 'camera_groups')).not.toContain(grp!.id)
    const actor: Actor = { id: other.id, orgId: orgA, role: 'operator' }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await createGroup({ admin: admin(), rls: other.client }, actor, name)
    logged.mockRestore()
    expect(res).toEqual({ ok: false, error: MSG_NAME_TAKEN })
    expect(MSG_NAME_TAKEN).not.toMatch(/exist/i)
  })

  it('VA-14 (AC-4, AC-10): NVR addresses and logins and camera addresses are not readable by a CCTV-only person', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, CCTV_VIEW, atLocation(L1))
    // P2-5b: the location row holds no NVR columns any more (contract migration: "column does not exist"); the NVR's own are on its
    // recorder, which a CCTV-only person cannot read at all.
    for (const col of ['nvr_ip', 'rtsp_port', 'http_port', 'nvr_username', 'nvr_secret_id']) {
      const res = await p.client.from('locations').select(col)
      expect(res.error?.code, col).toBe('42703')
    }
    expect((await p.client.from('locations').select('*')).error?.code).toBe('42501')
    expect((await p.client.from('recorders').select('id, http_port, rtsp_port, username')).data).toEqual([])
    expect((await p.client.from('recorders').select('secret_id')).error?.code).toBe('42501')
    expect((await p.client.from('cameras').select('camera_ip')).error?.code).toBe('42501')
    expect((await p.client.from('cameras').select('*')).error?.code).toBe('42501')
    // P2-5a: nor which recorder a camera is on (ruling C-1: the recorder is shown to IT users only).
    expect((await p.client.from('cameras').select('recorder_id')).error?.code).toBe('42501')
    // The plain columns still work.
    expect((await p.client.from('locations').select('id, code, name, city, zone, is_active')).data).toHaveLength(1)
    expect((await p.client.from('cameras').select('id, location_id, channel, name, is_active')).data).toHaveLength(3)
    expect((await p.client.from('recorder_endpoints').select('recorder_id')).data).toEqual([])
    expect((await p.client.from('camera_endpoints').select('camera_id')).data).toEqual([])
    // Straight to PostgREST with the person's own token.
    const raw = await fetch(`${URL_()}/rest/v1/locations?select=nvr_ip,nvr_username`, { headers: { apikey: ANON(), Authorization: `Bearer ${await token(p)}` } })
    expect(raw.status).toBeGreaterThanOrEqual(400)
    expect(await raw.text()).not.toContain('192.0.2.10')
    const rawRec = await fetch(`${URL_()}/rest/v1/recorder_endpoints?select=host,username`, { headers: { apikey: ANON(), Authorization: `Bearer ${await token(p)}` } })
    expect(await rawRec.text()).toBe('[]')

    // An IT person for L1 reads the addresses of L1 only (never the vault id). P2-5a: recorder_endpoints replaces store_nvr_endpoints.
    const it_ = await createUser(orgA, 'user')
    await grant(orgA, it_.id, 'it.inventory.view', atLocation(L1))
    expect((await it_.client.from('recorder_endpoints').select('location_id, host, username')).data).toEqual([{ location_id: L1, host: '192.0.2.10', username: 'viewer' }])
    expect((await it_.client.from('camera_endpoints').select('camera_id')).data?.length).toBe(3)
    expect((await it_.client.from('recorder_endpoints').select('secret_id' as never)).error).not.toBeNull()
    expect((await it_.client.from('recorders').select('secret_id')).error).not.toBeNull()
    expect(((await it_.client.from('assets').select('id')).data ?? []).map((a) => a.id).sort()).toEqual(sorted([d1, n1]))
  })

  it('VA-15 (AC-9): preview_access_change counts what a change adds and removes, and writes nothing', async () => {
    const p = await createUser(orgA, 'user')
    const preview = async (changes: unknown[], at?: string) => {
      const { data, error } = await admin().rpc('preview_access_change', { p_org: orgA, p_user: p.id, p_changes: changes as never, ...(at ? { p_at: at } : {}) })
      expect(error).toBeNull()
      return data as { version: number; capabilities: Record<string, { added_count: number; removed_count: number; sample_added: { id: string; label: string }[]; sample_removed: { id: string; label: string }[] }> }
    }
    // Minor 1: the preview is organisation-scoped, and its revoke path accepts only the person's own live grants.
    expect((await admin().rpc('preview_access_change', { p_org: orgB, p_user: p.id, p_changes: [] })).error).not.toBeNull()
    const otherPerson = await createUser(orgA, 'user')
    const [foreignGrant] = await grant(orgA, otherPerson.id, 'cctv.live', atLocation(L3))
    expect((await admin().rpc('preview_access_change', { p_org: orgA, p_user: p.id, p_changes: [{ op: 'revoke', grant_id: foreignGrant }] })).error).not.toBeNull()
    const addL1 = await preview([{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: L1 }])
    expect(addL1.capabilities['cctv.live']).toMatchObject({ added_count: 3, removed_count: 0 })
    expect(sorted(addL1.capabilities['cctv.live'].sample_added.map((s) => s.id))).toEqual(sorted([c11, c12, c13]))
    expect(addL1.capabilities['cctv.live'].sample_added[0].label).toMatch(/^L1 · Camera \d$/)
    expect((await admin().from('access_grants').select('id').eq('user_id', p.id)).data).toEqual([]) // nothing written

    const [g] = await grant(orgA, p.id, 'cctv.live', atLocation(L1))
    const cams = await preview([
      { op: 'grant', capability: 'cctv.live', scope_kind: 'camera', scope_id: c11 },
      { op: 'grant', capability: 'cctv.live', scope_kind: 'camera', scope_id: c21 },
    ])
    expect(cams.capabilities['cctv.live']).toMatchObject({ added_count: 1, removed_count: 0 })
    expect(cams.capabilities['cctv.live'].sample_added.map((s) => s.id)).toEqual([c21])

    const revoke = await preview([{ op: 'revoke', grant_id: g }])
    expect(revoke.capabilities['cctv.live']).toMatchObject({ added_count: 0, removed_count: 3 })
    // A grant that is already revoked cannot be "revoked" in a preview either.
    const [gone] = await grant(orgA, p.id, 'cctv.live', atLocation(L3))
    await admin().rpc('revoke_grant', { p_org: orgA, p_user: p.id, p_grant_ids: [gone] })
    expect((await admin().rpc('preview_access_change', { p_org: orgA, p_user: p.id, p_changes: [{ op: 'revoke', grant_id: gone }] })).error).not.toBeNull()

    await grant(orgA, p.id, 'cctv.playback', atLocation(L2), { validUntil: new Date(Date.now() + 3_600_000).toISOString() })
    const later = await preview([], new Date(Date.now() + 2 * 3_600_000).toISOString())
    expect(later.capabilities['cctv.playback']).toMatchObject({ added_count: 0, removed_count: 2 })
    expect(later.capabilities['cctv.live']).toMatchObject({ added_count: 0, removed_count: 0 })

    // IT capabilities count assets: L1's device and (P2-5a) L1's NVR, which is a recorder asset of the location now.
    const it_ = await preview([{ op: 'grant', capability: 'it.inventory.view', scope_kind: 'location', scope_id: L1 }])
    expect(it_.capabilities['it.inventory.view']).toMatchObject({ added_count: 2, removed_count: 0 })

    // The write refuses a stale expected version, so two administrators cannot overwrite each other.
    const stale = await admin().rpc('grant_access', {
      p_org: orgA, p_user: p.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'location', scope_id: L2 }], p_expected_version: later.version - 1,
    })
    expect(stale.error?.code).toBe('40001')
    const fresh = await admin().rpc('grant_access', {
      p_org: orgA, p_user: p.id, p_grants: [{ capability: 'cctv.live', scope_kind: 'location', scope_id: L2 }], p_expected_version: later.version,
    })
    expect(fresh.error).toBeNull()
    expect((fresh.data as { version: number }).version).toBe(later.version + 1)
  })

  it('VA-16 (AC-15): the human role is called operator; agent no longer exists', async () => {
    const op = await createUser(orgA, 'operator')
    expect((await admin().from('profiles').select('role').eq('id', op.id).single()).data?.role).toBe('operator')
    const bad = await admin().from('profiles').update({ role: 'agent' as never }).eq('id', op.id)
    expect(bad.error?.code).toBe('22P02')
  })

  it('VA-17: the old grant tables no longer influence access and are not readable by people', async () => {
    const p = await createUser(orgA, 'user')
    const db = admin()
    expect((await db.from('user_store_access').insert({ org_id: orgA, user_id: p.id, store_id: L1 })).error).toBeNull()
    expect((await db.from('user_zone_access').insert({ org_id: orgA, user_id: p.id, zone: 'N' })).error).toBeNull()
    expect((await db.from('user_camera_access').insert({ org_id: orgA, user_id: p.id, camera_id: c31 })).error).toBeNull()
    for (const t of ['locations', 'cameras', 'assets'] as const) expect(await rows(p, t)).toEqual([])
    for (const t of ['user_store_access', 'user_zone_access', 'user_camera_access'] as const) {
      expect((await p.client.from(t).select('org_id')).error?.code, t).toBe('42501')
    }
    const gone = await db.rpc('replace_user_access' as Fn, { p_user: p.id, p_stores: [], p_zones: [], p_cameras: [] } as never)
    expect(gone.error).not.toBeNull()
  })

  it('VA-19 (SO-2): privilege_violations() is empty and every new function has exactly the intended grants', async () => {
    const v = await admin().rpc('privilege_violations')
    expect(v.error).toBeNull()
    expect(v.data).toEqual([])
    const { data, error } = await admin().rpc('function_privileges')
    expect(error).toBeNull()
    const byName = new Map((data ?? []).map((f) => [f.name, f]))
    const people = ['authenticated', 'service_role']
    const server = ['service_role']
    // P2-6 (D-14): the per-service roles. The web app's own role (app_web) calls the server functions its screens use, never a credential
    // read, a worker, gateway, test or diagnostic function; the worker (monitor_worker) and the video path (media_service) their own.
    const web = ['service_role', 'app_web']
    const worker = ['service_role', 'monitor_worker']
    // Review round 1, M-2: only the web app counts (media_service no longer holds the limiter functions).
    const limiter = ['service_role', 'app_web']
    const expected: Record<string, string[]> = {
      mfa_enforced: people,
      has_capability: people,
      has_capability_for: people,
      capability_camera_ids: people,
      // P2-5a renames (decision D5-5): store → location, device → asset; region/cluster/recorder rows and the IT recorder view.
      capability_location_ids: people,
      capability_asset_ids: people,
      any_cctv_camera_ids: people,
      cameras_with_capability: people,
      any_grant_location_ids: people,
      any_grant_cluster_ids: people,
      any_grant_region_ids: people,
      it_view_location_ids: people,
      it_view_asset_ids: people,
      it_view_recorder_ids: people,
      cctv_visible_group_ids: people,
      cameras_monitoring_off: ['authenticated'],
      // P2-2: the caller's capability summary (one call per request). Signed-in people only: the service role is nobody.
      my_access_summary: ['authenticated'],
      // P2-2 fix I-1: why targets are offline, in camera terms without the IT view.
      status_reasons: ['authenticated'],
      grant_access: server,
      revoke_grant: server,
      replace_user_grants: server,
      preview_access_change: web,
      access_expiring: server,
      // Reporting only (ignore MFA, never for authorisation): the old access_effective_* names are gone (fix minor 2).
      report_effective_camera_ids: server,
      report_effective_asset_ids: server,
      access_session_capabilities: server,
      access_legacy_camera_ids: server,
      access_legacy_device_ids: server,
      access_legacy_store_ids: server,
      // Fix I-3: the migration itself is for the database owner only; tests use the wrapper that works only on test organisations.
      access_migrate_legacy: [],
      access_migrate_legacy_test: server,
      function_privileges: server,
      // Internal building blocks: nobody but their owner may call them (the functions above call them with the owner's rights).
      access_caller_aal2: [],
      access_aal2_of: [],
      access_grants_eval: [],
      access_merge_window: [],
      access_check_actor: [],
      access_grants_of: [],
      access_camera_set: [],
      access_asset_set: [],
      access_location_set: [],
      access_cameras_for: [],
      access_assets_for: [],
      access_locations_for: [],
      access_location_expand: [],
      access_ancestry: [],
      access_scope_covers: [],
      access_lock_person: [],
      access_bump_version: [],
      access_check_spec: [],
      access_put_grant: [],
      access_items: [],
      access_legacy_store_grants: [],
      access_grants_before_insert: [],
      access_grants_before_update: [],
      // P2-3 (20261021000015): the editor's save, the review record and the people summary; the grant rules are internal.
      apply_access_change: web,
      access_review_keep: web,
      access_grant_summary: web,
      access_check_manager: [],
      access_check_grantor: [],
      // Ruling P-1 (20261021000016): super administrators hold every capability; the triggers run with their owner's rights.
      grant_platform_owner_all: web,
      access_catalogue_probe_test: server,
      capabilities_after_insert: [],
      profiles_platform_owner_after_update: [],
      // P2-5a (20261021000019..21): locations, recorders, mappings, archive, hierarchy moves, monitoring switch, credentials, migration.
      access_target_ancestry: web,
      // P2-6: the web app WRITES an NVR password (never reads one); reads go through recorder_credential_read (below).
      // (recorder_store_credential: two forms since final fix Y, checked by their arguments after this list.)
      recorder_read_credential: server,
      recorder_delete_credential: server,
      recorder_credential_status: server,
      recorder_primary_of: web,
      recorder_set_monitoring: web,
      monitor_apply_results: worker,
      camera_remap: web,
      inventory_archive: web,
      inventory_restore: web,
      inventory_move_location: web,
      inventory_move_cluster: web,
      preview_hierarchy_change: web,
      inventory_purge_test_org: server,
      inventory_propose_hierarchy: web,
      inventory_effective_snapshot: server,
      inventory_stale_name_scan: server,
      network_validate_address: server,
      network_address_conflicts: server,
      inventory_require_test_org: [],
      address_space_global: [],
      asset_sync_endpoints: [],
      inventory_refuse_delete: [],
      organizations_global_space: [],
      assets_after_write: [],
      assets_before_update: [],
      assets_attached_check: [],
      monitor_stop_asset: [],
      monitor_stop_location: [],
      recorders_before_write: [],
      recorders_after_write: [],
      recorder_monitoring_stop: [],
      mappings_before_write: [],
      mappings_after_write: [],
      cameras_after_insert: [],
      cameras_before_update: [],
      inventory_hierarchy_moved: [],
      inventory_node_archived: [],
      network_definitions_check: [],
      asset_dependencies_no_cycle: [],
      // P2-5a review fix round 1 (20261021000022).
      it_view_endpoint_asset_ids: people,
      inventory_affected_people: [],
      access_bump_versions: [],
      inventory_remap_effects: [],
      locations_parent_check: [],
      assets_space_check: [],
      // P2-5b (20261021000023/24): one recorder saved by the server; the two stop helpers now with search_path ''.
      recorder_save: web,
      inventory_refresh_statistics: web,
      monitor_stop_targets: server,
      monitor_stop_target: server,
      // P2-5b review round 1 (20261021000025): one discovery saved in one transaction; NVR assets switched on with their location.
      discovery_apply: web,
      locations_recorders_on: [],
      // P2-5c-1 (20261021000026): merging a duplicate camera identity; dynamic camera-group rules (resolved for the signed-in reader,
      // intersected with what they may see; the resolver itself is internal); the rule reference check is a trigger.
      camera_merge: web,
      group_rule_members: ['authenticated'],
      camera_group_rule_members: [],
      camera_group_rules_check: [],
      // P2-5c-1 review round 1 (20261021000027): group counts for the caller; the ticked zone proposals in one transaction (server).
      group_member_counts: ['authenticated'],
      inventory_apply_proposals: web,
      // P2-5c-1 fix round 2 (20261021000030): the effect of ticked zone proposals on access, all rows in one call (server only).
      preview_hierarchy_proposals: web,
      // P2-5c-2 (20261021000028, 31): the location import in one transaction and its placeholder twin (server only); the Wi-Fi
      // inventory for the signed-in reader (it applies the reader's own wifi.inventory.view grants).
      inventory_import_apply: web,
      inventory_ensure_placeholders: server,
      wifi_inventory: ['authenticated'],
      // P2-6 (20261021000033): logged credential reads per purpose and role, the lock of the service key, the shared rate limiter,
      // housekeeping for the worker, the self-test of privilege_violations; internal helpers have no grant at all.
      recorder_credential_read: ['service_role', 'media_service', 'monitor_worker'],
      recorder_secret_equals: [],
      service_caller_role: [],
      credential_purpose_allowed: [],
      service_role_may_read_credentials: [],
      security_settings_set_test: server,
      vault_reads_prune: worker,
      rate_limit_hit: limiter,
      rate_limit_state: limiter,
      rate_limit_clear: limiter,
      rate_limit_prune: worker,
      rate_limit_window_start: [],
      privilege_violations: server,
      privilege_violations_selftest: server,
      media_session_create: ['service_role', 'media_service'],
      media_session_open: ['service_role', 'media_service', 'video_gateway'],
      media_sessions_still_valid: ['service_role', 'media_service', 'video_gateway'],
      media_session_close: ['service_role', 'media_service', 'video_gateway'],
      media_sessions_revoke_user: web,
      media_sessions_revalidate: web,
      media_sessions_prune: worker,
      monitor_request_check: web,
      targets_uptime: web,
      set_person_active: web,
      change_person_role: web,
      access_review_self_confirm: web,
      // P2-6 review round 1 (20261021000035): the atomic sign-in gate (I-3/I-4), the start-up check's list of organisations that
      // did not lock the service key out (M-3), the grant snapshot (M-1), the guard that no GoTrue user carries a service role (M-5).
      sign_in_gate: web,
      sign_in_finish: web,
      sign_in_delay_sec: [],
      security_unlocked_organizations: web,
      service_role_grants: server,
      auth_users_role_check: [],
      // P2-7 (20261021000036, D-8): the worker lease and every worker write fenced with its token; the fence itself is internal; the
      // test helpers (names "test:" only) for the service role only.
      worker_acquire_lease: worker,
      worker_renew_lease: worker,
      worker_release_lease: worker,
      worker_fence: [],
      monitor_heartbeat: worker,
      monitor_record_gap: worker,
      monitor_mark_round: worker,
      monitor_run_started: worker,
      monitor_run_progress: worker,
      monitor_run_finished: worker,
      monitor_save_camera_ips: worker,
      worker_lease_set_until_test: server,
      worker_lease_forget_test: server,
      // P2-7 review round 1 (20261021000039): the fence scoped to the rows it protects, and the guard that refuses direct writes of
      // worker_state / monitor_gaps by the service key (an old worker): internal, no grant at all.
      worker_fence_global: [],
      worker_fence_org: [],
      worker_rows_guard: [],
      // P4-L1 (20261021000038): roll-ups for the caller (their own access, the masking of status_reasons); the person's open live
      // streams for the video path's cap; the trigger that records each session's location and NVR (no grant at all).
      status_rollups: ['authenticated'],
      media_sessions_live_open: ['service_role', 'media_service'],
      media_sessions_before_insert: [],
      // P5.4 (20261021000041): the Health page's database answer for the web app; the audit guards and the test/demo clean-up of audit
      // rows for the service role only; the append-only trigger has no grant at all.
      ops_health_status: web,
      audit_guard_status: server,
      audit_purge_test_org: server,
      admin_audit_log_append_only: [],
      // P4-L1 review round 1 (0040) and fix round 2 (0043): the live opening under the person's cap and the release a window sends
      // when its page is left (its own unused tokens only) for the video path; what a person holds is internal.
      media_session_create_live: ['service_role', 'media_service'],
      media_sessions_release_live: ['service_role', 'media_service'],
      media_sessions_held_live: [],
      // Release 1 clean-ups (20261021000044): the security settings delete audit and truncate guard, and the guard of the tests'
      // organisation namespace, are trigger functions with no grant at all (the replaced functions keep the grants listed above).
      security_settings_audit_delete: [],
      security_settings_no_truncate: [],
      organizations_test_namespace: [],
      // Final fix Y (20261021000049): the owner-only two-step switch and its overview, the code-failure count, the password-reset rule,
      // person creation and the device import for the web app; the helpers and triggers have no grant at all. (recorder_store_credential
      // and revoke_user_sessions have a second, organisation-naming form for the web app; the old forms are the service key's only:
      // final-fix-y-db.test.ts.)
      security_set_mfa: web,
      security_mfa_overview: web,
      mfa_code_attempt_begin: web,
      mfa_code_attempt_end: web,
      mfa_code_locks: web,
      mfa_code_lock_clear: web,
      access_check_password_reset: web,
      create_person: web,
      inventory_devices_import: web,
      inventory_check_admin: [],
      access_admin_lock: [],
      mfa_default_enforced: [],
      mfa_code_lock_minutes: [],
      mfa_code_lock_record: [],
      profiles_role_rights: [],
      security_settings_mfa_normalise: [],
    }
    for (const [name, grantees] of Object.entries(expected)) {
      const f = byName.get(name)
      expect(f, name).toBeDefined()
      expect(sorted(f!.grantees), name).toEqual(sorted(grantees))
      if (f!.security_definer) expect(f!.search_path, name).toBe('')
    }
    // Final fix Y (review A M-6, 20261021000049): the web app's forms name the organisation; the forms without it are the service key's.
    const byArgs = (name: string) => new Map((data ?? []).filter((f) => f.name === name).map((f) => [String((f as { args?: string }).args ?? ''), sorted(f.grantees)]))
    expect(Object.fromEntries(byArgs('recorder_store_credential'))).toEqual({
      'p_org uuid, p_recorder uuid, p_secret text, p_actor uuid': sorted(web), 'p_recorder uuid, p_secret text': server,
    })
    expect(Object.fromEntries(byArgs('revoke_user_sessions'))).toEqual({ 'p_org uuid, p_user uuid': sorted(web), 'p_user uuid': server })
    // The old model is gone, and so are the names replaced in fix round 1.
    for (const old of ['is_staff_all', 'granted_store_ids', 'visible_store_ids', 'visible_camera_ids', 'visible_device_ids', 'replace_user_access',
      'access_effective_camera_ids', 'access_effective_device_ids',
      // Renamed in P2-5a (D5-5), and the history-erasing delete trigger function that is gone (archive instead).
      'capability_store_ids', 'capability_device_ids', 'any_grant_store_ids', 'it_view_store_ids', 'it_view_device_ids', 'report_effective_device_ids',
      'access_store_set', 'access_device_set', 'access_stores_for', 'access_devices_for', 'monitor_forget_target', 'monitor_stop_store',
      // Removed by the P2-5b contract migration (the transitional seam and the one-time migration machinery).
      'nvr_store_credential', 'nvr_read_credential', 'nvr_delete_credential', 'recorder_seam_of', 'recorder_ensure_primary', 'locations_legacy_seam',
      'inventory_migrate_org', 'inventory_unmigrate_org', 'inventory_migrate_org_test', 'inventory_unmigrate_org_test', 'inventory_secret_fingerprint_test',
      // P2-5c-2 review B-I3: the saved-password comparison (an oracle for the import preview) was dropped by 20261021000031.
      'recorder_credentials_match']) {
      expect(byName.has(old), old).toBe(false)
    }
    // One signature each (no stale overloads left behind by a changed parameter list).
    for (const name of ['preview_access_change', 'access_expiring', 'access_migrate_legacy', 'replace_user_grants', 'grant_access', 'revoke_grant',
      'access_camera_set', 'access_asset_set', 'my_access_summary', 'access_grant_summary',
      // P2-7: the unfenced 3-argument monitor_apply_results is gone.
      'monitor_apply_results',
      // P4-L1 fix round 2: the 6-argument media_session_create_live (no window id) is gone.
      'media_session_create_live']) {
      expect((data ?? []).filter((f) => f.name === name), name).toHaveLength(1)
    }
    // Minor 8, the sweep: no function of schema public is callable by anon or PUBLIC, and signed-in people only the allow-list.
    const forPeople = new Set([
      'current_org_id', 'current_user_role', 'monitor_stale_after_minutes', 'mfa_enforced', 'has_capability', 'has_capability_for',
      'capability_camera_ids', 'capability_location_ids', 'capability_asset_ids', 'any_cctv_camera_ids', 'cameras_with_capability',
      'any_grant_location_ids', 'any_grant_cluster_ids', 'any_grant_region_ids', 'it_view_location_ids', 'it_view_asset_ids', 'it_view_recorder_ids',
      'cctv_visible_group_ids', 'my_access_summary', 'status_reasons', 'cameras_monitoring_off', 'it_view_endpoint_asset_ids',
      // P2-5c-1: dynamic group members of groups the caller may see, cameras the caller may see.
      'group_rule_members',
      // P2-5c-1 review I-7: per-group counts of the cameras the caller may see.
      'group_member_counts',
      // P2-5c-2: the Wi-Fi inventory of the caller's own wifi.inventory.view grants (tests/integration/p2-5c-2-wifi-discover.test.ts).
      'wifi_inventory',
      // P3-1: the caller's own session facts for the multi-factor gate (tests/integration/mfa-session-db.test.ts).
      'my_session_status',
      // P4-L1: roll-ups per region, cluster and location of what the caller may see (tests/integration/live-rollups.test.ts).
      'status_rollups',
    ])
    for (const f of data ?? []) {
      expect(f.grantees.filter((g) => g === 'anon' || g.startsWith('PUBLIC')), `${f.name}(${f.args})`).toEqual([])
      if (f.grantees.includes('authenticated')) expect(forPeople.has(f.name), `${f.name} is callable by signed-in people`).toBe(true)
      if (f.security_definer) expect(f.search_path, `${f.name} search_path`).not.toBeNull()
    }
    // The two identity helpers used by every policy now run with an empty search_path too.
    for (const name of ['current_org_id', 'current_user_role']) expect(byName.get(name)?.search_path, name).toBe('')
    // Nobody signed in or anonymous may call the server-only ones.
    const anon = createClient<Database>(URL_(), ANON(), { auth: { persistSession: false } })
    const someone = await createUser(orgA, 'operator')
    const calls: [Fn, object][] = [
      ['grant_access', { p_org: orgA, p_user: someone.id, p_grants: [] }],
      ['revoke_grant', { p_org: orgA, p_user: someone.id, p_grant_ids: [] }],
      ['replace_user_grants', { p_org: orgA, p_user: someone.id, p_capabilities: [], p_scope_kinds: [], p_grants: [] }],
      ['preview_access_change', { p_org: orgA, p_user: someone.id, p_changes: [] }],
      ['access_expiring', { p_org: orgA, p_within: '1 day' }],
      ['access_migrate_legacy_test', { p_run: randomUUID(), p_users: [someone.id] }],
      ['report_effective_camera_ids', { p_user: someone.id, p_cap: 'cctv.live' }],
      ['access_session_capabilities', { p_user: someone.id, p_claims: {}, p_mfa_enforced: false }],
      // P2-5a server tools.
      ['recorder_read_credential', { p_recorder: randomUUID() }],
      ['inventory_archive', { p_org: orgA, p_kind: 'camera', p_id: c11 }],
      ['camera_remap', { p_org: orgA, p_camera: c11, p_recorder: randomUUID(), p_channel: 1 }],
      ['inventory_move_location', { p_org: orgA, p_location: L1, p_cluster: randomUUID() }],
      ['recorder_set_monitoring', { p_org: orgA, p_recorder: randomUUID(), p_enabled: false, p_reason: 'nope' }],
      ['inventory_purge_test_org', { p_org: orgA }],
      ['report_effective_asset_ids', { p_user: someone.id, p_cap: 'it.inventory.view' }],
      // P2-5b.
      ['recorder_save', { p_org: orgA, p_location: L1, p_recorder: null, p_host: '192.0.2.99', p_http_port: 80, p_rtsp_port: 554, p_username: 'x' }],
      ['discovery_apply', { p_org: orgA, p_recorder: randomUUID(), p_ops: [] }],
      // P2-5c-1.
      ['camera_merge', { p_org: orgA, p_keep: c11, p_duplicate: randomUUID() }],
      ['inventory_apply_proposals', { p_org: orgA, p_items: [] }],
      ['preview_hierarchy_proposals', { p_org: orgA, p_items: [] }],
    ]
    for (const [fn, args] of calls) {
      expect((await anon.rpc(fn, args as never)).error?.code, `anon ${fn}`).toBe('42501')
      expect((await someone.client.rpc(fn, args as never)).error?.code, `operator ${fn}`).toBe('42501')
    }
    // Not even the service role may run the real migration again (fix I-3).
    expect((await admin().rpc('access_migrate_legacy', { p_run: randomUUID(), p_users: [someone.id] } as never)).error?.code).toBe('42501')
    expect((await anon.rpc('has_capability', { p_cap: 'cctv.live' })).error?.code).toBe('42501')
    for (const t of ['access_grants', 'access_migration_report', 'capabilities'] as const) {
      expect((await anon.from(t).select('*').limit(1)).error?.code, t).toBe('42501')
    }
    // Signed-in people read the catalogue and their own grants, never write either.
    expect(((await someone.client.from('capabilities').select('key')).data ?? []).length).toBe(28)
    expect((await someone.client.from('capabilities').insert({ key: 'x.y', area: 'it', description: 'x', risk: 'low', requires_mfa: false, scope_kinds: ['organization'] })).error?.code).toBe('42501')
    expect((await someone.client.from('access_grants').insert({ org_id: orgA, user_id: someone.id, capability: 'cctv.live', scope_kind: 'organization' })).error?.code).toBe('42501')
    expect((await someone.client.from('access_migration_report').select('id')).error?.code).toBe('42501')
  })

  it('the catalogue holds every capability of the brief with its risk and MFA flag, and MFA is not enforced yet', async () => {
    const { data } = await admin().from('capabilities').select('key, area, risk, requires_mfa, scope_kinds').order('key')
    const keys = (data ?? []).map((c) => c.key)
    expect(keys).toEqual(sorted([
      'cctv.live', 'cctv.playback', 'cctv.export',
      'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate', 'it.remote.view', 'it.remote.control', 'it.diagnostics', 'it.script.run',
      'it.software.manage', 'it.config.deploy', 'it.patch.manage', 'it.credentials.admin', 'it.os.deploy',
      'wifi.inventory.view', 'wifi.config.view_redacted', 'wifi.profile.edit', 'wifi.deploy.approve', 'wifi.deploy.execute',
      'wifi.device.reboot_upgrade', 'wifi.config.restore', 'wifi.credentials.admin',
      'admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read',
    ]))
    for (const c of data ?? []) expect(c.requires_mfa, c.key).toBe(c.risk === 'high' || c.key === 'cctv.export')
    const byKey = new Map((data ?? []).map((c) => [c.key, c]))
    // P2-5a (ruling C-1, decision D5-6): region, cluster and recorder scopes; a CCTV right never has an asset scope, IT never a camera.
    expect(sorted(byKey.get('cctv.live')!.scope_kinds)).toEqual(sorted(['organization', 'region', 'cluster', 'location', 'recorder', 'camera']))
    expect(sorted(byKey.get('it.inventory.view')!.scope_kinds)).toEqual(sorted(['organization', 'region', 'cluster', 'location', 'recorder', 'asset']))
    expect(byKey.get('admin.users')!.scope_kinds).toEqual(['organization'])
    expect((await admin().rpc('mfa_enforced')).data).toBe(false)
    // A capability that needs MFA still works while MFA is not enforced (the switch arrives in P3).
    const p = await createUser(orgA, 'admin') // final fix Y (A M-3, E-1): export only for administrators, on every path
    await grant(orgA, p.id, 'cctv.export', atCamera(c11))
    expect(await canFor(p, 'cctv.export', 'camera', c11)).toBe(true)
    expect(await can(p, 'cctv.export')).toBe(true)
    void ORG_SCOPE
  })
})
