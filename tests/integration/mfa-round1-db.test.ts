import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

// P3-1 review round 1, the database half (migration 20261021000037_p31_review_fixes.sql):
//   M-9  mfa_code_claim(user, hash): a code of an authenticator app is accepted once per person (GoTrue 2.197 accepts the same code
//        again within its window — measured in the review round: the same code verified in a second session and again in the first);
//   I-4  mfa_factor_people(org) also says WHEN the app was set up and from which address (the latest mfa_enrolled event);
//   M-4  auth_events cannot be deleted or truncated directly (deleting the organisation still removes them);
//   M-5  every change of the multi-factor switch is written to admin_audit_log (old and new value, the database user).

const admin = () => adminClient()
const claim = (c: ReturnType<typeof serviceClient>, user: string, hash: string) => c.rpc('mfa_code_claim' as never, { p_user: user, p_hash: hash } as never)

describe('P3-1 review round 1 in the database', () => {
  let org: string
  let a: TestUser, b: TestUser

  beforeAll(async () => {
    org = await createOrg()
    a = await createUser(org, 'admin')
    b = await createUser(org, 'user')
  })
  afterAll(() => cleanupOrg(org))

  it('M-9: a code is accepted once per person; another person, or another code, is separate', async () => {
    const web = serviceClient('app_web')
    const h1 = 'a'.repeat(64)
    expect((await claim(web, a.id, h1)).data).toBe(true)
    expect((await claim(web, a.id, h1)).data).toBe(false)
    expect((await claim(web, b.id, h1)).data).toBe(true)
    expect((await claim(web, a.id, 'b'.repeat(64))).data).toBe(true)
    // Only the web app's role (and the service role) may claim; a signed-in person may not.
    expect((await a.client.rpc('mfa_code_claim' as never, { p_user: a.id, p_hash: 'c'.repeat(64) } as never)).error).not.toBeNull()
    expect((await claim(web, a.id, 'not a hash')).error).not.toBeNull()
  })

  it('I-4: the people list names when an app was set up and from where (from the sign-in audit)', async () => {
    const web = serviceClient('app_web')
    await web.rpc('auth_event_record', { p_event: 'mfa_enrolled', p_user: a.id, p_email: null, p_email_hash: null, p_actor: null, p_ip: '10.0.0.47', p_user_agent: null, p_detail: {} } as never)
    const { data, error } = await web.rpc('mfa_enrolment_events' as never, { p_org: org } as never)
    expect(error).toBeNull()
    const rows = (data ?? []) as { user_id: string; enrolled_at: string; enrolled_ip: string | null }[]
    const mine = rows.find((r) => r.user_id === a.id)
    expect(mine?.enrolled_ip).toBe('10.0.0.47')
    expect(Math.abs(Date.now() - Date.parse(mine!.enrolled_at))).toBeLessThan(5 * 60_000)
    expect(rows.find((r) => r.user_id === b.id)).toBeUndefined()
    expect((await a.client.rpc('mfa_enrolment_events' as never, { p_org: org } as never)).error).not.toBeNull()
  })

  it('M-4: sign-in events cannot be deleted or truncated, not even by the service role', async () => {
    const { data } = await admin().from('auth_events').select('id').eq('org_id', org).limit(1)
    const id = (data ?? [])[0]?.id
    expect(id).toBeTruthy()
    const del = await admin().from('auth_events').delete().eq('id', id!).select('id')
    expect(del.error !== null || (del.data ?? []).length === 0).toBe(true)
    expect(((await admin().from('auth_events').select('id').eq('id', id!)).data ?? []).length).toBe(1)
    const { data: guard } = await admin().rpc('auth_events_guard_status' as never)
    expect(guard).toEqual({ update_blocked: true, delete_blocked: true, truncate_blocked: true })
  })

  it('M-5: switching multi-factor on and off is audited with the old and the new value', async () => {
    await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: true })
    await admin().rpc('security_settings_set_mfa_test', { p_org: org, p_mfa_enforced: false })
    const { data } = await admin().from('admin_audit_log').select('action, detail').eq('org_id', org).eq('action', 'mfa_enforced_changed').order('created_at')
    expect((data ?? []).map((r) => [(r.detail as { from: unknown }).from, (r.detail as { to: unknown }).to])).toEqual([[false, true], [true, false]])
    expect(typeof ((data ?? [])[0]?.detail as { db_user?: unknown })?.db_user).toBe('string')
  })

  it('privilege_violations() stays empty', async () => {
    expect((await admin().rpc('privilege_violations')).data).toEqual([])
  })
})
