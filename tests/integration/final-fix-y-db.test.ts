import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/types/database'
import {
  adminClient, atLocation, cleanupOrg, createAsset, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion,
  createUser, grant, type TestUser,
} from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

// Release 1 final fix round, builder Y: the database items of migration 20261021000049 (final-review-A I-1, M-1..M-7; final-review-B
// I-1, I-2; final-review-C I-8, I-9). Every test works on its own test organisations (the ledger removes them); owner-side SQL runs in
// a transaction that is rolled back, or on the tests' own rows.
//   A I-1 / B I-1  two-step sign-in may not depend on a remembered manual step: the state of every active organisation (overview, the
//                  Health page's ops_health_status), an audited owner-only switch with a reason for turning it off, the production
//                  database's default (enforced) for an organisation without settings.
//   B I-2          consecutive wrong codes are counted in the database: 10 in a row lock the code step for 15 minutes (doubling, at most
//                  24 hours), 100 lock it until a super administrator clears it; a right code resets the count; concurrent tries never pass
//                  the limit.
//   A M-1          a plain administrator resets a password only when the person holds nothing the administrator does not hold.
//   A M-2          the inventory functions check the actor's right (admin.inventory or super administrator) in SQL; app_web must name one.
//   A M-3          admin.* and cctv.export only for administrators on every path; a role change made anywhere removes them; row security
//                  on admin.* needs an administrative role.
//   A M-4          two super administrators taking each other's admin.access at the same moment: one wins, the other is refused.
//   A M-6          recorder_store_credential and revoke_user_sessions for the web app take the organisation.
//   A M-7          a person is created through create_person (role checked in SQL); the web app cannot insert profiles itself.
//   C I-8          the device import applies in one transaction, keeps saved values for empty cells and never changes another kind.
//   C I-9          a restore under an archived parent is refused.

const admin = () => adminClient()
const web = () => serviceClient('app_web')
type Any = SupabaseClient<Database>
const call = (c: Any, fn: string, args: Record<string, unknown>) => (c.rpc as unknown as (f: string, a: unknown) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>)(fn, args)
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_cctv_hub'
function psql(sql: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (err += String(d)))
    p.on('close', (c) => resolve({ code: c, out, err }))
    p.stdin.end(sql)
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const liveGrants = async (userId: string, cap: string) => {
  const { data, error } = await admin().from('access_grants').select('id').eq('user_id', userId).eq('capability', cap).is('revoked_at', null)
  if (error) throw new Error(error.message)
  return (data ?? []).map((g) => g.id)
}

describe('final fix Y: two-step sign-in is required unless an audited opt-out says otherwise (A I-1, B I-1)', () => {
  let org: string
  let owner: TestUser, plainAdmin: TestUser, viewer: TestUser
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users', 'admin.access'])
    plainAdmin = await createUser(org, 'admin')
    await grant(org, plainAdmin.id, ['admin.users', 'admin.access'])
    viewer = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  const overview = async () => {
    const r = await call(web(), 'security_mfa_overview', {})
    expect(r.error).toBeNull()
    return (r.data as { org_id: string; enforced: boolean; opted_out: boolean; reason: string | null; off_at: string | null }[]).find((o) => o.org_id === org)
  }

  it('an organisation without settings is listed as off and not opted out (local development database)', async () => {
    expect(await overview()).toMatchObject({ enforced: false, opted_out: false, reason: null })
  })

  it('only a super administrator switches it, through the web app with the actor named; switching off needs a reason; every change is audited', async () => {
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: plainAdmin.id, p_enforced: true, p_reason: null })).error?.code).toBe('42501')
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: viewer.id, p_enforced: true, p_reason: null })).error?.code).toBe('42501')
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: null, p_enforced: true, p_reason: null })).error?.code).toBe('42501')
    expect((await call(viewer.client, 'security_set_mfa', { p_org: org, p_actor: owner.id, p_enforced: true, p_reason: null })).error).not.toBeNull()
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: owner.id, p_enforced: true, p_reason: null })).error).toBeNull()
    expect(await overview()).toMatchObject({ enforced: true, opted_out: false })
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: owner.id, p_enforced: false, p_reason: 'short' })).error?.code).toBe('22023')
    expect(await overview()).toMatchObject({ enforced: true })
    const why = 'Staged roll-out: two administrators still enrol this week'
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: owner.id, p_enforced: false, p_reason: why })).error).toBeNull()
    const off = await overview()
    expect(off).toMatchObject({ enforced: false, opted_out: true, reason: why })
    expect(off?.off_at).toBeTruthy()
    const { data: rows } = await admin().from('admin_audit_log').select('actor_id, action, detail').eq('org_id', org).eq('action', 'mfa_enforced_changed').order('created_at')
    expect((rows ?? []).length).toBeGreaterThanOrEqual(2)
    const last = (rows ?? [])[(rows ?? []).length - 1] as unknown as { actor_id: string; detail: { to: boolean; reason: string } }
    expect(last.actor_id).toBe(owner.id)
    expect(last.detail).toMatchObject({ to: false, reason: why })
    // On again: the opt-out is gone with it.
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: owner.id, p_enforced: true, p_reason: null })).error).toBeNull()
    expect(await overview()).toMatchObject({ enforced: true, opted_out: false, reason: null, off_at: null })
  })

  it('ops_health_status reports the state of every active organisation (counts only)', async () => {
    const r = await call(web(), 'ops_health_status', {})
    expect(r.error).toBeNull()
    const mfa = (r.data as { mfa?: Record<string, number> }).mfa
    expect(mfa).toBeDefined()
    for (const k of ['active', 'enforced', 'off', 'opted_out']) expect(typeof mfa![k], k).toBe('number')
    expect(mfa!.enforced + mfa!.off + mfa!.opted_out).toBe(mfa!.active)
    expect(mfa!.enforced).toBeGreaterThanOrEqual(1) // this file's organisation
  })

  it('a database marked as a production one requires it by default: an organisation without settings and a new settings row', async () => {
    const other = await createOrg()
    try {
      const person = await createUser(other, 'user')
      const r = await psql(`BEGIN;
        UPDATE public.test_fixture_switch SET honoured = false, production = true;
        SELECT 'user', public.mfa_enforced_for_user('${person.id}'::uuid);
        INSERT INTO public.security_settings (org_id) VALUES ('${other}'::uuid) RETURNING 'row', mfa_enforced;
        ROLLBACK;`)
      expect(r.code, r.err).toBe(0)
      expect(r.out).toContain('user|t')
      expect(r.out).toContain('row|t')
      // Outside production (this stack) the default stays off, so tests and development are unchanged.
      const dev = await psql(`SELECT public.mfa_enforced_for_user('${person.id}'::uuid);`)
      expect(dev.out.trim()).toBe('f')
    } finally {
      await cleanupOrg(other)
    }
  })
})

describe('final fix Y: consecutive wrong codes lock the code step (B I-2)', () => {
  let org: string
  let owner: TestUser, plainAdmin: TestUser
  const people: TestUser[] = []
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users'])
    plainAdmin = await createUser(org, 'admin')
    await grant(org, plainAdmin.id, ['admin.users'])
    for (let i = 0; i < 6; i++) people.push(await createUser(org, 'user'))
  })
  afterAll(() => cleanupOrg(org))

  type Begin = { allowed: boolean; locked_until: string | null; for_good: boolean; locks_if_wrong: boolean }
  const begin = async (u: string) => {
    const r = await call(web(), 'mfa_code_attempt_begin', { p_user: u })
    expect(r.error).toBeNull()
    return r.data as Begin
  }
  const finish = async (u: string, outcome: 'correct' | 'wrong' | 'not_counted') => {
    const r = await call(web(), 'mfa_code_attempt_end', { p_user: u, p_outcome: outcome })
    expect(r.error).toBeNull()
  }
  const state = async (u: string) => {
    const r = await psql(`SELECT failures || '|' || lockouts || '|' || coalesce(extract(epoch from (locked_until - now()))::int::text, '') || '|' || locked_for_good FROM public.mfa_code_failures WHERE user_id = '${u}'::uuid;`)
    expect(r.code, r.err).toBe(0)
    const [f, l, secs, good] = r.out.trim().split('|')
    return { failures: Number(f), lockouts: Number(l), lockedForSec: secs === '' ? null : Number(secs), forGood: good === 't' || good === 'true' }
  }
  const events = async (u: string) => ((await admin().from('auth_events').select('event, actor_id, detail').eq('user_id', u).order('at')).data ?? []) as { event: string; actor_id: string | null; detail: Record<string, unknown> }[]

  it('9 wrong codes leave the step open; the 10th wrong one locks it for 15 minutes, recorded once; while locked nothing is tried', async () => {
    const u = people[0].id
    for (let i = 1; i <= 9; i++) {
      const b = await begin(u)
      expect(b.allowed).toBe(true)
      expect(b.locks_if_wrong).toBe(false)
      await finish(u, 'wrong')
    }
    const tenth = await begin(u)
    expect(tenth).toMatchObject({ allowed: true, locks_if_wrong: true })
    await finish(u, 'wrong')
    const s = await state(u)
    expect(s).toMatchObject({ failures: 10, lockouts: 1, forGood: false })
    expect(s.lockedForSec).toBeGreaterThan(14 * 60)
    expect(s.lockedForSec).toBeLessThanOrEqual(15 * 60)
    const refused = await begin(u)
    expect(refused.allowed).toBe(false)
    expect(Date.parse(refused.locked_until!)).toBeGreaterThan(Date.now() + 14 * 60_000)
    expect((await state(u)).failures).toBe(10) // a refused try is not a try
    const locked = (await events(u)).filter((e) => e.event === 'mfa_locked')
    expect(locked).toHaveLength(1)
    expect(locked[0].detail).toMatchObject({ failures: 10, minutes: 15 })
  })

  it('a right code resets the count; a try the auth server could not judge is given back', async () => {
    const u = people[1].id
    for (let i = 0; i < 4; i++) {
      await begin(u)
      await finish(u, 'wrong')
    }
    await begin(u)
    await finish(u, 'not_counted')
    expect((await state(u)).failures).toBe(4)
    await begin(u)
    await finish(u, 'correct')
    expect(await state(u)).toMatchObject({ failures: 0, lockouts: 0, lockedForSec: null, forGood: false })
  })

  it('each further lock-out doubles the time, at most 24 hours', async () => {
    const u = people[2].id
    await begin(u)
    await finish(u, 'correct') // the row exists
    expect((await psql(`UPDATE public.mfa_code_failures SET failures = 19, lockouts = 1, locked_until = now() - interval '1 second' WHERE user_id = '${u}'::uuid;`)).code).toBe(0)
    expect((await begin(u)).allowed).toBe(true)
    await finish(u, 'wrong')
    const second = await state(u)
    expect(second).toMatchObject({ failures: 20, lockouts: 2 })
    expect(second.lockedForSec).toBeGreaterThan(29 * 60)
    expect(second.lockedForSec).toBeLessThanOrEqual(30 * 60)
    expect((await psql(`UPDATE public.mfa_code_failures SET failures = 79, lockouts = 7, locked_until = NULL WHERE user_id = '${u}'::uuid;`)).code).toBe(0)
    await begin(u)
    await finish(u, 'wrong')
    const capped = await state(u)
    expect(capped.lockouts).toBe(8)
    expect(capped.lockedForSec).toBeGreaterThan(23 * 3600)
    expect(capped.lockedForSec).toBeLessThanOrEqual(24 * 3600)
  })

  it('100 wrong codes in a row lock the code step for good: only a super administrator clears it, with a reason, audited', async () => {
    const u = people[3].id
    await begin(u)
    await finish(u, 'correct')
    expect((await psql(`UPDATE public.mfa_code_failures SET failures = 99, lockouts = 9, locked_until = NULL WHERE user_id = '${u}'::uuid;`)).code).toBe(0)
    expect((await begin(u)).locks_if_wrong).toBe(true)
    await finish(u, 'wrong')
    expect(await state(u)).toMatchObject({ failures: 100, forGood: true })
    expect((await psql(`UPDATE public.mfa_code_failures SET locked_until = now() - interval '1 day' WHERE user_id = '${u}'::uuid;`)).code).toBe(0)
    expect(await begin(u)).toMatchObject({ allowed: false, for_good: true })
    expect((await events(u)).map((e) => e.event)).toContain('mfa_locked_for_good')
    // The person's state is listed for the people screen of their organisation only.
    const listed = await call(web(), 'mfa_code_locks', { p_org: org })
    expect(listed.error).toBeNull()
    expect((listed.data as { user_id: string; for_good: boolean }[]).find((x) => x.user_id === u)).toMatchObject({ for_good: true })
    const elsewhere = await createOrg()
    try {
      expect(((await call(web(), 'mfa_code_locks', { p_org: elsewhere })).data as unknown[]).length).toBe(0)
    } finally {
      await cleanupOrg(elsewhere)
    }
    // Clearing: a plain administrator, the person themself, no reason: refused. A super administrator with a reason: cleared.
    expect((await call(web(), 'mfa_code_lock_clear', { p_org: org, p_actor: plainAdmin.id, p_user: u, p_reason: 'Phone was fine' })).error?.code).toBe('42501')
    expect((await call(web(), 'mfa_code_lock_clear', { p_org: org, p_actor: u, p_user: u, p_reason: 'Phone was fine' })).error?.code).toBe('42501')
    expect((await call(web(), 'mfa_code_lock_clear', { p_org: org, p_actor: owner.id, p_user: u, p_reason: '' })).error?.code).toBe('22023')
    expect((await call(web(), 'mfa_code_lock_clear', { p_org: org, p_actor: owner.id, p_user: u, p_reason: 'Checked with the person by phone' })).error).toBeNull()
    expect(await state(u)).toMatchObject({ failures: 0, lockouts: 0, lockedForSec: null, forGood: false })
    const cleared = (await events(u)).filter((e) => e.event === 'mfa_lock_cleared')
    expect(cleared).toHaveLength(1)
    expect(cleared[0].actor_id).toBe(owner.id)
    const { data: audit } = await admin().from('admin_audit_log').select('actor_id').eq('org_id', org).eq('action', 'mfa_code_lock_cleared').eq('entity_id', u)
    expect(audit).toEqual([{ actor_id: owner.id }])
  })

  it('concurrent tries never pass the limit: 15 at once from nothing, exactly 10 are allowed', async () => {
    const u = people[4].id
    const all = await Promise.all(Array.from({ length: 15 }, () => begin(u)))
    expect(all.filter((b) => b.allowed)).toHaveLength(10)
    expect(all.filter((b) => b.locks_if_wrong)).toHaveLength(1)
    expect((await state(u)).failures).toBe(10)
  })

  it('no oracle and no access from outside: an unknown person gives the same answer and leaves nothing; signed-in people reach nothing', async () => {
    expect(await begin(randomUUID())).toEqual({ allowed: true, locked_until: null, for_good: false, locks_if_wrong: false })
    for (const fn of ['mfa_code_attempt_begin', 'mfa_code_attempt_end', 'mfa_code_locks', 'mfa_code_lock_clear']) {
      const r = await call(people[5].client, fn, { p_user: people[5].id, p_outcome: 'correct', p_org: org, p_actor: people[5].id, p_reason: 'x' })
      expect(r.error, fn).not.toBeNull()
    }
    expect((await people[5].client.from('mfa_code_failures' as never).select('*')).error).not.toBeNull()
    for (const role of ['media_service', 'monitor_worker', 'video_gateway'] as const) {
      expect((await call(serviceClient(role), 'mfa_code_attempt_begin', { p_user: people[5].id })).error, role).not.toBeNull()
    }
  })
})

describe('final fix Y: password reset, inventory rights, E-1 everywhere, concurrent revocation, org arguments, person creation (A M-1..M-7)', () => {
  let org: string
  let otherOrg: string
  let owner: TestUser, owner2: TestUser, plainAdmin: TestUser, invAdmin: TestUser, operator: TestUser, manager: TestUser
  let loc: string
  let rec: string
  beforeAll(async () => {
    org = await createOrg()
    otherOrg = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users', 'admin.access', 'admin.inventory', 'cctv.live', 'cctv.playback'])
    owner2 = await createUser(org, 'platform_owner')
    await grant(org, owner2.id, ['admin.users', 'admin.access', 'admin.inventory'])
    plainAdmin = await createUser(org, 'admin')
    await grant(org, plainAdmin.id, ['admin.users', 'admin.access', 'cctv.live'])
    invAdmin = await createUser(org, 'admin')
    await grant(org, invAdmin.id, ['admin.inventory', 'admin.users'])
    operator = await createUser(org, 'operator')
    manager = await createUser(org, 'manager')
    loc = await createLocation(org)
    rec = await createRecorder(org, loc, { host: '10.148.0.1' })
  })
  afterAll(async () => {
    await cleanupOrg(org)
    await cleanupOrg(otherOrg)
  })

  it('M-1: a plain administrator may reset only a person whose every live grant they hold themselves, at an equal or wider scope and for as long', async () => {
    const check = (actor: string, user: string) => call(web(), 'access_check_password_reset', { p_org: org, p_actor: actor, p_user: user })
    expect((await check(plainAdmin.id, manager.id)).error).toBeNull() // no grants
    await grant(org, manager.id, 'cctv.live', atLocation(loc))
    expect((await check(plainAdmin.id, manager.id)).error).toBeNull() // live org-wide covers a location
    await grant(org, manager.id, 'cctv.playback')
    const refused = await check(plainAdmin.id, manager.id)
    expect(refused.error?.code).toBe('42501')
    expect(refused.error?.message).toMatch(/super administrator/)
    expect((await check(owner.id, manager.id)).error).toBeNull() // a super administrator may always
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await grant(org, plainAdmin.id, 'cctv.playback', { kind: 'organization' }, { validUntil: until })
    expect((await check(plainAdmin.id, manager.id)).error?.code).toBe('42501') // for less long than the person holds it
    await grant(org, plainAdmin.id, 'cctv.playback')
    expect((await check(plainAdmin.id, manager.id)).error).toBeNull()
    expect((await check(plainAdmin.id, owner.id)).error?.code).toBe('42501') // not a super administrator's
    expect((await check(plainAdmin.id, plainAdmin.id)).error?.code).toBe('42501') // not one's own
    expect((await check(operator.id, manager.id)).error?.code).toBe('42501') // not without admin.users
  })

  it('M-2: every inventory function asks for admin.inventory (or a super administrator) in SQL, and the web app must name the actor', async () => {
    const cam = await createCamera(org, { locationId: loc, recorderId: rec, channel: 7 })
    const cam2 = await createCamera(org, { locationId: loc, recorderId: rec, channel: 8 })
    const asset = await createAsset(org, { locationId: loc })
    const cluster = await createCluster(org, null)
    const region = await createRegion(org)
    const calls = (actor: string | null): [string, Record<string, unknown>][] => [
      ['inventory_archive', { p_org: org, p_kind: 'asset', p_id: asset, p_actor: actor }],
      ['inventory_restore', { p_org: org, p_kind: 'asset', p_id: asset, p_actor: actor }],
      ['inventory_move_location', { p_org: org, p_location: loc, p_cluster: cluster, p_actor: actor }],
      ['inventory_move_cluster', { p_org: org, p_cluster: cluster, p_region: region, p_actor: actor }],
      ['camera_remap', { p_org: org, p_camera: cam, p_recorder: rec, p_channel: 9, p_actor: actor }],
      ['camera_merge', { p_org: org, p_keep: cam, p_duplicate: cam2, p_actor: actor }],
      ['discovery_apply', { p_org: org, p_recorder: rec, p_ops: [], p_to_reconcile: 0, p_actor: actor, p_findings: [] }],
      ['recorder_save', { p_org: org, p_location: loc, p_recorder: rec, p_host: '10.148.0.1', p_http_port: 80, p_rtsp_port: 554, p_username: 'viewer', p_expected_channels: 0, p_name: 'NVR', p_actor: actor }],
      ['inventory_apply_proposals', { p_org: org, p_items: [{ location_id: loc, cluster_code: 'CFY1', region_code: null }], p_actor: actor }],
    ]
    for (const actor of [operator.id, manager.id, plainAdmin.id, null]) {
      for (const [fn, args] of calls(actor)) {
        const r = await call(web(), fn, args)
        expect(r.error?.code, `${fn} as ${actor ?? 'nobody'}`).toBe('42501')
      }
    }
    // With the right: allowed (one of each kind of actor).
    expect((await call(web(), 'inventory_archive', { p_org: org, p_kind: 'asset', p_id: asset, p_actor: invAdmin.id })).error).toBeNull()
    expect((await call(web(), 'inventory_restore', { p_org: org, p_kind: 'asset', p_id: asset, p_actor: owner.id })).error).toBeNull()
    // The service key (scripts, tests) may still act without a person.
    expect((await call(admin(), 'inventory_archive', { p_org: org, p_kind: 'asset', p_id: asset, p_actor: null })).error).toBeNull()
    // An actor of another organisation: refused as before.
    expect((await call(web(), 'inventory_restore', { p_org: otherOrg, p_kind: 'asset', p_id: asset, p_actor: invAdmin.id })).error?.code).toBe('42501')
  })

  it('M-3: admin.* and cctv.export are refused for a non-administrator on every path; a role change made anywhere takes them away', async () => {
    const target = await createUser(org, 'operator')
    for (const cap of ['admin.users', 'admin.inventory', 'cctv.export']) {
      const r = await call(admin(), 'grant_access', { p_org: org, p_user: target.id, p_grants: [{ capability: cap, scope_kind: 'organization', scope_id: null }], p_reason: 'test fixture' })
      expect(r.error?.code, cap).toBe('42501')
    }
    const adminTarget = await createUser(org, 'admin')
    await grant(org, adminTarget.id, ['admin.users', 'cctv.export', 'cctv.live'])
    // A direct role change with the service key (no screen, no change_person_role).
    expect((await admin().from('profiles').update({ role: 'manager' }).eq('id', adminTarget.id)).error).toBeNull()
    expect(await liveGrants(adminTarget.id, 'admin.users')).toEqual([])
    expect(await liveGrants(adminTarget.id, 'cctv.export')).toEqual([])
    expect(await liveGrants(adminTarget.id, 'cctv.live')).toHaveLength(1)
    const { data: audit } = await admin().from('admin_audit_log').select('detail').eq('org_id', org).eq('action', 'access_revoked').eq('entity_id', adminTarget.id)
    expect((audit ?? []).length).toBe(1)
    expect((audit ?? [])[0].detail).toMatchObject({ from_role: 'admin', to_role: 'manager', path: 'database' })
    // change_person_role still reports what it took away (the screens audit it themselves).
    const second = await createUser(org, 'admin')
    await grant(org, second.id, ['admin.users', 'cctv.export'])
    const changed = await call(web(), 'change_person_role', { p_org: org, p_actor: owner.id, p_user: second.id, p_role: 'operator' })
    expect(changed.error).toBeNull()
    expect(((changed.data as { revoked: unknown[] }).revoked).length).toBe(2)
  })

  it('M-3: row security on admin.* needs an administrative role (a stray grant alone reads nothing)', async () => {
    const stray = await createUser(org, 'operator')
    const r = await psql(`BEGIN;
      ALTER TABLE public.access_grants DISABLE TRIGGER access_grants_insert;
      INSERT INTO public.access_grants (org_id, user_id, capability, scope_kind, scope_id, valid_from, granted_at, reason, source)
      VALUES ('${org}'::uuid, '${stray.id}'::uuid, 'admin.users', 'organization', NULL, now() - interval '1 minute', now(), 'stray', 'manual'),
             ('${org}'::uuid, '${stray.id}'::uuid, 'admin.access', 'organization', NULL, now() - interval '1 minute', now(), 'stray', 'manual'),
             ('${org}'::uuid, '${stray.id}'::uuid, 'admin.audit.read', 'organization', NULL, now() - interval '1 minute', now(), 'stray', 'manual');
      SELECT set_config('request.jwt.claims', '{"sub":"${stray.id}","role":"authenticated","aal":"aal2"}', true);
      SET LOCAL ROLE authenticated;
      SELECT 'profiles', count(*) FROM public.profiles WHERE id <> '${stray.id}'::uuid;
      SELECT 'grants', count(*) FROM public.access_grants WHERE user_id <> '${stray.id}'::uuid;
      SELECT 'audit', count(*) FROM public.admin_audit_log;
      ROLLBACK;`)
    expect(r.code, r.err).toBe(0)
    expect(r.out, r.out).toContain('profiles|0')
    expect(r.out).toContain('grants|0')
    expect(r.out).toContain('audit|0')
  })

  it('M-4: two super administrators taking each other\'s admin.access at the same moment: the first wins, the second is refused', async () => {
    const a = await createUser(org, 'platform_owner')
    const b = await createUser(org, 'platform_owner')
    await grant(org, a.id, ['admin.access'])
    await grant(org, b.id, ['admin.access'])
    const [ga] = await liveGrants(a.id, 'admin.access')
    const [gb] = await liveGrants(b.id, 'admin.access')
    const change = (actor: string, user: string, grantId: string) =>
      `SELECT public.apply_access_change('${org}'::uuid, '${user}'::uuid, '[{"op":"revoke","grant_id":"${grantId}","reason":"concurrent test"}]'::jsonb, '${actor}'::uuid)`
    const first = psql(`BEGIN; ${change(a.id, b.id, gb)}; SELECT pg_sleep(2); COMMIT;`)
    await sleep(600)
    const second = await psql(`BEGIN; ${change(b.id, a.id, ga)}; COMMIT;`)
    const one = await first
    expect(one.code, one.err).toBe(0)
    expect(second.code).not.toBe(0)
    expect(second.err).toMatch(/admin\.access/)
    expect(await liveGrants(a.id, 'admin.access')).toEqual([ga])
    expect(await liveGrants(b.id, 'admin.access')).toEqual([])
  })

  it('M-6: the web app saves an NVR password and ends sign-ins only with the organisation named; the forms without it are server-only', async () => {
    expect((await call(web(), 'recorder_store_credential', { p_recorder: rec, p_secret: 'a-password-1' })).error?.code).toBe('42501')
    expect((await call(web(), 'revoke_user_sessions', { p_user: operator.id })).error?.code).toBe('42501')
    expect((await call(web(), 'recorder_store_credential', { p_org: otherOrg, p_recorder: rec, p_secret: 'a-password-1', p_actor: invAdmin.id })).error?.code).toMatch(/^(P0002|42501)$/)
    expect((await call(web(), 'recorder_store_credential', { p_org: org, p_recorder: rec, p_secret: 'a-password-1', p_actor: operator.id })).error?.code).toBe('42501')
    expect((await call(web(), 'recorder_store_credential', { p_org: org, p_recorder: rec, p_secret: 'a-password-1', p_actor: invAdmin.id })).error).toBeNull()
    const { data: audit } = await admin().from('admin_audit_log').select('actor_id').eq('org_id', org).eq('action', 'recorder_password_set').eq('entity_id', rec)
    expect(audit).toEqual([{ actor_id: invAdmin.id }])
    const stranger = await createUser(otherOrg, 'user')
    expect((await call(web(), 'revoke_user_sessions', { p_org: org, p_user: stranger.id })).error?.code).toBe('P0002')
    expect((await call(web(), 'revoke_user_sessions', { p_org: otherOrg, p_user: stranger.id })).error).toBeNull()
    // The service key keeps the old forms (scripts and tests).
    expect((await call(admin(), 'recorder_store_credential', { p_recorder: rec, p_secret: 'a-password-2' })).error).toBeNull()
  })

  it('M-7: a person is created only through create_person, which checks the role in SQL; the web app cannot insert a profile', async () => {
    const make = async () => {
      const email = `${randomUUID()}@example.test`
      const { data, error } = await admin().auth.admin.createUser({ email, password: `${randomUUID()}aA1!`, email_confirm: true })
      if (error || !data.user) throw new Error(error?.message)
      return { id: data.user.id, email }
    }
    const p1 = await make()
    expect((await web().from('profiles').insert({ id: p1.id, org_id: org, email: p1.email, full_name: 'Direct', role: 'user' })).error?.code).toBe('42501')
    const create = (actor: string, p: { id: string; email: string }, role: string) =>
      call(web(), 'create_person', { p_org: org, p_actor: actor, p_user: p.id, p_email: p.email, p_full_name: 'Made in SQL', p_role: role, p_location: null })
    expect((await create(plainAdmin.id, p1, 'platform_owner')).error?.code).toBe('42501')
    expect((await create(plainAdmin.id, p1, 'admin')).error?.code).toBe('42501')
    expect((await create(operator.id, p1, 'user')).error?.code).toBe('42501')
    expect((await create(plainAdmin.id, p1, 'operator')).error).toBeNull()
    const { data: row } = await admin().from('profiles').select('org_id, role, must_reset_password, is_active').eq('id', p1.id).single()
    expect(row).toEqual({ org_id: org, role: 'operator', must_reset_password: true, is_active: true })
    const p2 = await make()
    expect((await create(owner.id, p2, 'admin')).error).toBeNull()
    const p3 = await make()
    const elsewhere = await call(web(), 'create_person', { p_org: org, p_actor: plainAdmin.id, p_user: p3.id, p_email: p3.email, p_full_name: 'X', p_role: 'user', p_location: randomUUID() })
    expect(elsewhere.error).not.toBeNull()
    await admin().auth.admin.deleteUser(p3.id)
  })
})

describe('final fix Y: restoring under an archived parent is refused (C I-9)', () => {
  let org: string
  let owner: TestUser
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.inventory'])
  })
  afterAll(() => cleanupOrg(org))
  const archive = (kind: string, id: string) => call(web(), 'inventory_archive', { p_org: org, p_kind: kind, p_id: id, p_actor: owner.id })
  const restore = (kind: string, id: string) => call(web(), 'inventory_restore', { p_org: org, p_kind: kind, p_id: id, p_actor: owner.id })

  it('a location under an archived cluster, a cluster under an archived region, a camera or device at an archived location', async () => {
    const region = await createRegion(org)
    const cluster = await createCluster(org, region)
    const location = await createLocation(org, { clusterId: cluster })
    const cam = await createCamera(org, { locationId: location, channel: 1 })
    const device = await createAsset(org, { locationId: location })
    expect((await archive('camera', cam)).error).toBeNull()
    expect((await archive('asset', device)).error).toBeNull()
    expect((await archive('location', location)).error).toBeNull()
    expect((await archive('cluster', cluster)).error).toBeNull()
    expect((await archive('region', region)).error).toBeNull()
    for (const [kind, id] of [['location', location], ['cluster', cluster], ['camera', cam], ['asset', device]] as const) {
      const r = await restore(kind, id)
      expect(r.error?.code, kind).toBe('DR040')
    }
    expect((await restore('region', region)).error).toBeNull()
    expect((await restore('cluster', cluster)).error).toBeNull()
    expect((await restore('location', location)).error).toBeNull()
    expect((await restore('camera', cam)).error).toBeNull()
    expect((await restore('asset', device)).error).toBeNull()
  })
})

describe('final fix Y: the device import in one transaction (C I-8)', () => {
  let org: string
  let owner: TestUser, operator: TestUser
  let locA: string, locB: string
  const codeA = `FYA${randomUUID().slice(0, 4).toUpperCase()}`
  const codeB = `FYB${randomUUID().slice(0, 4).toUpperCase()}`
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.inventory'])
    operator = await createUser(org, 'operator')
    locA = await createLocation(org, { code: codeA })
    locB = await createLocation(org, { code: codeB })
  })
  afterAll(() => cleanupOrg(org))
  type Row = { line: number; name: string; type: string; location_code: string | null; clear_location?: boolean; ip: string; tcp_port: number | null; notes: string | null; clear_notes?: boolean }
  const run = (rows: Row[], apply: boolean, actor = owner.id) => call(web(), 'inventory_devices_import', { p_org: org, p_actor: actor, p_rows: rows, p_apply: apply })
  type Out = { created: number; updated: number; errors: { line: number; column?: string; message: string }[]; applied: boolean }
  const devicesAt = async (ip: string) => ((await admin().from('assets').select('id, name, type, location_id, notes').eq('org_id', org).eq('ip', ip).is('archived_at', null)).data ?? [])

  it('a check saves nothing; the import saves everything or nothing; empty cells keep saved values; clear tokens clear them', async () => {
    const first: Row[] = [
      { line: 2, name: 'Server one', type: 'server', location_code: codeA, ip: '172.31.40.1', tcp_port: 22, notes: 'rack 1' },
      { line: 3, name: 'Attendance', type: 'attendance', location_code: codeB, ip: '172.31.40.2', tcp_port: null, notes: null },
    ]
    const checked = await run(first, false)
    expect(checked.error).toBeNull()
    expect(checked.data).toMatchObject({ created: 2, updated: 0, errors: [], applied: false })
    expect(await devicesAt('172.31.40.1')).toEqual([])
    const applied = await run(first, true)
    expect(applied.data).toMatchObject({ created: 2, updated: 0, errors: [], applied: true })
    const [one] = await devicesAt('172.31.40.1')
    expect(one).toMatchObject({ name: 'Server one', location_id: locA, notes: 'rack 1' })
    // Empty location and notes: kept.
    const again = await run([{ line: 2, name: 'Server one renamed', type: 'server', location_code: null, ip: '172.31.40.1', tcp_port: 22, notes: null }], true)
    expect(again.data).toMatchObject({ created: 0, updated: 1, errors: [] })
    expect((await devicesAt('172.31.40.1'))[0]).toMatchObject({ name: 'Server one renamed', location_id: locA, notes: 'rack 1' })
    // The clear tokens: location and notes emptied on purpose.
    await run([{ line: 2, name: 'Server one renamed', type: 'server', location_code: null, clear_location: true, ip: '172.31.40.1', tcp_port: 22, notes: null, clear_notes: true }], true)
    expect((await devicesAt('172.31.40.1'))[0]).toMatchObject({ location_id: null, notes: null })
    // One bad row: nothing of the file is saved, and no message repeats a cell value.
    const bad = await run([
      { line: 2, name: 'New server', type: 'server', location_code: codeA, ip: '172.31.40.3', tcp_port: null, notes: null },
      { line: 3, name: 'Elsewhere', type: 'server', location_code: 'NOPE-ZZ9', ip: '172.31.40.4', tcp_port: null, notes: null },
    ], true)
    const out = bad.data as Out
    expect(out).toMatchObject({ created: 0, updated: 0, applied: false })
    expect(out.errors).toEqual([{ line: 3, column: 'location_code', message: expect.any(String) }])
    expect(out.errors[0].message).not.toContain('NOPE-ZZ9')
    expect(await devicesAt('172.31.40.3')).toEqual([])
  })

  it('an access point (or any other kind) at the same address is never changed into a device type; an NVR address is refused', async () => {
    const ap = await createAsset(org, { locationId: locA, type: 'access_point', ip: '172.31.41.1', port: null })
    const r = await run([{ line: 2, name: 'Not an AP', type: 'server', location_code: null, ip: '172.31.41.1', tcp_port: null, notes: null }], true)
    const out = r.data as Out
    expect(out.applied).toBe(false)
    expect(out.errors).toEqual([{ line: 2, column: 'ip', message: expect.stringMatching(/Assets/) }])
    const { data } = await admin().from('assets').select('type, name').eq('id', ap).single()
    expect(data).toEqual({ type: 'access_point', name: 'Asset' })
    const nvr = await createRecorder(org, locB, { host: '172.31.41.2', httpPort: 80 })
    const n = await run([{ line: 2, name: 'Not an NVR', type: 'server', location_code: null, ip: '172.31.41.2', tcp_port: 80, notes: null }], true)
    expect((n.data as Out).errors).toEqual([{ line: 2, column: 'ip', message: expect.any(String) }])
    expect((await admin().from('assets').select('name').eq('id', nvr).single()).data?.name).toBe('NVR')
  })

  it('only an administrator with admin.inventory (or a super administrator) imports', async () => {
    const r = await run([{ line: 2, name: 'x', type: 'server', location_code: null, ip: '172.31.42.1', tcp_port: null, notes: null }], true, operator.id)
    expect(r.error?.code).toBe('42501')
  })
})
