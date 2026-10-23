// P5.4 brief item 5, the durable audit coverage check: the operations of every required category are performed through the code the
// screens use, against the local database with the processes' own database roles where production uses them (the web app's app_web,
// the service key for GoTrue's user administration), and each expected row is found by its action name in the append-only tables
// (admin_audit_log, auth_events). The list of names is lib/audit/catalogue.ts; tests/unit/audit-catalogue.test.ts checks it against the
// source. Synthetic data only (TEST-NET addresses, made-up passwords, test- organisations); nothing contacts an NVR.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'
import { mfaClient, totpCode, totpEnabled, totpSuiteMode, TOTP_SKIP_REASON } from '../helpers/totp'

const m = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.client as SupabaseClient<Database> }))

const { AUDIT_ACTIONS } = await import('@/lib/audit/catalogue')
const { applyChange, previewChange } = await import('@/lib/admin/access')
const { resetFactors } = await import('@/lib/admin/sessions')
const { auditAccess } = await import('@/lib/auth/access-audit')
const { readSessionStatus } = await import('@/lib/auth/session-status')
const { archiveInventory, restoreInventory } = await import('@/lib/inventory/archive')
const { saveRecorder } = await import('@/lib/inventory/recorder-admin')
const { applyLocationImport, checkLocationImport } = await import('@/lib/import/locations-import')

const admin = () => adminClient()
const web = () => serviceClient('app_web')
const anonClient = () => createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
const fd = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const digest = (e: unknown) => String((e as { digest?: string })?.digest ?? e)
const HEADER = 'code,name,display_name,kind,city,zone,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring'

/** Every action name of the catalogue that was written for this organisation (admin_audit_log) or its people (auth_events). */
async function written(orgId: string): Promise<Set<string>> {
  const a = (await admin().from('admin_audit_log').select('action').eq('org_id', orgId)).data ?? []
  const e = (await admin().from('auth_events').select('event').eq('org_id', orgId)).data ?? []
  return new Set([...a.map((r) => `admin_audit_log:${r.action}`), ...e.map((r) => `auth_events:${r.event}`)])
}
const catalogued = (key: string) => AUDIT_ACTIONS.some((x) => `${x.table}:${x.action}` === key)

const totp = await (async () => {
  const org = await createOrg()
  const probe = await createUser(org, 'user')
  const enabled = await totpEnabled(await mfaClient(probe.email, probe.password))
  await cleanupOrg(org)
  const mode = totpSuiteMode(process.env, enabled)
  if (mode === 'skip') console.warn(`audit coverage: the two-step events are not exercised. ${TOTP_SKIP_REASON}`)
  return { mode }
})()

describe('durable audit coverage (P5.4)', () => {
  let org: string
  let owner: TestUser
  let adminUser: TestUser
  let viewer: TestUser
  let loc: string
  let rec: string
  let camKeep: string
  let camDup: string
  const ownerActor = () => ({ id: owner.id, orgId: org, role: 'platform_owner' as const })
  const inv = () => ({ admin: web(), rls: adminUser.client })
  const invActor = () => ({ id: adminUser.id, orgId: org, role: 'admin' as const })
  const expected = new Set<string>()

  beforeAll(async () => {
    org = await createOrg()
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users', 'admin.access', 'admin.inventory', 'admin.audit.read'])
    adminUser = await createUser(org, 'admin')
    await grant(org, adminUser.id, ['admin.inventory', 'cctv.live'])
    viewer = await createUser(org, 'user')
    loc = await createLocation(org, { code: 'AUD1' })
    rec = await createRecorder(org, loc, { host: '192.0.2.61' })
    camDup = await createCamera(org, { locationId: loc, recorderId: rec, channel: 1 })
    camKeep = await createCamera(org, { locationId: loc, recorderId: null, channel: 2, name: 'Keep me' })
  })
  afterAll(() => cleanupOrg(org))

  it('grants and revocations: the access editor writes access_granted and access_revoked', async () => {
    const version = Number((await admin().from('profiles').select('access_version').eq('id', viewer.id).single()).data!.access_version)
    const changes = [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: loc, valid_until: null, reason: 'audit coverage' }]
    const p = await previewChange(web(), ownerActor(), viewer.id, { changes, expectedVersion: version })
    if (!p.ok) throw new Error(p.error)
    const g = await applyChange(web(), ownerActor(), viewer.id, { changes, expectedVersion: p.version, token: p.token })
    if (!g.ok) throw new Error(g.error)
    const grantId = (await admin().from('access_grants').select('id').eq('user_id', viewer.id).eq('scope_id', loc).is('revoked_at', null).single()).data!.id
    const revoke = [{ op: 'revoke', grant_id: grantId, reason: 'audit coverage done' }]
    const p2 = await previewChange(web(), ownerActor(), viewer.id, { changes: revoke, expectedVersion: g.version })
    if (!p2.ok) throw new Error(p2.error)
    const r = await applyChange(web(), ownerActor(), viewer.id, { changes: revoke, expectedVersion: p2.version, token: p2.token })
    if (!r.ok) throw new Error(r.error)
    expected.add('admin_audit_log:access_granted').add('admin_audit_log:access_revoked')
    const w = await written(org)
    expect(w.has('admin_audit_log:access_granted')).toBe(true)
    expect(w.has('admin_audit_log:access_revoked')).toBe(true)
  })

  it('sign-ins and failures: the real sign-in and sign-out actions write sign_in_failed, sign_in and sign_out', async () => {
    const { signIn, signOut } = await import('@/lib/actions/auth')
    m.client = anonClient()
    expect(await signIn({}, fd({ email: viewer.email, password: 'not-the-password-1A!' }))).toEqual({ error: 'Wrong e-mail or password.' })
    m.client = anonClient()
    let redirected = ''
    try {
      await signIn({}, fd({ email: viewer.email, password: viewer.password, next: '/home' }))
    } catch (e) {
      redirected = digest(e)
    }
    expect(redirected).toContain('/home')
    try {
      await signOut()
    } catch (e) {
      expect(digest(e)).toContain('/login')
    }
    for (const k of ['auth_events:sign_in_failed', 'auth_events:sign_in', 'auth_events:sign_out']) expected.add(k)
    const w = await written(org)
    for (const k of ['auth_events:sign_in_failed', 'auth_events:sign_in', 'auth_events:sign_out']) expect(w.has(k), k).toBe(true)
  })

  it.skipIf(totp.mode === 'skip')('two-step events: set-up, a wrong code, the sign-in code and removal write mfa_enrolled, mfa_failed, mfa_verified, mfa_removed', async () => {
    if (totp.mode === 'fail') throw new Error(TOTP_SKIP_REASON)
    const { confirmEnrolment, removeOwnFactor, startEnrolment, verifySignInCode } = await import('@/lib/auth/mfa')
    const person = await createUser(org, 'user')
    const c = await mfaClient(person.email, person.password)
    const me = async (client: SupabaseClient<Database>) => ({ id: person.id, email: person.email, session: await readSessionStatus(client) })
    const s = await startEnrolment(c, await me(c))
    if (!s.ok) throw new Error(s.error)
    const right = totpCode(s.secret)
    const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, '0')
    expect((await confirmEnrolment(c, await me(c), s.factorId, wrong)).ok).toBe(false)
    expect(await confirmEnrolment(c, await me(c), s.factorId, right)).toEqual({ ok: true })
    // A new sign-in owes the code of the NEXT window (a code counts once per person).
    const wait = 30_000 - (Date.now() % 30_000) + 300
    await new Promise((r) => setTimeout(r, wait))
    const c2 = await mfaClient(person.email, person.password)
    expect(await verifySignInCode(c2, await me(c2), totpCode(s.secret))).toEqual({ ok: true })
    expect(await removeOwnFactor(c2, await me(c2))).toEqual({ ok: true })
    for (const k of ['auth_events:mfa_failed', 'auth_events:mfa_enrolled', 'auth_events:mfa_verified', 'auth_events:mfa_removed']) expected.add(k)
    const w = await written(org)
    for (const k of ['auth_events:mfa_failed', 'auth_events:mfa_enrolled', 'auth_events:mfa_verified', 'auth_events:mfa_removed']) expect(w.has(k), k).toBe(true)
  }, 90_000)

  it('two-step reset by a super administrator: admin_audit_log mfa_factor_reset AND auth_events mfa_factor_reset', async () => {
    const r = await resetFactors(admin(), ownerActor(), viewer.id, 'Lost phone (audit coverage)')
    expect(r).toEqual({ ok: true, removed: 0 })
    expected.add('admin_audit_log:mfa_factor_reset').add('auth_events:mfa_factor_reset')
    const w = await written(org)
    expect(w.has('admin_audit_log:mfa_factor_reset')).toBe(true)
    expect(w.has('auth_events:mfa_factor_reset')).toBe(true)
  })

  it('video opened: the access audit writes cctv_live_opened and cctv_playback_opened with the web app role', async () => {
    await auditAccess(web(), { orgId: org, actorId: adminUser.id, action: 'cctv_live_opened', capability: 'cctv.live', cameraIds: [camDup], detail: { kind: 'sub' } })
    await auditAccess(web(), { orgId: org, actorId: adminUser.id, action: 'cctv_playback_opened', capability: 'cctv.playback', cameraIds: [camDup], detail: { minutes: 5 } })
    expected.add('admin_audit_log:cctv_live_opened').add('admin_audit_log:cctv_playback_opened')
    const rows = (await admin().from('admin_audit_log').select('action, entity_type, entity_id, detail').eq('org_id', org).in('action', ['cctv_live_opened', 'cctv_playback_opened'])).data ?? []
    expect(rows.map((r) => r.action).sort()).toEqual(['cctv_live_opened', 'cctv_playback_opened'])
    expect(rows.every((r) => r.entity_type === 'camera' && r.entity_id === camDup)).toBe(true)
  })

  it('NVR password saved: recorder_password_set, and never the password itself', async () => {
    const r = await saveRecorder(inv(), invActor(), loc, { name: 'Upper floor', host: '192.0.2.62', httpPort: 80, rtspPort: 554, username: 'viewer', password: 'Pw-audit-coverage-1', expectedChannels: 0, clockOffsetSec: null })
    if (!r.ok) throw new Error(r.error)
    expected.add('admin_audit_log:recorder_password_set')
    const rows = (await admin().from('admin_audit_log').select('action, detail').eq('org_id', org).eq('action', 'recorder_password_set')).data ?? []
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(rows)).not.toContain('Pw-audit-coverage-1')
  })

  it('import: locations_imported (and the locations and NVR password it made)', async () => {
    const csv = `${HEADER}\nAUD2,,,,Patna,BR,,,192.0.2.63,,,viewer,Pw-audit-import,2,,\n`
    const check = await checkLocationImport(inv(), invActor(), csv, { skipBadRows: false })
    if (!check.ok) throw new Error(check.error)
    const r = await applyLocationImport(inv(), invActor(), csv, { skipBadRows: false, archive: false, fingerprint: check.preview.fingerprint })
    if (!r.ok) throw new Error(r.error)
    expected.add('admin_audit_log:locations_imported').add('admin_audit_log:location_created')
    const w = await written(org)
    expect(w.has('admin_audit_log:locations_imported')).toBe(true)
    expect(w.has('admin_audit_log:location_created')).toBe(true)
    const all = JSON.stringify((await admin().from('admin_audit_log').select('detail').eq('org_id', org)).data)
    expect(all).not.toContain('Pw-audit-import')
  })

  it('archive and restore: inventory_archived and inventory_restored', async () => {
    const extra = await createCamera(org, { locationId: loc, recorderId: rec, channel: 3 })
    expect(await archiveInventory(inv(), invActor(), 'camera', extra)).toEqual({ ok: true })
    expect(await restoreInventory(inv(), invActor(), 'camera', extra)).toEqual({ ok: true })
    expected.add('admin_audit_log:inventory_archived').add('admin_audit_log:inventory_restored')
    const w = await written(org)
    expect(w.has('admin_audit_log:inventory_archived')).toBe(true)
    expect(w.has('admin_audit_log:inventory_restored')).toBe(true)
  })

  it('merge: camera_merged', async () => {
    const r = await web().rpc('camera_merge', { p_org: org, p_keep: camKeep, p_duplicate: camDup, p_actor: adminUser.id })
    expect(r.error).toBeNull()
    expected.add('admin_audit_log:camera_merged')
    expect((await written(org)).has('admin_audit_log:camera_merged')).toBe(true)
  })

  it('every expected name is in the catalogue, and the rows written cannot be changed or removed afterwards', async () => {
    expect(expected.size).toBeGreaterThanOrEqual(totp.mode === 'skip' ? 14 : 18)
    for (const k of expected) expect(catalogued(k), k).toBe(true)
    const one = (await admin().from('admin_audit_log').select('id').eq('org_id', org).eq('action', 'access_granted').limit(1).single()).data!
    expect((await admin().from('admin_audit_log').update({ action: 'x' }).eq('id', one.id).select('id')).error?.code).toBe('42501')
    expect((await web().from('admin_audit_log').delete().eq('id', one.id).select('id')).error?.code).toBe('42501')
    const ev = (await admin().from('auth_events').select('id').eq('org_id', org).eq('event', 'sign_in').limit(1).single()).data!
    expect((await admin().from('auth_events').update({ event: 'sign_out' }).eq('id', ev.id).select('id')).error?.code).toBe('42501')
    expect((await admin().from('auth_events').delete().eq('id', ev.id).select('id')).error?.code).toBe('42501')
  })
})
