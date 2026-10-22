import { createHmac } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Database } from '@/types/database'
import { adminClient, cleanupOrg, createOrg, createSite, createUser, grant, type TestUser } from '../setup/fixtures'
import { localJwtSecret, serviceClient } from '../setup/service-keys'

// P3-1 brief item 1 (D-10, ruling D-10a) in the database, migration 20261021000034:
//   * the MFA switch per organisation (security_settings.mfa_enforced, default off; written by the database owner only; tests use
//     security_settings_set_mfa_test on test organisations), read by mfa_enforced() and by the grant evaluation for every person;
//   * my_session_status(): what the app's gate needs about the caller's own session (switch, privileged, aal2, factor, sign-in times);
//   * auth_events: the durable, append-only sign-in audit (auth_event_record, the web app's role only);
//   * auth_session_end(user, session): ends exactly one sign-in (the password re-check of "Confirm it's you").

const admin = () => adminClient()

/** The person's own access token with some claims replaced, signed with the local stack's JWT secret (PostgREST trusts it). */
async function withClaims(u: TestUser, patch: Record<string, unknown>): Promise<SupabaseClient<Database>> {
  const token = (await u.client.auth.getSession()).data.session!.access_token
  const [, payload] = token.split('.')
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), ...patch }
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = createHmac('sha256', localJwtSecret()).update(`${head}.${body}`).digest('base64url')
  const forged = `${head}.${body}.${sig}`
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${forged}` } },
  })
}

type Status = { mfa_enforced: boolean; privileged: boolean; aal2: boolean; has_factor: boolean; session_id: string | null; signed_in_at: string | null; last_auth_at: string | null }
const status = async (c: SupabaseClient<Database>): Promise<Status> => {
  const { data, error } = await c.rpc('my_session_status' as never)
  if (error) throw new Error(error.message)
  return (Array.isArray(data) ? data[0] : data) as Status
}
const caps = async (c: SupabaseClient<Database>) => {
  const { data, error } = await c.rpc('my_access_summary')
  if (error) throw new Error(error.message)
  return ((data ?? []) as { capability: string }[]).map((r) => r.capability).sort()
}
const setMfa = async (org: string, on: boolean) => {
  const { error } = await admin().rpc('security_settings_set_mfa_test' as never, { p_org: org, p_mfa_enforced: on } as never)
  if (error) throw new Error(error.message)
}

describe('MFA switch, session status and sign-in audit in the database (P3-1)', () => {
  let org: string, other: string
  let owner: TestUser, adminUser: TestUser, viewer: TestUser, itHigh: TestUser, otherAdmin: TestUser
  let camera: string

  beforeAll(async () => {
    org = await createOrg()
    other = await createOrg()
    camera = (await createSite(org, { code: 'MF1', name: 'MF1', host: '192.0.2.31', username: 'v', cameras: 1 })).cameraIds[0]
    owner = await createUser(org, 'platform_owner')
    adminUser = await createUser(org, 'admin')
    await grant(org, adminUser.id, ['admin.users', 'admin.access', 'cctv.live', 'cctv.playback', 'cctv.export'])
    viewer = await createUser(org, 'user')
    await grant(org, viewer.id, ['cctv.live', 'it.inventory.view'])
    itHigh = await createUser(org, 'operator')
    await grant(org, itHigh.id, ['it.remote.view'])
    otherAdmin = await createUser(other, 'admin')
    await grant(other, otherAdmin.id, ['admin.users'])
  })
  afterAll(async () => {
    await cleanupOrg(org)
    await cleanupOrg(other)
  })

  it('the switch is off by default (local development keeps working), per organisation', async () => {
    expect((await adminUser.client.rpc('mfa_enforced')).data).toBe(false)
    expect(await caps(adminUser.client)).toContain('admin.users')
  })

  it('my_session_status: the caller’s own session — sign-in time, last authentication, session id, aal1, no factor', async () => {
    const s = await status(adminUser.client)
    expect(s).toMatchObject({ mfa_enforced: false, privileged: true, aal2: false, has_factor: false })
    expect(s.session_id).toMatch(/^[0-9a-f-]{36}$/)
    const signedIn = Date.parse(s.signed_in_at!)
    expect(Math.abs(Date.now() - signedIn)).toBeLessThan(10 * 60_000)
    expect(Date.parse(s.last_auth_at!)).toBeGreaterThanOrEqual(signedIn)
  })

  it('privileged = administrative role, or any capability that requires MFA (export, admin.*, high-risk IT); plain viewers are not', async () => {
    expect((await status(owner.client)).privileged).toBe(true)
    expect((await status(adminUser.client)).privileged).toBe(true)
    expect((await status(itHigh.client)).privileged).toBe(true) // operator with it.remote.view (high risk)
    expect((await status(viewer.client)).privileged).toBe(false)
  })

  it('switched on: in an aal1 session the MFA capabilities stop counting (admin pages and actions close), the others stay', async () => {
    await setMfa(org, true)
    try {
      expect((await adminUser.client.rpc('mfa_enforced')).data).toBe(true)
      expect((await status(adminUser.client)).mfa_enforced).toBe(true)
      const c = await caps(adminUser.client)
      expect(c).toContain('cctv.live')
      expect(c).not.toContain('admin.users')
      expect(c).not.toContain('cctv.export')
      expect(await caps(viewer.client)).toEqual(['cctv.live', 'it.inventory.view'])
      // Another organisation is not affected.
      expect((await otherAdmin.client.rpc('mfa_enforced')).data).toBe(false)
      expect(await caps(otherAdmin.client)).toContain('admin.users')
    } finally {
      await setMfa(org, false)
    }
  })

  it('switched on: an aal2 session holds them again', async () => {
    await setMfa(org, true)
    try {
      const aal2 = await withClaims(adminUser, { aal: 'aal2' })
      expect((await status(aal2)).aal2).toBe(true)
      expect(await caps(aal2)).toEqual(expect.arrayContaining(['admin.users', 'admin.access', 'cctv.export']))
    } finally {
      await setMfa(org, false)
    }
  })

  it('the server-side check for another person (media sessions) follows the person’s organisation and the session’s level', async () => {
    const ask =(aal2: boolean) => admin().rpc('has_capability_for_user', { p_user: adminUser.id, p_cap: 'cctv.export', p_kind: 'camera', p_id: camera, p_aal2: aal2 })
    expect((await ask(false)).data).toBe(true)
    await setMfa(org, true)
    try {
      expect((await ask(false)).data).toBe(false)
      expect((await ask(true)).data).toBe(true)
    } finally {
      await setMfa(org, false)
    }
  })

  it('fast playback sessions (export, MFA) are made only for an aal2 session while the switch is on; the app passes the level', async () => {
    const { createMediaSessions } = await import('@/lib/streams/registry')
    const media = serviceClient('media_service')
    const make = (aal2: boolean) => createMediaSessions(media, { orgId: org, userId: adminUser.id, kind: 'vod', cameras: [{ id: camera, stream: null }], aal2 })
    expect((await make(false)).size).toBe(1) // switched off: as before
    await setMfa(org, true)
    try {
      expect((await make(false)).size).toBe(0)
      expect((await make(true)).size).toBe(1)
    } finally {
      await setMfa(org, false)
    }
  })

  it('the switch is written only by the database owner (no API role), the test helper only on test organisations', async () => {
    const { data: orgs } = await admin().from('organizations').select('id, slug').not('slug', 'like', 'test-%').limit(1)
    if (orgs?.[0]) {
      const { error } = await admin().rpc('security_settings_set_mfa_test' as never, { p_org: orgs[0].id, p_mfa_enforced: true } as never)
      expect(error).not.toBeNull()
    }
    for (const c of [serviceClient('app_web'), adminUser.client]) {
      const { error } = await c.from('security_settings' as never).update({ mfa_enforced: true } as never).eq('org_id', org)
      expect(error).not.toBeNull()
    }
    expect((await adminUser.client.rpc('security_settings_set_mfa_test' as never, { p_org: org, p_mfa_enforced: true } as never)).error).not.toBeNull()
  })

  it('auth_event_record: the web app’s role writes events; the person and organisation are filled in, no secrets are stored', async () => {
    const web = serviceClient('app_web')
    const ok = await web.rpc('auth_event_record' as never, {
      p_event: 'sign_in', p_user: adminUser.id, p_email: null, p_email_hash: null, p_actor: null, p_ip: '10.0.0.47', p_user_agent: 'test agent', p_detail: { aal: 'aal1' },
    } as never)
    expect(ok.error).toBeNull()
    const failed = await web.rpc('auth_event_record' as never, {
      p_event: 'sign_in_failed', p_user: null, p_email: viewer.email.toUpperCase(), p_email_hash: 'a'.repeat(64), p_actor: null, p_ip: null, p_user_agent: null, p_detail: {},
    } as never)
    expect(failed.error).toBeNull()
    const { data } = await admin().from('auth_events' as never).select('*').eq('org_id', org).order('at')
    const rows = (data ?? []) as Record<string, unknown>[]
    expect(rows.find((r) => r.event === 'sign_in')).toMatchObject({ user_id: adminUser.id, ip: '10.0.0.47', user_agent: 'test agent' })
    // A failed sign-in names the person when the address belongs to one (looked up case-insensitively); only the hash is kept.
    expect(rows.find((r) => r.event === 'sign_in_failed')).toMatchObject({ user_id: viewer.id, email_hash: 'a'.repeat(64) })
    expect(JSON.stringify(rows)).not.toContain(viewer.email)
  })

  it('auth_event_record refuses unknown events and is not callable by signed-in people', async () => {
    const web = serviceClient('app_web')
    expect((await web.rpc('auth_event_record' as never, { p_event: 'password=hunter2', p_user: null, p_email: null, p_email_hash: null, p_actor: null, p_ip: null, p_user_agent: null, p_detail: {} } as never)).error).not.toBeNull()
    expect((await adminUser.client.rpc('auth_event_record' as never, { p_event: 'sign_in', p_user: adminUser.id, p_email: null, p_email_hash: null, p_actor: null, p_ip: null, p_user_agent: null, p_detail: {} } as never)).error).not.toBeNull()
  })

  it('auth_events are append-only (not even the service role changes or deletes them) and readable with admin.audit.read only', async () => {
    const { data } = await admin().from('auth_events' as never).select('id').eq('org_id', org).limit(1)
    const id = ((data ?? []) as { id: string }[])[0]?.id
    expect(id).toBeTruthy()
    expect((await admin().from('auth_events' as never).update({ event: 'sign_out' } as never).eq('id', id)).error).not.toBeNull()
    const del = await admin().from('auth_events' as never).delete().eq('id', id).select('id')
    expect(del.error !== null || ((del.data ?? []) as unknown[]).length === 0).toBe(true)
    expect(((await admin().from('auth_events' as never).select('id').eq('id', id)).data ?? []).length).toBe(1)
    // admin.audit.read: the platform owner holds every capability? Not in this fixture: grant it to the admin.
    expect(((await adminUser.client.from('auth_events' as never).select('id').eq('org_id', org)).data ?? []).length).toBe(0)
    await grant(org, adminUser.id, ['admin.audit.read'])
    expect(((await adminUser.client.from('auth_events' as never).select('id').eq('org_id', org)).data ?? []).length).toBeGreaterThan(0)
    expect(((await adminUser.client.from('auth_events' as never).select('id').eq('org_id', other)).data ?? []).length).toBe(0)
    expect(((await viewer.client.from('auth_events' as never).select('id')).data ?? []).length).toBe(0)
  })

  it('auth_session_end ends exactly one sign-in of that person (the web app’s role only)', async () => {
    const second = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
    expect((await second.auth.signInWithPassword({ email: viewer.email, password: viewer.password })).error).toBeNull()
    const s1 = (await status(viewer.client)).session_id!
    const s2 = (await status(second)).session_id!
    expect(s1).not.toBe(s2)
    // Somebody else's session id does nothing.
    expect((await serviceClient('app_web').rpc('auth_session_end' as never, { p_user: adminUser.id, p_session: s2 } as never)).data).toBe(false)
    expect((await viewer.client.rpc('auth_session_end' as never, { p_user: viewer.id, p_session: s2 } as never)).error).not.toBeNull()
    expect((await serviceClient('app_web').rpc('auth_session_end' as never, { p_user: viewer.id, p_session: s2 } as never)).data).toBe(true)
    expect((await second.auth.refreshSession()).error).not.toBeNull()
    expect((await viewer.client.auth.getUser()).error).toBeNull()
  })

  it('privilege_violations() stays empty', async () => {
    const { data, error } = await admin().rpc('privilege_violations')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
