import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/types/database'
import {
  adminClient, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRegion, createUser, grant, type TestUser,
} from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'
import { MSG_PLAN_CHANGED, prepareImport, runImportPlan } from '@/lib/import/locations-import'

// Release 1 final clean-up (the database items of .superpowers/sdd/drishti/release1-cleanups.md "From the final-fix-Y review"; migration
// 20261021000051). Every test works on its own test organisations (the ledger removes them); owner-side SQL runs in a transaction that is
// rolled back, or on the tests' own rows.
//   Y-R1   the service key cannot switch two-step sign-in (no person named): only the database owner, or a super administrator through
//          the web app.
//   Y-R3   break-glass for a code step locked for good when nobody else can clear it: mfa_code_lock_owner_clear, the database owner only,
//          with a reason, audited.
//   Y-R4   the web role writes no archive state and no organisation on the inventory tables (column grants), and a direct write by any
//          API role cannot archive, restore, move an item to another organisation or put a live item under an archived parent (trigger).
//   Y-R9   security_mfa_overview names each organisation by its slug (the start-up refusal prints it).
//   Y-R10  privilege_violations() also flags whole-table writes of the web role on the inventory tables and the break-glass function
//          given to an API role.
//   Y-R11  access_check_password_reset takes the organisation's access lock.
//   C M-29 an NVR and its password are saved in one transaction (recorder_save_login); a new password changes the saved-login version.
//   C M-30 one location import per organisation at a time, and an import refused when the inventory changed since its check.

const admin = () => adminClient()
const web = () => serviceClient('app_web')
type Any = SupabaseClient<Database>
type RpcResult = { data: unknown; error: { code?: string; message: string; details?: string } | null }
const call = (c: Any, fn: string, args: Record<string, unknown>) => (c.rpc as unknown as (f: string, a: unknown) => Promise<RpcResult>)(fn, args)
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

describe('final clean-up: two-step sign-in and its break-glass belong to the database owner (Y-R1, Y-R3, Y-R9)', () => {
  let org: string
  let owner: TestUser, person: TestUser
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    person = await createUser(org, 'platform_owner')
  })
  afterAll(() => cleanupOrg(org))

  it('Y-R1: the service key and the web app cannot switch it without a person; the database owner can (audited with no person)', async () => {
    for (const enforced of [true, false]) {
      const reason = enforced ? null : 'Service key trying to switch it off for good'
      expect((await call(admin(), 'security_set_mfa', { p_org: org, p_actor: null, p_enforced: enforced, p_reason: reason })).error?.code, `service key ${enforced}`).toBe('42501')
      expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: null, p_enforced: enforced, p_reason: reason })).error?.code, `web ${enforced}`).toBe('42501')
    }
    // The super administrator through the web app still works.
    expect((await call(web(), 'security_set_mfa', { p_org: org, p_actor: owner.id, p_enforced: true, p_reason: null })).error).toBeNull()
    // The database owner (psql) with a reason: allowed, audited with no person and the database user.
    const r = await psql(`BEGIN;
      SELECT public.security_set_mfa('${org}'::uuid, NULL, false, 'Owner opt-out written from psql for the test');
      SELECT 'audit', actor_id IS NULL, detail->>'db_user' FROM public.admin_audit_log WHERE org_id = '${org}'::uuid AND action = 'mfa_enforced_changed' ORDER BY created_at DESC LIMIT 1;
      ROLLBACK;`)
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('audit|t|postgres')
  })

  it('Y-R9: the overview names each organisation by its slug', async () => {
    const r = await call(web(), 'security_mfa_overview', {})
    expect(r.error).toBeNull()
    const row = (r.data as { org_id: string; slug: string }[]).find((o) => o.org_id === org)
    expect(row?.slug).toMatch(/^test-/)
  })

  it('Y-R3: only the database owner clears a code step locked for good, with a reason; audited in both logs', async () => {
    const u = person.id
    expect((await call(web(), 'mfa_code_attempt_begin', { p_user: u })).error).toBeNull()
    expect((await call(web(), 'mfa_code_attempt_end', { p_user: u, p_outcome: 'wrong' })).error).toBeNull()
    expect((await psql(`UPDATE public.mfa_code_failures SET failures = 100, lockouts = 9, locked_for_good = true, locked_until = NULL WHERE user_id = '${u}'::uuid;`)).code).toBe(0)
    const args = { p_org: org, p_user: u, p_reason: 'Only super administrator locked out; ticket 42' }
    expect((await call(web(), 'mfa_code_lock_owner_clear', args)).error).not.toBeNull()
    expect((await call(admin(), 'mfa_code_lock_owner_clear', args)).error).not.toBeNull()
    expect((await call(owner.client, 'mfa_code_lock_owner_clear', args)).error).not.toBeNull()
    for (const role of ['media_service', 'monitor_worker', 'video_gateway'] as const) {
      expect((await call(serviceClient(role), 'mfa_code_lock_owner_clear', args)).error, role).not.toBeNull()
    }
    const short = await psql(`SELECT public.mfa_code_lock_owner_clear('${org}'::uuid, '${u}'::uuid, 'short');`)
    expect(short.code).not.toBe(0)
    const stranger = await psql(`SELECT public.mfa_code_lock_owner_clear('${org}'::uuid, '${randomUUID()}'::uuid, 'Unknown person for the test');`)
    expect(stranger.code).not.toBe(0)
    const ok = await psql(`SELECT public.mfa_code_lock_owner_clear('${org}'::uuid, '${u}'::uuid, 'Only super administrator locked out; ticket 42');
      SELECT 'state', failures, locked_for_good FROM public.mfa_code_failures WHERE user_id = '${u}'::uuid;`)
    expect(ok.code, ok.err).toBe(0)
    expect(ok.out).toContain('state|0|f')
    const { data: events } = await admin().from('auth_events').select('event, actor_id, detail').eq('user_id', u).eq('event', 'mfa_lock_cleared')
    expect(events).toHaveLength(1)
    expect(events![0]).toMatchObject({ actor_id: null, detail: { path: 'database_owner' } })
    const { data: audit } = await admin().from('admin_audit_log').select('actor_id, detail').eq('org_id', org).eq('action', 'mfa_code_lock_cleared').eq('entity_id', u)
    expect(audit).toHaveLength(1)
    expect(audit![0]).toMatchObject({ actor_id: null, detail: { reason: 'Only super administrator locked out; ticket 42', path: 'database_owner', locked_for_good: true } })
  })
})

describe('final clean-up: inventory tables are written through the audited functions only (Y-R4, archive guard)', () => {
  let org: string
  let otherOrg: string
  let owner: TestUser
  beforeAll(async () => {
    org = await createOrg()
    otherOrg = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.inventory'])
  })
  afterAll(async () => {
    await cleanupOrg(org)
    await cleanupOrg(otherOrg)
  })

  it('the web role cannot write archive state or the organisation of a region, cluster, location, camera or asset', async () => {
    const region = await createRegion(org)
    const cluster = await createCluster(org, region)
    const location = await createLocation(org, { clusterId: cluster })
    const camera = await createCamera(org, { locationId: location, channel: 1 })
    const asset = (await admin().from('assets').insert({ org_id: org, location_id: location, type: 'server', name: 'Box', ip: '172.30.51.1' }).select('id').single()).data!.id
    const rows: [string, string][] = [['regions', region], ['clusters', cluster], ['locations', location], ['cameras', camera], ['assets', asset]]
    const now = new Date().toISOString()
    for (const [table, id] of rows) {
      for (const change of [{ archived_at: now }, { org_id: otherOrg }]) {
        const r = await web().from(table as 'regions').update(change as never).eq('id', id)
        expect(r.error?.code, `${table} ${Object.keys(change)[0]}`).toBe('42501')
      }
    }
    expect((await web().from('locations').insert({ org_id: org, code: `ARC${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Born archived', archived_at: now } as never)).error?.code).toBe('42501')
    // What the web app writes still works.
    expect((await web().from('locations').update({ name: 'Renamed by the web app' }).eq('id', location)).error).toBeNull()
    expect((await web().from('regions').update({ name: 'Renamed region' }).eq('id', region)).error).toBeNull()
    const made = await web().from('locations').insert({ org_id: org, code: `WEB${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Made by the web app', kind: 'store', cluster_id: cluster }).select('id').single()
    expect(made.error).toBeNull()
  })

  it('a direct write by the service key cannot archive, restore or move an item to another organisation (only the functions can)', async () => {
    const location = await createLocation(org)
    const camera = await createCamera(org, { locationId: location, channel: 2 })
    const now = new Date().toISOString()
    expect((await admin().from('locations').update({ archived_at: now }).eq('id', location)).error?.code).toBe('42501')
    expect((await admin().from('cameras').update({ org_id: otherOrg } as never).eq('id', camera)).error?.code).toBe('42501')
    expect((await admin().from('regions').insert({ org_id: org, code: `RA${randomUUID().slice(0, 4).toUpperCase()}`, name: 'x', archived_at: now } as never)).error?.code).toBe('42501')
    // Through the audited function: archived, then restored.
    expect((await call(web(), 'inventory_archive', { p_org: org, p_kind: 'camera', p_id: camera, p_actor: owner.id })).error).toBeNull()
    expect((await admin().from('cameras').update({ archived_at: null }).eq('id', camera)).error?.code).toBe('42501')
    expect((await call(web(), 'inventory_restore', { p_org: org, p_kind: 'camera', p_id: camera, p_actor: owner.id })).error).toBeNull()
  })

  it('nothing live goes under an archived parent by a direct write (DR040), whoever writes', async () => {
    const region = await createRegion(org)
    const liveRegion = await createRegion(org)
    const cluster = await createCluster(org, null)
    const location = await createLocation(org)
    const spare = await createLocation(org)
    expect((await call(web(), 'inventory_archive', { p_org: org, p_kind: 'region', p_id: region, p_actor: owner.id })).error).toBeNull()
    expect((await call(web(), 'inventory_archive', { p_org: org, p_kind: 'location', p_id: location, p_actor: owner.id })).error).toBeNull()
    expect((await admin().from('clusters').insert({ org_id: org, region_id: region, code: `CA${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Under archived' })).error?.code).toBe('DR040')
    expect((await admin().from('clusters').update({ region_id: region }).eq('id', cluster)).error?.code).toBe('DR040')
    expect((await admin().from('clusters').update({ region_id: liveRegion }).eq('id', cluster)).error).toBeNull()
    expect((await admin().from('cameras').insert({ org_id: org, location_id: location, channel: 3, name: 'At archived' })).error?.code).toBe('DR040')
    expect((await web().from('assets').insert({ org_id: org, location_id: location, type: 'server', name: 'At archived', ip: '172.30.51.9' })).error?.code).toBe('DR040')
    expect((await web().from('assets').insert({ org_id: org, location_id: spare, type: 'server', name: 'At a live one', ip: '172.30.51.10' })).error).toBeNull()
    const archivedCluster = await createCluster(org, null)
    expect((await call(web(), 'inventory_archive', { p_org: org, p_kind: 'cluster', p_id: archivedCluster, p_actor: owner.id })).error).toBeNull()
    expect((await web().from('locations').insert({ org_id: org, code: `LA${randomUUID().slice(0, 4).toUpperCase()}`, name: 'x', kind: 'store', cluster_id: archivedCluster })).error?.code).toBe('DR040')
  })

  it('Y-R10: privilege_violations() flags a whole-table write of the web role on an inventory table and the break-glass given to an API role', async () => {
    const clean = await psql('SELECT count(*) FROM public.privilege_violations();')
    expect(clean.out.trim()).toBe('0')
    const r = await psql(`BEGIN;
      GRANT UPDATE ON public.locations TO app_web;
      GRANT EXECUTE ON FUNCTION public.mfa_code_lock_owner_clear(uuid, uuid, text) TO service_role;
      SELECT v FROM public.privilege_violations() v;
      ROLLBACK;`)
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/locations: app_web may UPDATE/)
    expect(r.out).toMatch(/mfa_code_lock_owner_clear: service_role may execute/)
  })
})

describe('final clean-up: password resets wait for the organisation\'s access lock (Y-R11)', () => {
  let org: string
  let owner: TestUser, target: TestUser
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users'])
    target = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  it('a reset check while an access change of the organisation holds the lock waits for it', async () => {
    const holder = psql(`BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('drishti.access_admin:' || '${org}', 0)); SELECT pg_sleep(2); COMMIT;`)
    await sleep(600)
    const waited = await psql(`SET lock_timeout = '300ms'; SELECT public.access_check_password_reset('${org}'::uuid, '${owner.id}'::uuid, '${target.id}'::uuid);`)
    expect(waited.code).not.toBe(0)
    expect(waited.err).toMatch(/lock timeout/)
    expect((await holder).code).toBe(0)
    expect((await call(web(), 'access_check_password_reset', { p_org: org, p_actor: owner.id, p_user: target.id })).error).toBeNull()
  })
})

describe('final clean-up: an NVR and its password in one transaction (C M-29)', () => {
  let org: string
  let owner: TestUser, operator: TestUser
  let loc: string
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.inventory'])
    operator = await createUser(org, 'operator')
    loc = await createLocation(org)
  })
  afterAll(() => cleanupOrg(org))

  const save = (o: { recorder?: string | null; host: string; port?: number; secret: string | null; actor?: string; offset?: number | null }) =>
    call(web(), 'recorder_save_login', {
      p_org: org, p_location: loc, p_recorder: o.recorder ?? null, p_host: o.host, p_http_port: o.port ?? 80, p_rtsp_port: 554, p_username: 'viewer',
      p_expected_channels: 0, p_name: 'Ground floor', p_actor: o.actor ?? owner.id, p_secret: o.secret, p_clock_offset_sec: o.offset ?? null,
    })
  const version = async (rec: string) => (await psql(`SELECT public.nvr_login_version('${rec}'::uuid);`)).out.trim()
  const atHost = async (host: string) => ((await admin().from('assets').select('id').eq('org_id', org).eq('ip', host)).data ?? []).length

  it('a new NVR whose password cannot be saved leaves nothing behind; one with a password is saved with it, its clock offset too', async () => {
    const bad = await save({ host: '10.151.0.1', secret: '   ' })
    expect(bad.error?.code).toBe('22023')
    expect(await atHost('10.151.0.1')).toBe(0)
    expect((await save({ host: '10.151.0.2', secret: null })).error?.code).toBe('22023') // a new NVR needs its password
    const ok = await save({ host: '10.151.0.3', secret: 'Pw-one-151', offset: 120 })
    expect(ok.error).toBeNull()
    const rec = ok.data as string
    const { data } = await admin().from('recorders').select('secret_id, clock_offset_sec, clock_offset_source').eq('id', rec).single()
    expect(data).toMatchObject({ clock_offset_sec: 120, clock_offset_source: 'manual' })
    expect(data?.secret_id).not.toBeNull()
    const audit = ((await admin().from('admin_audit_log').select('action').eq('org_id', org).eq('entity_id', rec)).data ?? []).map((a) => a.action).sort()
    expect(audit).toEqual(['recorder_created', 'recorder_password_set'])
    expect((await save({ host: '10.151.0.4', secret: 'Pw-x-151', actor: operator.id })).error?.code).toBe('42501')
  })

  it('a new address needs the password again; a new password changes the saved-login version; the same details keep it', async () => {
    const rec = (await save({ host: '10.151.1.1', secret: 'Pw-two-151' })).data as string
    const v1 = await version(rec)
    expect(v1).toMatch(/^[0-9a-f]{32}$/)
    expect((await save({ recorder: rec, host: '10.151.1.2', secret: null })).error?.code).toBe('DR011')
    expect((await admin().from('assets').select('ip').eq('id', rec).single()).data?.ip).toBe('10.151.1.1')
    expect((await save({ recorder: rec, host: '10.151.1.1', secret: null })).error).toBeNull()
    expect(await version(rec)).toBe(v1)
    expect((await save({ recorder: rec, host: '10.151.1.1', secret: 'Pw-three-151' })).error).toBeNull()
    const v2 = await version(rec)
    expect(v2).not.toBe(v1)
    expect((await save({ recorder: rec, host: '10.151.1.2', secret: 'Pw-four-151' })).error).toBeNull()
    expect((await admin().from('assets').select('ip').eq('id', rec).single()).data?.ip).toBe('10.151.1.2')
    expect(await version(rec)).not.toBe(v2)
  })
})

describe('final clean-up: one location import per organisation at a time, against the inventory it was checked with (C M-30)', () => {
  let org: string
  let owner: TestUser
  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.inventory'])
  })
  afterAll(() => cleanupOrg(org))

  const stamp = async () => {
    const r = await call(web(), 'inventory_import_stamp', { p_org: org })
    expect(r.error).toBeNull()
    return r.data as string
  }
  const plan = (code: string) => ({ regions: [], clusters: [], archive: [], locations: [{ line: 2, action: 'create', id: null, code, fields: { name: code, kind: 'store' }, cluster: null, join_cluster: null, recorders: [] }] })
  const byCode = async (code: string) => ((await admin().from('locations').select('id').eq('org_id', org).eq('code', code)).data ?? []).length

  it('the web app runs an import only with the stamp of its check; a changed inventory refuses it (DR051); the old function is the service key\'s', async () => {
    const s1 = await stamp()
    expect(typeof s1).toBe('string')
    expect(await stamp()).toBe(s1)
    await createLocation(org)
    const s2 = await stamp()
    expect(s2).not.toBe(s1)
    const stale = await call(web(), 'inventory_import_run', { p_org: org, p_actor: owner.id, p_plan: plan('IMPA1'), p_stamp: s1 })
    expect(stale.error?.code).toBe('DR051')
    expect(await byCode('IMPA1')).toBe(0)
    const ok = await call(web(), 'inventory_import_run', { p_org: org, p_actor: owner.id, p_plan: plan('IMPA1'), p_stamp: s2 })
    expect(ok.error).toBeNull()
    expect(await byCode('IMPA1')).toBe(1)
    expect((await call(web(), 'inventory_import_apply', { p_org: org, p_actor: owner.id, p_plan: plan('IMPA2') })).error?.code).toBe('42501')
  })

  it('the web app\'s import (prepareImport + runImportPlan) says "something changed" when the inventory changed after its check', async () => {
    const actor = { id: owner.id, orgId: org, role: 'platform_owner' as const }
    const { apply, stamp: s } = await prepareImport(web(), actor, 'code,name,kind\nIMPC1,IMPC1,store\n', { skipBadRows: false })
    await createLocation(org)
    const r = await runImportPlan({ admin: web() }, actor, apply, [], s)
    expect(r).toEqual({ ok: false, error: `Nothing was imported. ${MSG_PLAN_CHANGED}` })
    expect(await byCode('IMPC1')).toBe(0)
  })

  it('a second import waits for the first and is then refused because the first changed the inventory', async () => {
    const s = await stamp()
    const first = psql(`BEGIN;
      SELECT public.inventory_import_run('${org}'::uuid, '${owner.id}'::uuid, '${JSON.stringify(plan('IMPB1'))}'::jsonb, '${s}');
      SELECT pg_sleep(2);
      COMMIT;`)
    await sleep(700)
    const started = Date.now()
    const second = await call(web(), 'inventory_import_run', { p_org: org, p_actor: owner.id, p_plan: plan('IMPB2'), p_stamp: s })
    expect(Date.now() - started).toBeGreaterThan(800) // it waited for the first
    expect(second.error?.code).toBe('DR051')
    expect((await first).code).toBe(0)
    expect(await byCode('IMPB1')).toBe(1)
    expect(await byCode('IMPB2')).toBe(0)
  })
})
