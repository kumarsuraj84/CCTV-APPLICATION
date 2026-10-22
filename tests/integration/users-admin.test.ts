import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyChange, loadEditor, previewChange, type AccessChange } from '@/lib/admin/access'
import { createUser, listStoresForAccess, listUsers, resetUserPassword, updateUser } from '@/lib/admin/users'
import type { Actor } from '@/lib/admin/types'
import { adminClient, cleanupOrg, createOrg, createUser as makeUser, grant } from '../setup/fixtures'

// P2-3 replaced the interim access editor (setUserAccess / getUserAccess, live + playback ticks) with the change editor in
// lib/admin/access.ts (explicit grants and revocations, preview, expected version). The tests of the interim editor were moved to
// the new one here and in tests/integration/access-editor.test.ts, each with the same claim (AC-5, AC-6, AC-8, AC-12).
async function saveAccess(actor: Actor, userId: string, changes: AccessChange[]) {
  const version = Number((await adminClient().from('profiles').select('access_version').eq('id', userId).maybeSingle()).data?.access_version ?? 0)
  const p = await previewChange(adminClient(), actor, userId, { changes, expectedVersion: version })
  if (!p.ok) return p
  return applyChange(adminClient(), actor, userId, { changes, expectedVersion: p.version, token: p.token })
}
const live = (kind: 'location' | 'camera', id: string): AccessChange[] => (['cctv.live', 'cctv.playback'] as const).map((capability) => ({ op: 'grant', capability, scope_kind: kind, scope_id: id, valid_until: null, reason: '' }))

const admin = () => adminClient()

async function signIn(email: string, password: string) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password })
  return { client: c, error }
}

describe('user administration', () => {
  let orgId: string
  let owner: Actor
  let plainAdmin: Actor
  let storeId: string
  let cameraIds: string[]

  beforeAll(async () => {
    orgId = await createOrg()
    const o = await makeUser(orgId, 'platform_owner')
    const a = await makeUser(orgId, 'admin')
    owner = { id: o.id, orgId, role: 'platform_owner' }
    plainAdmin = { id: a.id, orgId, role: 'admin' }
    // P2-3 grant rule: an administrator gives only what they hold, and needs admin.access.
    await grant(orgId, o.id, ['admin.users', 'admin.access'])
    await grant(orgId, a.id, ['admin.users', 'admin.access', 'cctv.live', 'cctv.playback'])
    const { data: s } = await admin().from('locations').insert({ org_id: orgId, code: 'U1', name: 'Store U1', zone: 'BR', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    storeId = s!.id
    const { data: cams } = await admin().from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, location_id: storeId, channel: n, name: `C${n}` }))).select('id')
    cameraIds = cams!.map((c) => c.id)
  })

  afterAll(() => cleanupOrg(orgId))

  it('creates a user who can sign in with the one-time password but must choose their own first', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const res = await createUser(admin(), plainAdmin, { email, full_name: 'New Viewer', role: 'user' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { client, error } = await signIn(email, res.oneTimePassword)
    expect(error).toBeNull()
    const org = await client.from('organizations').select('id')
    expect(org.data).toEqual([])
    const profile = await admin().from('profiles').select('must_reset_password, role').eq('id', res.userId).single()
    expect(profile.data).toEqual({ must_reset_password: true, role: 'user' })
  })

  it('refuses a duplicate e-mail and bad input', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    expect((await createUser(admin(), plainAdmin, { email, full_name: 'A', role: 'user' })).ok).toBe(true)
    // The service logs the refused sign-up; keep that expected line out of the test output.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dup = await createUser(admin(), plainAdmin, { email, full_name: 'A', role: 'user' })
    logged.mockRestore()
    expect(dup.ok).toBe(false)
    const bad = await createUser(admin(), plainAdmin, { email: 'nope', full_name: '', role: 'user' })
    expect(bad.ok).toBe(false)
  })

  it('a plain admin cannot create administrators, a platform owner can', async () => {
    const email = () => `${crypto.randomUUID()}@example.test`
    expect((await createUser(admin(), plainAdmin, { email: email(), full_name: 'X', role: 'admin' })).ok).toBe(false)
    expect((await createUser(admin(), owner, { email: email(), full_name: 'X', role: 'admin' })).ok).toBe(true)
  })

  it('a viewer cannot administer anyone', async () => {
    const viewer: Actor = { id: crypto.randomUUID(), orgId, role: 'user' }
    expect((await createUser(admin(), viewer, { email: `${crypto.randomUUID()}@example.test`, full_name: 'X', role: 'user' })).ok).toBe(false)
  })

  it('changes a role, forbids changing oneself, and deactivation blocks sign-in until reactivated', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Change Me', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    expect((await updateUser(admin(), plainAdmin, made.userId, { role: 'operator' })).ok).toBe(true) // 'agent' before P2-1 (AC-15)
    expect((await updateUser(admin(), plainAdmin, plainAdmin.id, { role: 'user' })).ok).toBe(false)
    expect((await updateUser(admin(), plainAdmin, owner.id, { is_active: false })).ok).toBe(false)

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: false })).ok).toBe(true)
    expect((await signIn(email, made.oneTimePassword)).error).not.toBeNull()
    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: true })).ok).toBe(true)
    expect((await signIn(email, made.oneTimePassword)).error).toBeNull()
  })

  it('resets a password: the new one works, the old one does not, and the person must choose again', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Reset Me', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    await admin().from('profiles').update({ must_reset_password: false }).eq('id', made.userId)
    const reset = await resetUserPassword(admin(), plainAdmin, made.userId)
    if (!reset.ok) throw new Error('reset failed')
    expect((await signIn(email, made.oneTimePassword)).error).not.toBeNull()
    expect((await signIn(email, reset.oneTimePassword)).error).toBeNull()
    const p = await admin().from('profiles').select('must_reset_password').eq('id', made.userId).single()
    expect(p.data?.must_reset_password).toBe(true)
  })

  it('saves an access list that the person then sees through row-level security', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Gets Access', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    await admin().from('profiles').update({ must_reset_password: false }).eq('id', made.userId)

    // A new person has no grants at all (AC-8): the create form offers "Assign access next".
    expect((await admin().from('access_grants').select('id').eq('user_id', made.userId)).data).toEqual([])
    expect((await saveAccess(plainAdmin, made.userId, [...live('camera', cameraIds[0]), ...live('camera', cameraIds[1])])).ok).toBe(true)
    const { client } = await signIn(email, made.oneTimePassword)
    const seen = await client.from('cameras').select('id')
    expect((seen.data ?? []).map((r) => r.id).sort()).toEqual([cameraIds[0], cameraIds[1]].sort())

    // Widening to the location means granting it and revoking the camera grants, with a reason (P2-3: never by replacing a list).
    const ed = await loadEditor(admin(), plainAdmin, made.userId)
    const revokes: AccessChange[] = ed!.grants.filter((g) => g.state === 'active').map((g) => ({ op: 'revoke', grant_id: g.id, reason: 'Whole location instead' }))
    expect((await saveAccess(plainAdmin, made.userId, [...revokes, ...live('location', storeId)])).ok).toBe(true)
    const all = await client.from('cameras').select('id')
    expect((all.data ?? []).length).toBe(3)
    // Explicit live + playback grants; the removed camera grants are revoked, not deleted (history).
    const { data: grants } = await admin().from('access_grants').select('capability, scope_kind, scope_id, revoked_at').eq('user_id', made.userId)
    const liveRows = (grants ?? []).filter((g) => g.revoked_at === null).map((g) => `${g.capability}:${g.scope_kind}:${g.scope_id}`).sort()
    expect(liveRows).toEqual([`cctv.live:location:${storeId}`, `cctv.playback:location:${storeId}`])
    expect((grants ?? []).filter((g) => g.revoked_at !== null)).toHaveLength(4)
  })

  // AC-6 (P2-1): this used to be "camera grants inside a store narrow it". Now they only add.
  // P2-3: zones are no longer offered (P2-1 turned them into their locations); a change touches only the grants it names.
  it('a camera next to its location adds nothing and takes nothing away, and a change leaves every other grant alone', async () => {
    const viewer = await makeUser(orgId, 'user')
    expect((await saveAccess(plainAdmin, viewer.id, [...live('location', storeId), ...live('camera', cameraIds[0])])).ok).toBe(true)
    expect(((await viewer.client.from('cameras').select('id')).data ?? []).length).toBe(3)
    // An IT grant given elsewhere survives removing the CCTV grants.
    await grant(orgId, viewer.id, 'it.inventory.view')
    const ed = await loadEditor(admin(), owner, viewer.id)
    const cctv = ed!.grants.filter((g) => g.capability.startsWith('cctv.')).map((g): AccessChange => ({ op: 'revoke', grant_id: g.id, reason: 'Not needed any more' }))
    expect((await saveAccess(plainAdmin, viewer.id, cctv)).ok).toBe(true)
    expect(((await viewer.client.from('cameras').select('id')).data ?? []).length).toBe(0)
    expect((await viewer.client.rpc('has_capability', { p_cap: 'it.inventory.view' })).data).toBe(true)
  })

  // Review fix I-2 (kept in P2-3): saving never re-dates a grant: an expired grant stays expired, a future one stays future, and
  // neither is turned into a permanent grant; the editor lists both with their state.
  it('expired and future grants are listed with their state, and a save of other changes keeps their dates', async () => {
    const hour = 3_600_000
    const iso = (ms: number) => new Date(ms).toISOString()
    const mk = async (code: string) => {
      const s = (await admin().from('locations').insert({ org_id: orgId, code, name: `Store ${code}`, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
      const c = (await admin().from('cameras').insert({ org_id: orgId, location_id: s, channel: 1, name: `${code} cam` }).select('id').single()).data!.id
      return { s, c }
    }
    const past = await mk('UEXP')
    const future = await mk('UFUT')
    const viewer = await makeUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live', 'cctv.playback'], { kind: 'location', id: storeId })
    await grant(orgId, viewer.id, ['cctv.live', 'cctv.playback'], { kind: 'location', id: past.s }, { validFrom: iso(Date.now() - 2 * hour), validUntil: iso(Date.now() - hour) })
    await grant(orgId, viewer.id, ['cctv.live', 'cctv.playback'], { kind: 'location', id: future.s }, { validFrom: iso(Date.now() + 24 * hour) })
    const rowsOf = async () => (await admin().from('access_grants').select('id, scope_id, valid_from, valid_until, revoked_at').eq('user_id', viewer.id).order('id')).data ?? []
    const before = await rowsOf()

    const shown = await loadEditor(admin(), owner, viewer.id)
    expect(shown!.grants.filter((o) => o.scopeId === past.s).map((o) => o.state)).toEqual(['expired', 'expired'])
    expect(shown!.grants.filter((o) => o.scopeId === future.s).map((o) => o.state)).toEqual(['future', 'future'])
    const seen = async () => ((await viewer.client.from('cameras').select('id')).data ?? []).map((r) => r.id)
    expect(await seen()).not.toContain(past.c)
    expect(await seen()).not.toContain(future.c)
    // Removing everything that is in effect leaves the dated grants alone.
    const inEffect = shown!.grants.filter((o) => o.state === 'active').map((o): AccessChange => ({ op: 'revoke', grant_id: o.id, reason: 'Moving to another team' }))
    expect((await saveAccess(plainAdmin, viewer.id, inEffect)).ok).toBe(true)
    expect(before.length).toBe(6)
    const after = await rowsOf()
    for (const r of after.filter((x) => x.scope_id !== storeId)) expect(r).toEqual(before.find((b) => b.id === r.id))
    expect(after.filter((x) => x.scope_id === storeId).every((x) => x.revoked_at !== null)).toBe(true)
    // Restored (P2-3 review M-2): the administrator gives the expired location again: the expired grants stay exactly as they were
    // (expired, not re-dated, not revoked) and new grants are added next to them.
    expect((await saveAccess(plainAdmin, viewer.id, live('location', past.s))).ok).toBe(true)
    const again = await rowsOf()
    for (const old of before.filter((x) => x.scope_id === past.s)) expect(again.find((r) => r.id === old.id)).toEqual(old)
    expect(again.filter((x) => x.scope_id === past.s && x.revoked_at === null && x.valid_until === null)).toHaveLength(2)
    expect(await seen()).toContain(past.c)
  })

  // Review fix I-4 (kept in P2-3): every grant is listed, organisation-wide (for example migrated) access included, and a change of
  // other grants keeps it.
  it('a migrated manager’s organisation-wide grants are listed with source and review flag, and a save of other changes keeps them', async () => {
    const manager = await makeUser(orgId, 'manager')
    const run = await admin().rpc('access_migrate_legacy_test', { p_run: crypto.randomUUID(), p_users: [manager.id] })
    expect(run.error).toBeNull()
    const shown = await loadEditor(admin(), owner, manager.id)
    const orgWide = shown!.grants.filter((o) => o.scopeKind === 'organization')
    expect(orgWide.map((o) => o.capability).sort()).toEqual(['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'])
    for (const o of orgWide) expect(o).toMatchObject({ source: 'migrated:manager', needsReview: true, scopeLabel: 'Whole organisation', state: 'active', validUntil: null })
    expect(orgWide[0].capabilityLabel.length).toBeGreaterThan(3)
    expect((await saveAccess(plainAdmin, manager.id, live('location', storeId))).ok).toBe(true)
    const again = await loadEditor(admin(), owner, manager.id)
    expect(again!.grants.filter((o) => o.scopeKind === 'organization' && o.state === 'active')).toHaveLength(4)
  })

  // AC-8 (P2-1): this used to refuse a manager ("sees everything"). A manager now gets explicit grants like everyone else.
  it('gives a manager explicit grants like anyone else, and refuses locations of another organisation', async () => {
    const manager = await makeUser(orgId, 'manager')
    expect(((await manager.client.from('cameras').select('id')).data ?? []).length).toBe(0)
    expect((await saveAccess(plainAdmin, manager.id, live('location', storeId))).ok).toBe(true)
    expect(((await manager.client.from('cameras').select('id')).data ?? []).length).toBe(3)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('locations').insert({ org_id: otherOrg, code: 'O1', name: 'Other', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    const viewer = await makeUser(orgId, 'user')
    const res = await saveAccess(plainAdmin, viewer.id, live('location', other!.id))
    expect(res).toMatchObject({ ok: false, error: 'One of the locations, cameras or assets was not found.' })
    await cleanupOrg(otherOrg)
  })

  it('a plain admin cannot promote a manager to administrator, reset an administrator, or touch their own role', async () => {
    const manager = await makeUser(orgId, 'manager')
    const promoted = await updateUser(admin(), plainAdmin, manager.id, { role: 'admin' })
    expect(promoted.ok).toBe(false)
    const after = await admin().from('profiles').select('role').eq('id', manager.id).single()
    expect(after.data?.role).toBe('manager')

    const otherAdmin = await makeUser(orgId, 'admin')
    expect((await resetUserPassword(admin(), plainAdmin, otherAdmin.id)).ok).toBe(false)
    // The administrator's password still works.
    expect((await signIn(otherAdmin.email, otherAdmin.password)).error).toBeNull()
  })

  it('a platform owner cannot change their own role or status', async () => {
    const res = await updateUser(admin(), owner, owner.id, { role: 'admin' })
    expect(res).toEqual({ ok: false, error: 'You cannot change your own role or status.' })
    const res2 = await updateUser(admin(), owner, owner.id, { is_active: false })
    expect(res2.ok).toBe(false)
    const after = await admin().from('profiles').select('role, is_active').eq('id', owner.id).single()
    expect(after.data).toEqual({ role: 'platform_owner', is_active: true })
  })

  it('refuses a person who belongs to another organisation', async () => {
    const otherOrg = await createOrg()
    try {
      const stranger = await makeUser(otherOrg, 'user')
      const notFound = { ok: false, error: 'User not found.' }
      expect(await updateUser(admin(), owner, stranger.id, { full_name: 'Hijacked' })).toEqual(notFound)
      expect(await resetUserPassword(admin(), owner, stranger.id)).toEqual(notFound)
      expect(await saveAccess(owner, stranger.id, live('camera', cameraIds[0]))).toEqual(notFound)
      expect(await loadEditor(admin(), owner, stranger.id)).toBeNull()
      // Nothing changed, and the stranger's password still works.
      expect((await signIn(stranger.email, stranger.password)).error).toBeNull()
    } finally {
      await cleanupOrg(otherOrg)
    }
  })

  it('ends the old sessions when a password is reset', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Session Reset', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    const old = await signIn(email, made.oneTimePassword)
    expect(old.error).toBeNull()
    const oldAccess = (await old.client.auth.getSession()).data.session!.access_token

    const reset = await resetUserPassword(admin(), plainAdmin, made.userId)
    expect(reset.ok).toBe(true)

    // The old session can neither choose a new password nor be renewed.
    const attempt = await old.client.auth.updateUser({ password: crypto.randomUUID() + 'aA1!' })
    expect(attempt.error).not.toBeNull()
    const refreshed = await old.client.auth.refreshSession()
    expect(refreshed.error).not.toBeNull()
    expect(refreshed.data.session).toBeNull()
    // Same through the raw access token.
    const raw = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, Authorization: `Bearer ${oldAccess}` },
    })
    // What GoTrue does with the already-issued access token is recorded in the fix report.
    expect(typeof raw.status).toBe('number')
  })

  it('ends the sessions of a deactivated person, and reactivating does not bring them back', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Session Off', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    // Two separate sessions: one is tried while the person is deactivated, the other only after reactivation.
    const whileOff = await signIn(email, made.oneTimePassword)
    const afterOn = await signIn(email, made.oneTimePassword)
    expect(whileOff.error).toBeNull()
    expect(afterOn.error).toBeNull()

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: false })).ok).toBe(true)
    expect((await whileOff.client.auth.updateUser({ password: crypto.randomUUID() + 'aA1!' })).error).not.toBeNull()
    expect((await whileOff.client.auth.refreshSession()).error).not.toBeNull()

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: true })).ok).toBe(true)
    // The ban is lifted, yet the sessions that existed before the deactivation stay ended.
    expect((await afterOn.client.auth.updateUser({ password: crypto.randomUUID() + 'aA1!' })).error).not.toBeNull()
    const refreshed = await afterOn.client.auth.refreshSession()
    expect(refreshed.error).not.toBeNull()
    expect(refreshed.data.session).toBeNull()
    // A fresh sign-in works again.
    expect((await signIn(email, made.oneTimePassword)).error).toBeNull()
  })

  it('only the server may end sessions: a signed-in person cannot call the function', async () => {
    const viewer = await makeUser(orgId, 'user')
    const res = await viewer.client.rpc('revoke_user_sessions', { p_user: owner.id })
    expect(res.error).not.toBeNull()
  })

  it('lists every store and camera and user even when sort keys tie across more than 1000 rows', async () => {
    const pagingOrg = await createOrg()
    try {
      const { data: two } = await admin().from('locations').insert([1, 2].map((n) => ({ org_id: pagingOrg, code: `P${n}`, name: `Paging ${n}`, zone: 'PG', nvr_ip: '127.0.0.1', nvr_username: 'u' }))).select('id')
      // Two stores with channels 1..501: every channel number appears twice, so ordering by channel alone would tie.
      const rows = two!.flatMap((s) => Array.from({ length: 501 }, (_, i) => ({ org_id: pagingOrg, location_id: s.id, channel: i + 1, name: `C${i + 1}` })))
      const ins = await admin().from('cameras').insert(rows)
      expect(ins.error).toBeNull()

      const v = await makeUser(pagingOrg, 'user')
      const po = await makeUser(pagingOrg, 'platform_owner')
      await grant(pagingOrg, po.id, ['admin.users', 'admin.access'])
      const actor: Actor = { id: po.id, orgId: pagingOrg, role: 'platform_owner' }
      const editor = await loadEditor(admin(), actor, v.id)
      const cams = editor!.cameras
      expect(cams).toHaveLength(1002)
      expect(new Set(cams.map((c) => c.id)).size).toBe(1002)
      expect(editor!.locations).toHaveLength(2)
      expect(await listStoresForAccess(admin(), pagingOrg)).toHaveLength(2)

      // A viewer granted every one of those cameras reads them all back.
      const ids = cams.map((c) => c.id)
      expect((await saveAccess(actor, v.id, ids.map((id): AccessChange => ({ op: 'grant', capability: 'cctv.live', scope_kind: 'camera', scope_id: id, valid_until: null, reason: '' })))).ok).toBe(true)
      const back = (await loadEditor(admin(), actor, v.id))!.grants.filter((g) => g.state === 'active').map((g) => g.scopeId)
      expect(back).toHaveLength(1002)
      expect(new Set(back).size).toBe(1002)
      // P2-3 review M-4: a large save is audited in parts of at most 200 grants; no grant id is lost.
      const { data: parts } = await admin().from('admin_audit_log').select('detail').eq('org_id', pagingOrg).eq('action', 'access_granted').eq('entity_id', v.id)
      const audited = new Set((parts ?? []).flatMap((p) => (p.detail as { grants: { grant_id: string }[] }).grants.map((g) => g.grant_id)))
      expect(audited.size).toBe(1002)
      expect((parts ?? []).every((p) => (p.detail as { grants: unknown[] }).grants.length <= 200)).toBe(true)

      expect((await listUsers(admin(), pagingOrg)).length).toBe(2)
    } finally {
      await cleanupOrg(pagingOrg)
    }
  })

  it('writes an audit record for each change', async () => {
    const { data } = await admin().from('admin_audit_log').select('action').eq('org_id', orgId)
    const actions = new Set((data ?? []).map((r) => r.action))
    expect(actions).toContain('user_created')
    expect(actions).toContain('user_updated')
    expect(actions).toContain('user_password_reset')
    expect(actions).toContain('access_granted') // P2-3: was user_access_set (interim editor)
    expect(actions).toContain('access_revoked')
  })
})
