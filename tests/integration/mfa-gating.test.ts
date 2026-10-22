import { createHmac } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, type TestUser } from '../setup/fixtures'
import { localJwtSecret } from '../setup/service-keys'

// P3-1 brief item 1 with the REAL Server Actions, the real gates and the real database (only the Next request plumbing is replaced, as
// in access-entry-points.test.ts): with the multi-factor switch on, an administrator in an aal1 session is sent to set up / enter a
// code by every admin action and nothing changes; in an aal2 session the actions work; with the switch off they work as before.
// Fresh sign-in (default 10 minutes) is enforced for access changes, user management and credential writes. The aal2 and old-sign-in
// sessions are the person's own token with those claims changed, signed with the local JWT secret (PostgREST trusts it): the real
// authenticator flow is in mfa-totp.test.ts.

const m = vi.hoisted(() => ({ client: null as unknown, userId: '' }))
vi.mock('next/headers', async () => {
  const { signVerifiedUser, VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER } = await import('@/lib/auth/verified-user')
  return {
    headers: async () => {
      const h = new Headers({ 'x-request-path': '/admin/users' })
      const sig = signVerifiedUser(m.userId)
      if (sig && m.userId) {
        h.set(VERIFIED_USER_HEADER, m.userId)
        h.set(VERIFIED_USER_SIG_HEADER, sig)
      }
      return h
    },
    cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => m.client as SupabaseClient<Database> }))

const admin = () => adminClient()
const randomId = () => crypto.randomUUID()
const digest = (e: unknown) => String((e as { digest?: string })?.digest ?? e)
async function outcome(call: () => Promise<unknown>): Promise<{ redirect: string | null; value: unknown }> {
  try {
    return { redirect: null, value: await call() }
  } catch (e) {
    const d = digest(e)
    if (!d.includes('NEXT_REDIRECT')) throw e
    return { redirect: d.split(';')[2] ?? d, value: null }
  }
}

/** The person's own token with claims replaced (aal, amr times), as a client. */
async function as(u: TestUser, patch: { aal?: 'aal1' | 'aal2'; authAgoSec?: number }): Promise<SupabaseClient<Database>> {
  const token = (await u.client.auth.getSession()).data.session!.access_token
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  if (patch.aal) claims.aal = patch.aal
  if (patch.authAgoSec !== undefined) {
    const t = Math.floor(Date.now() / 1000) - patch.authAgoSec
    claims.amr = [{ method: 'password', timestamp: t }, ...(patch.aal === 'aal2' ? [{ method: 'totp', timestamp: t }] : [])]
  }
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = createHmac('sha256', localJwtSecret()).update(`${head}.${body}`).digest('base64url')
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${head}.${body}.${sig}` } },
  })
}
const actAs = (u: TestUser, c: SupabaseClient<Database>) => {
  m.client = c
  m.userId = u.id
}
const setMfa = async (org: string, on: boolean) => {
  const { error } = await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: on })
  if (error) throw new Error(error.message)
}

describe('multi-factor gating and fresh sign-in through the real actions (P3-1)', () => {
  let org: string, store: string
  let owner: TestUser, plainAdmin: TestUser, target: TestUser, viewer: TestUser

  beforeAll(async () => {
    org = await createOrg()
    store = (await createSite(org, { code: 'MG1', name: 'MG1', host: '192.0.2.41', username: 'v' })).locationId
    owner = await createUser(org, 'platform_owner')
    await grant(org, owner.id, ['admin.users', 'admin.access', 'cctv.live'])
    plainAdmin = await createUser(org, 'admin')
    await grant(org, plainAdmin.id, ['admin.users', 'admin.access', 'admin.inventory', 'cctv.live'])
    target = await createUser(org, 'user')
    viewer = await createUser(org, 'user')
    await grant(org, viewer.id, ['cctv.live'])
  })
  afterAll(() => cleanupOrg(org))
  beforeEach(() => setMfa(org, false))

  const change = () => [{ op: 'grant', capability: 'cctv.live', scope_kind: 'location', scope_id: store, valid_until: null, reason: '' }]

  it('switched on: an administrator in an aal1 session is sent to set up an authenticator app by every admin action; nothing changes', async () => {
    await setMfa(org, true)
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 30 }))
    const access = await import('@/lib/actions/admin/access')
    const users = await import('@/lib/actions/admin/users')
    const sessions = await import('@/lib/actions/admin/sessions')
    const calls: (() => Promise<unknown>)[] = [
      () => access.previewAccessAction(target.id, { changes: change(), expectedVersion: 0 }),
      () => access.applyAccessAction(target.id, { changes: change(), expectedVersion: 0, token: 'x' }),
      () => access.keepReviewedAction({ grantIds: [] }),
      () => users.setRoleAction(target.id, 'operator'),
      () => users.resetPasswordAction(target.id),
      () => sessions.signOutEverywhereAction(target.id),
    ]
    for (const call of calls) expect((await outcome(call)).redirect).toBe('/mfa/enrol?next=%2Fadmin%2Fusers')
    expect((await admin().from('access_grants').select('id').eq('user_id', target.id)).data).toEqual([])
    expect((await admin().from('profiles').select('role, must_reset_password').eq('id', target.id).single()).data).toEqual({ role: 'user', must_reset_password: false })
  })

  it('switched on: a viewer is not made to enrol (optional for viewers) and keeps live view', async () => {
    await setMfa(org, true)
    actAs(viewer, await as(viewer, { aal: 'aal1', authAgoSec: 30 }))
    const { requireProfile } = await import('@/lib/auth/profile')
    const p = (await outcome(() => requireProfile())).value as { capabilities: { grants: Record<string, unknown> } }
    expect(Object.keys(p.capabilities.grants)).toEqual(['cctv.live'])
  })

  it('switched on: in an aal2 session the same administrator previews and saves access', async () => {
    await setMfa(org, true)
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal2', authAgoSec: 30 }))
    const access = await import('@/lib/actions/admin/access')
    const p = (await outcome(() => access.previewAccessAction(target.id, { changes: change(), expectedVersion: 0 }))).value as { ok: boolean; version: number; token: string }
    expect(p.ok).toBe(true)
    const r = await outcome(() => access.applyAccessAction(target.id, { changes: change(), expectedVersion: p.version, token: p.token }))
    expect(r.value).toMatchObject({ ok: true, added: 1 })
  })

  it('switched off: the aal1 administrator works as before (the local default)', async () => {
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 30 }))
    const users = await import('@/lib/actions/admin/users')
    expect((await outcome(() => users.reactivationReviewAction(target.id))).value).toMatchObject({ ok: true })
  })

  it('fresh sign-in: 11 minutes after the last sign-in or code, access changes, user changes and credential writes are refused; nothing changes', async () => {
    const stale = await as(plainAdmin, { aal: 'aal1', authAgoSec: 11 * 60 })
    actAs(plainAdmin, stale)
    const access = await import('@/lib/actions/admin/access')
    const users = await import('@/lib/actions/admin/users')
    const sessions = await import('@/lib/actions/admin/sessions')
    const locations = await import('@/lib/actions/admin/locations')
    const { MSG_CONFIRM_FIRST } = await import('@/lib/auth/session-policy')
    // The preview only reads: allowed.
    const version = (await admin().from('profiles').select('access_version').eq('id', viewer.id).single()).data!.access_version
    const p = (await outcome(() => access.previewAccessAction(viewer.id, { changes: change(), expectedVersion: version }))).value as { ok: boolean; version: number; token: string }
    expect(p.ok).toBe(true)
    const refusedOf = (v: unknown) => (v as { error?: string }).error
    expect(refusedOf((await outcome(() => access.applyAccessAction(viewer.id, { changes: change(), expectedVersion: p.version, token: p.token }))).value)).toBe(MSG_CONFIRM_FIRST)
    expect(refusedOf((await outcome(() => access.keepReviewedAction({ grantIds: [] }))).value)).toBe(MSG_CONFIRM_FIRST)
    expect(refusedOf((await outcome(() => users.setRoleAction(viewer.id, 'operator'))).value)).toBe(MSG_CONFIRM_FIRST)
    expect(refusedOf((await outcome(() => users.resetPasswordAction(viewer.id))).value)).toBe(MSG_CONFIRM_FIRST)
    expect(refusedOf((await outcome(() => users.setActiveAction(viewer.id, false))).value)).toBe(MSG_CONFIRM_FIRST)
    const fd = new FormData()
    for (const [k, v] of Object.entries({ email: 'new@example.test', full_name: 'N', role: 'user' })) fd.set(k, v)
    expect(refusedOf((await outcome(() => users.createUserAction({}, fd))).value)).toBe(MSG_CONFIRM_FIRST)
    expect(refusedOf((await outcome(() => sessions.signOutEverywhereAction(viewer.id))).value)).toBe(MSG_CONFIRM_FIRST)
    const nvr = new FormData()
    for (const [k, v] of Object.entries({ name: 'N2', host: '192.0.2.42', http_port: '80', rtsp_port: '554', username: 'v', password: 'a-new-password' })) nvr.set(k, v)
    expect(refusedOf((await outcome(() => locations.saveRecorderAction(store, {}, nvr))).value)).toBe(MSG_CONFIRM_FIRST)
    const imp = new FormData()
    imp.set('file', new File(['name,city\n'], 'x.csv', { type: 'text/csv' }))
    const { applyLocationImportAction } = await import('@/lib/actions/admin/import-locations')
    expect(refusedOf((await outcome(() => applyLocationImportAction(imp))).value)).toBe(MSG_CONFIRM_FIRST)
    // Nothing changed.
    expect((await admin().from('profiles').select('role, is_active, must_reset_password').eq('id', viewer.id).single()).data).toEqual({ role: 'user', is_active: true, must_reset_password: false })
    expect(((await admin().from('access_grants').select('id').eq('user_id', viewer.id).is('revoked_at', null)).data ?? []).length).toBe(1)
    expect(((await admin().from('recorders').select('id').eq('location_id', store)).data ?? []).length).toBe(1)
  })

  it('fresh sign-in: within 10 minutes the same changes go through', async () => {
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 9 * 60 }))
    const users = await import('@/lib/actions/admin/users')
    expect((await outcome(() => users.setRoleAction(viewer.id, 'operator'))).value).toMatchObject({ ok: true })
  })

  // Review I-3 replaces the earlier rule "an NVR saved without a password is not a credential write" (one guard now covers every change):
  // merge, archive and restore, hierarchy moves, the monitoring switch, every NVR save, devices, the device import, set-up and fast
  // playback (an export) are all refused with an old sign-in, and nothing changes.
  it('review I-3: with an old sign-in, merge, archive, restore, moves, monitoring on/off, NVR saves, devices, imports, set-up and fast playback are refused', async () => {
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 30 * 60 }))
    const locations = await import('@/lib/actions/admin/locations')
    const inventory = await import('@/lib/actions/admin/inventory')
    const mfa = await import('@/lib/actions/mfa')
    const { MSG_CONFIRM_FIRST } = await import('@/lib/auth/session-policy')
    const errorOf = (v: unknown) => (v as { error?: string }).error
    const recorder = (await admin().from('recorders').select('id').eq('location_id', store).single()).data!.id
    const nvr = new FormData()
    for (const [k, v] of Object.entries({ name: 'N3', host: '192.0.2.43', http_port: '80', rtsp_port: '554', username: 'v' })) nvr.set(k, v)
    const devices = new FormData()
    devices.set('file', new File(['name,type,ip\nX,server,192.0.2.50\n'], 'd.csv', { type: 'text/csv' }))
    const calls: [string, () => Promise<unknown>][] = [
      ['merge', () => locations.mergeCamerasAction({ keepId: randomId(), duplicateId: randomId(), confirmation: 'x' })],
      ['archive', () => locations.archiveNodeAction('location', store)],
      ['restore', () => locations.restoreNodeAction('location', store)],
      ['move', () => locations.moveNodeAction({ kind: 'location', id: store, to: null })],
      ['monitoring off', () => locations.setMonitoringAction(recorder, { enabled: false, reason: 'test reason' })],
      ['NVR save without a password', () => locations.saveRecorderAction(store, {}, nvr)],
      ['device delete', () => inventory.deleteDeviceAction(randomId())],
      ['device import', () => inventory.importDevicesAction({}, devices)],
      ['archive (inventory)', () => inventory.archiveInventoryAction('location', store)],
    ]
    for (const [what, call] of calls) expect(errorOf((await outcome(call)).value), what).toBe(MSG_CONFIRM_FIRST)
    expect(await outcome(() => mfa.startEnrolmentAction())).toMatchObject({ value: { ok: false, error: MSG_CONFIRM_FIRST } })
    // Fast playback (a downloadable recording, D-10 "exports") through the real route.
    await grant(org, plainAdmin.id, ['cctv.export', 'cctv.playback'])
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 30 * 60 }))
    const { GET } = await import('@/app/api/vod/route')
    const res = await GET(new Request(`http://localhost:3212/api/vod?camera=${randomId()}&start=2026-10-22T09:20:00Z&minutes=1`))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe(MSG_CONFIRM_FIRST)
    expect((await admin().from('locations').select('archived_at').eq('id', store).single()).data?.archived_at).toBeNull()
    expect((await admin().from('recorders').select('monitoring_enabled').eq('id', recorder).single()).data?.monitoring_enabled).toBe(true)
  })

  it('sign out everywhere: the person’s sign-ins end; audited in the admin log and the sign-in audit', async () => {
    const other = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
    expect((await other.auth.signInWithPassword({ email: target.email, password: target.password })).error).toBeNull()
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 30 }))
    const sessions = await import('@/lib/actions/admin/sessions')
    expect((await outcome(() => sessions.signOutEverywhereAction(target.id))).value).toEqual({ ok: true })
    expect((await other.auth.refreshSession()).error).not.toBeNull()
    expect((await admin().from('admin_audit_log').select('action').eq('entity_id', target.id).eq('action', 'user_signed_out_everywhere')).data).toHaveLength(1)
    expect((await admin().from('auth_events').select('event, actor_id').eq('user_id', target.id).eq('event', 'sign_out_everywhere')).data).toEqual([{ event: 'sign_out_everywhere', actor_id: plainAdmin.id }])
  })

  it('factor reset: only a super administrator, with a reason, never for themself; audited first', async () => {
    const sessions = await import('@/lib/actions/admin/sessions')
    const { MSG_OWNER_ONLY, MSG_REASON, MSG_NOT_SELF } = await import('@/lib/admin/sessions')
    actAs(plainAdmin, await as(plainAdmin, { aal: 'aal1', authAgoSec: 30 }))
    expect((await outcome(() => sessions.resetFactorsAction(target.id, 'lost phone'))).value).toEqual({ ok: false, error: MSG_OWNER_ONLY })
    actAs(owner, await as(owner, { aal: 'aal1', authAgoSec: 30 }))
    expect((await outcome(() => sessions.resetFactorsAction(target.id, 'x'))).value).toEqual({ ok: false, error: MSG_REASON })
    expect((await outcome(() => sessions.resetFactorsAction(owner.id, 'my own'))).value).toEqual({ ok: false, error: MSG_NOT_SELF })
    expect((await outcome(() => sessions.resetFactorsAction(target.id, 'lost phone'))).value).toEqual({ ok: true, removed: 0 })
    const log = (await admin().from('admin_audit_log').select('actor_id, detail').eq('entity_id', target.id).eq('action', 'mfa_factor_reset')).data ?? []
    expect(log).toEqual([{ actor_id: owner.id, detail: { reason: 'lost phone', factors: 0, verified: 0 } }])
  })
})
