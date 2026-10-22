// P2-1 acceptance tests for the capability access model (docs/drishti/access-model.md).
// Each test is one requirement of the brief (VA-n) and names the directive requirement it proves (AC-n).
// Every positive and negative case goes through PostgREST with the person's own JWT; the service role only builds fixtures.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { createGroup, MSG_NAME_TAKEN } from '@/lib/groups/service'
import type { Database } from '@/types/database'
import {
  adminClient,
  atCamera,
  atLocation,
  atAsset,
  CCTV_VIEW,
  cleanupOrg,
  createOrg,
  createUser,
  grant,
  ORG_SCOPE,
  READ_EVERYTHING,
  type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const sorted = (a: readonly string[]) => [...a].sort()
const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

type Fn = keyof Database['public']['Functions']

async function addStore(orgId: string, code: string, zone: string | null = null): Promise<string> {
  const { data, error } = await admin().from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, zone, nvr_ip: '192.0.2.10', nvr_username: 'viewer' }).select('id').single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}
async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await admin().from('cameras').insert({ org_id: orgId, store_id: storeId, channel, name: `Camera ${channel}`, camera_ip: `192.0.2.${100 + channel}` }).select('id').single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}
let port = 20
async function addDevice(orgId: string, storeId: string | null, name: string): Promise<string> {
  const { data, error } = await admin().from('devices').insert({ org_id: orgId, store_id: storeId, type: 'server', name, ip: '192.0.2.50', tcp_port: port++ }).select('id').single()
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
async function rows(u: TestUser, table: 'stores' | 'cameras' | 'devices' | 'camera_groups' | 'profiles' | 'admin_audit_log'): Promise<string[]> {
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
      p_org: orgA,
      p_results: [
        { type: 'camera', id: c11, ok: true, at },
        { type: 'device', id: d1, ok: true, at },
        { type: 'nvr', id: L1, ok: true, at },
      ],
    })
    expect(applied.error).toBeNull()
    await admin().from('outages').insert([
      { org_id: orgA, target_type: 'device', target_id: d1, started_at: at, ended_at: at },
      { org_id: orgA, target_type: 'nvr', target_id: L1, started_at: at, ended_at: at },
      { org_id: orgA, target_type: 'camera', target_id: c11, started_at: at, ended_at: at },
    ])
    expect(await rows(p, 'devices')).toEqual([])
    const states = await p.client.from('check_state').select('target_type, target_id')
    expect(states.error).toBeNull()
    expect(states.data).toEqual([{ target_type: 'camera', target_id: c11 }])
    const outs = await p.client.from('outages').select('target_type')
    expect(outs.data).toEqual([{ target_type: 'camera' }])
    const status = await p.client.from('store_status').select('store_id, cameras_total, nvr_status')
    expect(status.data).toEqual([{ store_id: L1, cameras_total: 3, nvr_status: null }])
    for (const cap of ['it.inventory.view', 'it.monitoring.view']) {
      expect(await can(p, cap)).toBe(false)
      expect(await ids(p, 'capability_device_ids', { p_cap: cap })).toEqual([])
    }

    // The same location with it.monitoring.view shows the devices and their status (and nothing of CCTV).
    const it_ = await createUser(orgA, 'user')
    await grant(orgA, it_.id, 'it.monitoring.view', atLocation(L1))
    expect(await rows(it_, 'devices')).toEqual([d1])
    expect(await rows(it_, 'cameras')).toEqual([])
    const itStates = await it_.client.from('check_state').select('target_type').order('target_type')
    expect(itStates.data).toEqual([{ target_type: 'device' }, { target_type: 'nvr' }])
    // An asset grant shows exactly that asset; a device without a location needs an organisation or asset grant.
    const one = await createUser(orgA, 'user')
    await grant(orgA, one.id, 'it.inventory.view', atAsset(d0))
    expect(await rows(one, 'devices')).toEqual([d0])
  })

  it('VA-4 (AC-5): selected-camera grants across two locations, with live different from playback', async () => {
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, 'cctv.live', [atCamera(c11), atCamera(c21)])
    await grant(orgA, p.id, 'cctv.playback', [atCamera(c12), atCamera(c21)])
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.live' })).toEqual(sorted([c11, c21]))
    expect(await ids(p, 'capability_camera_ids', { p_cap: 'cctv.playback' })).toEqual(sorted([c12, c21]))
    expect(await ids(p, 'any_cctv_camera_ids')).toEqual(sorted([c11, c12, c21]))
    expect(await rows(p, 'cameras')).toEqual(sorted([c11, c12, c21]))
    expect(await rows(p, 'stores')).toEqual(sorted([L1, L2]))
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
    await admin().from('cameras').delete().eq('id', later)
  })

  it('VA-6 (AC-7): a home store on the profile grants nothing', async () => {
    const p = await createUser(orgA, 'user', { storeId: L1 })
    for (const t of ['stores', 'cameras', 'devices'] as const) expect(await rows(p, t)).toEqual([])
    expect(await can(p, 'cctv.live')).toBe(false)
    expect(await canFor(p, 'cctv.live', 'location', L1)).toBe(false)
    // The column stays, as information only.
    const own = await p.client.from('profiles').select('store_id').eq('id', p.id).single()
    expect(own.data?.store_id).toBe(L1)
  })

  it('VA-7 (AC-8): a manager without grants sees nothing but their own profile; admin.users opens the profiles', async () => {
    const m = await createUser(orgA, 'manager')
    await createUser(orgA, 'user')
    for (const t of ['stores', 'cameras', 'devices', 'camera_groups', 'admin_audit_log'] as const) expect(await rows(m, t)).toEqual([])
    expect((await m.client.from('check_state').select('id')).data).toEqual([])
    expect((await m.client.from('outages').select('id')).data).toEqual([])
    expect((await m.client.from('store_status').select('store_id')).data).toEqual([])
    expect(await rows(m, 'profiles')).toEqual([m.id])

    await grant(orgA, m.id, 'admin.users')
    expect((await rows(m, 'profiles')).length).toBeGreaterThan(2)
    // admin.users is administrative: it still shows no store, camera or device.
    for (const t of ['stores', 'cameras', 'devices'] as const) expect(await rows(m, t)).toEqual([])

    // P2-2 fix M-2: no role literal any more: an administrator reads only their own profile until granted admin.users, and no data.
    const a = await createUser(orgA, 'admin')
    expect(await rows(a, 'profiles')).toEqual([a.id])
    await grant(orgA, a.id, 'admin.users')
    expect((await rows(a, 'profiles')).length).toBeGreaterThan(2)
    for (const t of ['stores', 'cameras', 'devices', 'admin_audit_log'] as const) expect(await rows(a, t)).toEqual([])
    await grant(orgA, a.id, 'admin.audit.read')
    await admin().from('admin_audit_log').insert({ org_id: orgA, actor_id: a.id, action: 'test' })
    expect((await rows(a, 'admin_audit_log')).length).toBe(1)
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
    const p = await createUser(orgA, 'user')
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
    for (const t of ['stores', 'cameras', 'devices'] as const) expect(await rows(p, t)).toEqual([])
    expect(await can(p, 'cctv.live')).toBe(false)
    expect(await ids(p, 'any_cctv_camera_ids')).toEqual([])
    await admin().from('profiles').update({ is_active: true }).eq('id', p.id)
    expect((await rows(p, 'cameras')).length).toBe(6)
    expect(await rows(p, 'devices')).toEqual(sorted([d0, d1, d2]))

    const r = await createUser(orgA, 'user', { mustReset: true })
    await grant(orgA, r.id, READ_EVERYTHING)
    for (const t of ['stores', 'cameras', 'devices'] as const) expect(await rows(r, t)).toEqual([])
    expect(await can(r, 'cctv.live')).toBe(false)
  })

  it('VA-12: organisations are isolated, and grants cannot point across them', async () => {
    const a = await createUser(orgA, 'user')
    await grant(orgA, a.id, READ_EVERYTHING)
    const b = await createUser(orgB, 'user')
    await grant(orgB, b.id, READ_EVERYTHING)
    expect(await rows(b, 'stores')).toEqual([LB])
    expect(await rows(b, 'cameras')).toEqual([cB])
    expect(await rows(b, 'devices')).toEqual([dB])
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
    for (const col of ['nvr_ip', 'rtsp_port', 'http_port', 'nvr_username', 'nvr_secret_id', '*']) {
      const res = await p.client.from('stores').select(col)
      expect(res.error?.code, col).toBe('42501')
    }
    expect((await p.client.from('cameras').select('camera_ip')).error?.code).toBe('42501')
    expect((await p.client.from('cameras').select('*')).error?.code).toBe('42501')
    // The plain columns still work.
    expect((await p.client.from('stores').select('id, code, name, city, zone, is_active')).data).toHaveLength(1)
    expect((await p.client.from('cameras').select('id, store_id, channel, name, is_active')).data).toHaveLength(3)
    expect((await p.client.from('store_nvr_endpoints').select('store_id')).data).toEqual([])
    expect((await p.client.from('camera_endpoints').select('camera_id')).data).toEqual([])
    // Straight to PostgREST with the person's own token.
    const raw = await fetch(`${URL_()}/rest/v1/stores?select=nvr_ip,nvr_username`, { headers: { apikey: ANON(), Authorization: `Bearer ${await token(p)}` } })
    expect(raw.status).toBeGreaterThanOrEqual(400)
    expect(await raw.text()).not.toContain('192.0.2.10')

    // An IT person for L1 reads the addresses of L1 only (never the vault id).
    const it_ = await createUser(orgA, 'user')
    await grant(orgA, it_.id, 'it.inventory.view', atLocation(L1))
    expect((await it_.client.from('store_nvr_endpoints').select('store_id, nvr_ip, nvr_username')).data).toEqual([{ store_id: L1, nvr_ip: '192.0.2.10', nvr_username: 'viewer' }])
    expect((await it_.client.from('camera_endpoints').select('camera_id')).data?.length).toBe(3)
    expect((await it_.client.from('store_nvr_endpoints').select('nvr_secret_id')).error).not.toBeNull()
    expect((await it_.client.from('devices').select('ip, tcp_port')).data).toHaveLength(1)
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

    // IT capabilities count assets.
    const it_ = await preview([{ op: 'grant', capability: 'it.inventory.view', scope_kind: 'location', scope_id: L1 }])
    expect(it_.capabilities['it.inventory.view']).toMatchObject({ added_count: 1, removed_count: 0 })

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
    for (const t of ['stores', 'cameras', 'devices'] as const) expect(await rows(p, t)).toEqual([])
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
    const expected: Record<string, string[]> = {
      mfa_enforced: people,
      has_capability: people,
      has_capability_for: people,
      capability_camera_ids: people,
      capability_store_ids: people,
      capability_device_ids: people,
      any_cctv_camera_ids: people,
      cameras_with_capability: people,
      any_grant_store_ids: people,
      it_view_store_ids: people,
      it_view_device_ids: people,
      cctv_visible_group_ids: people,
      // P2-2: the caller's capability summary (one call per request). Signed-in people only: the service role is nobody.
      my_access_summary: ['authenticated'],
      // P2-2 fix I-1: why targets are offline, in camera terms without the IT view.
      status_reasons: ['authenticated'],
      grant_access: server,
      revoke_grant: server,
      replace_user_grants: server,
      preview_access_change: server,
      access_expiring: server,
      // Reporting only (ignore MFA, never for authorisation): the old access_effective_* names are gone (fix minor 2).
      report_effective_camera_ids: server,
      report_effective_device_ids: server,
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
      access_device_set: [],
      access_store_set: [],
      access_cameras_for: [],
      access_devices_for: [],
      access_stores_for: [],
      access_lock_person: [],
      access_bump_version: [],
      access_check_spec: [],
      access_put_grant: [],
      access_items: [],
      access_legacy_store_grants: [],
      access_grants_before_insert: [],
      access_grants_before_update: [],
    }
    for (const [name, grantees] of Object.entries(expected)) {
      const f = byName.get(name)
      expect(f, name).toBeDefined()
      expect(sorted(f!.grantees), name).toEqual(sorted(grantees))
      if (f!.security_definer) expect(f!.search_path, name).toBe('')
    }
    // The old model is gone, and so are the names replaced in fix round 1.
    for (const old of ['is_staff_all', 'granted_store_ids', 'visible_store_ids', 'visible_camera_ids', 'visible_device_ids', 'replace_user_access',
      'access_effective_camera_ids', 'access_effective_device_ids']) {
      expect(byName.has(old), old).toBe(false)
    }
    // One signature each (no stale overloads left behind by a changed parameter list).
    for (const name of ['preview_access_change', 'access_expiring', 'access_migrate_legacy', 'replace_user_grants', 'grant_access', 'revoke_grant']) {
      expect((data ?? []).filter((f) => f.name === name), name).toHaveLength(1)
    }
    // Minor 8, the sweep: no function of schema public is callable by anon or PUBLIC, and signed-in people only the allow-list.
    const forPeople = new Set([
      'current_org_id', 'current_user_role', 'monitor_stale_after_minutes', 'mfa_enforced', 'has_capability', 'has_capability_for',
      'capability_camera_ids', 'capability_store_ids', 'capability_device_ids', 'any_cctv_camera_ids', 'cameras_with_capability',
      'any_grant_store_ids', 'it_view_store_ids', 'it_view_device_ids', 'cctv_visible_group_ids', 'my_access_summary', 'status_reasons',
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
    expect(sorted(byKey.get('cctv.live')!.scope_kinds)).toEqual(sorted(['organization', 'location', 'camera']))
    expect(sorted(byKey.get('it.inventory.view')!.scope_kinds)).toEqual(sorted(['organization', 'location', 'asset']))
    expect(byKey.get('admin.users')!.scope_kinds).toEqual(['organization'])
    expect((await admin().rpc('mfa_enforced')).data).toBe(false)
    // A capability that needs MFA still works while MFA is not enforced (the switch arrives in P3).
    const p = await createUser(orgA, 'user')
    await grant(orgA, p.id, 'cctv.export', atCamera(c11))
    expect(await canFor(p, 'cctv.export', 'camera', c11)).toBe(true)
    expect(await can(p, 'cctv.export')).toBe(true)
    void ORG_SCOPE
  })
})
